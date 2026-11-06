/**
 * Console API: everything the admin UI can do, as one async interface with two
 * implementations:
 *  - LocalConsoleApi: the in-browser reference backend (GitHub Pages demo).
 *  - RemoteConsoleApi: a FleetGuard server (Cloudflare Worker) over HTTPS with
 *    an HttpOnly session cookie + CSRF header.
 * Every authorisation decision is made by the backend in both cases.
 */
import type { Backend, ComplianceIssue, DeviceView, LocationView, Notice } from '../core/backend';
import { ApiError } from '../core/backend';
import type { AuditRow, ChainVerification } from '../core/audit';
import type { CommandType, Role } from '../core/rbac';
import type { AppCatalogEntry, CommandRecord, DevicePolicy, Employee, EnrollmentToken, OrgSettings, ProvisioningPayload, PublicUser, PushWake } from '../core/types';

export type Command = Omit<CommandRecord, 'envelope'>;
export type Stats = ReturnType<Backend['stats']>;
export type SessionInfo = ReturnType<Backend['listSessions']>[number];
export type Transparency = Awaited<ReturnType<Backend['transparency']>>;
export type InstallPageData = Awaited<ReturnType<Backend['installPage']>>;
export type Enrollment = Awaited<ReturnType<Backend['createEnrollment']>>;
export type PolicyPatch = Parameters<Backend['updatePolicy']>[2];
export type Health = { service: 'fleetguard'; mode: 'demo' | 'server'; version: string; needsBootstrap: boolean; sso: boolean };
export type { ComplianceIssue, DeviceView, LocationView, Notice };

export interface ConsoleApi {
  readonly mode: 'demo' | 'server';
  health(): Promise<Health>;
  bootstrap(input: { token: string; name: string; email: string; password: string }): Promise<{ email: string; totpSecret: string; otpauthUri: string }>;
  // auth
  login(email: string, password: string): Promise<{ challengeId: string }>;
  verifyMfa(challengeId: string, code: string): Promise<PublicUser>;
  sso(): Promise<PublicUser>;
  logout(): Promise<void>;
  me(): Promise<PublicUser>;
  changePassword(current: string, next: string): Promise<void>;
  // devices
  stats(): Promise<Stats>;
  listDevices(filter?: { q?: string; unnamedOnly?: boolean }): Promise<DeviceView[]>;
  getDevice(id: string): Promise<DeviceView>;
  updateDevice(id: string, patch: { label?: string | null; assignedUserId?: string | null }): Promise<DeviceView>;
  updatePolicy(id: string, patch: PolicyPatch, justification: string): Promise<DeviceView>;
  retireDevice(id: string, reason: string): Promise<DeviceView>;
  compliance(): Promise<{ deviceId: string; deviceName: string; issues: ComplianceIssue[] }[]>;
  // commands
  issueCommand(deviceId: string, input: { type: CommandType; ticket?: string; reason?: string; params?: Record<string, unknown> }): Promise<Command>;
  approveCommand(id: string, approve: boolean): Promise<Command>;
  listCommands(deviceId?: string): Promise<Command[]>;
  pushLog(): Promise<PushWake[]>;
  // enrolment
  createEnrollment(opts?: { note?: string; wifiSsid?: string }): Promise<Enrollment>;
  listEnrollments(): Promise<Omit<EnrollmentToken, 'tokenHash'>[]>;
  installPage(token: string): Promise<InstallPageData>;
  // location
  listLocationResults(filter: { deviceId?: string; ticket: string }): Promise<LocationView[]>;
  purgeNow(): Promise<number>;
  // audit
  listAudit(): Promise<AuditRow[]>;
  verifyAudit(): Promise<ChainVerification>;
  exportAudit(): Promise<string>;
  // people
  listUsers(): Promise<PublicUser[]>;
  createUser(input: { name: string; email: string; role: Role; password: string }): Promise<{ user: PublicUser; totpSecret: string; otpauthUri: string }>;
  setUserRole(id: string, role: Role): Promise<PublicUser>;
  setUserDisabled(id: string, disabled: boolean): Promise<PublicUser>;
  resetUserMfa(id: string): Promise<{ totpSecret: string; otpauthUri: string }>;
  listSessions(): Promise<SessionInfo[]>;
  revokeSession(id: string): Promise<void>;
  listEmployees(): Promise<Employee[]>;
  createEmployee(e: Omit<Employee, 'id' | 'status'>): Promise<Employee>;
  updateEmployee(id: string, patch: Partial<Omit<Employee, 'id' | 'status'>>): Promise<Employee>;
  importEmployees(rows: Omit<Employee, 'id' | 'status'>[]): Promise<{ created: number; updated: number; errors: { row: number; error: string }[] }>;
  offboardEmployee(id: string): Promise<{ unassigned: string[] }>;
  exportEmployeeData(id: string, ticket: string): Promise<string>;
  // settings
  getSettings(): Promise<OrgSettings>;
  updateSettings(patch: Partial<Pick<OrgSettings, 'orgName' | 'dpoContact' | 'siemWebhookUrl'>>): Promise<OrgSettings>;
  upsertApp(app: AppCatalogEntry): Promise<AppCatalogEntry[]>;
  removeApp(packageName: string): Promise<AppCatalogEntry[]>;
  // public
  transparency(deviceId: string, key: string): Promise<Transparency>;
}

// ------------------------------------------------------------------ demo (in-browser)

export class LocalConsoleApi implements ConsoleApi {
  readonly mode = 'demo' as const;
  constructor(private readonly b: Backend, private readonly sid: { get(): string | null; set(v: string | null): void }) {}
  private get s(): string {
    const v = this.sid.get();
    if (!v) throw new ApiError(401, 'unauthenticated', 'Please sign in');
    return v;
  }
  async health(): Promise<Health> {
    return { service: 'fleetguard', mode: 'demo', version: '2.0.0', needsBootstrap: this.b.needsBootstrap(), sso: false };
  }
  bootstrap(input: { token: string; name: string; email: string; password: string }) {
    return this.b.bootstrap(input);
  }
  login(email: string, password: string) {
    return this.b.login(email, password);
  }
  async verifyMfa(challengeId: string, code: string) {
    const r = await this.b.verifyMfa(challengeId, code);
    this.sid.set(r.sessionId);
    return r.user;
  }
  async sso(): Promise<PublicUser> {
    throw new ApiError(404, 'sso_disabled', 'Single sign-on is only available on a FleetGuard server');
  }
  async logout() {
    const v = this.sid.get();
    this.sid.set(null);
    if (v) await this.b.logout(v);
  }
  async me() {
    return this.b.me(this.s);
  }
  changePassword(current: string, next: string) {
    return this.b.changePassword(this.s, current, next);
  }
  async stats() {
    return this.b.stats(this.s);
  }
  async listDevices(filter: { q?: string; unnamedOnly?: boolean } = {}) {
    return this.b.listDevices(this.s, filter);
  }
  async getDevice(id: string) {
    return this.b.getDevice(this.s, id);
  }
  updateDevice(id: string, patch: { label?: string | null; assignedUserId?: string | null }) {
    return this.b.updateDevice(this.s, id, patch);
  }
  updatePolicy(id: string, patch: PolicyPatch, justification: string) {
    return this.b.updatePolicy(this.s, id, patch, justification);
  }
  retireDevice(id: string, reason: string) {
    return this.b.retireDevice(this.s, id, reason);
  }
  async compliance() {
    return this.b.compliance(this.s);
  }
  async issueCommand(deviceId: string, input: { type: CommandType; ticket?: string; reason?: string; params?: Record<string, unknown> }) {
    const { envelope: _e, ...c } = await this.b.issueCommand(this.s, deviceId, input);
    return c;
  }
  async approveCommand(id: string, approve: boolean) {
    const { envelope: _e, ...c } = await this.b.approveCommand(this.s, id, approve);
    return c;
  }
  async listCommands(deviceId?: string) {
    return this.b.listCommands(this.s, deviceId);
  }
  async pushLog() {
    return this.b.pushLog(this.s);
  }
  createEnrollment(opts?: { note?: string; wifiSsid?: string }) {
    return this.b.createEnrollment(this.s, opts);
  }
  async listEnrollments() {
    return this.b.listEnrollments(this.s);
  }
  installPage(token: string) {
    return this.b.installPage(token);
  }
  listLocationResults(filter: { deviceId?: string; ticket: string }) {
    return this.b.listLocationResults(this.s, filter);
  }
  purgeNow() {
    return this.b.purgeNow(this.s);
  }
  async listAudit() {
    return this.b.listAudit(this.s);
  }
  verifyAudit() {
    return this.b.verifyAudit(this.s);
  }
  exportAudit() {
    return this.b.exportAudit(this.s);
  }
  async listUsers() {
    return this.b.listUsers(this.s);
  }
  createUser(input: { name: string; email: string; role: Role; password: string }) {
    return this.b.adminCreateUser(this.s, input);
  }
  setUserRole(id: string, role: Role) {
    return this.b.setUserRole(this.s, id, role);
  }
  setUserDisabled(id: string, disabled: boolean) {
    return this.b.setUserDisabled(this.s, id, disabled);
  }
  resetUserMfa(id: string) {
    return this.b.resetUserMfa(this.s, id);
  }
  async listSessions() {
    return this.b.listSessions(this.s);
  }
  revokeSession(id: string) {
    return this.b.revokeSession(this.s, id);
  }
  async listEmployees() {
    return this.b.listEmployees(this.s);
  }
  createEmployee(e: Omit<Employee, 'id' | 'status'>) {
    return this.b.createEmployee(this.s, e);
  }
  updateEmployee(id: string, patch: Partial<Omit<Employee, 'id' | 'status'>>) {
    return this.b.updateEmployee(this.s, id, patch);
  }
  importEmployees(rows: Omit<Employee, 'id' | 'status'>[]) {
    return this.b.importEmployees(this.s, rows);
  }
  offboardEmployee(id: string) {
    return this.b.offboardEmployee(this.s, id);
  }
  exportEmployeeData(id: string, ticket: string) {
    return this.b.exportEmployeeData(this.s, id, ticket);
  }
  async getSettings() {
    return this.b.getSettings(this.s);
  }
  updateSettings(patch: Partial<Pick<OrgSettings, 'orgName' | 'dpoContact' | 'siemWebhookUrl'>>) {
    return this.b.updateSettings(this.s, patch);
  }
  upsertApp(app: AppCatalogEntry) {
    return this.b.upsertApp(this.s, app);
  }
  removeApp(packageName: string) {
    return this.b.removeApp(this.s, packageName);
  }
  transparency(deviceId: string, key: string) {
    return this.b.transparency(deviceId, key);
  }
}

// ------------------------------------------------------------------ server (HTTPS)

export class RemoteConsoleApi implements ConsoleApi {
  readonly mode = 'server' as const;
  constructor(private readonly base = './api', private readonly fetcher: typeof fetch = (...a) => fetch(...a)) {}

  private async req<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'x-fleetguard-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw && res.ok) return (await res.text()) as T;
    const j = (await res.json().catch(() => ({ error: 'http_error', message: `HTTP ${res.status}` }))) as { error?: string; message?: string };
    if (!res.ok) throw new ApiError(res.status, j.error ?? 'http_error', j.message ?? `HTTP ${res.status}`);
    return j as T;
  }
  private q(o: Record<string, string | undefined | boolean>) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== false && v !== '') p.set(k, v === true ? '1' : v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }
  health() {
    return this.req<Health>('GET', '/health');
  }
  bootstrap(input: { token: string; name: string; email: string; password: string }) {
    return this.req<{ email: string; totpSecret: string; otpauthUri: string }>('POST', '/bootstrap', input);
  }
  login(email: string, password: string) {
    return this.req<{ challengeId: string }>('POST', '/admin/login', { email, password });
  }
  async verifyMfa(challengeId: string, code: string) {
    return (await this.req<{ user: PublicUser }>('POST', '/admin/mfa', { challengeId, code })).user;
  }
  async sso() {
    return (await this.req<{ user: PublicUser }>('POST', '/admin/sso', {})).user;
  }
  async logout() {
    await this.req('POST', '/admin/logout', {});
  }
  me() {
    return this.req<PublicUser>('GET', '/admin/me');
  }
  async changePassword(current: string, next: string) {
    await this.req('POST', '/admin/me/password', { current, next });
  }
  stats() {
    return this.req<Stats>('GET', '/admin/stats');
  }
  listDevices(filter: { q?: string; unnamedOnly?: boolean } = {}) {
    return this.req<DeviceView[]>('GET', `/admin/devices${this.q({ q: filter.q, unnamed: filter.unnamedOnly })}`);
  }
  getDevice(id: string) {
    return this.req<DeviceView>('GET', `/admin/devices/${encodeURIComponent(id)}`);
  }
  updateDevice(id: string, patch: { label?: string | null; assignedUserId?: string | null }) {
    return this.req<DeviceView>('PATCH', `/admin/devices/${encodeURIComponent(id)}`, patch);
  }
  updatePolicy(id: string, patch: PolicyPatch, justification: string) {
    return this.req<DeviceView>('POST', `/admin/devices/${encodeURIComponent(id)}/policy`, { patch, justification });
  }
  retireDevice(id: string, reason: string) {
    return this.req<DeviceView>('POST', `/admin/devices/${encodeURIComponent(id)}/retire`, { reason });
  }
  compliance() {
    return this.req<{ deviceId: string; deviceName: string; issues: ComplianceIssue[] }[]>('GET', '/admin/compliance');
  }
  issueCommand(deviceId: string, input: { type: CommandType; ticket?: string; reason?: string; params?: Record<string, unknown> }) {
    return this.req<Command>('POST', `/admin/devices/${encodeURIComponent(deviceId)}/commands`, input);
  }
  approveCommand(id: string, approve: boolean) {
    return this.req<Command>('POST', `/admin/commands/${encodeURIComponent(id)}/approve`, { approve });
  }
  listCommands(deviceId?: string) {
    return this.req<Command[]>('GET', `/admin/commands${this.q({ deviceId })}`);
  }
  pushLog() {
    return this.req<PushWake[]>('GET', '/admin/push-log');
  }
  createEnrollment(opts: { note?: string; wifiSsid?: string } = {}) {
    return this.req<Enrollment>('POST', '/admin/enrollments', opts);
  }
  listEnrollments() {
    return this.req<Omit<EnrollmentToken, 'tokenHash'>[]>('GET', '/admin/enrollments');
  }
  installPage(token: string) {
    return this.req<InstallPageData>('GET', `/e/${encodeURIComponent(token)}`);
  }
  listLocationResults(filter: { deviceId?: string; ticket: string }) {
    return this.req<LocationView[]>('GET', `/admin/location-results${this.q({ deviceId: filter.deviceId, ticket: filter.ticket })}`);
  }
  async purgeNow() {
    return (await this.req<{ purged: number }>('POST', '/admin/location-purge', {})).purged;
  }
  listAudit() {
    return this.req<AuditRow[]>('GET', '/admin/audit');
  }
  verifyAudit() {
    return this.req<ChainVerification>('GET', '/admin/audit/verify');
  }
  exportAudit() {
    return this.req<string>('GET', '/admin/audit/export', undefined, true);
  }
  listUsers() {
    return this.req<PublicUser[]>('GET', '/admin/roles');
  }
  createUser(input: { name: string; email: string; role: Role; password: string }) {
    return this.req<{ user: PublicUser; totpSecret: string; otpauthUri: string }>('POST', '/admin/users', input);
  }
  setUserRole(id: string, role: Role) {
    return this.req<PublicUser>('PATCH', `/admin/users/${encodeURIComponent(id)}/role`, { role });
  }
  setUserDisabled(id: string, disabled: boolean) {
    return this.req<PublicUser>('POST', `/admin/users/${encodeURIComponent(id)}/disable`, { disabled });
  }
  resetUserMfa(id: string) {
    return this.req<{ totpSecret: string; otpauthUri: string }>('POST', `/admin/users/${encodeURIComponent(id)}/reset-mfa`, {});
  }
  listSessions() {
    return this.req<SessionInfo[]>('GET', '/admin/sessions');
  }
  async revokeSession(id: string) {
    await this.req('DELETE', `/admin/sessions/${encodeURIComponent(id)}`);
  }
  listEmployees() {
    return this.req<Employee[]>('GET', '/admin/employees');
  }
  createEmployee(e: Omit<Employee, 'id' | 'status'>) {
    return this.req<Employee>('POST', '/admin/employees', e);
  }
  updateEmployee(id: string, patch: Partial<Omit<Employee, 'id' | 'status'>>) {
    return this.req<Employee>('PATCH', `/admin/employees/${encodeURIComponent(id)}`, patch);
  }
  importEmployees(rows: Omit<Employee, 'id' | 'status'>[]) {
    return this.req<{ created: number; updated: number; errors: { row: number; error: string }[] }>('POST', '/admin/employees/import', { rows });
  }
  offboardEmployee(id: string) {
    return this.req<{ unassigned: string[] }>('POST', `/admin/employees/${encodeURIComponent(id)}/offboard`, {});
  }
  exportEmployeeData(id: string, ticket: string) {
    return this.req<string>('POST', `/admin/employees/${encodeURIComponent(id)}/dsar`, { ticket }, true);
  }
  getSettings() {
    return this.req<OrgSettings>('GET', '/admin/settings');
  }
  updateSettings(patch: Partial<Pick<OrgSettings, 'orgName' | 'dpoContact' | 'siemWebhookUrl'>>) {
    return this.req<OrgSettings>('PATCH', '/admin/settings', patch);
  }
  upsertApp(app: AppCatalogEntry) {
    return this.req<AppCatalogEntry[]>('PUT', '/admin/apps', app);
  }
  removeApp(packageName: string) {
    return this.req<AppCatalogEntry[]>('DELETE', `/admin/apps/${encodeURIComponent(packageName)}`);
  }
  transparency(deviceId: string, key: string) {
    return this.req<Transparency>('GET', `/transparency/${encodeURIComponent(deviceId)}/${encodeURIComponent(key)}`);
  }
}

export type { DevicePolicy, ProvisioningPayload };
