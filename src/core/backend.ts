/**
 * Backend — the reference implementation of the API surface in build-prompt
 * section 3.3 (device, enrolment and admin routes), running in-process.
 *
 * On GitHub Pages it runs in the browser so the whole service can be used
 * end-to-end; the same contract is what the Cloudflare Worker implements in
 * production. Every authorisation decision is made HERE, never in the UI.
 */
import { AuditLog, verifyChain, type AuditRow, type ChainVerification } from './audit';
import { signCommand } from './commands';
import {
  canonicalJson,
  fingerprint,
  generateAesKey,
  generateEd25519,
  hashPassword,
  openJson,
  randomBytes,
  randomId,
  sealJson,
  sha256Hex,
  signEd25519,
  timingSafeEqual,
  toHex,
  verifyEd25519,
  verifyEs256,
  isP256Spki,
} from './crypto';
import { buildProvisioningPayload, COLLECTION_NOTICE, defaultPolicy, ENROLLMENT_TTL_MS } from './enrollment';
import {
  assertCan,
  can,
  DUAL_CONTROL,
  ForbiddenError,
  isCommandType,
  isRole,
  TICKET_REQUIRED,
  type CommandType,
  type Role,
} from './rbac';
import { detectThreats, riskBand, riskScore, SEVERITIES, THREATS, type RiskBand, type ThreatCategory, type ThreatDef } from './threats';
import { DeviceRelay, StubPushProvider, withDeviceLock, type PushProvider } from './relay';
import { base32Encode, verifyTotp } from './totp';
import type {
  BackendState,
  CommandRecord,
  Device,
  DeviceAuth,
  DeviceCertificate,
  DevicePolicy,
  Employee,
  EnrollmentToken,
  Incident,
  Platform,
  SecurityPosture,
  ThreatEvent,
  ThreatSeverity,
  ThreatState,
  AppCatalogEntry,
  OrgSettings,
  LocationFix,
  ProvisioningPayload,
  PublicUser,
  Session,
  SignedCommand,
  StoredLocation,
  Telemetry,
  User, ManagementMode, DeviceCapabilities } from './types';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const LOCATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_REQUEST_WINDOW_MS = 5 * 60 * 1000;
export const CERT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** completed command history kept for 180 days (audit rows are kept independently) */
export const COMMAND_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const STALE_CHECKIN_MS = 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Store {
  load(): BackendState | null;
  save(state: BackendState): void;
  clear(): void;
}

export class MemoryStore implements Store {
  private data: string | null = null;
  load() {
    return this.data ? (JSON.parse(this.data) as BackendState) : null;
  }
  save(s: BackendState) {
    this.data = JSON.stringify(s);
  }
  clear() {
    this.data = null;
  }
}

export interface DemoAccount {
  email: string;
  password: string;
  role: Role;
  name: string;
  totpSecret: string;
}

export interface BackendOptions {
  store: Store;
  clock?: () => number;
  apiBaseUrl?: string;
  /** PBKDF2 iterations (lower only in tests) */
  pbkdf2Iterations?: number;
  push?: PushProvider;
  /** SHA-256 (URL-safe base64) of the agent APK signing certificate, for the provisioning QR */
  apkSignatureChecksum?: string;
  apkVersion?: string;
  apkDownloadUrl?: string;
  /** called for every audit row (e.g. forward to a SIEM) */
  onAudit?: (row: AuditRow) => void;
}

/** Simple fixed-window rate limiter (stands in for Cloudflare WAF rate-limit rules). */
class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  check(key: string, now: number): void {
    const h = this.hits.get(key);
    if (!h || now - h.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      return;
    }
    h.count++;
    if (h.count > this.limit) throw new ApiError(429, 'rate_limited', 'Too many requests, slow down');
  }
}

export interface DeviceView extends Omit<Device, 'transparencyKey' | 'cert'> {
  displayName: string;
  certSerial: string;
  certNotAfter: number;
  assignedUser: Employee | null;
  queuedCommands: number;
  /** open lost/stolen incident (no coordinates) */
  activeIncident: Pick<Incident, 'id' | 'kind' | 'ticket' | 'startedAt' | 'trackingUntil' | 'trackingIntervalSec'> | null;
  /** Threat posture: open threats (accepted ones listed but not scored) and the resulting risk score. */
  risk: { score: number; band: RiskBand; threats: DeviceThreat[] };
}

export interface DeviceThreat extends ThreatDef {
  detail: string;
  firstSeen: number;
  accepted: { by: string; byName: string; at: number; until: number; reason: string } | null;
}

export interface ThreatLandscape {
  generatedAt: number;
  score: number;
  band: RiskBand;
  devices: number;
  devicesAtRisk: number;
  counts: Record<ThreatSeverity, number>;
  accepted: number;
  resolved7d: number;
  detected7d: number;
  byCategory: { category: ThreatCategory; count: number; worst: ThreatSeverity }[];
  byPlatform: { platform: Platform; devices: number; atRisk: number; threats: number }[];
  byThreat: { key: string; title: string; severity: ThreatSeverity; category: ThreatCategory; devices: number }[];
  threats: (DeviceThreat & { deviceId: string; deviceName: string; platform: Platform })[];
  topDevices: { deviceId: string; deviceName: string; platform: Platform; score: number; band: RiskBand; open: number; worst: ThreatSeverity | null }[];
  events: (ThreatEvent & { deviceName: string; title: string })[];
  history: ThreatState['history'];
}

export interface LocationView {
  id: string;
  deviceId: string;
  deviceName: string;
  commandId: string | null;
  ticket: string | null;
  tier: 1 | 2 | 3;
  receivedAt: number;
  fix: LocationFix;
}

export function displayName(d: Pick<Device, 'label'>): string {
  return d.label?.trim() ? d.label : 'Unnamed device';
}

export class Backend {
  private state!: BackendState;
  private audit!: AuditLog;
  private commandsById = new Map<string, CommandRecord>();
  private readonly clock: () => number;
  private readonly iterations: number;
  readonly apiBaseUrl: string;
  readonly push: PushProvider;
  private listeners = new Set<() => void>();
  private loginLimiter = new RateLimiter(10, 60_000);
  private enrollLimiter = new RateLimiter(20, 60_000);
  private publicLimiter = new RateLimiter(60, 60_000);
  /** demo credentials are only kept in memory right after seeding, so the sign-in page can show them */
  demoAccounts: DemoAccount[] = [];

  private constructor(private readonly opts: BackendOptions) {
    this.clock = opts.clock ?? (() => Date.now());
    this.iterations = opts.pbkdf2Iterations ?? 210_000;
    this.apiBaseUrl = opts.apiBaseUrl ?? 'https://mdm.example.com';
    this.push = opts.push ?? new StubPushProvider((w) => this.state.wakes.push(w), this.clock);
  }

  static async open(opts: BackendOptions): Promise<Backend> {
    const b = new Backend(opts);
    const loaded = opts.store.load();
    if (loaded && loaded.schema === 1) {
      b.attach(loaded);
    } else {
      await b.initialise();
    }
    return b;
  }

  private attach(state: BackendState) {
    // Forward-compatible migration of older persisted state.
    state.settings ??= defaultSettings();
    state.incidents ??= [];
    state.settings.apps ??= [];
    this.state = state;
    this.audit = new AuditLog(state.audit, this.opts.onAudit);
    this.commandsById = new Map(state.commands.map((c) => [c.id, c]));
  }

  private async initialise() {
    const now = this.clock();
    const cmdKey = await generateEd25519();
    const caKey = await generateEd25519();
    this.attach({
      schema: 1,
      createdAt: now,
      keys: {
        commandSigning: { kid: `cmd-${now}`, ...cmdKey },
        deviceCa: { kid: `ca-${now}`, ...caKey },
        locationKey: await generateAesKey(),
      },
      users: [],
      sessions: [],
      mfa: [],
      employees: [],
      devices: [],
      enrollments: [],
      commands: [],
      relayQueues: {},
      locations: [],
      wakes: [],
      deviceNonces: {},
      audit: [],
      lastPurgeAt: null,
    });
    await this.audit.append({ at: now, actor: 'system', actorRole: 'SYSTEM', action: 'system.initialised' });
    this.persist();
  }

  // ------------------------------------------------------------------ infra

  /** Re-read state written by another tab (the Durable Object analogue: one source of truth). */
  reloadFromStore(): void {
    const loaded = this.opts.store.load();
    if (loaded && loaded.schema === 1) {
      this.attach(loaded);
      for (const l of this.listeners) l();
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist() {
    this.opts.store.save(this.state);
    for (const l of this.listeners) l();
  }

  now(): number {
    return this.clock();
  }

  /** Public half of the command-signing key; agents pin its fingerprint. */
  serverPublicKey(): string {
    return this.state.keys.commandSigning.publicKey;
  }

  serverPin(): Promise<string> {
    return fingerprint(this.state.keys.commandSigning.publicKey);
  }

  // ------------------------------------------------------------------ seeding

  async createUser(input: { name: string; email: string; role: Role; password: string }, actor = 'system'): Promise<DemoAccount> {
    if (!isRole(input.role)) throw new ApiError(422, 'invalid_role', 'Unknown role');
    const email = input.email.trim().toLowerCase();
    if (this.state.users.some((u) => u.email === email)) throw new ApiError(409, 'exists', 'User already exists');
    if (input.password.length < 12) throw new ApiError(422, 'weak_password', 'Password must be at least 12 characters');
    const salt = toHex(randomBytes(16));
    const totpSecret = base32Encode(randomBytes(20));
    const user: User = {
      id: randomId('usr', 9),
      name: input.name,
      email,
      role: input.role,
      salt,
      passwordHash: await hashPassword(input.password, salt, this.iterations),
      totpSecret,
      disabled: false,
      failedLogins: 0,
    };
    this.state.users.push(user);
    await this.audit.append({ at: this.clock(), actor, actorRole: 'SYSTEM', action: 'user.created', target: user.id, detail: { role: user.role } });
    this.persist();
    return { email, password: input.password, role: input.role, name: input.name, totpSecret };
  }

  addEmployee(e: Omit<Employee, 'id'>): Employee {
    const emp = { id: randomId('emp', 6), ...e };
    this.state.employees.push(emp);
    this.persist();
    return emp;
  }

  // ------------------------------------------------------------------ admin auth

  /** Step 1: password. Returns an MFA challenge; never a session directly. */
  async login(emailRaw: string, password: string): Promise<{ challengeId: string }> {
    const now = this.clock();
    const email = String(emailRaw).trim().toLowerCase();
    this.loginLimiter.check(email, now);
    const user = this.state.users.find((u) => u.email === email);
    // Always hash, even for unknown users, so timing does not reveal account existence.
    const hash = await hashPassword(String(password), user?.salt ?? '00'.repeat(16), this.iterations);
    if (!user || user.disabled) {
      await this.audit.append({ at: now, actor: email, actorRole: 'ANON', action: 'auth.login_failed', detail: { reason: 'unknown_or_disabled' } });
      this.persist();
      throw new ApiError(401, 'invalid_credentials', 'Invalid e-mail or password');
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new ApiError(423, 'locked', 'Account temporarily locked after repeated failures');
    }
    if (!timingSafeEqual(hash, user.passwordHash)) {
      user.failedLogins++;
      if (user.failedLogins >= MAX_FAILED_LOGINS) {
        user.lockedUntil = now + LOCKOUT_MS;
        user.failedLogins = 0;
      }
      await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'auth.login_failed', detail: { reason: 'bad_password' } });
      this.persist();
      throw new ApiError(401, 'invalid_credentials', 'Invalid e-mail or password');
    }
    const challenge = { id: randomId('mfa'), userId: user.id, expiresAt: now + 5 * 60_000, attempts: 0 };
    this.state.mfa = this.state.mfa.filter((m) => m.expiresAt > now);
    this.state.mfa.push(challenge);
    this.persist();
    return { challengeId: challenge.id };
  }

  /** Step 2: TOTP. Returns the session id (kept server-side; the client only holds the opaque id). */
  async verifyMfa(challengeId: string, code: string): Promise<{ sessionId: string; user: PublicUser }> {
    const now = this.clock();
    const ch = this.state.mfa.find((m) => m.id === challengeId);
    if (!ch || ch.expiresAt < now) throw new ApiError(401, 'mfa_expired', 'Sign-in expired, start again');
    const user = this.state.users.find((u) => u.id === ch.userId)!;
    ch.attempts++;
    if (!(await verifyTotp(user.totpSecret, String(code).trim(), now))) {
      if (ch.attempts >= 5) this.state.mfa = this.state.mfa.filter((m) => m.id !== ch.id);
      await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'auth.mfa_failed' });
      this.persist();
      throw new ApiError(401, 'mfa_invalid', 'Invalid authentication code');
    }
    this.state.mfa = this.state.mfa.filter((m) => m.id !== ch.id);
    user.failedLogins = 0;
    const session: Session = { id: randomId('ses', 24), userId: user.id, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_ABSOLUTE_MS };
    this.state.sessions = this.state.sessions.filter((s) => s.expiresAt > now && now - s.lastSeenAt < SESSION_IDLE_MS);
    this.state.sessions.push(session);
    await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'auth.login' });
    this.persist();
    return { sessionId: session.id, user: publicUser(user) };
  }

  /**
   * SSO sign-in (Cloudflare Access / OIDC). The identity provider has already
   * enforced authentication + MFA; we only map the verified e-mail to a console user.
   */
  async ssoLogin(emailRaw: string, provider: string): Promise<{ sessionId: string; user: PublicUser }> {
    const now = this.clock();
    const email = String(emailRaw).trim().toLowerCase();
    const user = this.state.users.find((u) => u.email === email);
    if (!user || user.disabled) {
      this.audit.append({ at: now, actor: email, actorRole: 'ANON', action: 'auth.sso_denied', detail: { provider } });
      this.persist();
      throw new ApiError(403, 'not_provisioned', 'Your account is not provisioned in this console');
    }
    const session: Session = { id: randomId('ses', 24), userId: user.id, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_ABSOLUTE_MS };
    this.state.sessions = this.state.sessions.filter((s) => s.expiresAt > now && now - s.lastSeenAt < SESSION_IDLE_MS);
    this.state.sessions.push(session);
    this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'auth.login', detail: { method: 'sso', provider } });
    this.persist();
    return { sessionId: session.id, user: publicUser(user) };
  }

  siemWebhookUrl(): string | undefined {
    return this.state.settings?.siemWebhookUrl;
  }

  /** Push tokens that look real (the placeholder minted at enrolment is skipped by push providers). */
  pushTargetsFor(deviceId: string): { platform: Device['platform']; token: string } | null {
    const d = this.state.devices.find((x) => x.id === deviceId);
    return d ? { platform: d.platform, token: d.pushToken } : null;
  }

  async logout(sessionId: string): Promise<void> {
    const s = this.state.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const user = this.state.users.find((u) => u.id === s.userId);
    this.state.sessions = this.state.sessions.filter((x) => x.id !== sessionId);
    await this.audit.append({ at: this.clock(), actor: s.userId, actorRole: user?.role ?? '?', action: 'auth.logout' });
    this.persist();
  }

  private requireSession(sessionId: string | null | undefined): { user: User; session: Session } {
    const now = this.clock();
    const session = sessionId ? this.state.sessions.find((s) => s.id === sessionId) : undefined;
    if (!session || session.expiresAt < now || now - session.lastSeenAt > SESSION_IDLE_MS) {
      throw new ApiError(401, 'unauthenticated', 'Session expired — please sign in again');
    }
    const user = this.state.users.find((u) => u.id === session.userId);
    if (!user || user.disabled) throw new ApiError(401, 'unauthenticated', 'Account disabled');
    session.lastSeenAt = now;
    return { user, session };
  }

  private guard(user: User, perm: Parameters<typeof assertCan>[1]) {
    try {
      assertCan(user.role, perm);
    } catch (e) {
      if (e instanceof ForbiddenError) {
        // Denials are security-relevant: record them (fire and forget ordering is preserved by the chain).
        this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'access.denied', detail: { permission: perm } });
        this.persist();
        throw new ApiError(403, 'forbidden', `Your role (${user.role}) is not allowed to do this (${perm})`);
      }
      throw e;
    }
  }

  me(sessionId: string): PublicUser {
    return publicUser(this.requireSession(sessionId).user);
  }

  // ------------------------------------------------------------------ admin: users & roles

  /** GET /admin/roles */
  listUsers(sessionId: string): PublicUser[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'roles.read');
    return this.state.users.map(publicUser);
  }

  async setUserRole(sessionId: string, userId: string, role: Role): Promise<PublicUser> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'roles.manage');
    if (!isRole(role)) throw new ApiError(422, 'invalid_role', 'Unknown role');
    if (userId === user.id) throw new ApiError(409, 'self_change', 'Separation of duties: you cannot change your own role');
    const target = this.state.users.find((u) => u.id === userId);
    if (!target) throw new ApiError(404, 'not_found', 'User not found');
    if (target.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN' && this.state.users.filter((u) => u.role === 'SUPER_ADMIN' && !u.disabled).length <= 1) {
      throw new ApiError(409, 'last_admin', 'Cannot demote the last Super Admin');
    }
    const from = target.role;
    target.role = role;
    // Role change revokes the target's sessions so the new role applies immediately.
    this.state.sessions = this.state.sessions.filter((s) => s.userId !== target.id);
    await this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'user.role_changed', target: target.id, detail: { from, to: role } });
    this.persist();
    return publicUser(target);
  }

  listEmployees(sessionId: string): Employee[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    return [...this.state.employees];
  }

  // ------------------------------------------------------------------ admin: devices

  // ------------------------------------------------------------------ threat detection

  private get threatState(): ThreatState {
    return (this.state.threats ??= { records: {}, events: [], history: [] });
  }

  /** Re-evaluates one device's threats; records detections and resolutions. Returns true if anything changed. */
  private syncThreats(d: Device): boolean {
    const now = this.clock();
    const ts = this.threatState;
    const recs = (ts.records[d.id] ??= {});
    const found = detectThreats(d, now, { commands: this.state.commands, incidents: this.state.incidents ?? [] });
    let changed = false;
    const event = (key: string, kind: ThreatEvent['kind']) => {
      ts.events.push({ at: now, deviceId: d.id, key, kind, severity: THREATS[key].severity });
      if (ts.events.length > 1000) ts.events.splice(0, ts.events.length - 1000);
      changed = true;
    };
    for (const f of found) {
      const r = recs[f.key];
      if (!r || r.resolvedAt !== null) {
        recs[f.key] = { firstSeen: now, lastSeen: now, resolvedAt: null, detail: f.detail, accepted: null };
        event(f.key, 'detected');
      } else {
        r.lastSeen = now;
        if (r.detail !== f.detail) (r.detail = f.detail), (changed = true);
        if (r.accepted && r.accepted.until < now) (r.accepted = null), event(f.key, 'reopened');
      }
    }
    for (const [key, r] of Object.entries(recs)) {
      if (r.resolvedAt === null && !found.some((f) => f.key === key)) {
        r.resolvedAt = now;
        event(key, 'resolved');
      }
    }
    return changed;
  }

  /** Re-evaluates the whole fleet (time-based rules such as patch age and silence) and stores today's snapshot. */
  private refreshThreats() {
    let changed = false;
    for (const d of this.state.devices) changed = this.syncThreats(d) || changed;
    const day = new Date(this.clock()).toISOString().slice(0, 10);
    const live = this.state.devices.filter((d) => !['retired', 'wiped', 'released'].includes(d.state));
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    let atRisk = 0;
    let total = 0;
    for (const d of live) {
      const r = this.riskOf(d);
      total += r.score;
      const open = r.threats.filter((t) => !t.accepted);
      if (open.length) atRisk++;
      for (const t of open) counts[t.severity]++;
    }
    const snap = { day, ...counts, devicesAtRisk: atRisk, devices: live.length, avgScore: live.length ? Math.round(total / live.length) : 0 };
    const h = this.threatState.history;
    const last = h[h.length - 1];
    if (last?.day === day) {
      if (JSON.stringify(last) !== JSON.stringify(snap)) (h[h.length - 1] = snap), (changed = true);
    } else {
      h.push(snap);
      if (h.length > 90) h.splice(0, h.length - 90);
      changed = true;
    }
    if (changed) this.persist();
  }

  private riskOf(d: Device): DeviceView['risk'] {
    const recs = this.state.threats?.records[d.id] ?? {};
    const threats: DeviceThreat[] = Object.entries(recs)
      .filter(([key, r]) => r.resolvedAt === null && THREATS[key])
      .map(([key, r]) => ({
        ...THREATS[key],
        detail: r.detail,
        firstSeen: r.firstSeen,
        accepted: r.accepted ? { ...r.accepted, byName: this.state.users.find((u) => u.id === r.accepted!.by)?.name ?? 'Unknown' } : null,
      }))
      .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
    const score = riskScore(threats.filter((t) => !t.accepted).map((t) => t.severity));
    return { score, band: riskBand(score), threats };
  }

  /** GET /admin/threats — the fleet's threat landscape. */
  getThreatLandscape(sessionId: string): ThreatLandscape {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'threat.read');
    this.refreshThreats();
    const now = this.clock();
    const live = this.state.devices.filter((d) => !['retired', 'wiped', 'released'].includes(d.state));
    const name = (id: string) => {
      const d = this.state.devices.find((x) => x.id === id);
      return d ? displayName(d) : 'Deleted device';
    };
    const threats: ThreatLandscape['threats'] = [];
    const topDevices: ThreatLandscape['topDevices'] = [];
    const platforms = new Map<Platform, { devices: number; atRisk: number; threats: number }>();
    let total = 0;
    for (const d of live) {
      const r = this.riskOf(d);
      const open = r.threats.filter((t) => !t.accepted);
      total += r.score;
      for (const t of r.threats) threats.push({ ...t, deviceId: d.id, deviceName: displayName(d), platform: d.platform });
      topDevices.push({ deviceId: d.id, deviceName: displayName(d), platform: d.platform, score: r.score, band: r.band, open: open.length, worst: open[0]?.severity ?? null });
      const p = platforms.get(d.platform) ?? { devices: 0, atRisk: 0, threats: 0 };
      p.devices++;
      if (open.length) p.atRisk++;
      p.threats += open.length;
      platforms.set(d.platform, p);
    }
    const open = threats.filter((t) => !t.accepted);
    const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<ThreatSeverity, number>;
    for (const t of open) counts[t.severity]++;
    const cats = new Map<ThreatCategory, { count: number; worst: ThreatSeverity }>();
    const kinds = new Map<string, number>();
    for (const t of open) {
      const c = cats.get(t.category);
      if (!c) cats.set(t.category, { count: 1, worst: t.severity });
      else {
        c.count++;
        if (SEVERITIES.indexOf(t.severity) < SEVERITIES.indexOf(c.worst)) c.worst = t.severity;
      }
      kinds.set(t.key, (kinds.get(t.key) ?? 0) + 1);
    }
    const week = now - 7 * 86_400_000;
    const ev = this.threatState.events;
    const score = live.length ? Math.round(total / live.length) : 0;
    // The fleet band follows the worst open threat as well as the average, so one compromised phone is never hidden.
    const worst = SEVERITIES.find((s) => counts[s] > 0);
    const order: RiskBand[] = ['secure', 'low', 'medium', 'high', 'critical'];
    const band = order[Math.max(order.indexOf(riskBand(score)), worst ? order.indexOf(worst) : 0)];
    return {
      generatedAt: now,
      score,
      band,
      devices: live.length,
      devicesAtRisk: topDevices.filter((d) => d.open > 0).length,
      counts,
      accepted: threats.length - open.length,
      resolved7d: ev.filter((e) => e.kind === 'resolved' && e.at >= week).length,
      detected7d: ev.filter((e) => e.kind === 'detected' && e.at >= week).length,
      byCategory: [...cats].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.count - a.count),
      byPlatform: [...platforms].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => b.devices - a.devices),
      byThreat: [...kinds].map(([key, devices]) => ({ key, title: THREATS[key].title, severity: THREATS[key].severity, category: THREATS[key].category, devices })).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.devices - a.devices),
      threats: threats.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.firstSeen - b.firstSeen),
      topDevices: topDevices.filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, 10),
      events: ev.slice(-60).reverse().map((e) => ({ ...e, deviceName: name(e.deviceId), title: THREATS[e.key]?.title ?? e.key })),
      history: this.threatState.history.slice(-30),
    };
  }

  /** POST /admin/devices/{id}/threats/{key}/accept — accept a known risk for a limited time, with a reason. */
  async acceptThreat(sessionId: string, deviceId: string, key: string, input: { reason: string; days?: number }): Promise<DeviceView> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'threat.manage');
    const d = this.findDevice(deviceId);
    const r = this.state.threats?.records[d.id]?.[key];
    if (!r || r.resolvedAt !== null) throw new ApiError(404, 'not_found', 'No open threat of that kind on this device');
    const reason = String(input.reason ?? '').trim();
    if (reason.length < 5) throw new ApiError(422, 'justification_required', 'Give a reason for accepting this risk');
    if (THREATS[key].severity === 'critical') throw new ApiError(422, 'not_acceptable', 'Critical threats cannot be accepted — remediate the device instead');
    const days = Math.min(90, Math.max(1, Math.round(Number(input.days) || 30)));
    const now = this.clock();
    r.accepted = { by: user.id, at: now, until: now + days * 86_400_000, reason: reason.slice(0, 300) };
    this.threatState.events.push({ at: now, deviceId: d.id, key, kind: 'accepted', severity: THREATS[key].severity });
    await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'threat.accepted', target: d.id, detail: { threat: key, days, reason: r.accepted.reason } });
    this.persist();
    return this.deviceView(d);
  }

  /** DELETE /admin/devices/{id}/threats/{key}/accept — withdraw an acceptance. */
  async reopenThreat(sessionId: string, deviceId: string, key: string): Promise<DeviceView> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'threat.manage');
    const d = this.findDevice(deviceId);
    const r = this.state.threats?.records[d.id]?.[key];
    if (!r?.accepted) throw new ApiError(404, 'not_found', 'This threat is not accepted');
    r.accepted = null;
    const now = this.clock();
    this.threatState.events.push({ at: now, deviceId: d.id, key, kind: 'reopened', severity: THREATS[key].severity });
    await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'threat.reopened', target: d.id, detail: { threat: key } });
    this.persist();
    return this.deviceView(d);
  }

  private deviceView(d: Device): DeviceView {
    const { transparencyKey: _t, cert, ...rest } = d;
    return {
      ...structuredClone(rest),
      displayName: displayName(d),
      certSerial: cert.serial,
      certNotAfter: cert.notAfter,
      assignedUser: this.state.employees.find((e) => e.id === d.assignedUserId) ?? null,
      queuedCommands: this.state.relayQueues[d.id]?.length ?? 0,
      risk: this.riskOf(d),
      activeIncident: (() => {
        const i = this.state.incidents!.find((x) => x.deviceId === d.id && x.status === 'active');
        return i ? { id: i.id, kind: i.kind, ticket: i.ticket, startedAt: i.startedAt, trackingUntil: i.trackingUntil, trackingIntervalSec: i.trackingIntervalSec } : null;
      })(),
    };
  }

  /** GET /admin/devices */
  listDevices(sessionId: string, filter: { q?: string; unnamedOnly?: boolean } = {}): DeviceView[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    this.refreshThreats();
    const q = filter.q?.trim().toLowerCase();
    return this.state.devices
      .filter((d) => (filter.unnamedOnly ? !d.label : true))
      .map((d) => this.deviceView(d))
      .filter((d) =>
        q ? [d.displayName, d.serial, d.model, d.id, d.assignedUser?.name, d.assetTag, ...(d.tags ?? [])].some((v) => v?.toLowerCase().includes(q)) : true,
      )
      .sort((a, b) => (b.lastCheckinAt ?? b.enrolledAt) - (a.lastCheckinAt ?? a.enrolledAt));
  }

  getDevice(sessionId: string, deviceId: string): DeviceView {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    const d = this.findDevice(deviceId);
    if (this.syncThreats(d)) this.persist();
    return this.deviceView(d);
  }

  private findDevice(id: string): Device {
    const d = this.state.devices.find((x) => x.id === id);
    if (!d) throw new ApiError(404, 'not_found', 'Device not found');
    return d;
  }

  /** PATCH /admin/devices/{id} — rename and assign to an employee. */
  async updateDevice(sessionId: string, deviceId: string, patch: { label?: string | null; assignedUserId?: string | null; tags?: string[]; assetTag?: string | null; notes?: string | null }): Promise<DeviceView> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.update');
    const d = this.findDevice(deviceId);
    const before = { label: d.label, assignedUserId: d.assignedUserId, tags: d.tags ?? [], assetTag: d.assetTag ?? null, notes: d.notes ?? null };
    if (patch.label !== undefined) {
      const label = patch.label === null ? null : String(patch.label).trim();
      if (label !== null && (label.length === 0 || label.length > 80)) throw new ApiError(422, 'invalid_label', 'Name must be 1–80 characters');
      if (label && /[<>]/.test(label)) throw new ApiError(422, 'invalid_label', 'Name contains invalid characters');
      d.label = label;
    }
    if (patch.assignedUserId !== undefined) {
      if (patch.assignedUserId !== null && !this.state.employees.some((e) => e.id === patch.assignedUserId)) {
        throw new ApiError(422, 'invalid_employee', 'Unknown employee');
      }
      d.assignedUserId = patch.assignedUserId;
    }
    if (patch.tags !== undefined) d.tags = cleanTags(patch.tags);
    if (patch.assetTag !== undefined) {
      const t = patch.assetTag === null ? '' : String(patch.assetTag).trim();
      if (t.length > 40 || /[<>]/.test(t)) throw new ApiError(422, 'invalid_asset_tag', 'Asset tag must be up to 40 characters');
      d.assetTag = t || null;
    }
    if (patch.notes !== undefined) {
      const n = patch.notes === null ? '' : String(patch.notes).trim();
      if (n.length > 500) throw new ApiError(422, 'invalid_notes', 'Notes must be up to 500 characters');
      d.notes = n || null;
    }
    await this.audit.append({
      at: this.clock(),
      actor: user.id,
      actorRole: user.role,
      action: 'device.updated',
      target: d.id,
      detail: { before, after: { label: d.label, assignedUserId: d.assignedUserId, tags: d.tags ?? [], assetTag: d.assetTag ?? null, notes: d.notes ?? null } },
    });
    this.persist();
    return this.deviceView(d);
  }

  async updatePolicy(sessionId: string, deviceId: string, patch: PolicyPatch, justification: string): Promise<DeviceView> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.policy');
    const d = this.findDevice(deviceId);
    if (!justification || justification.trim().length < 5) throw new ApiError(422, 'justification_required', 'A justification is required for policy changes');
    const next: DevicePolicy = { ...d.policy };
    if (patch.continuousLocation !== undefined) next.continuousLocation = !!patch.continuousLocation;
    if (patch.continuousIntervalMin !== undefined) {
      if (patch.continuousIntervalMin < 15) throw new ApiError(422, 'interval_too_short', 'Continuous location interval must be at least 15 minutes');
      next.continuousIntervalMin = Math.round(patch.continuousIntervalMin);
    }
    if (patch.workingHours) {
      const w = patch.workingHours;
      if (w.startHour < 0 || w.endHour > 24 || w.startHour >= w.endHour) throw new ApiError(422, 'invalid_hours', 'Invalid working hours');
      next.workingHours = { ...w, timeZone: w.timeZone || d.policy.workingHours.timeZone, days: [...w.days] };
    }
    if (patch.passwordMinLength !== undefined) next.passwordMinLength = Math.max(6, Math.round(patch.passwordMinLength));
    if (patch.maxTimeToLockSec !== undefined) next.maxTimeToLockSec = Math.min(900, Math.max(30, Math.round(patch.maxTimeToLockSec)));
    for (const k of RESTRICTION_KEYS) if (patch[k] !== undefined) next[k] = !!patch[k];
    // Security / network logging are hard-wired OFF and cannot be enabled via the API.
    next.securityLogging = false;
    next.networkLogging = false;
    next.version = d.policy.version + 1;
    d.policy = next;
    await this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'device.policy_changed', target: d.id, detail: { patch, justification: justification.trim(), version: next.version } });
    this.persist();
    // Tell the device to pull the new policy.
    await this.enqueueSystemCommand(d, 'SYNC_POLICY', user);
    return this.deviceView(d);
  }

  // ------------------------------------------------------------------ enrolment

  /** POST /admin/enrollments */
  async createEnrollment(sessionId: string, opts: { note?: string; wifiSsid?: string } = {}): Promise<{
    tokenId: string;
    token: string;
    installPath: string;
    expiresAt: number;
    provisioning: ProvisioningPayload;
    sideloadApkUrl: string;
    /** opens the agent on a phone enrolled without a factory reset (standard enrolment) */
    standardLink: string;
  }> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'enrollment.create');
    const now = this.clock();
    const token = randomId('', 24);
    const rec: EnrollmentToken = {
      id: randomId('enr', 8),
      tokenHash: await sha256Hex(token),
      createdBy: user.id,
      createdAt: now,
      expiresAt: now + ENROLLMENT_TTL_MS,
      usedAt: null,
      deviceId: null,
      note: opts.note?.slice(0, 120),
    };
    this.state.enrollments.push(rec);
    await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'enrollment.created', target: rec.id, detail: { expiresAt: rec.expiresAt } });
    this.persist();
    return {
      tokenId: rec.id,
      token,
      installPath: `/e/${token}`,
      expiresAt: rec.expiresAt,
      provisioning: await this.provisioningFor(token, opts.wifiSsid),
      sideloadApkUrl: this.opts.apkDownloadUrl || `${this.apiBaseUrl}/apk/1.0.0`,
      standardLink: await this.standardLink(token),
    };
  }

  /** mobhunter://enrol link for enrolling an existing phone without a factory reset (same token, same server-key pin). */
  private async standardLink(token: string): Promise<string> {
    const q = new URLSearchParams({ server: this.apiBaseUrl, token, pin: await this.serverPin() });
    return `mobhunter://enrol?${q.toString()}`;
  }

  private async provisioningFor(token: string, wifiSsid?: string): Promise<ProvisioningPayload> {
    return buildProvisioningPayload({
      apiBaseUrl: this.apiBaseUrl,
      token,
      serverPin: await this.serverPin(),
      wifi: wifiSsid ? { ssid: wifiSsid, security: 'WPA' } : undefined,
      apkVersion: this.opts.apkVersion,
      signatureChecksum: this.opts.apkSignatureChecksum,
      apkDownloadUrl: this.opts.apkDownloadUrl,
    });
  }

  listEnrollments(sessionId: string): Omit<EnrollmentToken, 'tokenHash'>[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'enrollment.create');
    return this.state.enrollments.map(({ tokenHash: _h, ...r }) => ({ ...r })).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** GET /e/{token} — public install page data. Reveals nothing once used or expired. */
  async installPage(token: string): Promise<
    | { status: 'valid'; expiresAt: number; provisioning: ProvisioningPayload; sideloadApkUrl: string; standardLink: string }
    | { status: 'used' | 'expired' | 'invalid' }
  > {
    this.publicLimiter.check('install', this.clock());
    if (typeof token !== 'string' || token.length < 16 || token.length > 64) return { status: 'invalid' };
    const hash = await sha256Hex(token);
    const found = this.state.enrollments.find((e) => e.tokenHash === hash);
    if (!found) return { status: 'invalid' };
    if (found.usedAt) return { status: 'used' };
    if (found.expiresAt < this.clock()) return { status: 'expired' };
    return {
      status: 'valid',
      expiresAt: found.expiresAt,
      provisioning: await this.provisioningFor(token),
      sideloadApkUrl: this.opts.apkDownloadUrl || `${this.apiBaseUrl}/apk/1.0.0`,
      standardLink: await this.standardLink(token),
    };
  }

  /** POST /v1/enroll — exchanges the one-time token for a device id and a client certificate. */
  async enroll(input: {
    token: string;
    devicePublicKey: string;
    /** android (default), or a computer running the desktop agent */
    platform?: 'android' | 'windows' | 'linux' | 'macos';
    /** 'ES256' for Android Keystore P-256 keys (SPKI hex); default Ed25519 (32-byte hex) */
    keyAlg?: 'Ed25519' | 'ES256';
    hardware: { serial: string; model: string; os: string };
    /** 'standard' when the agent is not device owner (installed without a factory reset) */
    mode?: ManagementMode;
  }): Promise<{ deviceId: string; cert: DeviceCertificate; certJson: string; certSig: string; serverPublicKey: string; caPublicKey: string; policy: DevicePolicy; notice: Notice; transparencyUrl: string }> {
    const now = this.clock();
    this.enrollLimiter.check('enroll', now);
    const es256 = input.keyAlg === 'ES256';
    if (es256 ? !/^[0-9a-f]{150,200}$/.test(input.devicePublicKey ?? '') : !/^[0-9a-f]{64}$/.test(input.devicePublicKey ?? '')) {
      throw new ApiError(422, 'invalid_key', es256 ? 'Device public key must be a P-256 SubjectPublicKeyInfo (hex)' : 'Device public key must be a 32-byte Ed25519 key');
    }
    if (es256 && !(await isP256Spki(input.devicePublicKey))) {
      throw new ApiError(422, 'invalid_key', 'Unreadable device key');
    }
    const hash = await sha256Hex(String(input.token ?? ''));
    const rec = this.state.enrollments.find((e) => e.tokenHash === hash);
    if (!rec) throw new ApiError(401, 'invalid_token', 'Unknown enrolment token');
    if (rec.usedAt) throw new ApiError(410, 'token_used', 'Enrolment token has already been used');
    if (rec.expiresAt < now) throw new ApiError(410, 'token_expired', 'Enrolment token has expired');
    rec.usedAt = now; // single-use: burnt before anything else can fail

    const platform: Platform = (['windows', 'linux', 'macos'] as const).find((p) => p === input.platform) ?? 'android';
    const deviceId = randomId('dev', 9);
    const cert: DeviceCertificate = {
      ...(es256 ? { alg: 'ES256' as const } : {}),
      serial: toHex(randomBytes(8)),
      deviceId,
      publicKey: input.devicePublicKey,
      issuer: this.state.keys.deviceCa.kid,
      notBefore: now,
      notAfter: now + CERT_LIFETIME_MS,
    };
    const certJson = canonicalJson(cert);
    const certSig = await signEd25519(certJson, this.state.keys.deviceCa.secretKey);
    const device: Device = {
      id: deviceId,
      platform,
      label: null,
      assignedUserId: null,
      state: 'enrolled',
      serial: null,
      model: null,
      os: null,
      enrolledAt: now,
      lastCheckinAt: null,
      telemetry: null,
      cert,
      policyAckAt: null,
      policyAckVersion: null,
      pushToken: randomId('fcm', 16),
      lostMode: false,
      policy: defaultPolicy(),
      transparencyKey: randomId('', 18),
      enrollmentTokenId: rec.id,
      managementMode: input.mode === 'standard' ? 'standard' : 'device_owner',
      capabilities: null,
    };
    rec.deviceId = deviceId;
    this.state.devices.push(device);
    this.state.relayQueues[deviceId] = [];
    await this.audit.append({ at: now, actor: deviceId, actorRole: 'DEVICE', action: 'device.enrolled', target: deviceId, detail: { enrollment: rec.id, certSerial: cert.serial, mode: device.managementMode, platform } });
    this.persist();
    return {
      deviceId,
      cert,
      certJson,
      certSig,
      serverPublicKey: this.state.keys.commandSigning.publicKey,
      caPublicKey: this.state.keys.deviceCa.publicKey,
      policy: structuredClone(device.policy),
      notice: this.notice(),
      transparencyUrl: this.transparencyPath(device),
    };
  }

  // ------------------------------------------------------------------ device authentication (mTLS equivalent)

  /**
   * Validates a device request: the certificate must be signed by our CA and
   * match the device's current certificate, and the request must be signed
   * with the certificate's key over (method, path, ts, nonce, body hash),
   * fresh and never seen before. This is the browser stand-in for mutual TLS.
   */
  private async authenticateDevice(method: string, path: string, body: unknown, auth: DeviceAuth): Promise<Device> {
    const now = this.clock();
    const fail = (msg: string): never => {
      throw new ApiError(401, 'device_unauthenticated', msg);
    };
    if (!auth || typeof auth !== 'object') fail('Missing client certificate');
    const device = this.state.devices.find((d) => d.id === auth.deviceId);
    if (!device) return fail('Unknown device');
    if (device.state === 'wiped' || device.state === 'retired') fail('Certificate revoked');
    if (!auth.cert || typeof auth.sig !== 'string' || typeof auth.nonce !== 'string' || auth.nonce.length < 8 || auth.nonce.length > 64) fail('Malformed device credentials');
    if (!(await verifyEd25519(canonicalJson(auth.cert), auth.certSig, this.state.keys.deviceCa.publicKey))) fail('Certificate not issued by this CA');
    if (canonicalJson(auth.cert) !== canonicalJson(device.cert)) fail('Certificate does not match device record');
    if (auth.cert.notAfter < now || auth.cert.notBefore > now + 60_000) fail('Certificate not valid now');
    if (Math.abs(now - auth.ts) > DEVICE_REQUEST_WINDOW_MS) fail('Request timestamp outside allowed window');
    const bodyHash = auth.serverBodyHash ?? (await sha256Hex(canonicalJson(body ?? null)));
    if (bodyHash !== auth.bodyHash) fail('Body hash mismatch');
    const msg = deviceRequestMessage(method, path, auth.ts, auth.nonce, auth.bodyHash);
    const sigOk = device.cert.alg === 'ES256' ? await verifyEs256(msg, auth.sig, device.cert.publicKey) : await verifyEd25519(msg, auth.sig, device.cert.publicKey);
    if (!sigOk) fail('Bad request signature');
    const seen = (this.state.deviceNonces[device.id] ??= []).filter((n) => now - n.at < DEVICE_REQUEST_WINDOW_MS * 2);
    if (seen.some((n) => n.nonce === auth.nonce)) fail('Replayed request');
    seen.push({ nonce: auth.nonce, at: now });
    this.state.deviceNonces[device.id] = seen;
    return device;
  }

  /** GET /v1/policy */
  async devicePolicy(auth: DeviceAuth): Promise<{ policy: DevicePolicy; lostMode: boolean; transparencyUrl: string }> {
    const d = await this.authenticateDevice('GET', '/v1/policy', null, auth);
    this.persist();
    return { policy: structuredClone(d.policy), lostMode: d.lostMode, transparencyUrl: this.transparencyPath(d) };
  }

  transparencyPath(d: Pick<Device, 'id' | 'transparencyKey'>): string {
    return `/transparency/${d.id}/${d.transparencyKey}`;
  }

  /** POST /v1/checkin */
  async checkin(auth: DeviceAuth, body: { telemetry: Telemetry; serial: string; model: string; os: string; policyAck?: { version: string; at: number }; capabilities?: DeviceCapabilities }): Promise<{ ok: true; state: Device['state']; policyVersion: number; pendingCommands: number; transparencyUrl: string }> {
    const d = await this.authenticateDevice('POST', '/v1/checkin', body, auth);
    const now = this.clock();
    d.lastCheckinAt = now;
    if (body.serial) d.serial = String(body.serial).slice(0, 64);
    if (body.model) d.model = String(body.model).slice(0, 64);
    if (body.os) d.os = String(body.os).slice(0, 64);
    if (body.telemetry) d.telemetry = sanitiseTelemetry(body.telemetry);
    if (body.capabilities && typeof body.capabilities === 'object') d.capabilities = sanitiseCapabilities(body.capabilities);
    this.syncThreats(d);
    if (body.policyAck && !d.policyAckAt) {
      if (body.policyAck.version !== COLLECTION_NOTICE.version) throw new ApiError(409, 'notice_outdated', 'Acknowledged notice version is not current');
      d.policyAckAt = now;
      d.policyAckVersion = body.policyAck.version;
      if (d.state === 'enrolled') d.state = 'active';
      await this.audit.append({ at: now, actor: d.id, actorRole: 'DEVICE', action: 'device.notice_acknowledged', target: d.id, detail: { version: body.policyAck.version } });
    }
    this.persist();
    return { ok: true, state: d.state, policyVersion: d.policy.version, pendingCommands: this.state.relayQueues[d.id]?.length ?? 0, transparencyUrl: this.transparencyPath(d) };
  }

  /** GET /v1/commands/pending — the device pulls through its relay. */
  async pendingCommands(auth: DeviceAuth): Promise<SignedCommand[]> {
    const d = await this.authenticateDevice('GET', '/v1/commands/pending', null, auth);
    return withDeviceLock(d.id, async () => {
      await this.refreshPendingRemoval(d);
      const relay = this.relayFor(d.id);
      const out = relay.pull(this.clock());
      d.lastCheckinAt = this.clock();
      this.persist();
      // `signed` is the exact signed string, so agents in other languages verify without re-serialising.
      return structuredClone(out).map((e) => ({ ...e, signed: canonicalJson(e.payload) }));
    });
  }

  /** POST /v1/commands/{id}/result */
  async commandResult(auth: DeviceAuth, commandId: string, body: { status: 'succeeded' | 'failed' | 'rejected'; detail?: string; location?: LocationFix }): Promise<{ ok: true }> {
    const d = await this.authenticateDevice('POST', `/v1/commands/${commandId}/result`, body, auth);
    return withDeviceLock(d.id, async () => {
      const now = this.clock();
      const cmd = this.commandsById.get(commandId);
      if (!cmd || cmd.deviceId !== d.id) throw new ApiError(404, 'not_found', 'Command not found');
      if (['succeeded', 'failed', 'rejected', 'expired'].includes(cmd.status)) return { ok: true as const }; // idempotent
      if (cmd.status !== 'delivered') throw new ApiError(409, 'not_delivered', 'Command was not delivered');

      let status: CommandRecord['status'] = body.status === 'succeeded' ? 'succeeded' : body.status === 'rejected' ? 'rejected' : 'failed';
      let summary = String(body.detail ?? '').slice(0, 200);

      if (status === 'succeeded' && (cmd.type === 'LOCATE' || cmd.type === 'LOST_MODE_ON')) {
        if (body.location) {
          const accepted = await this.storeLocation(d, body.location, cmd, cmd.type === 'LOCATE' ? 1 : 2);
          if (!accepted) {
            status = 'failed';
            summary = 'Location discarded: agent did not prove the mandatory notification was shown';
          } else summary = summary || `Location fix received (±${Math.round(body.location.accuracyM)} m)`;
        } else if (cmd.type === 'LOCATE') {
          status = 'failed';
          summary = summary || 'No location returned';
        }
      }
      if (status === 'succeeded') this.applyCommandEffects(d, cmd);
      cmd.status = status;
      cmd.completedAt = now;
      cmd.resultSummary = summary;
      this.relayFor(d.id).complete(cmd.id);
      if (status === 'rejected') this.syncThreats(d);
      await this.audit.append({ at: now, actor: d.id, actorRole: 'DEVICE', action: `command.${status}`, target: d.id, ticket: cmd.ticket, detail: { commandId: cmd.id, type: cmd.type } });
      if (cmd.type === 'RELEASE') {
        if (status === 'succeeded' && d.pendingRemoval) {
          const req = d.pendingRemoval;
          const actor = this.state.users.find((u) => u.id === req.requestedBy);
          this.audit.append({ at: now, actor: d.id, actorRole: 'DEVICE', action: 'device.released', target: d.id, detail: { detail: summary } });
          this.eraseDevice(d, { id: req.requestedBy, role: actor?.role ?? 'SYSTEM' }, req.reason, 'agent released management and uninstalled');
        } else if (status !== 'succeeded') {
          // The phone refused or failed: keep the record, surface it, let the admin decide (retry, retire or wipe).
          d.pendingRemoval = null;
        }
      }
      this.persist();
      return { ok: true as const };
    });
  }

  /** POST /v1/location/batch — Tier 2 (Lost Mode) and Tier 3 (continuous) fixes. */
  async locationBatch(auth: DeviceAuth, body: { fixes: LocationFix[] }): Promise<{ accepted: number; rejected: number }> {
    const d = await this.authenticateDevice('POST', '/v1/location/batch', body, auth);
    let accepted = 0;
    let rejected = 0;
    for (const fix of (body.fixes ?? []).slice(0, 100)) {
      const allowed = (fix.tier === 2 && d.lostMode) || (fix.tier === 3 && d.policy.continuousLocation && withinWorkingHours(d.policy, fix.fixAt));
      if (!allowed) {
        rejected++;
        continue;
      }
      // Lost Mode fixes are filed under the ticket that turned Lost Mode on (purpose limitation).
      const lostCmd =
        fix.tier === 2
          ? this.state.commands.filter((c) => c.deviceId === d.id && c.type === 'LOST_MODE_ON' && c.status === 'succeeded').sort((a, b) => b.issuedAt - a.issuedAt)[0] ?? null
          : null;
      if (await this.storeLocation(d, fix, lostCmd, fix.tier)) accepted++;
      else rejected++;
    }
    if (rejected) await this.audit.append({ at: this.clock(), actor: d.id, actorRole: 'DEVICE', action: 'location.batch_rejected', target: d.id, detail: { rejected } });
    this.persist();
    return { accepted, rejected };
  }

  private async storeLocation(d: Device, fix: LocationFix, cmd: CommandRecord | null, tier: 1 | 2 | 3): Promise<boolean> {
    // Non-negotiable #2/#3: no silent location. A fix without notification proof is discarded and flagged.
    if (!fix?.notification || typeof fix.notification.shownAt !== 'number') {
      await this.audit.append({ at: this.clock(), actor: d.id, actorRole: 'DEVICE', action: 'security.silent_location_blocked', target: d.id, detail: { commandId: cmd?.id ?? null } });
      return false;
    }
    if (!isFiniteCoord(fix.lat, -90, 90) || !isFiniteCoord(fix.lng, -180, 180)) return false;
    const id = randomId('loc', 9);
    const clean: LocationFix = {
      lat: fix.lat,
      lng: fix.lng,
      accuracyM: Math.max(0, Number(fix.accuracyM) || 0),
      fixAt: Number(fix.fixAt) || this.clock(),
      source: fix.source === 'last_known' ? 'last_known' : 'fused',
      ageSec: fix.ageSec,
      tier,
      notification: { shownAt: fix.notification.shownAt, channel: String(fix.notification.channel).slice(0, 40), text: String(fix.notification.text).slice(0, 200) },
    };
    const sealed = await sealJson(clean, this.state.keys.locationKey, `${id}|${d.id}`);
    const stored: StoredLocation = { id, deviceId: d.id, commandId: tier === 2 && cmd?.type === 'LOST_MODE_ON' && cmd.status === 'succeeded' ? null : (cmd?.id ?? null), ticket: cmd?.ticket ?? null, tier, receivedAt: this.clock(), sealed };
    this.state.locations.push(stored);
    return true;
  }

  private applyCommandEffects(d: Device, cmd: CommandRecord) {
    switch (cmd.type) {
      case 'LOST_MODE_ON':
        d.lostMode = true;
        d.state = 'lost';
        break;
      case 'LOST_MODE_OFF':
        d.lostMode = false;
        if (d.state === 'lost') d.state = d.policyAckAt ? 'active' : 'enrolled';
        this.closeIncidents(d.id, 'found', cmd.issuedBy, 'Lost Mode ended');
        break;
      case 'WIPE':
        d.state = 'wiped';
        d.lostMode = false;
        this.state.relayQueues[d.id] = [];
        this.closeIncidents(d.id, 'not_recovered', cmd.issuedBy, 'Device wiped');
        break;
      case 'RELEASE':
        // The agent has removed management and is uninstalling itself: revoke the certificate.
        d.state = 'released';
        d.lostMode = false;
        this.state.relayQueues[d.id] = [];
        break;
      default:
        break;
    }
  }

  private relayFor(deviceId: string): DeviceRelay {
    const q = (this.state.relayQueues[deviceId] ??= []);
    return new DeviceRelay(deviceId, q, this.commandsById);
  }

  // ------------------------------------------------------------------ admin: commands

  /**
   * POST /admin/commands/bulk — the same command to many phones. Each phone goes through the
   * normal single-device path (permission, support check, signing, relay, audit); one failure
   * does not stop the rest, and every result is reported back.
   */
  async issueBulkCommand(
    sessionId: string,
    input: { deviceIds: string[]; type: CommandType; params?: Record<string, unknown> },
  ): Promise<{ results: { deviceId: string; ok: boolean; commandId?: string; error?: string }[] }> {
    const { user } = this.requireSession(sessionId);
    if (!isCommandType(input.type) || !BULK_COMMANDS.has(input.type)) throw new ApiError(422, 'not_bulk', 'This command can only be sent to one device at a time');
    this.guard(user, `command.${input.type}`);
    const ids = [...new Set(Array.isArray(input.deviceIds) ? input.deviceIds.map(String) : [])];
    if (!ids.length) throw new ApiError(422, 'no_devices', 'Choose at least one device');
    if (ids.length > 500) throw new ApiError(422, 'too_many', 'At most 500 devices per bulk command');
    const results: { deviceId: string; ok: boolean; commandId?: string; error?: string }[] = [];
    for (const id of ids) {
      try {
        const c = await this.issueCommand(sessionId, id, { type: input.type, params: input.params });
        results.push({ deviceId: id, ok: true, commandId: c.id });
      } catch (e) {
        results.push({ deviceId: id, ok: false, error: e instanceof ApiError ? e.message : 'Failed' });
      }
    }
    await this.audit.append({
      at: this.clock(),
      actor: user.id,
      actorRole: user.role,
      action: 'command.bulk',
      target: input.type,
      detail: { devices: ids.length, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
    });
    this.persist();
    return { results };
  }

  /** POST /admin/devices/{id}/commands */
  async issueCommand(sessionId: string, deviceId: string, input: { type: CommandType; ticket?: string; reason?: string; params?: Record<string, unknown> }): Promise<CommandRecord> {
    const { user } = this.requireSession(sessionId);
    if (!isCommandType(input.type)) throw new ApiError(422, 'invalid_command', 'Unknown command type');
    if (input.type === 'RELEASE') throw new ApiError(422, 'use_delete', 'Removing management is done by deleting the device');
    this.guard(user, `command.${input.type}`);
    const d = this.findDevice(deviceId);
    if (d.state === 'wiped' || d.state === 'retired') throw new ApiError(409, 'device_inactive', 'Device is wiped or retired');
    const unsupported = unsupportedReason(d, input.type);
    if (unsupported) throw new ApiError(422, 'not_supported', unsupported);
    const ticket = input.ticket?.trim();
    if (TICKET_REQUIRED.has(input.type)) {
      if (!ticket || !/^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/.test(ticket)) throw new ApiError(422, 'ticket_required', 'A ticket reference like INC-1234 is required for this command');
      if (!input.reason || input.reason.trim().length < 5) throw new ApiError(422, 'reason_required', 'Describe why this action is necessary');
    }
    if ((input.type === 'LOCATE' || input.type === 'LOST_MODE_ON') && !d.policyAckAt) {
      throw new ApiError(409, 'not_acknowledged', 'The user has not acknowledged the device notice yet — location cannot be collected');
    }
    const params = sanitiseParams(input.type, input.params ?? {}, this.state.settings!.apps);
    const now = this.clock();
    const cmd: CommandRecord = {
      id: randomId('cmd', 10),
      deviceId: d.id,
      type: input.type,
      params,
      ticket: ticket || undefined,
      reason: input.reason?.trim().slice(0, 500) || undefined,
      issuedBy: user.id,
      issuedAt: now,
      status: 'pending_approval',
    };
    this.state.commands.push(cmd);
    this.commandsById.set(cmd.id, cmd);
    await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'command.issued', target: d.id, ticket: cmd.ticket, detail: { commandId: cmd.id, type: cmd.type, reason: cmd.reason } });
    if (DUAL_CONTROL.has(cmd.type)) {
      this.persist();
      return { ...cmd };
    }
    await this.dispatch(cmd, d);
    return { ...cmd };
  }

  /** Four-eyes approval for destructive commands. */
  async approveCommand(sessionId: string, commandId: string, approve: boolean): Promise<CommandRecord> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'command.approve');
    const cmd = this.commandsById.get(commandId);
    if (!cmd) throw new ApiError(404, 'not_found', 'Command not found');
    if (cmd.status !== 'pending_approval') throw new ApiError(409, 'not_pending', 'Command is not awaiting approval');
    if (cmd.issuedBy === user.id) throw new ApiError(409, 'same_approver', 'Four-eyes rule: a different person must approve');
    const now = this.clock();
    if (!approve) {
      cmd.status = 'rejected';
      cmd.completedAt = now;
      cmd.resultSummary = 'Rejected by approver';
      await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'command.approval_rejected', target: cmd.deviceId, ticket: cmd.ticket, detail: { commandId } });
      this.persist();
      return { ...cmd };
    }
    cmd.approvedBy = user.id;
    await this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'command.approved', target: cmd.deviceId, ticket: cmd.ticket, detail: { commandId } });
    await this.dispatch(cmd, this.findDevice(cmd.deviceId));
    return { ...cmd };
  }

  private async dispatch(cmd: CommandRecord, d: Device) {
    await withDeviceLock(d.id, async () => {
      cmd.envelope = await signCommand({ id: cmd.id, deviceId: d.id, type: cmd.type, params: cmd.params, ticket: cmd.ticket }, this.state.keys.commandSigning, this.clock());
      this.relayFor(d.id).enqueue(cmd);
      this.persist();
    });
    await this.push.wake(d.id, d.platform, d.pushToken, cmd.type);
    this.persist();
  }

  private async enqueueSystemCommand(d: Device, type: CommandType, actor: User) {
    const cmd: CommandRecord = { id: randomId('cmd', 10), deviceId: d.id, type, params: {}, issuedBy: actor.id, issuedAt: this.clock(), status: 'pending_approval' };
    this.state.commands.push(cmd);
    this.commandsById.set(cmd.id, cmd);
    await this.audit.append({ at: this.clock(), actor: actor.id, actorRole: actor.role, action: 'command.issued', target: d.id, detail: { commandId: cmd.id, type, system: true } });
    await this.dispatch(cmd, d);
  }

  listCommands(sessionId: string, deviceId?: string): Omit<CommandRecord, 'envelope'>[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    this.expireStaleCommands();
    return this.state.commands
      .filter((c) => (deviceId ? c.deviceId === deviceId : true))
      .map(({ envelope: _e, ...c }) => ({ ...c, params: { ...c.params } }))
      .sort((a, b) => b.issuedAt - a.issuedAt);
  }

  private expireStaleCommands() {
    const now = this.clock();
    for (const c of this.state.commands) {
      if ((c.status === 'queued' || c.status === 'delivered') && c.envelope && now > c.envelope.payload.expiresAt) {
        c.status = 'expired';
        c.completedAt = now;
        const q = this.state.relayQueues[c.deviceId];
        if (q) this.state.relayQueues[c.deviceId] = q.filter((id) => id !== c.id);
      }
      if (c.status === 'pending_approval' && now - c.issuedAt > 24 * 3600_000) {
        c.status = 'expired';
        c.completedAt = now;
      }
    }
  }

  // ------------------------------------------------------------------ admin: location

  /** GET /admin/location-results — Location Operator and Super Admin; every read is audited. */
  async listLocationResults(sessionId: string, filter: { deviceId?: string; ticket: string; tier?: 1 | 2 | 3; sinceMs?: number; onlyTicket?: boolean }): Promise<LocationView[]> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'location.read');
    const ticket = filter.ticket?.trim();
    if (!ticket || !/^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/.test(ticket)) throw new ApiError(422, 'ticket_required', 'Viewing location data requires a ticket reference');
    await this.runRetention();
    const since = Number(filter.sinceMs) > 0 ? this.clock() - Number(filter.sinceMs) : 0;
    const rows = this.state.locations.filter(
      (l) =>
        (filter.deviceId ? l.deviceId === filter.deviceId : true) &&
        (filter.tier ? l.tier === Number(filter.tier) : true) &&
        (filter.onlyTicket ? l.ticket === ticket : true) &&
        l.receivedAt >= since,
    );
    const out: LocationView[] = [];
    for (const l of rows) {
      const fix = await openJson<LocationFix>(l.sealed, this.state.keys.locationKey);
      const d = this.state.devices.find((x) => x.id === l.deviceId);
      out.push({ id: l.id, deviceId: l.deviceId, deviceName: d ? displayName(d) : l.deviceId, commandId: l.commandId, ticket: l.ticket, tier: l.tier, receivedAt: l.receivedAt, fix });
    }
    await this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'location.viewed', target: filter.deviceId ?? '*', ticket, detail: { results: out.length, tier: filter.tier ?? null, sinceMs: filter.sinceMs ?? null, onlyTicket: !!filter.onlyTicket } });
    this.persist();
    return out.sort((a, b) => b.receivedAt - a.receivedAt);
  }

  /**
   * Index of location tickets (no coordinates): which tickets have location
   * requests or results, for which devices, and when. Lets the Location
   * Operator pick the right ticket instead of guessing. Location Operator and Super Admin.
   */
  listLocationTickets(sessionId: string): { ticket: string; devices: string[]; requests: number; fixes: number; lastAt: number; open: boolean }[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'location.read');
    const by = new Map<string, { ticket: string; devices: Set<string>; requests: number; fixes: number; lastAt: number; open: boolean }>();
    const entry = (t: string) => {
      let e = by.get(t);
      if (!e) by.set(t, (e = { ticket: t, devices: new Set(), requests: 0, fixes: 0, lastAt: 0, open: false }));
      return e;
    };
    const name = (id: string) => {
      const d = this.state.devices.find((x) => x.id === id);
      return d ? displayName(d) : id;
    };
    for (const c of this.state.commands) {
      if (!c.ticket || !['LOCATE', 'LOST_MODE_ON', 'LOST_MODE_OFF'].includes(c.type)) continue;
      const e = entry(c.ticket);
      e.devices.add(name(c.deviceId));
      e.requests++;
      e.lastAt = Math.max(e.lastAt, c.issuedAt);
      if (c.type === 'LOST_MODE_ON' && this.state.devices.find((d) => d.id === c.deviceId)?.lostMode) e.open = true;
    }
    for (const l of this.state.locations) {
      if (!l.ticket) continue;
      const e = entry(l.ticket);
      e.devices.add(name(l.deviceId));
      e.fixes++;
      e.lastAt = Math.max(e.lastAt, l.receivedAt);
    }
    return [...by.values()].map((e) => ({ ...e, devices: [...e.devices] })).sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * Permanently deletes a device record. Only for devices already retired or
   * wiped (so no managed phone is left orphaned). Its commands, relay queue and
   * encrypted location data are erased; the append-only audit log keeps a
   * snapshot of what was deleted, by whom and why.
   */
  async deleteDevice(
    sessionId: string,
    deviceId: string,
    input: { reason: string; confirm: string },
  ): Promise<{ status: 'deleted'; deleted: string; commands: number; locations: number } | { status: 'pending_removal'; commandId: string }> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.delete');
    const d = this.findDevice(deviceId);
    if (!input?.reason || input.reason.trim().length < 5) throw new ApiError(422, 'reason_required', 'Give a reason for deleting the device');
    if (input.confirm !== 'DELETE') throw new ApiError(422, 'confirm_required', 'Type DELETE to confirm');
    const reason = input.reason.trim().slice(0, 300);

    // Still managed and reachable: the agent must release the phone and uninstall itself first.
    if (d.state === 'enrolled' || d.state === 'active' || d.state === 'lost') {
      if (d.pendingRemoval) throw new ApiError(409, 'removal_pending', 'Removal already requested — waiting for the phone to uninstall the agent');
      const cmd: CommandRecord = {
        id: randomId('cmd', 10),
        deviceId: d.id,
        type: 'RELEASE',
        params: { orgName: this.state.settings!.orgName },
        reason,
        issuedBy: user.id,
        issuedAt: this.clock(),
        status: 'pending_approval',
      };
      this.state.commands.push(cmd);
      this.commandsById.set(cmd.id, cmd);
      d.pendingRemoval = { requestedBy: user.id, requestedAt: this.clock(), reason, commandId: cmd.id };
      this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'device.removal_requested', target: d.id, detail: { reason, commandId: cmd.id } });
      await this.dispatch(cmd, d);
      return { status: 'pending_removal', commandId: cmd.id };
    }
    // Retired, wiped or released: nothing left on the phone to talk to — delete now.
    return { status: 'deleted', ...this.eraseDevice(d, { id: user.id, role: user.role }, reason, d.state) };
  }

  /** Cancels a removal that the phone has not completed (e.g. it is offline for good — then retire or wipe it). */
  async cancelRemoval(sessionId: string, deviceId: string): Promise<DeviceView> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.delete');
    const d = this.findDevice(deviceId);
    if (!d.pendingRemoval) throw new ApiError(409, 'no_removal', 'No removal is pending for this device');
    const cmd = this.commandsById.get(d.pendingRemoval.commandId);
    if (cmd && (cmd.status === 'queued' || cmd.status === 'delivered' || cmd.status === 'expired')) {
      cmd.status = 'rejected';
      cmd.completedAt = this.clock();
      cmd.resultSummary = 'Removal cancelled by an administrator';
      this.relayFor(d.id).complete(cmd.id);
    }
    d.pendingRemoval = null;
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'device.removal_cancelled', target: d.id });
    this.persist();
    return this.deviceView(d);
  }

  /**
   * Keeps a pending removal alive while the phone is offline: commands expire after
   * 10 minutes (non-negotiable), so the RELEASE command is re-signed with a fresh
   * nonce and expiry when the phone next pulls. The phone never accepted the old
   * envelope, so re-using the command id does not trip its replay protection.
   */
  private async refreshPendingRemoval(d: Device) {
    const pr = d.pendingRemoval;
    if (!pr) return;
    const cmd = this.commandsById.get(pr.commandId);
    if (!cmd) return;
    const now = this.clock();
    const stale = cmd.status === 'expired' || ((cmd.status === 'queued' || cmd.status === 'delivered') && cmd.envelope && now > cmd.envelope.payload.expiresAt - 30_000);
    if (!stale) return;
    cmd.envelope = await signCommand({ id: cmd.id, deviceId: d.id, type: cmd.type, params: cmd.params, ticket: cmd.ticket }, this.state.keys.commandSigning, now);
    cmd.status = 'pending_approval';
    this.relayFor(d.id).enqueue(cmd);
  }

  /** Closes any open incident for a device whose Lost Mode ended or that left management. */
  private closeIncidents(deviceId: string, resolution: NonNullable<Incident['resolution']>, by: string, note: string) {
    const now = this.clock();
    for (const i of this.state.incidents ?? []) {
      if (i.deviceId !== deviceId || i.status !== 'active') continue;
      i.status = 'resolved';
      i.resolution = resolution;
      i.resolvedBy = by;
      i.resolvedAt = now;
      i.trackingUntil = Math.min(i.trackingUntil, now);
      i.note = note;
      this.audit.append({ at: now, actor: by, actorRole: 'SYSTEM', action: 'incident.resolved', target: deviceId, ticket: i.ticket, detail: { incidentId: i.id, resolution, note, automatic: true } });
    }
  }

  private eraseDevice(d: Device, actor: { id: string; role: string }, reason: string, how: string): { deleted: string; commands: number; locations: number } {
    this.closeIncidents(d.id, 'not_recovered', actor.id, `Device deleted (${how})`);
    const commands = this.state.commands.filter((c) => c.deviceId === d.id).length;
    const locations = this.state.locations.filter((l) => l.deviceId === d.id).length;
    this.state.devices = this.state.devices.filter((x) => x.id !== d.id);
    this.state.commands = this.state.commands.filter((c) => c.deviceId !== d.id);
    this.commandsById = new Map(this.state.commands.map((c) => [c.id, c]));
    this.state.locations = this.state.locations.filter((l) => l.deviceId !== d.id);
    delete this.state.relayQueues[d.id];
    delete this.state.deviceNonces[d.id];
    this.state.wakes = this.state.wakes.filter((w) => w.deviceId !== d.id);
    this.audit.append({
      at: this.clock(),
      actor: actor.id,
      actorRole: actor.role,
      action: 'device.deleted',
      target: d.id,
      detail: {
        reason,
        how,
        snapshot: { label: d.label, serial: d.serial, model: d.model, state: d.state, enrolledAt: d.enrolledAt, certSerial: d.cert.serial, assignedUserId: d.assignedUserId },
        erased: { commands, locations },
      },
    });
    this.persist();
    return { deleted: d.id, commands, locations };
  }

  // ------------------------------------------------------------------ lost / stolen incidents (active tracking)

  /**
   * Report a device lost or stolen: turns on Lost Mode with time-boxed active
   * tracking (a fix every 1–5 min for up to 72 h). Location Operator and Super Admin,
   * ticket + reason required, the phone shows a persistent notice for as long
   * as tracking runs, and the phone itself stops at `trackingUntil`.
   */
  async reportIncident(
    sessionId: string,
    deviceId: string,
    input: { kind: 'lost' | 'stolen'; ticket: string; reason: string; intervalSec: number; durationHours: number; message?: string; phone?: string },
  ): Promise<Incident> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'command.LOST_MODE_ON');
    const d = this.findDevice(deviceId);
    if (this.state.incidents!.some((i) => i.deviceId === d.id && i.status === 'active')) throw new ApiError(409, 'incident_open', 'This device already has an open lost/stolen incident');
    const kind = input.kind === 'stolen' ? 'stolen' : input.kind === 'lost' ? 'lost' : null;
    if (!kind) throw new ApiError(422, 'invalid_kind', 'Choose lost or stolen');
    const interval = Number(input.intervalSec);
    if (![60, 120, 300].includes(interval)) throw new ApiError(422, 'invalid_interval', 'Tracking interval must be 1, 2 or 5 minutes');
    const hours = Number(input.durationHours);
    if (!(hours >= 1 && hours <= 72)) throw new ApiError(422, 'invalid_duration', 'Active tracking can run for 1–72 hours (extend if needed)');
    const now = this.clock();
    const trackingUntil = now + Math.round(hours * 3600_000);
    // issueCommand enforces ticket, reason, notice acknowledgement and RBAC, and audits the command.
    await this.issueCommand(sessionId, d.id, {
      type: 'LOST_MODE_ON',
      ticket: input.ticket,
      reason: input.reason,
      params: { message: input.message, phone: input.phone, kind, trackingIntervalSec: interval, trackingUntil },
    });
    const inc: Incident = {
      id: randomId('inc', 8),
      deviceId: d.id,
      kind,
      ticket: String(input.ticket).trim(),
      reason: String(input.reason).trim().slice(0, 500),
      reportedBy: user.id,
      startedAt: now,
      trackingIntervalSec: interval,
      trackingUntil,
      status: 'active',
      viewAudit: {},
    };
    this.state.incidents!.push(inc);
    this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'incident.reported', target: d.id, ticket: inc.ticket, detail: { incidentId: inc.id, kind, intervalSec: interval, trackingUntil } });
    this.persist();
    return structuredClone(inc);
  }

  /** Extend tracking and/or change the interval (re-sends a signed LOST_MODE_ON with the new limits). */
  async updateIncidentTracking(sessionId: string, incidentId: string, input: { extendHours?: number; intervalSec?: number; reason: string }): Promise<Incident> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'command.LOST_MODE_ON');
    const inc = this.findIncident(incidentId);
    if (inc.status !== 'active') throw new ApiError(409, 'incident_closed', 'This incident is closed');
    if (!input.reason || input.reason.trim().length < 5) throw new ApiError(422, 'reason_required', 'Say why tracking is being changed');
    const now = this.clock();
    let until = inc.trackingUntil;
    if (input.extendHours !== undefined) {
      const h = Number(input.extendHours);
      if (!(h >= 1 && h <= 72)) throw new ApiError(422, 'invalid_duration', 'Extend by 1–72 hours');
      until = Math.min(Math.max(until, now) + h * 3600_000, now + 72 * 3600_000);
    }
    let interval = inc.trackingIntervalSec;
    if (input.intervalSec !== undefined) {
      if (![60, 120, 300].includes(Number(input.intervalSec))) throw new ApiError(422, 'invalid_interval', 'Tracking interval must be 1, 2 or 5 minutes');
      interval = Number(input.intervalSec);
    }
    const last = this.state.commands.filter((c) => c.deviceId === inc.deviceId && c.type === 'LOST_MODE_ON').sort((a, b) => b.issuedAt - a.issuedAt)[0];
    await this.issueCommand(sessionId, inc.deviceId, {
      type: 'LOST_MODE_ON',
      ticket: inc.ticket,
      reason: input.reason,
      params: { message: last?.params.message, phone: last?.params.phone, kind: inc.kind, trackingIntervalSec: interval, trackingUntil: until },
    });
    const before = { trackingUntil: inc.trackingUntil, intervalSec: inc.trackingIntervalSec };
    inc.trackingUntil = until;
    inc.trackingIntervalSec = interval;
    this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'incident.tracking_updated', target: inc.deviceId, ticket: inc.ticket, detail: { incidentId: inc.id, before, after: { trackingUntil: until, intervalSec: interval }, reason: input.reason.trim().slice(0, 300) } });
    this.persist();
    return structuredClone(inc);
  }

  /**
   * Close an incident. Found/recovered/false alarm end Lost Mode (and tracking)
   * on the phone; "not recovered" stops active tracking but keeps Lost Mode so
   * the phone stays locked — wipe it next.
   */
  async resolveIncident(sessionId: string, incidentId: string, input: { resolution: Incident['resolution']; note?: string }): Promise<Incident> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'command.LOST_MODE_OFF');
    const inc = this.findIncident(incidentId);
    if (inc.status !== 'active') throw new ApiError(409, 'incident_closed', 'This incident is already closed');
    const resolution = input.resolution;
    if (!resolution || !['found', 'recovered', 'not_recovered', 'false_alarm'].includes(resolution)) throw new ApiError(422, 'invalid_resolution', 'Choose how the incident ended');
    const now = this.clock();
    const d = this.state.devices.find((x) => x.id === inc.deviceId);
    if (d && d.state !== 'wiped' && d.state !== 'retired') {
      if (resolution === 'not_recovered') {
        // Stop high-frequency tracking now; Lost Mode (5-minute fixes, locked screen) stays until the phone is wiped.
        const last = this.state.commands.filter((c) => c.deviceId === inc.deviceId && c.type === 'LOST_MODE_ON').sort((a, b) => b.issuedAt - a.issuedAt)[0];
        await this.issueCommand(sessionId, inc.deviceId, {
          type: 'LOST_MODE_ON',
          ticket: inc.ticket,
          reason: 'Incident closed as not recovered: active tracking stopped',
          params: { message: last?.params.message, phone: last?.params.phone, kind: inc.kind, trackingIntervalSec: 300, trackingUntil: now },
        });
      } else {
        await this.issueCommand(sessionId, inc.deviceId, { type: 'LOST_MODE_OFF' });
      }
    }
    inc.status = 'resolved';
    inc.resolution = resolution;
    inc.resolvedBy = user.id;
    inc.resolvedAt = now;
    inc.trackingUntil = Math.min(inc.trackingUntil, now);
    inc.note = input.note?.trim().slice(0, 500) || undefined;
    this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'incident.resolved', target: inc.deviceId, ticket: inc.ticket, detail: { incidentId: inc.id, resolution, note: inc.note } });
    this.persist();
    return structuredClone(inc);
  }

  /** Incidents without coordinates — visible to every console role (status only). */
  listIncidents(sessionId: string): (Omit<Incident, 'viewAudit'> & { deviceName: string; lastFixAt: number | null; batteryLevel: number | null; lastCheckinAt: number | null })[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    return this.state
      .incidents!.map((i) => {
        const d = this.state.devices.find((x) => x.id === i.deviceId);
        const fixes = this.state.locations.filter((l) => l.deviceId === i.deviceId && l.ticket === i.ticket);
        const { viewAudit: _v, ...rest } = i;
        return {
          ...structuredClone(rest),
          deviceName: d ? displayName(d) : `${i.deviceId} (deleted)`,
          lastFixAt: fixes.length ? Math.max(...fixes.map((f) => f.receivedAt)) : null,
          batteryLevel: d?.telemetry?.batteryLevel ?? null,
          lastCheckinAt: d?.lastCheckinAt ?? null,
        };
      })
      .sort((a, b) => (a.status === b.status ? b.startedAt - a.startedAt : a.status === 'active' ? -1 : 1));
  }

  /**
   * Live tracking data for one incident (Location Operator). Every fix filed
   * under the incident's ticket since it started, newest first. Audited once
   * per operator per 15 minutes so a live, auto-refreshing view does not flood
   * the audit log while every viewing session is still on record.
   */
  async trackIncident(sessionId: string, incidentId: string): Promise<{
    incident: Omit<Incident, 'viewAudit'>;
    device: { id: string; name: string; state: string; lostMode: boolean; batteryLevel: number | null; lastCheckinAt: number | null } | null;
    fixes: LocationView[];
    trackingActive: boolean;
  }> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'location.read');
    const inc = this.findIncident(incidentId);
    const now = this.clock();
    const d = this.state.devices.find((x) => x.id === inc.deviceId) ?? null;
    const fixes: LocationView[] = [];
    for (const l of this.state.locations.filter((x) => x.deviceId === inc.deviceId && x.ticket === inc.ticket && x.receivedAt >= inc.startedAt - 60_000)) {
      fixes.push({ id: l.id, deviceId: l.deviceId, deviceName: d ? displayName(d) : l.deviceId, commandId: l.commandId, ticket: l.ticket, tier: l.tier, receivedAt: l.receivedAt, fix: await openJson<LocationFix>(l.sealed, this.state.keys.locationKey) });
    }
    inc.viewAudit ??= {};
    if (!inc.viewAudit[user.id] || now - inc.viewAudit[user.id] > 15 * 60_000) {
      inc.viewAudit[user.id] = now;
      this.audit.append({ at: now, actor: user.id, actorRole: user.role, action: 'location.tracking_viewed', target: inc.deviceId, ticket: inc.ticket, detail: { incidentId: inc.id, fixes: fixes.length } });
      this.persist();
    }
    const { viewAudit: _v, ...incident } = inc;
    return {
      incident: structuredClone(incident),
      device: d ? { id: d.id, name: displayName(d), state: d.state, lostMode: d.lostMode, batteryLevel: d.telemetry?.batteryLevel ?? null, lastCheckinAt: d.lastCheckinAt } : null,
      fixes: fixes.sort((a, b) => b.fix.fixAt - a.fix.fixAt),
      trackingActive: inc.status === 'active' && now < inc.trackingUntil,
    };
  }

  private findIncident(id: string): Incident {
    const i = this.state.incidents!.find((x) => x.id === id);
    if (!i) throw new ApiError(404, 'not_found', 'Incident not found');
    return i;
  }

  /** 30-day retention job (Cloudflare Queue/cron in production). */
  async runRetention(): Promise<number> {
    const now = this.clock();
    const before = this.state.locations.length;
    const enrBefore = this.state.enrollments.length;
    this.state.locations = this.state.locations.filter((l) => now - l.receivedAt < LOCATION_RETENTION_MS);
    const purged = before - this.state.locations.length;
    this.state.enrollments = this.state.enrollments.filter((e) => now - e.createdAt < 30 * 24 * 3600_000);
    this.state.wakes = this.state.wakes.slice(-500);
    const cmdBefore = this.state.commands.length;
    this.state.commands = this.state.commands.filter((c) => !c.completedAt || now - c.completedAt < COMMAND_RETENTION_MS);
    if (cmdBefore !== this.state.commands.length) this.commandsById = new Map(this.state.commands.map((c) => [c.id, c]));
    this.state.lastPurgeAt = now;
    if (purged > 0) this.audit.append({ at: now, actor: 'system', actorRole: 'SYSTEM', action: 'location.purged', detail: { purged, retentionDays: 30 } });
    // Only notify listeners when something actually changed (avoids render loops on read paths).
    if (purged > 0 || enrBefore !== this.state.enrollments.length || cmdBefore !== this.state.commands.length) this.persist();
    return purged;
  }

  async purgeNow(sessionId: string): Promise<number> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'location.purge');
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'location.purge_requested' });
    const purged = await this.runRetention();
    this.persist();
    return purged;
  }

  locationCount(): number {
    return this.state.locations.length;
  }

  // ------------------------------------------------------------------ audit

  /** GET /admin/audit */
  listAudit(sessionId: string): AuditRow[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'audit.read');
    return [...this.audit.all()].reverse();
  }

  async verifyAudit(sessionId: string): Promise<ChainVerification> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'audit.read');
    return verifyChain(this.audit.all());
  }

  async exportAudit(sessionId: string): Promise<string> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'audit.export');
    const rows = this.audit.all();
    const verification = await verifyChain(rows);
    await this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'audit.exported', detail: { rows: rows.length, head: verification.head } });
    this.persist();
    return JSON.stringify({ exportedAt: this.clock(), verification, rows }, null, 2);
  }

  /** Test hook: raw audit rows (used to prove tamper detection). */
  rawAuditForTests(): AuditRow[] {
    return this.state.audit;
  }

  // ------------------------------------------------------------------ employee transparency

  /** Employee-facing page: what is collected + every location request for their device (30 days). */
  async transparency(deviceId: string, key: string): Promise<{
    deviceName: string;
    notice: Notice;
    acknowledgedAt: number | null;
    lostMode: boolean;
    tracking: { kind: 'lost' | 'stolen'; intervalSec: number; until: number } | null;
    continuousLocation: boolean;
    events: { at: number; type: string; ticket?: string; status: string }[];
    locations: { at: number; tier: number; lat: number; lng: number; accuracyM: number }[];
  }> {
    this.publicLimiter.check('transparency', this.clock());
    const d = this.state.devices.find((x) => x.id === deviceId);
    if (!d || !timingSafeEqual(d.transparencyKey, String(key))) throw new ApiError(404, 'not_found', 'Not found');
    await this.runRetention();
    const since = this.clock() - LOCATION_RETENTION_MS;
    const events = this.state.commands
      .filter((c) => c.deviceId === d.id && c.issuedAt >= since && ['LOCATE', 'LOST_MODE_ON', 'LOST_MODE_OFF', 'LOCK', 'WIPE'].includes(c.type))
      .map((c) => ({ at: c.issuedAt, type: c.type, ticket: c.ticket, status: c.status }))
      .sort((a, b) => b.at - a.at);
    const locations = [];
    for (const l of this.state.locations.filter((x) => x.deviceId === d.id)) {
      const f = await openJson<LocationFix>(l.sealed, this.state.keys.locationKey);
      locations.push({ at: f.fixAt, tier: l.tier, lat: f.lat, lng: f.lng, accuracyM: f.accuracyM });
    }
    return {
      deviceName: displayName(d),
      notice: this.notice(),
      acknowledgedAt: d.policyAckAt,
      lostMode: d.lostMode,
      tracking: (() => {
        const i = this.state.incidents!.find((x) => x.deviceId === d.id && x.status === 'active' && x.trackingUntil > this.clock());
        return i ? { kind: i.kind, intervalSec: i.trackingIntervalSec, until: i.trackingUntil } : null;
      })(),
      continuousLocation: d.policy.continuousLocation,
      events,
      locations: locations.sort((a, b) => b.at - a.at),
    };
  }

  // ------------------------------------------------------------------ bootstrap (first Super Admin on a fresh deployment)

  needsBootstrap(): boolean {
    return this.state.users.length === 0;
  }

  /** Creates the first Super Admin. Only works while there are no users at all. */
  async bootstrap(input: { name: string; email: string; password: string }): Promise<{ email: string; totpSecret: string; otpauthUri: string }> {
    if (!this.needsBootstrap()) throw new ApiError(409, 'already_bootstrapped', 'This deployment already has administrators');
    const acc = await this.createUser({ ...input, role: 'SUPER_ADMIN' }, 'bootstrap');
    return { email: acc.email, totpSecret: acc.totpSecret, otpauthUri: this.otpauthUri(acc.email, acc.totpSecret) };
  }

  otpauthUri(email: string, secret: string): string {
    const issuer = encodeURIComponent(this.state.settings?.orgName || 'Mob Hunter');
    return `otpauth://totp/${issuer}:${encodeURIComponent(email)}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  }

  // ------------------------------------------------------------------ admin: user lifecycle

  async adminCreateUser(sessionId: string, input: { name: string; email: string; role: Role; password: string }): Promise<{ user: PublicUser; totpSecret: string; otpauthUri: string }> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'users.manage');
    if (!input.name?.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email ?? '')) throw new ApiError(422, 'invalid_user', 'Name and a valid e-mail are required');
    const acc = await this.createUser({ ...input, name: input.name.trim() }, user.id);
    const created = this.state.users.find((u) => u.email === acc.email)!;
    return { user: publicUser(created), totpSecret: acc.totpSecret, otpauthUri: this.otpauthUri(acc.email, acc.totpSecret) };
  }

  async setUserDisabled(sessionId: string, userId: string, disabled: boolean): Promise<PublicUser> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'users.manage');
    if (userId === user.id) throw new ApiError(409, 'self_change', 'You cannot disable your own account');
    const target = this.state.users.find((u) => u.id === userId);
    if (!target) throw new ApiError(404, 'not_found', 'User not found');
    if (disabled && target.role === 'SUPER_ADMIN' && this.state.users.filter((u) => u.role === 'SUPER_ADMIN' && !u.disabled).length <= 1) {
      throw new ApiError(409, 'last_admin', 'Cannot disable the last Super Admin');
    }
    target.disabled = disabled;
    if (disabled) this.state.sessions = this.state.sessions.filter((s) => s.userId !== target.id);
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: disabled ? 'user.disabled' : 'user.enabled', target: target.id });
    this.persist();
    return publicUser(target);
  }

  /** Issues a new TOTP secret (lost phone). Existing sessions are revoked. */
  async resetUserMfa(sessionId: string, userId: string): Promise<{ totpSecret: string; otpauthUri: string }> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'users.manage');
    if (userId === user.id) throw new ApiError(409, 'self_change', 'Ask another Super Admin to reset your MFA');
    const target = this.state.users.find((u) => u.id === userId);
    if (!target) throw new ApiError(404, 'not_found', 'User not found');
    target.totpSecret = base32Encode(randomBytes(20));
    this.state.sessions = this.state.sessions.filter((s) => s.userId !== target.id);
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'user.mfa_reset', target: target.id });
    this.persist();
    return { totpSecret: target.totpSecret, otpauthUri: this.otpauthUri(target.email, target.totpSecret) };
  }

  async changePassword(sessionId: string, current: string, next: string): Promise<void> {
    const { user, session } = this.requireSession(sessionId);
    if (!timingSafeEqual(await hashPassword(String(current), user.salt, this.iterations), user.passwordHash)) throw new ApiError(401, 'invalid_credentials', 'Current password is wrong');
    if (String(next).length < 12) throw new ApiError(422, 'weak_password', 'Password must be at least 12 characters');
    user.salt = toHex(randomBytes(16));
    user.passwordHash = await hashPassword(String(next), user.salt, this.iterations);
    // keep only the current session
    this.state.sessions = this.state.sessions.filter((s) => s.userId !== user.id || s.id === session.id);
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'user.password_changed', target: user.id });
    this.persist();
  }

  listSessions(sessionId: string): { id: string; userId: string; userName: string; createdAt: number; lastSeenAt: number; current: boolean }[] {
    const { user, session } = this.requireSession(sessionId);
    this.guard(user, 'sessions.manage');
    const now = this.clock();
    return this.state.sessions
      .filter((s) => s.expiresAt > now && now - s.lastSeenAt < SESSION_IDLE_MS)
      .map((s) => ({
        // never expose the bearer value itself
        id: s.id.slice(0, 12),
        userId: s.userId,
        userName: this.state.users.find((u) => u.id === s.userId)?.name ?? s.userId,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        current: s.id === session.id,
      }));
  }

  async revokeSession(sessionId: string, sessionPrefix: string): Promise<void> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'sessions.manage');
    if (!sessionPrefix || sessionPrefix.length < 12) throw new ApiError(422, 'invalid_session', 'Unknown session');
    const target = this.state.sessions.find((s) => s.id.startsWith(sessionPrefix));
    if (!target) throw new ApiError(404, 'not_found', 'Session not found');
    this.state.sessions = this.state.sessions.filter((s) => s !== target);
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'session.revoked', target: target.userId });
    this.persist();
  }

  // ------------------------------------------------------------------ admin: employees

  async createEmployee(sessionId: string, e: Omit<Employee, 'id' | 'status'>): Promise<Employee> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'employee.manage');
    const emp = this.validateEmployee(e);
    if (this.state.employees.some((x) => x.email.toLowerCase() === emp.email.toLowerCase())) throw new ApiError(409, 'exists', 'An employee with this e-mail exists');
    const rec: Employee = { id: randomId('emp', 6), ...emp, status: 'active' };
    this.state.employees.push(rec);
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'employee.created', target: rec.id });
    this.persist();
    return { ...rec };
  }

  async updateEmployee(sessionId: string, id: string, patch: Partial<Omit<Employee, 'id' | 'status'>>): Promise<Employee> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'employee.manage');
    const rec = this.state.employees.find((x) => x.id === id);
    if (!rec) throw new ApiError(404, 'not_found', 'Employee not found');
    const next = this.validateEmployee({ name: patch.name ?? rec.name, email: patch.email ?? rec.email, department: patch.department ?? rec.department });
    Object.assign(rec, next);
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'employee.updated', target: rec.id });
    this.persist();
    return { ...rec };
  }

  /** Bulk import (CSV parsed by the client). Existing e-mails are updated, new ones created. */
  async importEmployees(sessionId: string, rows: Omit<Employee, 'id' | 'status'>[]): Promise<{ created: number; updated: number; errors: { row: number; error: string }[] }> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'employee.manage');
    if (!Array.isArray(rows) || rows.length > 5000) throw new ApiError(422, 'too_many', 'Import up to 5000 rows at a time');
    let created = 0;
    let updated = 0;
    const errors: { row: number; error: string }[] = [];
    rows.forEach((r, i) => {
      try {
        const emp = this.validateEmployee(r);
        const existing = this.state.employees.find((x) => x.email.toLowerCase() === emp.email.toLowerCase());
        if (existing) {
          Object.assign(existing, emp);
          updated++;
        } else {
          this.state.employees.push({ id: randomId('emp', 6), ...emp, status: 'active' });
          created++;
        }
      } catch (e) {
        errors.push({ row: i + 1, error: e instanceof Error ? e.message : String(e) });
      }
    });
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'employee.imported', detail: { created, updated, errors: errors.length } });
    this.persist();
    return { created, updated, errors };
  }

  /** Leaver workflow: unassigns their devices and marks the record; devices then need re-issue or retirement. */
  async offboardEmployee(sessionId: string, id: string): Promise<{ unassigned: string[] }> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'employee.manage');
    const rec = this.state.employees.find((x) => x.id === id);
    if (!rec) throw new ApiError(404, 'not_found', 'Employee not found');
    rec.status = 'leaver';
    const unassigned: string[] = [];
    for (const d of this.state.devices) {
      if (d.assignedUserId === id) {
        d.assignedUserId = null;
        unassigned.push(d.id);
      }
    }
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'employee.offboarded', target: id, detail: { unassigned } });
    this.persist();
    return { unassigned };
  }

  private validateEmployee(e: Partial<Employee>): Omit<Employee, 'id' | 'status'> {
    const name = String(e.name ?? '').trim();
    const email = String(e.email ?? '').trim().toLowerCase();
    const department = String(e.department ?? '').trim();
    if (!name || name.length > 120 || /[<>]/.test(name)) throw new ApiError(422, 'invalid_name', 'Invalid name');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new ApiError(422, 'invalid_email', `Invalid e-mail: ${email || '(empty)'}`);
    if (department.length > 120 || /[<>]/.test(department)) throw new ApiError(422, 'invalid_department', 'Invalid department');
    return { name, email, department };
  }

  // ------------------------------------------------------------------ admin: device lifecycle

  /** Decommission: revokes the certificate (device can no longer call the API) and clears the queue. */
  async retireDevice(sessionId: string, deviceId: string, reason: string): Promise<DeviceView> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.retire');
    if (!reason || reason.trim().length < 5) throw new ApiError(422, 'reason_required', 'Give a reason for retiring the device');
    const d = this.findDevice(deviceId);
    if (d.state === 'retired') throw new ApiError(409, 'already_retired', 'Device already retired');
    d.state = 'retired';
    d.lostMode = false;
    d.assignedUserId = null;
    d.pendingRemoval = null;
    this.closeIncidents(d.id, 'not_recovered', user.id, 'Device retired');
    this.state.relayQueues[d.id] = [];
    for (const c of this.state.commands) if (c.deviceId === d.id && ['queued', 'delivered', 'pending_approval'].includes(c.status)) c.status = 'expired';
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'device.retired', target: d.id, detail: { reason: reason.trim().slice(0, 300), certSerial: d.cert.serial } });
    this.persist();
    return this.deviceView(d);
  }

  /** Registers / refreshes the push (FCM) token the agent reports. */
  async registerPushToken(auth: DeviceAuth, body: { token: string }): Promise<{ ok: true }> {
    const d = await this.authenticateDevice('POST', '/v1/push-token', body, auth);
    const t = String(body?.token ?? '');
    if (t.length < 10 || t.length > 4096) throw new ApiError(422, 'invalid_token', 'Invalid push token');
    d.pushToken = t;
    this.persist();
    return { ok: true };
  }

  // ------------------------------------------------------------------ compliance

  /** Per-device compliance findings, computed server-side so every client sees the same result. */
  compliance(sessionId: string): { deviceId: string; deviceName: string; issues: ComplianceIssue[] }[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    const now = this.clock();
    return this.state.devices
      .filter((d) => d.state !== 'retired' && d.state !== 'wiped')
      .map((d) => ({ deviceId: d.id, deviceName: displayName(d), issues: complianceIssues(d, now) }))
      .sort((a, b) => b.issues.length - a.issues.length);
  }

  // ------------------------------------------------------------------ app catalogue & settings

  getSettings(sessionId: string): OrgSettings {
    this.requireSession(sessionId);
    return structuredClone(this.state.settings!);
  }

  async updateSettings(sessionId: string, patch: Partial<Pick<OrgSettings, 'orgName' | 'dpoContact' | 'siemWebhookUrl'>>): Promise<OrgSettings> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'settings.manage');
    const st = this.state.settings!;
    if (patch.orgName !== undefined) {
      const v = String(patch.orgName).trim();
      if (!v || v.length > 80 || /[<>]/.test(v)) throw new ApiError(422, 'invalid_org', 'Invalid organisation name');
      st.orgName = v;
    }
    if (patch.dpoContact !== undefined) {
      const v = String(patch.dpoContact).trim();
      if (v.length > 200 || /[<>]/.test(v)) throw new ApiError(422, 'invalid_contact', 'Invalid contact');
      st.dpoContact = v;
    }
    if (patch.siemWebhookUrl !== undefined) {
      const v = String(patch.siemWebhookUrl).trim();
      if (v && !/^https:\/\/[^\s]+$/.test(v)) throw new ApiError(422, 'invalid_url', 'Webhook must be an https:// URL');
      st.siemWebhookUrl = v || undefined;
    }
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'settings.updated', detail: { fields: Object.keys(patch) } });
    this.persist();
    return structuredClone(st);
  }

  async upsertApp(sessionId: string, app: AppCatalogEntry): Promise<AppCatalogEntry[]> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'apps.manage');
    const pkg = String(app.packageName ?? '').trim();
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(pkg)) throw new ApiError(422, 'invalid_package', 'Invalid package name');
    if (!/^https:\/\/[^\s]+$/.test(String(app.url ?? ''))) throw new ApiError(422, 'invalid_url', 'APK URL must be https://');
    if (!/^[0-9a-f]{64}$/.test(String(app.sha256 ?? '').toLowerCase())) throw new ApiError(422, 'invalid_hash', 'SHA-256 must be 64 hex characters');
    const name = String(app.name ?? '').trim().slice(0, 80) || pkg;
    const entry: AppCatalogEntry = { packageName: pkg, name, url: app.url, sha256: app.sha256.toLowerCase() };
    const apps = this.state.settings!.apps;
    const i = apps.findIndex((a) => a.packageName === pkg);
    if (i >= 0) apps[i] = entry;
    else apps.push(entry);
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'apps.upserted', detail: { packageName: pkg, sha256: entry.sha256 } });
    this.persist();
    return structuredClone(apps);
  }

  async removeApp(sessionId: string, packageName: string): Promise<AppCatalogEntry[]> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'apps.manage');
    const st = this.state.settings!;
    st.apps = st.apps.filter((a) => a.packageName !== packageName);
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'apps.removed', detail: { packageName } });
    this.persist();
    return structuredClone(st.apps);
  }

  /** The notice shown to employees, personalised with the organisation's name and DPO contact. */
  notice(): Notice {
    const st = this.state?.settings ?? defaultSettings();
    return {
      ...COLLECTION_NOTICE,
      collected: [...COLLECTION_NOTICE.collected],
      notCollected: [...COLLECTION_NOTICE.notCollected],
      title: `${st.orgName} — company device notice`,
      rights: st.dpoContact ? `${COLLECTION_NOTICE.rights} Contact: ${st.dpoContact}.` : COLLECTION_NOTICE.rights,
    };
  }

  // ------------------------------------------------------------------ privacy: data-subject access request

  /** Everything held about one employee (DSAR). Restricted to Security and always audited. */
  async exportEmployeeData(sessionId: string, employeeId: string, ticket: string): Promise<string> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'privacy.dsar');
    if (!ticket || !/^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/.test(ticket.trim())) throw new ApiError(422, 'ticket_required', 'A DSAR ticket reference is required');
    const emp = this.state.employees.find((e) => e.id === employeeId);
    if (!emp) throw new ApiError(404, 'not_found', 'Employee not found');
    const deviceIds = new Set(
      this.state.devices.filter((d) => d.assignedUserId === emp.id).map((d) => d.id),
    );
    // devices they held in the past (from the audit trail)
    for (const r of this.state.audit) {
      const after = (r.detail as { after?: { assignedUserId?: string } } | undefined)?.after;
      if (r.action === 'device.updated' && after?.assignedUserId === emp.id && r.target) deviceIds.add(r.target);
    }
    const devices = this.state.devices.filter((d) => deviceIds.has(d.id)).map((d) => {
      const { transparencyKey: _t, cert: _c, pushToken: _p, ...rest } = d;
      return rest;
    });
    const commands = this.state.commands.filter((c) => deviceIds.has(c.deviceId)).map(({ envelope: _e, ...c }) => c);
    const locations = [];
    for (const l of this.state.locations.filter((x) => deviceIds.has(x.deviceId))) {
      locations.push({ deviceId: l.deviceId, ticket: l.ticket, tier: l.tier, receivedAt: l.receivedAt, fix: await openJson<LocationFix>(l.sealed, this.state.keys.locationKey) });
    }
    this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'privacy.dsar_exported', target: emp.id, ticket: ticket.trim(), detail: { devices: devices.length, locations: locations.length } });
    this.persist();
    return JSON.stringify({ generatedAt: this.clock(), organisation: this.state.settings!.orgName, employee: emp, devices, commands, locations, notice: this.notice() }, null, 2);
  }

  // ------------------------------------------------------------------ misc read models

  pushLog(sessionId: string) {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    return [...this.state.wakes].reverse().slice(0, 50);
  }

  stats(sessionId: string) {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    const now = this.clock();
    const ds = this.state.devices;
    return {
      total: ds.length,
      unnamed: ds.filter((d) => !d.label).length,
      online: ds.filter((d) => d.lastCheckinAt && now - d.lastCheckinAt < 15 * 60_000).length,
      lost: ds.filter((d) => d.lostMode).length,
      awaitingAck: ds.filter((d) => !d.policyAckAt && d.state === 'enrolled').length,
      pendingApprovals: this.state.commands.filter((c) => c.status === 'pending_approval').length,
      auditRows: this.state.audit.length,
    };
  }

  /** Persist after an external change (e.g. simulator ticking clocks). */
  touch() {
    this.persist();
  }
}

// ------------------------------------------------------------------ helpers

export function deviceRequestMessage(method: string, path: string, ts: number, nonce: string, bodyHash: string): string {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

function publicUser(u: User): PublicUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role, disabled: u.disabled };
}

function isFiniteCoord(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function clamp(n: unknown, min: number, max: number, dflt: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
}

function sanitiseTelemetry(t: Telemetry): Telemetry {
  const integrity = ['MEETS_STRONG_INTEGRITY', 'MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY', 'NOT_EVALUATED', 'FAILED'].includes(t.integrity) ? t.integrity : 'FAILED';
  return {
    batteryLevel: clamp(t.batteryLevel, 0, 100, 0),
    batteryHealth: (['good', 'fair', 'poor'] as const).includes(t.batteryHealth) ? t.batteryHealth : 'fair',
    batteryTempC: clamp(t.batteryTempC, -20, 90, 0),
    storageFreeGb: clamp(t.storageFreeGb, 0, 4096, 0),
    storageTotalGb: clamp(t.storageTotalGb, 0, 4096, 0),
    integrity,
    patchLevel: String(t.patchLevel ?? '').slice(0, 16),
    ...(t.noBattery === true ? { noBattery: true } : {}),
    ...(t.security && typeof t.security === 'object' ? { security: sanitiseSecurity(t.security) } : {}),
  };
}

function sanitiseSecurity(s: SecurityPosture): SecurityPosture {
  const out: SecurityPosture = {};
  const flags = ['compromised', 'devOptions', 'usbDebugging', 'unknownSources', 'screenLock', 'encrypted', 'firewall', 'antivirus', 'secureBoot', 'openWifi'] as const;
  for (const k of flags) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (typeof s.pendingUpdates === 'number' && Number.isFinite(s.pendingUpdates)) out.pendingUpdates = Math.min(9999, Math.max(0, Math.round(s.pendingUpdates)));
  if (typeof s.agentVersion === 'string') out.agentVersion = s.agentVersion.replace(/[^\w.+-]/g, '').slice(0, 24);
  return out;
}

function sanitiseParams(type: CommandType, p: Record<string, unknown>, apps: AppCatalogEntry[]): Record<string, unknown> {
  switch (type) {
    case 'LOST_MODE_ON': {
      const out: Record<string, unknown> = {
        message: String(p.message ?? 'This device is company property. Please call the number below.').slice(0, 200),
        phone: String(p.phone ?? '').replace(/[^0-9+ ()-]/g, '').slice(0, 24),
      };
      // Active tracking (set only by the lost/stolen incident flow).
      if (p.trackingIntervalSec !== undefined) {
        out.trackingIntervalSec = Math.min(300, Math.max(60, Math.round(Number(p.trackingIntervalSec) || 300)));
        out.trackingUntil = Math.round(Number(p.trackingUntil) || 0);
        out.kind = p.kind === 'stolen' ? 'stolen' : 'lost';
      }
      return out;
    }
    case 'INSTALL_APP': {
      const pkg = String(p.packageName ?? '');
      if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(pkg)) throw new ApiError(422, 'invalid_package', 'Invalid package name');
      // Only apps in the approved catalogue can be pushed; the device verifies the SHA-256 before installing.
      const app = apps.find((a) => a.packageName === pkg);
      if (!app) throw new ApiError(422, 'not_in_catalogue', 'App is not in the approved app catalogue');
      return { packageName: app.packageName, url: app.url, sha256: app.sha256, name: app.name };
    }
    case 'LOCK':
      return { message: String(p.message ?? '').slice(0, 120) };
    case 'MESSAGE': {
      const text = String(p.text ?? '').trim();
      if (text.length < 1 || text.length > 300) throw new ApiError(422, 'invalid_message', 'Message must be 1–300 characters');
      return { title: String(p.title ?? '').trim().slice(0, 60) || 'Message from your IT team', text };
    }
    case 'UNINSTALL_APP': {
      const pkg = String(p.packageName ?? '');
      // Only catalogue apps (the ones the organisation installed) can be removed — never personal apps.
      const app = apps.find((a) => a.packageName === pkg);
      if (!app) throw new ApiError(422, 'not_in_catalogue', 'Only apps from the approved catalogue can be uninstalled');
      return { packageName: app.packageName, name: app.name };
    }
    default:
      return {};
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Working hours are evaluated in the policy's time zone, not the server's or browser's. */
export function withinWorkingHours(policy: DevicePolicy, at: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: policy.workingHours.timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(at));
  const day = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return policy.workingHours.days.includes(day) && hour >= policy.workingHours.startHour && hour < policy.workingHours.endHour;
}

export type Notice = Omit<typeof COLLECTION_NOTICE, 'title' | 'rights' | 'collected' | 'notCollected'> & {
  title: string;
  rights: string;
  collected: string[];
  notCollected: string[];
};

export function defaultSettings(): OrgSettings {
  return { orgName: 'Mob Hunter', dpoContact: '', apps: [] };
}

export type ComplianceIssue =
  | { code: 'not_acknowledged'; severity: 'warn'; text: string }
  | { code: 'stale_checkin'; severity: 'bad'; text: string }
  | { code: 'never_checked_in'; severity: 'bad'; text: string }
  | { code: 'low_battery'; severity: 'warn'; text: string }
  | { code: 'integrity'; severity: 'bad' | 'warn'; text: string }
  | { code: 'old_patch'; severity: 'warn' | 'bad'; text: string }
  | { code: 'low_storage'; severity: 'warn'; text: string }
  | { code: 'unassigned'; severity: 'warn'; text: string }
  | { code: 'lost'; severity: 'bad'; text: string }
  | { code: 'compromised' | 'no_screen_lock' | 'not_encrypted' | 'antivirus_off'; severity: 'bad'; text: string }
  | { code: 'firewall_off'; severity: 'warn'; text: string };

/** Pure compliance rules (unit-tested). */
export function complianceIssues(d: Device, now: number): ComplianceIssue[] {
  const out: ComplianceIssue[] = [];
  if (d.lostMode) out.push({ code: 'lost', severity: 'bad', text: 'Device is in Lost Mode' });
  if (!d.policyAckAt) out.push({ code: 'not_acknowledged', severity: 'warn', text: 'Employee has not acknowledged the notice' });
  if (!d.lastCheckinAt) out.push({ code: 'never_checked_in', severity: 'bad', text: 'Never checked in' });
  else if (now - d.lastCheckinAt > STALE_CHECKIN_MS) out.push({ code: 'stale_checkin', severity: 'bad', text: `No check-in for ${Math.floor((now - d.lastCheckinAt) / 86_400_000)} day(s)` });
  if (!d.label || !d.assignedUserId) out.push({ code: 'unassigned', severity: 'warn', text: 'Not named or not assigned to an employee' });
  const t = d.telemetry;
  if (t) {
    if (!t.noBattery && t.batteryLevel < 15) out.push({ code: 'low_battery', severity: 'warn', text: `Battery ${t.batteryLevel}%` });
    // Play Integrity exists on Android only; computers report their integrity through the security posture.
    if (t.integrity === 'FAILED') out.push({ code: 'integrity', severity: 'bad', text: 'Play Integrity failed — possible rooted/tampered device' });
    else if (t.integrity === 'NOT_EVALUATED' && (d.platform ?? 'android') === 'android') out.push({ code: 'integrity', severity: 'warn', text: 'Play Integrity not evaluated' });
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.patchLevel);
    if (m) {
      const ageDays = Math.floor((now - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86_400_000);
      if (ageDays > 180) out.push({ code: 'old_patch', severity: 'bad', text: `Security patch ${ageDays} days old` });
      else if (ageDays > 90) out.push({ code: 'old_patch', severity: 'warn', text: `Security patch ${ageDays} days old` });
    }
    const sec = t.security ?? {};
    if (sec.compromised) out.push({ code: 'compromised', severity: 'bad', text: 'OS integrity broken (rooted / jailbroken / protection disabled)' });
    if (sec.screenLock === false) out.push({ code: 'no_screen_lock', severity: 'bad', text: 'No screen lock' });
    if (sec.encrypted === false) out.push({ code: 'not_encrypted', severity: 'bad', text: 'Storage not encrypted' });
    if (sec.firewall === false) out.push({ code: 'firewall_off', severity: 'warn', text: 'Firewall off' });
    if (sec.antivirus === false) out.push({ code: 'antivirus_off', severity: 'bad', text: 'Malware protection off' });
    if (t.storageTotalGb > 0 && t.storageFreeGb / t.storageTotalGb < 0.1) out.push({ code: 'low_storage', severity: 'warn', text: 'Less than 10% storage free' });
  }
  return out;
}

export { can };

/** Commands that need the agent to be device owner (factory reset + provisioning QR). */
const DEVICE_OWNER_ONLY: ReadonlySet<CommandType> = new Set(['WIPE', 'REBOOT', 'INSTALL_APP', 'UNINSTALL_APP']);

/** What the desktop agent (Windows, Linux, macOS) can run. LOCATE, Lost Mode, ring, apps and wipe are phone-only. */
const DESKTOP_COMMANDS: ReadonlySet<CommandType> = new Set(['LOCK', 'SYNC_POLICY', 'MESSAGE', 'REBOOT', 'RELEASE']);

/** Why a command cannot run on this device, or null. Keeps admins from queuing commands that can only fail. */
export function unsupportedReason(d: Pick<Device, 'managementMode' | 'capabilities'> & { platform?: Platform }, type: CommandType): string | null {
  if (d.platform === 'ios') return 'iOS devices need Apple MDM (an Apple push certificate); no command can be sent to them yet.';
  if (d.platform === 'windows' || d.platform === 'linux' || d.platform === 'macos') {
    if (!DESKTOP_COMMANDS.has(type)) return 'Not available on computers: locate, Lost Mode, ring, app installs and wipe are for phones. Lock, message, reboot and policy sync work.';
    if (type === 'REBOOT' && d.managementMode === 'standard') return 'Reboot needs the agent installed as a system service (administrator / root).';
    return null;
  }
  if (d.managementMode !== 'standard') return null;
  if (DEVICE_OWNER_ONLY.has(type)) return 'Not available on a phone enrolled without a factory reset (standard enrolment). Re-enrol it as a company device to wipe, reboot or install apps.';
  if (type === 'LOCK' && !d.capabilities?.deviceAdmin) return 'Remote lock is off on this phone: the user has not allowed it in the Mob Hunter app.';
  return null;
}

function sanitiseCapabilities(c: Partial<DeviceCapabilities>): DeviceCapabilities {
  return {
    deviceOwner: c.deviceOwner === true,
    deviceAdmin: c.deviceAdmin === true,
    notifications: c.notifications === true,
    location: c.location === 'background' || c.location === 'foreground' ? c.location : 'none',
  };
}

export const RESTRICTION_KEYS = ['cameraDisabled', 'screenCaptureDisabled', 'bluetoothDisabled', 'disallowAddUser', 'disallowConfigWifi'] as const;

export type PolicyPatch = Partial<
  Pick<DevicePolicy, 'continuousLocation' | 'continuousIntervalMin' | 'workingHours' | 'passwordMinLength' | 'maxTimeToLockSec' | (typeof RESTRICTION_KEYS)[number]>
>;

/** Commands that may be sent to many phones at once. Ticketed / destructive ones stay one-by-one. */
export const BULK_COMMANDS: ReadonlySet<CommandType> = new Set(['LOCK', 'SYNC_POLICY', 'REBOOT', 'MESSAGE', 'RING', 'INSTALL_APP', 'UNINSTALL_APP']);

/** Tags: up to 10, each 1–30 letters, digits, spaces, - or _; trimmed, de-duplicated (case-insensitive). */
export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) throw new ApiError(422, 'invalid_tags', 'Tags must be a list');
  const out: string[] = [];
  for (const raw of tags) {
    const t = String(raw).trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > 30 || !/^[\p{L}\p{N} _-]+$/u.test(t)) throw new ApiError(422, 'invalid_tags', `Invalid tag “${t.slice(0, 30)}”: use letters, digits, spaces, - or _ (max 30)`);
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  if (out.length > 10) throw new ApiError(422, 'invalid_tags', 'At most 10 tags per device');
  return out;
}
