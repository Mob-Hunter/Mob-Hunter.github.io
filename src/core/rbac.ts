/**
 * Role-based access control. Enforced inside the backend on every call —
 * the UI only *hides* things, it is never the place a permission is decided.
 */
export const ROLES = ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK', 'LOCATION_OPERATOR', 'SECURITY', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  DEVICE_ADMIN: 'Device Admin',
  HELPDESK: 'Helpdesk',
  LOCATION_OPERATOR: 'Location Operator',
  SECURITY: 'Security',
  AUDITOR: 'Auditor',
};

export const COMMAND_TYPES = [
  'LOCATE',
  'LOST_MODE_ON',
  'LOST_MODE_OFF',
  'LOCK',
  'WIPE',
  'SYNC_POLICY',
  'INSTALL_APP',
  'REBOOT',
  /** Remove management and uninstall the agent (sent only by the "delete device" flow). */
  'RELEASE',
  /** Show a message from IT as a notification on the phone. */
  'MESSAGE',
  /** Play an alarm at full volume for 30 s, even on silent, to find a phone nearby. */
  'RING',
  /** Remove an app that was installed from the approved catalogue (company phones). */
  'UNINSTALL_APP',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export type Permission =
  | 'device.read'
  | 'device.update'
  | 'device.policy'
  | 'enrollment.create'
  | 'location.read'
  | 'location.purge'
  | 'audit.read'
  | 'audit.export'
  | 'roles.read'
  | 'roles.manage'
  | 'command.approve'
  | 'users.manage'
  | 'sessions.manage'
  | 'employee.manage'
  | 'device.retire'
  | 'device.delete'
  | 'apps.manage'
  | 'settings.manage'
  | 'privacy.dsar'
  | `command.${CommandType}`;

const ALL_READ: Role[] = [...ROLES];

/** Single source of truth for who may do what. Super Admin holds every permission. */
export const PERMISSIONS: Record<Permission, readonly Role[]> = {
  'device.read': ALL_READ,
  'device.update': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'device.policy': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'enrollment.create': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  // Location: Location Operator, plus Super Admin (organisation decision). Every read still needs a ticket and is audited.
  'location.read': ['SUPER_ADMIN', 'LOCATION_OPERATOR'],
  'location.purge': ['SUPER_ADMIN', 'SECURITY'],
  'audit.read': ['SUPER_ADMIN', 'SECURITY', 'AUDITOR'],
  'audit.export': ['SUPER_ADMIN', 'SECURITY', 'AUDITOR'],
  'roles.read': ALL_READ,
  'roles.manage': ['SUPER_ADMIN'],
  'command.approve': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'SECURITY'],
  'users.manage': ['SUPER_ADMIN'],
  'sessions.manage': ['SUPER_ADMIN', 'SECURITY'],
  'employee.manage': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'device.retire': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'device.delete': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'apps.manage': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'settings.manage': ['SUPER_ADMIN'],
  // Data-subject access requests: Security (acting for the DPO) and Super Admin; never the Location Operator.
  'privacy.dsar': ['SUPER_ADMIN', 'SECURITY'],
  // LOCATE and Lost Mode: Location Operator and Super Admin. Ticket required; the employee is always notified.
  'command.LOCATE': ['SUPER_ADMIN', 'LOCATION_OPERATOR'],
  'command.LOST_MODE_ON': ['SUPER_ADMIN', 'LOCATION_OPERATOR'],
  'command.LOST_MODE_OFF': ['SUPER_ADMIN', 'LOCATION_OPERATOR'],
  'command.LOCK': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK'],
  'command.SYNC_POLICY': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK'],
  'command.REBOOT': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK'],
  'command.INSTALL_APP': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'command.WIPE': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'command.RELEASE': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'command.MESSAGE': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK'],
  'command.RING': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK', 'LOCATION_OPERATOR'],
  'command.UNINSTALL_APP': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
};

/** Commands that must carry a ticket reference (purpose limitation). */
export const TICKET_REQUIRED: ReadonlySet<CommandType> = new Set(['LOCATE', 'LOST_MODE_ON', 'WIPE']);

/** Commands that need a second, different approver before they are relayed (four-eyes). */
export const DUAL_CONTROL: ReadonlySet<CommandType> = new Set(['WIPE']);

export function can(role: Role | undefined | null, perm: Permission): boolean {
  if (!role) return false;
  return PERMISSIONS[perm]?.includes(role) ?? false;
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(public readonly permission: Permission) {
    super(`Forbidden: missing permission ${permission}`);
    this.name = 'ForbiddenError';
  }
}

export function assertCan(role: Role | undefined | null, perm: Permission): void {
  if (!can(role, perm)) throw new ForbiddenError(perm);
}

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

export function isCommandType(x: unknown): x is CommandType {
  return typeof x === 'string' && (COMMAND_TYPES as readonly string[]).includes(x);
}
