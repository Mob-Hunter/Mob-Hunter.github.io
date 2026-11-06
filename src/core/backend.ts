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
  LocationFix,
  ProvisioningPayload,
  PublicUser,
  Session,
  SignedCommand,
  StoredLocation,
  Telemetry,
  User,
} from './types';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const LOCATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_REQUEST_WINDOW_MS = 5 * 60 * 1000;
export const CERT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
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
    this.state = state;
    this.audit = new AuditLog(state.audit);
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

  private deviceView(d: Device): DeviceView {
    const { transparencyKey: _t, cert, ...rest } = d;
    return {
      ...structuredClone(rest),
      displayName: displayName(d),
      certSerial: cert.serial,
      certNotAfter: cert.notAfter,
      assignedUser: this.state.employees.find((e) => e.id === d.assignedUserId) ?? null,
      queuedCommands: this.state.relayQueues[d.id]?.length ?? 0,
    };
  }

  /** GET /admin/devices */
  listDevices(sessionId: string, filter: { q?: string; unnamedOnly?: boolean } = {}): DeviceView[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    const q = filter.q?.trim().toLowerCase();
    return this.state.devices
      .filter((d) => (filter.unnamedOnly ? !d.label : true))
      .map((d) => this.deviceView(d))
      .filter((d) =>
        q ? [d.displayName, d.serial, d.model, d.id, d.assignedUser?.name].some((v) => v?.toLowerCase().includes(q)) : true,
      )
      .sort((a, b) => (b.lastCheckinAt ?? b.enrolledAt) - (a.lastCheckinAt ?? a.enrolledAt));
  }

  getDevice(sessionId: string, deviceId: string): DeviceView {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.read');
    return this.deviceView(this.findDevice(deviceId));
  }

  private findDevice(id: string): Device {
    const d = this.state.devices.find((x) => x.id === id);
    if (!d) throw new ApiError(404, 'not_found', 'Device not found');
    return d;
  }

  /** PATCH /admin/devices/{id} — rename and assign to an employee. */
  async updateDevice(sessionId: string, deviceId: string, patch: { label?: string | null; assignedUserId?: string | null }): Promise<DeviceView> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'device.update');
    const d = this.findDevice(deviceId);
    const before = { label: d.label, assignedUserId: d.assignedUserId };
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
    await this.audit.append({
      at: this.clock(),
      actor: user.id,
      actorRole: user.role,
      action: 'device.updated',
      target: d.id,
      detail: { before, after: { label: d.label, assignedUserId: d.assignedUserId } },
    });
    this.persist();
    return this.deviceView(d);
  }

  async updatePolicy(sessionId: string, deviceId: string, patch: Partial<Pick<DevicePolicy, 'continuousLocation' | 'continuousIntervalMin' | 'workingHours' | 'passwordMinLength' | 'maxTimeToLockSec'>>, justification: string): Promise<DeviceView> {
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
      sideloadApkUrl: `${this.apiBaseUrl}/apk/1.0.0`,
    };
  }

  private async provisioningFor(token: string, wifiSsid?: string): Promise<ProvisioningPayload> {
    return buildProvisioningPayload({
      apiBaseUrl: this.apiBaseUrl,
      token,
      serverPin: await this.serverPin(),
      wifi: wifiSsid ? { ssid: wifiSsid, security: 'WPA' } : undefined,
    });
  }

  listEnrollments(sessionId: string): Omit<EnrollmentToken, 'tokenHash'>[] {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'enrollment.create');
    return this.state.enrollments.map(({ tokenHash: _h, ...r }) => ({ ...r })).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** GET /e/{token} — public install page data. Reveals nothing once used or expired. */
  async installPage(token: string): Promise<
    { status: 'valid'; expiresAt: number; provisioning: ProvisioningPayload; sideloadApkUrl: string } | { status: 'used' | 'expired' | 'invalid' }
  > {
    this.publicLimiter.check('install', this.clock());
    if (typeof token !== 'string' || token.length < 16 || token.length > 64) return { status: 'invalid' };
    const hash = await sha256Hex(token);
    const found = this.state.enrollments.find((e) => e.tokenHash === hash);
    if (!found) return { status: 'invalid' };
    if (found.usedAt) return { status: 'used' };
    if (found.expiresAt < this.clock()) return { status: 'expired' };
    return { status: 'valid', expiresAt: found.expiresAt, provisioning: await this.provisioningFor(token), sideloadApkUrl: `${this.apiBaseUrl}/apk/1.0.0` };
  }

  /** POST /v1/enroll — exchanges the one-time token for a device id and a client certificate. */
  async enroll(input: {
    token: string;
    devicePublicKey: string;
    platform?: 'android';
    hardware: { serial: string; model: string; os: string };
  }): Promise<{ deviceId: string; cert: DeviceCertificate; certSig: string; serverPublicKey: string; caPublicKey: string; policy: DevicePolicy; notice: typeof COLLECTION_NOTICE }> {
    const now = this.clock();
    this.enrollLimiter.check('enroll', now);
    if (!/^[0-9a-f]{64}$/.test(input.devicePublicKey ?? '')) throw new ApiError(422, 'invalid_key', 'Device public key must be a 32-byte Ed25519 key');
    const hash = await sha256Hex(String(input.token ?? ''));
    const rec = this.state.enrollments.find((e) => e.tokenHash === hash);
    if (!rec) throw new ApiError(401, 'invalid_token', 'Unknown enrolment token');
    if (rec.usedAt) throw new ApiError(410, 'token_used', 'Enrolment token has already been used');
    if (rec.expiresAt < now) throw new ApiError(410, 'token_expired', 'Enrolment token has expired');
    rec.usedAt = now; // single-use: burnt before anything else can fail

    const deviceId = randomId('dev', 9);
    const cert: DeviceCertificate = {
      serial: toHex(randomBytes(8)),
      deviceId,
      publicKey: input.devicePublicKey,
      issuer: this.state.keys.deviceCa.kid,
      notBefore: now,
      notAfter: now + CERT_LIFETIME_MS,
    };
    const certSig = await signEd25519(canonicalJson(cert), this.state.keys.deviceCa.secretKey);
    const device: Device = {
      id: deviceId,
      platform: 'android',
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
    };
    rec.deviceId = deviceId;
    this.state.devices.push(device);
    this.state.relayQueues[deviceId] = [];
    await this.audit.append({ at: now, actor: deviceId, actorRole: 'DEVICE', action: 'device.enrolled', target: deviceId, detail: { enrollment: rec.id, certSerial: cert.serial } });
    this.persist();
    return {
      deviceId,
      cert,
      certSig,
      serverPublicKey: this.state.keys.commandSigning.publicKey,
      caPublicKey: this.state.keys.deviceCa.publicKey,
      policy: structuredClone(device.policy),
      notice: COLLECTION_NOTICE,
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
    if (!(await verifyEd25519(canonicalJson(auth.cert), auth.certSig, this.state.keys.deviceCa.publicKey))) fail('Certificate not issued by this CA');
    if (canonicalJson(auth.cert) !== canonicalJson(device.cert)) fail('Certificate does not match device record');
    if (auth.cert.notAfter < now || auth.cert.notBefore > now + 60_000) fail('Certificate not valid now');
    if (Math.abs(now - auth.ts) > DEVICE_REQUEST_WINDOW_MS) fail('Request timestamp outside allowed window');
    const bodyHash = await sha256Hex(canonicalJson(body ?? null));
    if (bodyHash !== auth.bodyHash) fail('Body hash mismatch');
    const msg = deviceRequestMessage(method, path, auth.ts, auth.nonce, auth.bodyHash);
    if (!(await verifyEd25519(msg, auth.sig, auth.cert.publicKey))) fail('Bad request signature');
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
  async checkin(auth: DeviceAuth, body: { telemetry: Telemetry; serial: string; model: string; os: string; policyAck?: { version: string; at: number } }): Promise<{ ok: true; state: Device['state']; policyVersion: number; pendingCommands: number; transparencyUrl: string }> {
    const d = await this.authenticateDevice('POST', '/v1/checkin', body, auth);
    const now = this.clock();
    d.lastCheckinAt = now;
    if (body.serial) d.serial = String(body.serial).slice(0, 64);
    if (body.model) d.model = String(body.model).slice(0, 64);
    if (body.os) d.os = String(body.os).slice(0, 64);
    if (body.telemetry) d.telemetry = sanitiseTelemetry(body.telemetry);
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
      const relay = this.relayFor(d.id);
      const out = relay.pull(this.clock());
      d.lastCheckinAt = this.clock();
      this.persist();
      return structuredClone(out);
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
      await this.audit.append({ at: now, actor: d.id, actorRole: 'DEVICE', action: `command.${status}`, target: d.id, ticket: cmd.ticket, detail: { commandId: cmd.id, type: cmd.type } });
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
      if (await this.storeLocation(d, fix, null, fix.tier)) accepted++;
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
    const stored: StoredLocation = { id, deviceId: d.id, commandId: cmd?.id ?? null, ticket: cmd?.ticket ?? null, tier, receivedAt: this.clock(), sealed };
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
        break;
      case 'WIPE':
        d.state = 'wiped';
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

  /** POST /admin/devices/{id}/commands */
  async issueCommand(sessionId: string, deviceId: string, input: { type: CommandType; ticket?: string; reason?: string; params?: Record<string, unknown> }): Promise<CommandRecord> {
    const { user } = this.requireSession(sessionId);
    if (!isCommandType(input.type)) throw new ApiError(422, 'invalid_command', 'Unknown command type');
    this.guard(user, `command.${input.type}`);
    const d = this.findDevice(deviceId);
    if (d.state === 'wiped' || d.state === 'retired') throw new ApiError(409, 'device_inactive', 'Device is wiped or retired');
    const ticket = input.ticket?.trim();
    if (TICKET_REQUIRED.has(input.type)) {
      if (!ticket || !/^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/.test(ticket)) throw new ApiError(422, 'ticket_required', 'A ticket reference like INC-1234 is required for this command');
      if (!input.reason || input.reason.trim().length < 5) throw new ApiError(422, 'reason_required', 'Describe why this action is necessary');
    }
    if ((input.type === 'LOCATE' || input.type === 'LOST_MODE_ON') && !d.policyAckAt) {
      throw new ApiError(409, 'not_acknowledged', 'The user has not acknowledged the device notice yet — location cannot be collected');
    }
    const params = sanitiseParams(input.type, input.params ?? {});
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

  /** GET /admin/location-results — Location Operator only; every read is audited. */
  async listLocationResults(sessionId: string, filter: { deviceId?: string; ticket: string }): Promise<LocationView[]> {
    const { user } = this.requireSession(sessionId);
    this.guard(user, 'location.read');
    const ticket = filter.ticket?.trim();
    if (!ticket || !/^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/.test(ticket)) throw new ApiError(422, 'ticket_required', 'Viewing location data requires a ticket reference');
    await this.runRetention();
    const rows = this.state.locations.filter((l) => (filter.deviceId ? l.deviceId === filter.deviceId : true));
    const out: LocationView[] = [];
    for (const l of rows) {
      const fix = await openJson<LocationFix>(l.sealed, this.state.keys.locationKey);
      const d = this.state.devices.find((x) => x.id === l.deviceId);
      out.push({ id: l.id, deviceId: l.deviceId, deviceName: d ? displayName(d) : l.deviceId, commandId: l.commandId, ticket: l.ticket, tier: l.tier, receivedAt: l.receivedAt, fix });
    }
    await this.audit.append({ at: this.clock(), actor: user.id, actorRole: user.role, action: 'location.viewed', target: filter.deviceId ?? '*', ticket, detail: { results: out.length } });
    this.persist();
    return out.sort((a, b) => b.receivedAt - a.receivedAt);
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
    this.state.lastPurgeAt = now;
    if (purged > 0) this.audit.append({ at: now, actor: 'system', actorRole: 'SYSTEM', action: 'location.purged', detail: { purged, retentionDays: 30 } });
    // Only notify listeners when something actually changed (avoids render loops on read paths).
    if (purged > 0 || enrBefore !== this.state.enrollments.length) this.persist();
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
    notice: typeof COLLECTION_NOTICE;
    acknowledgedAt: number | null;
    lostMode: boolean;
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
      notice: COLLECTION_NOTICE,
      acknowledgedAt: d.policyAckAt,
      lostMode: d.lostMode,
      continuousLocation: d.policy.continuousLocation,
      events,
      locations: locations.sort((a, b) => b.at - a.at),
    };
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
  const integrity = ['MEETS_STRONG_INTEGRITY', 'MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY', 'FAILED'].includes(t.integrity) ? t.integrity : 'FAILED';
  return {
    batteryLevel: clamp(t.batteryLevel, 0, 100, 0),
    batteryHealth: (['good', 'fair', 'poor'] as const).includes(t.batteryHealth) ? t.batteryHealth : 'fair',
    batteryTempC: clamp(t.batteryTempC, -20, 90, 0),
    storageFreeGb: clamp(t.storageFreeGb, 0, 4096, 0),
    storageTotalGb: clamp(t.storageTotalGb, 0, 4096, 0),
    integrity,
    patchLevel: String(t.patchLevel ?? '').slice(0, 16),
  };
}

function sanitiseParams(type: CommandType, p: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'LOST_MODE_ON':
      return {
        message: String(p.message ?? 'This device is company property. Please call the number below.').slice(0, 200),
        phone: String(p.phone ?? '').replace(/[^0-9+ ()-]/g, '').slice(0, 24),
      };
    case 'INSTALL_APP': {
      const pkg = String(p.packageName ?? '');
      if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(pkg)) throw new ApiError(422, 'invalid_package', 'Invalid package name');
      return { packageName: pkg };
    }
    case 'LOCK':
      return { message: String(p.message ?? '').slice(0, 120) };
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

export { can };
