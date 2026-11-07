/**
 * SimulatedAgent — behaves like the Android device-owner agent (Phase 3) so
 * the relay, signing, enrolment and transparency rules can be exercised
 * without a phone. It talks to the backend only through the device API and
 * JSON round-trips every message, exactly as a network client would.
 *
 * Transparency is built in, not configurable: there is no flag anywhere in
 * this class that suppresses the managed-device disclosure, the per-fix
 * notification or the persistent Tier 3 notification.
 */
import { Backend, withinWorkingHours } from './backend';
import { CommandVerifier, type VerifyFailure } from './commands';
import { fingerprint, generateEd25519, randomId, signEd25519 } from './crypto';
import { COLLECTION_NOTICE } from './enrollment';
import type { DeviceCertificate, DevicePolicy, LocationFix, ProvisioningPayload, SignedCommand, Telemetry } from './types';
import { LocalDeviceTransport, type DeviceSigner, type DeviceTransport } from '../api/device';

export interface AgentNotification {
  id: string;
  at: number;
  channel: 'location_request' | 'lost_mode' | 'continuous_location' | 'management';
  importance: 'high' | 'low';
  title: string;
  text: string;
  persistent: boolean;
  link?: string;
}

export interface AgentState {
  simId: string;
  hardware: { serial: string; model: string; os: string };
  provisioning: { serverUrl: string; token: string; serverPin: string };
  keys?: { secretKey: string; publicKey: string };
  deviceId?: string;
  cert?: DeviceCertificate;
  certSig?: string;
  serverPublicKey?: string;
  acknowledgedAt?: number;
  ackSent?: boolean;
  policy?: DevicePolicy;
  lostMode: boolean;
  lostMessage?: string;
  locked: boolean;
  wiped: boolean;
  installedApps: string[];
  seen: { ids: string[]; nonces: string[] };
  notifications: AgentNotification[];
  log: { at: number; text: string }[];
  home: { lat: number; lng: number };
  battery: number;
  transparencyUrl?: string;
  lastEnvelope?: SignedCommand;
  lastContinuousAt?: number;
  lastLostFixAt?: number;
  /** simulator setting: pull automatically when a push wake arrives */
  autoPull?: boolean;
  /** management released and the agent uninstalled (RELEASE) */
  released?: boolean;
}

export class PinMismatchError extends Error {
  constructor() {
    super('Server key does not match the pinned fingerprint — refusing to enrol');
    this.name = 'PinMismatchError';
  }
}

const MODELS = ['Pixel 9', 'Galaxy A56', 'Galaxy XCover7 Pro', 'Moto g85', 'Pixel 8a'];

export function newAgentFromProvisioning(payload: ProvisioningPayload, seed?: Partial<AgentState>): AgentState {
  const extras = payload['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'];
  if (!extras?.token || !extras.serverPin) throw new Error('Provisioning payload is missing the admin extras bundle');
  const model = MODELS[Math.floor(Math.random() * MODELS.length)];
  return {
    simId: randomId('sim', 6),
    hardware: { serial: `R${Math.random().toString(36).slice(2, 12).toUpperCase()}`, model, os: 'Android 16' },
    provisioning: { serverUrl: extras.serverUrl, token: extras.token, serverPin: extras.serverPin },
    lostMode: false,
    locked: false,
    wiped: false,
    installedApps: [],
    seen: { ids: [], nonces: [] },
    notifications: [],
    log: [],
    // Simulated position somewhere in Colombo.
    home: { lat: 6.9271 + (Math.random() - 0.5) * 0.08, lng: 79.8612 + (Math.random() - 0.5) * 0.08 },
    battery: 40 + Math.floor(Math.random() * 60),
    ...seed,
  };
}

/** Round-trip through JSON: nothing is shared by reference between "device" and "server". */
function wire<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export class SimulatedAgent {
  private readonly t: DeviceTransport;
  private readonly clock: () => number;

  /** Accepts the in-browser backend (demo) or any DeviceTransport (e.g. a real server over HTTP). */
  constructor(public state: AgentState, target: Backend | DeviceTransport, clock?: () => number) {
    if (target instanceof Backend) {
      this.clock = clock ?? (() => target.now());
      this.t = new LocalDeviceTransport(target, this.clock);
    } else {
      this.clock = clock ?? (() => Date.now());
      this.t = target;
    }
  }

  private log(text: string) {
    this.state.log.unshift({ at: this.clock(), text });
    this.state.log = this.state.log.slice(0, 60);
  }

  private notify(n: Omit<AgentNotification, 'id' | 'at'>): AgentNotification {
    const full: AgentNotification = { id: randomId('n', 6), at: this.clock(), ...n };
    if (n.persistent) this.state.notifications = this.state.notifications.filter((x) => !(x.persistent && x.channel === n.channel));
    this.state.notifications.unshift(full);
    this.state.notifications = this.state.notifications.slice(0, 30);
    return full;
  }

  get enrolled(): boolean {
    return !!this.state.deviceId && !this.state.wiped && !this.state.released;
  }

  private signer(): DeviceSigner {
    const s = this.state;
    if (!s.keys || !s.cert || !s.certSig || !s.deviceId) throw new Error('Agent is not enrolled');
    const sk = s.keys.secretKey;
    return { deviceId: s.deviceId, cert: s.cert, certSig: s.certSig, sign: (m) => signEd25519(m, sk) };
  }

  private call<T>(method: 'GET' | 'POST', path: string, body: unknown = null): Promise<T> {
    return this.t.request<T>(method, path, body, this.signer());
  }

  /** POST /v1/enroll. The keypair is generated on the device (Android Keystore in the real agent). */
  async enroll(): Promise<void> {
    const keys = await generateEd25519();
    const res = await this.t.enroll({ token: this.state.provisioning.token, devicePublicKey: keys.publicKey, platform: 'android', hardware: this.state.hardware });
    // Certificate pinning: the server key must match the fingerprint delivered in the QR.
    if ((await fingerprint(res.serverPublicKey)) !== this.state.provisioning.serverPin) throw new PinMismatchError();
    this.state.keys = keys;
    this.state.deviceId = res.deviceId;
    this.state.cert = res.cert;
    this.state.certSig = res.certSig;
    this.state.serverPublicKey = res.serverPublicKey;
    this.state.policy = res.policy;
    this.state.transparencyUrl = res.transparencyUrl;
    this.state.provisioning.token = ''; // one-time token is discarded
    this.notify({
      channel: 'management',
      importance: 'low',
      title: 'This device is managed by your organisation',
      text: 'Your IT admin can see device health and, when needed, its location. Tap to see what is collected.',
      persistent: false,
    });
    this.log(`Enrolled as ${res.deviceId}; certificate ${res.cert.serial} issued; server key pin verified`);
  }

  /** The user reads the notice and taps "I understand" (Non-negotiable #1). */
  acknowledge(): void {
    this.state.acknowledgedAt = this.clock();
    this.log(`Notice ${COLLECTION_NOTICE.version} acknowledged by the user`);
  }

  private telemetry(): Telemetry {
    this.state.battery = Math.max(5, Math.min(100, this.state.battery + (Math.random() > 0.5 ? 1 : -2)));
    return {
      batteryLevel: this.state.battery,
      batteryHealth: 'good',
      batteryTempC: 28 + Math.round(Math.random() * 8),
      storageFreeGb: 41.2,
      storageTotalGb: 128,
      integrity: 'MEETS_DEVICE_INTEGRITY',
      patchLevel: '2026-10-05',
    };
  }

  async checkin(): Promise<void> {
    if (!this.enrolled) throw new Error('Not enrolled');
    const body = {
      telemetry: this.telemetry(),
      ...this.state.hardware,
      ...(this.state.acknowledgedAt && !this.state.ackSent ? { policyAck: { version: COLLECTION_NOTICE.version, at: this.state.acknowledgedAt } } : {}),
    };
    const res = await this.call<{ state: string; pendingCommands: number; transparencyUrl: string }>('POST', '/v1/checkin', body);
    if ('policyAck' in body) this.state.ackSent = true;
    this.state.transparencyUrl = res.transparencyUrl;
    this.log(`Checked in (state ${res.state}, ${res.pendingCommands} pending)`);
  }

  private makeFix(tier: 1 | 2 | 3, notificationAt: number, channel: string, text: string): LocationFix {
    const jitter = () => (Math.random() - 0.5) * 0.002;
    return {
      lat: +(this.state.home.lat + jitter()).toFixed(6),
      lng: +(this.state.home.lng + jitter()).toFixed(6),
      accuracyM: 5 + Math.round(Math.random() * 25),
      fixAt: this.clock(),
      source: 'fused',
      tier,
      notification: { shownAt: notificationAt, channel, text },
    };
  }

  /** Verify a command exactly as the real agent does; exposed for tamper/replay demonstrations. */
  async verify(env: SignedCommand): Promise<{ ok: true } | { ok: false; reason: VerifyFailure }> {
    const v = new CommandVerifier(this.state.deviceId!, this.state.serverPublicKey!, this.state.seen);
    const r = await v.verify(wire(env), this.clock());
    if (r.ok) this.state.seen = v.snapshot();
    return r.ok ? { ok: true } : r;
  }

  /** Wake → pull → verify → execute → post result. Returns per-command outcomes. */
  async poll(): Promise<{ id: string; type: string; outcome: string }[]> {
    if (!this.enrolled) return [];
    const cmds = await this.call<SignedCommand[]>('GET', '/v1/commands/pending');
    const outcomes: { id: string; type: string; outcome: string }[] = [];
    for (const env of cmds) {
      const v = await this.verify(env);
      if (!v.ok) {
        // A replay of an id we already executed is simply skipped (idempotency); anything else is reported.
        if (v.reason !== 'replayed') {
          await this.postResult(env.payload.id, { status: 'rejected', detail: `Agent rejected command: ${v.reason}` });
        }
        this.log(`Rejected ${env.payload.type}: ${v.reason}`);
        outcomes.push({ id: env.payload.id, type: env.payload.type, outcome: `rejected:${v.reason}` });
        continue;
      }
      this.state.lastEnvelope = env;
      const outcome = await this.execute(env);
      outcomes.push({ id: env.payload.id, type: env.payload.type, outcome });
      if (this.state.wiped) break;
    }
    return outcomes;
  }

  private async postResult(id: string, body: { status: 'succeeded' | 'failed' | 'rejected'; detail?: string; location?: LocationFix }) {
    await this.call('POST', `/v1/commands/${id}/result`, body);
  }

  private transparencyLink(): string | undefined {
    return this.state.transparencyUrl;
  }

  private async execute(env: SignedCommand): Promise<string> {
    const p = env.payload;
    const needsAck = p.type === 'LOCATE' || p.type === 'LOST_MODE_ON';
    if (needsAck && !this.state.acknowledgedAt) {
      await this.postResult(p.id, { status: 'rejected', detail: 'User has not acknowledged the device notice' });
      this.log(`Refused ${p.type}: notice not acknowledged`);
      return 'rejected:not_acknowledged';
    }
    switch (p.type) {
      case 'LOCATE': {
        // The notification is posted BEFORE the fix is taken, every time.
        const n = this.notify({
          channel: 'location_request',
          importance: 'high',
          title: 'Your device location was requested',
          text: `Requested by your IT team for ticket ${p.ticket ?? '—'}. Tap to see all location requests.`,
          persistent: false,
          link: this.transparencyLink(),
        });
        const fix = this.makeFix(1, n.at, n.channel, n.text);
        await this.postResult(p.id, { status: 'succeeded', detail: 'Fix via FusedLocationProvider (high accuracy)', location: fix });
        this.log(`LOCATE ${p.ticket}: fix sent, notification shown`);
        return 'succeeded';
      }
      case 'LOST_MODE_ON': {
        this.state.lostMode = true;
        this.state.lostMessage = String(p.params.message ?? '');
        const n = this.notify({
          channel: 'lost_mode',
          importance: 'high',
          title: 'Lost Mode is on',
          text: `Your organisation put this device in Lost Mode (ticket ${p.ticket ?? '—'}). Its location is shared every 5 minutes until Lost Mode ends.`,
          persistent: true,
          link: this.transparencyLink(),
        });
        this.state.lastLostFixAt = this.clock();
        await this.postResult(p.id, { status: 'succeeded', detail: 'Lost Mode screen shown', location: this.makeFix(2, n.at, n.channel, n.text) });
        this.log('Lost Mode enabled');
        return 'succeeded';
      }
      case 'LOST_MODE_OFF': {
        this.state.lostMode = false;
        this.state.notifications = this.state.notifications.filter((x) => x.channel !== 'lost_mode' || !x.persistent);
        this.notify({ channel: 'management', importance: 'low', title: 'Lost Mode ended', text: 'Location sharing for Lost Mode has stopped.', persistent: false });
        await this.postResult(p.id, { status: 'succeeded', detail: 'Lost Mode disabled' });
        return 'succeeded';
      }
      case 'LOCK':
        this.state.locked = true;
        await this.postResult(p.id, { status: 'succeeded', detail: 'Device locked (lockNow)' });
        return 'succeeded';
      case 'REBOOT':
        await this.postResult(p.id, { status: 'succeeded', detail: 'Reboot scheduled' });
        this.state.locked = true;
        return 'succeeded';
      case 'SYNC_POLICY': {
        const res = await this.call<{ policy: DevicePolicy; transparencyUrl: string }>('GET', '/v1/policy');
        this.state.policy = res.policy;
        this.state.transparencyUrl = res.transparencyUrl;
        await this.postResult(p.id, { status: 'succeeded', detail: `Policy v${res.policy.version} applied` });
        return 'succeeded';
      }
      case 'INSTALL_APP': {
        const pkg = String(p.params.packageName);
        if (!this.state.installedApps.includes(pkg)) this.state.installedApps.push(pkg);
        await this.postResult(p.id, { status: 'succeeded', detail: `Installed ${pkg}` });
        return 'succeeded';
      }
      case 'RELEASE': {
        // Report first: once uninstalled there is no agent left to report.
        await this.postResult(p.id, { status: 'succeeded', detail: 'Restrictions cleared, device owner released, agent uninstalled' });
        this.state.released = true;
        this.state.lostMode = false;
        this.state.locked = false;
        this.state.notifications = [
          {
            id: randomId('n', 6),
            at: this.clock(),
            channel: 'management',
            importance: 'low',
            title: 'This phone is no longer managed',
            text: `${String(p.params.orgName ?? 'Your organisation')} removed this phone from management. The management app has been uninstalled and nothing is collected any more.`,
            persistent: false,
          },
        ];
        this.state.keys = undefined;
        this.log('Management released; agent uninstalled itself');
        return 'succeeded';
      }
      case 'WIPE':
        await this.postResult(p.id, { status: 'succeeded', detail: 'Factory reset initiated' });
        this.state.wiped = true;
        this.state.notifications = [];
        this.log('Device wiped — agent and keys erased');
        return 'succeeded';
      default:
        // No remote shell, screen capture, or data access exists on this agent.
        await this.postResult((p as { id: string }).id, { status: 'rejected', detail: 'Unsupported command' });
        return 'rejected:unsupported';
    }
  }

  /** Periodic work: Tier 2 every 5 min in Lost Mode; Tier 3 (if policy) every ≥15 min in working hours. */
  async tick(): Promise<void> {
    if (!this.enrolled) return;
    const now = this.clock();
    const fixes: LocationFix[] = [];
    if (this.state.lostMode && now - (this.state.lastLostFixAt ?? 0) >= 5 * 60_000) {
      const n = this.notify({ channel: 'lost_mode', importance: 'high', title: 'Lost Mode is on', text: 'Location shared with your organisation (Lost Mode).', persistent: true, link: this.transparencyLink() });
      fixes.push(this.makeFix(2, n.at, n.channel, n.text));
      this.state.lastLostFixAt = now;
    }
    const pol = this.state.policy;
    const inHours = !!pol && pol.continuousLocation && !!this.state.acknowledgedAt && withinWorkingHours(pol, now);
    if (inHours) {
      // Foreground-service notification — present for as long as Tier 3 runs.
      const n = this.notify({
        channel: 'continuous_location',
        importance: 'low',
        title: 'Work location sharing is on',
        text: `Shared every ${pol!.continuousIntervalMin} min during working hours. Tap for details.`,
        persistent: true,
        link: this.transparencyLink(),
      });
      if (now - (this.state.lastContinuousAt ?? 0) >= pol!.continuousIntervalMin * 60_000) {
        fixes.push(this.makeFix(3, n.at, n.channel, n.text));
        this.state.lastContinuousAt = now;
      }
    } else {
      this.state.notifications = this.state.notifications.filter((x) => x.channel !== 'continuous_location');
    }
    if (fixes.length) {
      const body = { fixes };
      const r = await this.call<{ accepted: number; rejected: number }>('POST', '/v1/location/batch', body);
      this.log(`Location batch: ${r.accepted} accepted, ${r.rejected} rejected`);
    }
  }
}
