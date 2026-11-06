/**
 * Browser runtime: wires the reference backend to localStorage, seeds a demo
 * tenant on first visit, and runs the simulated devices (push wake → pull).
 */
import { Backend, type DemoAccount, type Store } from './core/backend';
import type { BackendState, ProvisioningPayload } from './core/types';
import { SimulatedAgent, newAgentFromProvisioning, type AgentState } from './core/agent';
import { StubPushProvider } from './core/relay';
import type { Role } from './core/rbac';
import { totp } from './core/totp';

const STATE_KEY = 'fleetguard.state.v1';
const AGENTS_KEY = 'fleetguard.agents.v1';
const DEMO_KEY = 'fleetguard.demo.v1';
const SESSION_KEY = 'fleetguard.sid';

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
  private timer: ReturnType<typeof setInterval> | undefined;
  version = 0;

  private constructor(public backend: Backend, public demoAccounts: DemoAccount[]) {}

  static async boot(onProgress?: (msg: string) => void): Promise<Runtime> {
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
    const rt = new Runtime(backend, demo);
    if (firstRun || demo.length === 0) await rt.seed(onProgress);
    rt.loadAgents();
    (backend.push as StubPushProvider).onWake((deviceId) => rt.onWake(deviceId));
    backend.subscribe(() => rt.emit());
    rt.timer = setInterval(() => void rt.tickAll(), 20_000);
    // Keep several open tabs consistent: adopt whatever another tab just wrote.
    window.addEventListener('storage', (e) => {
      if (e.key === STATE_KEY) backend.reloadFromStore();
      if (e.key === AGENTS_KEY) rt.reloadAgents();
      if (e.key === null) location.reload();
    });
    return rt;
  }

  private async seed(onProgress?: (msg: string) => void) {
    const accounts: DemoAccount[] = [];
    for (const p of DEMO_PEOPLE) {
      onProgress?.(`Creating ${p.name} (PBKDF2 210k)…`);
      accounts.push(await this.backend.createUser({ ...p, password: DEMO_PASSWORD }));
    }
    this.demoAccounts = accounts;
    safeSet(ls, DEMO_KEY, JSON.stringify(accounts));
    const emps = [
      { name: 'Nimal Perera', email: 'nimal.perera@example.com', department: 'Field Operations' },
      { name: 'Kavya Fernando', email: 'kavya.fernando@example.com', department: 'Sales' },
      { name: 'Ruwan Silva', email: 'ruwan.silva@example.com', department: 'Logistics' },
      { name: 'Ishara Jayasinghe', email: 'ishara.j@example.com', department: 'Finance' },
    ].map((e) => this.backend.addEmployee(e));

    onProgress?.('Enrolling simulated devices…');
    const sid = await this.signInDemo('DEVICE_ADMIN');
    // Device 1: acknowledged, named and assigned.
    const e1 = await this.backend.createEnrollment(sid, { note: 'Seed device 1' });
    const a1 = await this.addAgent(e1.provisioning, { autoPull: true });
    a1.acknowledge();
    await a1.checkin();
    await this.backend.updateDevice(sid, a1.state.deviceId!, { label: "Nimal's field phone", assignedUserId: emps[0].id });
    // Device 2: freshly enrolled, unnamed, awaiting the user's acknowledgement.
    const e2 = await this.backend.createEnrollment(sid, { note: 'Seed device 2' });
    await this.addAgent(e2.provisioning, { autoPull: true });
    await this.backend.logout(sid);
    this.saveAgents();
  }

  /** Used only for seeding: performs the real password + TOTP flow with the demo authenticator. */
  async signInDemo(role: Role): Promise<string> {
    const acc = this.demoAccounts.find((a) => a.role === role)!;
    const { challengeId } = await this.backend.login(acc.email, acc.password);
    return (await this.backend.verifyMfa(challengeId, await totp(acc.totpSecret, Date.now()))).sessionId;
  }

  // ---------------------------------------------------------------- simulators

  private loadAgents() {
    let states: AgentState[] = [];
    try {
      states = JSON.parse(safeGet(ls, AGENTS_KEY) ?? '[]');
    } catch {
      states = [];
    }
    for (const s of states) this.agents.set(s.simId, new SimulatedAgent(s, this.backend));
  }

  reloadAgents() {
    this.agents.clear();
    this.loadAgents();
    this.emit();
  }

  saveAgents() {
    safeSet(ls, AGENTS_KEY, JSON.stringify([...this.agents.values()].map((a) => a.state)));
    this.emit();
  }

  async addAgent(provisioning: ProvisioningPayload, opts: { autoPull?: boolean } = {}): Promise<SimulatedAgent> {
    const agent = new SimulatedAgent(newAgentFromProvisioning(provisioning, { autoPull: opts.autoPull ?? true }), this.backend);
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

  // ---------------------------------------------------------------- session

  get sessionId(): string | null {
    return safeGet(ss, SESSION_KEY);
  }
  set sessionId(v: string | null) {
    if (v) safeSet(ss, SESSION_KEY, v);
    else safeRemove(ss, SESSION_KEY);
    this.emit();
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
    if (this.timer) clearInterval(this.timer);
    for (const k of [STATE_KEY, AGENTS_KEY, DEMO_KEY]) safeRemove(ls, k);
    safeRemove(ss, SESSION_KEY);
  }
}
