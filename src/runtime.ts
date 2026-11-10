/**
 * Browser runtime. Picks the operating mode at start-up:
 *  - server: the console is served by a Mob Hunter server (/api/health answers) —
 *    every call goes to the real backend over HTTPS with a session cookie.
 *  - demo:   GitHub Pages (or offline APK) — the reference backend runs in the
 *    browser, seeded with demo accounts and simulated phones.
 */
import { Backend, type DemoAccount, type Store } from './core/backend';
import type { BackendState, ProvisioningPayload, PublicUser } from './core/types';
import { SimulatedAgent, newAgentFromProvisioning, type AgentState } from './core/agent';
import { StubPushProvider } from './core/relay';
import type { Role } from './core/rbac';
import { totp } from './core/totp';
import { LocalConsoleApi, RemoteConsoleApi, type ConsoleApi, type Health } from './api/console';
import { HttpDeviceTransport } from './api/device';

const STATE_KEY = 'mob-hunter.state.v1';
const AGENTS_KEY = 'mob-hunter.agents.v1';
const DEMO_KEY = 'mob-hunter.demo.v1';
const SESSION_KEY = 'mob-hunter.sid';

function safeGet(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function safeSet(storage: Storage | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode) — app keeps working in memory */
  }
}
function safeRemove(storage: Storage | undefined, key: string) {
  try {
    storage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

const ls = typeof localStorage !== 'undefined' ? localStorage : undefined;
const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;

class LocalStore implements Store {
  private mem: string | null = null;
  load(): BackendState | null {
    const raw = safeGet(ls, STATE_KEY) ?? this.mem;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BackendState;
    } catch {
      return null;
    }
  }
  save(s: BackendState) {
    const raw = JSON.stringify(s);
    this.mem = raw;
    safeSet(ls, STATE_KEY, raw);
  }
  clear() {
    this.mem = null;
    safeRemove(ls, STATE_KEY);
  }
}

export const DEMO_PEOPLE: { name: string; email: string; role: Role }[] = [
  { name: 'Sam Super', email: 'super@demo.local', role: 'SUPER_ADMIN' },
  { name: 'Dana Device', email: 'device@demo.local', role: 'DEVICE_ADMIN' },
  { name: 'Drew Device (approver)', email: 'device2@demo.local', role: 'DEVICE_ADMIN' },
  { name: 'Hari Helpdesk', email: 'helpdesk@demo.local', role: 'HELPDESK' },
  { name: 'Lee Location', email: 'locator@demo.local', role: 'LOCATION_OPERATOR' },
  { name: 'Sena Security', email: 'security@demo.local', role: 'SECURITY' },
  { name: 'Ari Auditor', email: 'auditor@demo.local', role: 'AUDITOR' },
];
export const DEMO_PASSWORD = 'Demo-Passw0rd-2026';

export class Runtime {
  agents = new Map<string, SimulatedAgent>();
  private listeners = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  version = 0;
  me: PublicUser | null = null;

  private constructor(
    public readonly api: ConsoleApi,
    public readonly health: Health,
    /** only in demo mode */
    public readonly backend: Backend | null,
    public demoAccounts: DemoAccount[],
  ) {}

  get mode(): 'demo' | 'server' {
    return this.api.mode;
  }

  static async detectServer(): Promise<Health | null> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch('./api/health', { signal: ctl.signal, credentials: 'same-origin' });
      clearTimeout(t);
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
      const j = (await res.json()) as Health;
      return j?.service === 'mob-hunter' && j.mode === 'server' ? j : null;
    } catch {
      return null;
    }
  }

  static async boot(onProgress?: (msg: string) => void): Promise<Runtime> {
    onProgress?.('Connecting…');
    const server = await Runtime.detectServer();
    if (server) {
      const api = new RemoteConsoleApi('./api');
      const rt = new Runtime(api, server, null, []);
      try {
        rt.me = await api.currentUser();
      } catch {
        rt.me = null;
      }
      rt.loadAgents();
      // Server mode: refresh views periodically; test devices poll for commands.
      rt.timers.push(setInterval(() => rt.emit(), 10_000));
      rt.timers.push(setInterval(() => void rt.pollAgents(), 8_000));
      rt.timers.push(setInterval(() => void rt.tickAll(), 30_000));
      return rt;
    }

    const store = new LocalStore();
    const firstRun = !store.load();
    onProgress?.(firstRun ? 'Generating signing keys…' : 'Opening console…');
    const backend = await Backend.open({ store, apiBaseUrl: `${location.origin}${location.pathname.replace(/\/$/, '')}/api` });
    let demo: DemoAccount[] = [];
    try {
      demo = JSON.parse(safeGet(ls, DEMO_KEY) ?? '[]');
    } catch {
      demo = [];
    }
    let rtRef: Runtime | null = null;
    const api = new LocalConsoleApi(backend, {
      get: () => safeGet(ss, SESSION_KEY),
      set: (v) => {
        if (v) safeSet(ss, SESSION_KEY, v);
        else safeRemove(ss, SESSION_KEY);
        rtRef?.emit();
      },
    });
    const rt = new Runtime(api, await api.health(), backend, demo);
    rtRef = rt;
    if (firstRun || demo.length === 0) await rt.seed(onProgress);
    try {
      rt.me = await api.me();
    } catch {
      rt.me = null;
    }
    rt.loadAgents();
    (backend.push as StubPushProvider).onWake((deviceId) => rt.onWake(deviceId));
    backend.subscribe(() => rt.emit());
    rt.timers.push(setInterval(() => void rt.tickAll(), 20_000));
    // Keep several open tabs consistent: adopt whatever another tab just wrote.
    window.addEventListener('storage', (e) => {
      if (e.key === STATE_KEY) backend.reloadFromStore();
      if (e.key === AGENTS_KEY) rt.reloadAgents();
      if (e.key === null) location.reload();
    });
    return rt;
  }

  private async seed(onProgress?: (msg: string) => void) {
    const backend = this.backend!;
    const accounts: DemoAccount[] = [];
    for (const p of DEMO_PEOPLE) {
      onProgress?.(`Creating ${p.name} (PBKDF2 210k)…`);
      accounts.push(await backend.createUser({ ...p, password: DEMO_PASSWORD }));
    }
    this.demoAccounts = accounts;
    safeSet(ls, DEMO_KEY, JSON.stringify(accounts));
    const emps = [
      { name: 'Nimal Perera', email: 'nimal.perera@example.com', department: 'Field Operations' },
      { name: 'Kavya Fernando', email: 'kavya.fernando@example.com', department: 'Sales' },
      { name: 'Ruwan Silva', email: 'ruwan.silva@example.com', department: 'Logistics' },
      { name: 'Ishara Jayasinghe', email: 'ishara.j@example.com', department: 'Finance' },
    ].map((e) => backend.addEmployee(e));

    const sa = await this.signInDemo('SUPER_ADMIN');
    await backend.updateSettings(sa, { orgName: 'Demo Company (Pvt) Ltd', dpoContact: 'dpo@example.com' });
    await backend.upsertApp(sa, { packageName: 'com.example.timesheets', name: 'Timesheets', url: 'https://apps.example.com/timesheets-2.3.1.apk', sha256: 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' });
    await backend.logout(sa);

    onProgress?.('Enrolling simulated devices…');
    const sid = await this.signInDemo('DEVICE_ADMIN');
    // Device 1: acknowledged, named and assigned.
    const e1 = await backend.createEnrollment(sid, { note: 'Seed device 1' });
    const a1 = await this.addAgent(e1.provisioning, { autoPull: true });
    a1.acknowledge();
    await a1.checkin();
    await backend.updateDevice(sid, a1.state.deviceId!, { label: "Nimal's field phone", assignedUserId: emps[0].id });
    // Device 2: freshly enrolled, unnamed, awaiting the user's acknowledgement.
    const e2 = await backend.createEnrollment(sid, { note: 'Seed device 2' });
    await this.addAgent(e2.provisioning, { autoPull: true });
    // Threat landscape demo: device 1 runs an old patch with USB debugging on, on open Wi-Fi.
    a1.state.posture = { patchLevel: '2026-04-05', security: { usbDebugging: true, devOptions: true, openWifi: true } };
    await a1.checkin();
    // Two computers running the desktop agent (Windows and Linux).
    const computers = [
      { label: 'Finance laptop (Windows)', platform: 'windows' as const, hardware: { serial: 'PF4K2Z9', model: 'Dell Latitude 7450', os: 'Windows 11 Pro 24H2 (26100.4351)' }, posture: { patchLevel: '2026-10-14', security: { encrypted: true, firewall: false, antivirus: true, secureBoot: true, screenLock: true, pendingUpdates: 3 } }, emp: 1 },
      { label: 'Build server (Linux)', platform: 'linux' as const, hardware: { serial: 'MJ0K7Q2B', model: 'Lenovo ThinkCentre M70q', os: 'Ubuntu 24.04.3 LTS' }, posture: { patchLevel: '2026-11-02', noBattery: true, security: { encrypted: false, firewall: true, secureBoot: true, pendingUpdates: 12 } }, emp: null },
    ];
    for (const c of computers) {
      const e = await backend.createEnrollment(sid, { note: c.label });
      const ag = await this.addAgent(e.provisioning, { seed: { platform: c.platform, hardware: c.hardware, posture: c.posture, battery: 92 } });
      ag.acknowledge();
      await ag.checkin();
      await backend.updateDevice(sid, ag.state.deviceId!, { label: c.label, assignedUserId: c.emp === null ? null : emps[c.emp].id, tags: ['Computers'] });
    }
    await backend.logout(sid);

    // Location history for the demo: the Location Operator locates device 1 twice against a ticket,
    // through the normal signed-command flow (the simulated phone shows its notification each time).
    onProgress?.('Recording demo location requests…');
    const op = await this.signInDemo('LOCATION_OPERATOR');
    for (const reason of ['Employee reported the phone missing after a site visit', 'Follow-up check before dispatching a courier']) {
      await backend.issueCommand(op, a1.state.deviceId!, { type: 'LOCATE', ticket: 'INC-1001', reason });
      await a1.poll();
      a1.state.home = { lat: a1.state.home.lat + 0.004, lng: a1.state.home.lng + 0.003 };
    }
    await backend.logout(op);
    this.saveAgents();
  }

  /** Used only for seeding: performs the real password + TOTP flow with the demo authenticator. */
  async signInDemo(role: Role): Promise<string> {
    const backend = this.backend!;
    const acc = this.demoAccounts.find((a) => a.role === role)!;
    const { challengeId } = await backend.login(acc.email, acc.password);
    return (await backend.verifyMfa(challengeId, await totp(acc.totpSecret, Date.now()))).sessionId;
  }

  // ---------------------------------------------------------------- auth state

  async signedIn(user: PublicUser) {
    this.me = user;
    this.emit();
  }

  async signOut() {
    try {
      await this.api.logout();
    } finally {
      this.me = null;
      this.emit();
    }
  }

  /** Called when any call reports 401: drop the local idea of being signed in. */
  sessionLost() {
    if (this.me) {
      this.me = null;
      this.emit();
    }
  }

  // ---------------------------------------------------------------- simulators

  private agentFor(state: AgentState): SimulatedAgent {
    return this.backend ? new SimulatedAgent(state, this.backend) : new SimulatedAgent(state, new HttpDeviceTransport(`${location.origin}${location.pathname.replace(/\/$/, '')}`));
  }

  private loadAgents() {
    let states: AgentState[] = [];
    try {
      states = JSON.parse(safeGet(ls, this.agentsKey) ?? '[]');
    } catch {
      states = [];
    }
    for (const s of states) this.agents.set(s.simId, this.agentFor(s));
  }

  private get agentsKey() {
    return this.backend ? AGENTS_KEY : `${AGENTS_KEY}.server`;
  }

  reloadAgents() {
    this.agents.clear();
    this.loadAgents();
    this.emit();
  }

  saveAgents() {
    safeSet(ls, this.agentsKey, JSON.stringify([...this.agents.values()].map((a) => a.state)));
    this.emit();
  }

  async addAgent(provisioning: ProvisioningPayload, opts: { autoPull?: boolean; seed?: Partial<AgentState> } = {}): Promise<SimulatedAgent> {
    const agent = this.agentFor(newAgentFromProvisioning(provisioning, { autoPull: opts.autoPull ?? true, ...opts.seed }));
    await agent.enroll();
    await agent.checkin(); // like the real agent: first check-in right after enrolment
    this.agents.set(agent.state.simId, agent);
    this.saveAgents();
    return agent;
  }

  removeAgent(simId: string) {
    this.agents.delete(simId);
    this.saveAgents();
  }

  /** A deleted device's simulator has nothing left to talk to: remove it too. */
  forgetDevice(deviceId: string) {
    const a = this.agentForDevice(deviceId);
    if (a) this.removeAgent(a.state.simId);
  }

  agentForDevice(deviceId: string): SimulatedAgent | undefined {
    return [...this.agents.values()].find((a) => a.state.deviceId === deviceId);
  }

  private onWake(deviceId: string) {
    const agent = this.agentForDevice(deviceId);
    if (!agent || !agent.state.autoPull) return;
    // Simulate push latency, then the device pulls over its authenticated channel.
    setTimeout(() => {
      void agent
        .poll()
        .catch((e) => agent.state.log.unshift({ at: Date.now(), text: `Pull failed: ${(e as Error).message}` }))
        .finally(() => this.saveAgents());
    }, 900);
  }

  /** Server mode has no push to a browser: test devices poll. */
  private async pollAgents() {
    let changed = false;
    for (const a of this.agents.values()) {
      if (!a.state.autoPull || !a.enrolled) continue;
      try {
        changed = (await a.poll()).length > 0 || changed;
      } catch {
        /* revoked or offline */
      }
    }
    if (changed) this.saveAgents();
  }

  async tickAll() {
    for (const a of this.agents.values()) {
      try {
        await a.tick();
      } catch {
        /* a wiped/revoked device simply stops working */
      }
    }
    this.saveAgents();
  }

  // ---------------------------------------------------------------- events

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  resetDemo() {
    for (const t of this.timers) clearInterval(t);
    for (const k of [STATE_KEY, AGENTS_KEY, DEMO_KEY]) safeRemove(ls, k);
    safeRemove(ss, SESSION_KEY);
  }
}
