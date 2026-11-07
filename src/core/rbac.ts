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

/** Single source of truth for who may do what. */
export const PERMISSIONS: Record<Permission, readonly Role[]> = {
  'device.read': ALL_READ,
  'device.update': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'device.policy': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'enrollment.create': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  // Non-negotiable #4: location is readable ONLY through the Location Operator path.
  'location.read': ['LOCATION_OPERATOR'],
  'location.purge': ['SECURITY'],
  'audit.read': ['SUPER_ADMIN', 'SECURITY', 'AUDITOR'],
  'audit.export': ['SECURITY', 'AUDITOR'],
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
  // Data-subject access requests are handled by Security (acting for the DPO), never by the Location Operator.
  'privacy.dsar': ['SECURITY'],
  // LOCATE and Lost Mode are allowed only for Location Operator (Phase 1 spec).
  'command.LOCATE': ['LOCATION_OPERATOR'],
  'command.LOST_MODE_ON': ['LOCATION_OPERATOR'],
  'command.LOST_MODE_OFF': ['LOCATION_OPERATOR'],
  'command.LOCK': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK'],
  'command.SYNC_POLICY': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK'],
  'command.REBOOT': ['SUPER_ADMIN', 'DEVICE_ADMIN', 'HELPDESK'],
  'command.INSTALL_APP': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
  'command.WIPE': ['SUPER_ADMIN', 'DEVICE_ADMIN'],
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
