import type { AuditRow } from './audit';
import type { Sealed } from './crypto';
import type { CommandType, Role } from './rbac';

export type DeviceState = 'enrolled' | 'active' | 'lost' | 'wiped' | 'retired' | 'released';
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
  /** 'leaver' once offboarded; kept for audit/DSAR, never assignable */
  status?: 'active' | 'leaver';
}

export interface AppCatalogEntry {
  packageName: string;
  name: string;
  /** HTTPS URL of the signed APK */
  url: string;
  /** SHA-256 of the APK file (hex) — the agent refuses a mismatching download */
  sha256: string;
}

export interface OrgSettings {
  orgName: string;
  dpoContact: string;
  apps: AppCatalogEntry[];
  /** optional HTTPS endpoint that receives every audit row (HMAC-signed) */
  siemWebhookUrl?: string;
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
  /** Restrictions (device owner only). Absent on policies from before they existed = off. */
  cameraDisabled?: boolean;
  /** Blocks screenshots and screen recording ON the phone — the console never sees the screen. */
  screenCaptureDisabled?: boolean;
  bluetoothDisabled?: boolean;
  disallowAddUser?: boolean;
  disallowConfigWifi?: boolean;
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
  integrity: 'MEETS_STRONG_INTEGRITY' | 'MEETS_DEVICE_INTEGRITY' | 'MEETS_BASIC_INTEGRITY' | 'NOT_EVALUATED' | 'FAILED';
  patchLevel: string;
}

export interface DeviceCertificate {
  /** absent = Ed25519 (simulator); 'ES256' = ECDSA P-256 from the Android Keystore */
  alg?: 'ES256';
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
  /** Set when an admin deletes an active device: the agent must release management and uninstall itself first. */
  pendingRemoval?: { requestedBy: string; requestedAt: number; reason: string; commandId: string } | null;
  policy: DevicePolicy;
  /** random key embedded in on-device notifications; lets the employee open their own transparency page */
  transparencyKey: string;
  enrollmentTokenId: string;
  /**
   * How the phone was enrolled. 'device_owner': factory reset + provisioning QR (full management).
   * 'standard': agent installed on an existing phone without a factory reset — notifications,
   * location and telemetry only; policy, wipe, reboot and silent installs are unavailable.
   */
  managementMode?: ManagementMode;
  /** Free-form groups such as "Sales" or "Warehouse"; used for filtering and bulk commands. */
  tags?: string[];
  assetTag?: string | null;
  notes?: string | null;
  /** What the agent reports it can do right now (permissions the user granted). */
  capabilities?: DeviceCapabilities | null;
}

export type ManagementMode = 'device_owner' | 'standard';

export interface DeviceCapabilities {
  deviceOwner: boolean;
  /** device admin active: allows remote lock on a standard enrolment */
  deviceAdmin: boolean;
  notifications: boolean;
  location: 'none' | 'foreground' | 'background';
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
  /** exact string that was signed (canonicalJson(payload)); lets non-JS agents verify without re-serialising */
  signed?: string;
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

/** A device reported lost or stolen, with time-boxed active tracking. */
export interface Incident {
  id: string;
  deviceId: string;
  kind: 'lost' | 'stolen';
  ticket: string;
  reason: string;
  reportedBy: string;
  startedAt: number;
  /** fix interval while active tracking runs (60–300 s) */
  trackingIntervalSec: number;
  /** active tracking stops on the phone at this time (≤ 72 h from the last extension) */
  trackingUntil: number;
  status: 'active' | 'resolved';
  resolution?: 'found' | 'recovered' | 'not_recovered' | 'false_alarm';
  resolvedBy?: string;
  resolvedAt?: number;
  note?: string;
  /** throttles "tracking viewed" audit rows: userId → last audited view */
  viewAudit?: Record<string, number>;
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
  settings?: OrgSettings;
  incidents?: Incident[];
}

export interface DeviceAuth {
  deviceId: string;
  cert: DeviceCertificate;
  certSig: string;
  ts: number;
  nonce: string;
  bodyHash: string;
  sig: string;
  /**
   * Set ONLY by the HTTP layer: SHA-256 of the exact request bytes. When present
   * it replaces the canonical-JSON body hash, so non-JS agents need no canonicaliser.
   */
  serverBodyHash?: string;
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
