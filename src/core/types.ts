import type { AuditRow } from './audit';
import type { Sealed } from './crypto';
import type { CommandType, Role } from './rbac';

export type DeviceState = 'enrolled' | 'active' | 'lost' | 'wiped' | 'retired';
export type Platform = 'android' | 'ios';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  salt: string;
  passwordHash: string;
  totpSecret: string;
  disabled: boolean;
  failedLogins: number;
  lockedUntil?: number;
}

export type PublicUser = Pick<User, 'id' | 'name' | 'email' | 'role' | 'disabled'>;

export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  /** absolute expiry */
  expiresAt: number;
}

export interface MfaChallenge {
  id: string;
  userId: string;
  expiresAt: number;
  attempts: number;
}

export interface Employee {
  id: string;
  name: string;
  email: string;
  department: string;
}

export interface DevicePolicy {
  version: number;
  passwordMinLength: number;
  maxTimeToLockSec: number;
  updateWindow: { startMinute: number; endMinute: number };
  disallowFactoryReset: boolean;
  disallowUsbTransfer: boolean;
  disallowUnknownSources: boolean;
  disallowDebugging: boolean;
  keepLocationOn: boolean;
  /** Tier 3 – off by default; only ever runs as a foreground service with a persistent notification. */
  continuousLocation: boolean;
  continuousIntervalMin: number;
  workingHours: { startHour: number; endHour: number; days: number[]; timeZone: string };
  /** Security / network logging stay OFF (design-doc requirement). */
  securityLogging: false;
  networkLogging: false;
}

export interface Telemetry {
  batteryLevel: number;
  batteryHealth: 'good' | 'fair' | 'poor';
  batteryTempC: number;
  storageFreeGb: number;
  storageTotalGb: number;
  integrity: 'MEETS_STRONG_INTEGRITY' | 'MEETS_DEVICE_INTEGRITY' | 'MEETS_BASIC_INTEGRITY' | 'FAILED';
  patchLevel: string;
}

export interface DeviceCertificate {
  serial: string;
  deviceId: string;
  publicKey: string;
  issuer: string;
  notBefore: number;
  notAfter: number;
}

export interface Device {
  id: string;
  platform: Platform;
  label: string | null;
  assignedUserId: string | null;
  state: DeviceState;
  serial: string | null;
  model: string | null;
  os: string | null;
  enrolledAt: number;
  lastCheckinAt: number | null;
  telemetry: Telemetry | null;
  cert: DeviceCertificate;
  policyAckAt: number | null;
  policyAckVersion: string | null;
  pushToken: string;
  lostMode: boolean;
  policy: DevicePolicy;
  /** random key embedded in on-device notifications; lets the employee open their own transparency page */
  transparencyKey: string;
  enrollmentTokenId: string;
}

export interface EnrollmentToken {
  id: string;
  tokenHash: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  deviceId: string | null;
  note?: string;
}

export interface CommandPayload {
  v: 1;
  id: string;
  deviceId: string;
  type: CommandType;
  params: Record<string, unknown>;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  ticket?: string;
}

export interface SignedCommand {
  payload: CommandPayload;
  /** Ed25519 signature over canonicalJson(payload) */
  sig: string;
  kid: string;
}

export type CommandStatus =
  | 'pending_approval'
  | 'queued'
  | 'delivered'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'rejected';

export interface CommandRecord {
  id: string;
  deviceId: string;
  type: CommandType;
  params: Record<string, unknown>;
  ticket?: string;
  reason?: string;
  issuedBy: string;
  issuedAt: number;
  approvedBy?: string;
  status: CommandStatus;
  envelope?: SignedCommand;
  deliveredAt?: number;
  completedAt?: number;
  resultSummary?: string;
}

export interface LocationFix {
  lat: number;
  lng: number;
  accuracyM: number;
  fixAt: number;
  source: 'fused' | 'last_known';
  ageSec?: number;
  tier: 1 | 2 | 3;
  /** proof that the agent showed the mandatory on-device notification */
  notification: { shownAt: number; channel: string; text: string } | null;
}

export interface StoredLocation {
  id: string;
  deviceId: string;
  commandId: string | null;
  ticket: string | null;
  tier: 1 | 2 | 3;
  receivedAt: number;
  /** AES-256-GCM, AAD = `${id}|${deviceId}` */
  sealed: Sealed;
}

export interface PushWake {
  id: string;
  deviceId: string;
  platform: Platform;
  at: number;
  reason: string;
}

export interface ServerKeys {
  commandSigning: { kid: string; secretKey: string; publicKey: string };
  deviceCa: { kid: string; secretKey: string; publicKey: string };
  /** AES-256-GCM key for location data at rest */
  locationKey: JsonWebKey;
}

export interface BackendState {
  schema: 1;
  createdAt: number;
  keys: ServerKeys;
  users: User[];
  sessions: Session[];
  mfa: MfaChallenge[];
  employees: Employee[];
  devices: Device[];
  enrollments: EnrollmentToken[];
  commands: CommandRecord[];
  relayQueues: Record<string, string[]>;
  locations: StoredLocation[];
  wakes: PushWake[];
  deviceNonces: Record<string, { nonce: string; at: number }[]>;
  audit: AuditRow[];
  lastPurgeAt: number | null;
}

export interface DeviceAuth {
  deviceId: string;
  cert: DeviceCertificate;
  certSig: string;
  ts: number;
  nonce: string;
  bodyHash: string;
  sig: string;
}

export interface ProvisioningPayload {
  'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': string;
  'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': string;
  'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': string;
  'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': boolean;
  'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': false;
  'android.app.extra.PROVISIONING_WIFI_SSID'?: string;
  'android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'?: string;
  'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': {
    serverUrl: string;
    token: string;
    /** SHA-256 pin of the server command-signing key */
    serverPin: string;
  };
}
