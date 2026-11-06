import { describe, expect, it } from 'vitest';
import { assertCan, can, COMMAND_TYPES, ForbiddenError, PERMISSIONS, ROLES } from '../src/core/rbac';

describe('RBAC matrix', () => {
  it('LOCATE and Lost Mode are Location Operator only', () => {
    for (const perm of ['command.LOCATE', 'command.LOST_MODE_ON', 'command.LOST_MODE_OFF', 'location.read'] as const) {
      expect(PERMISSIONS[perm]).toEqual(['LOCATION_OPERATOR']);
    }
  });
  it('Helpdesk cannot locate, wipe, rename or read audit', () => {
    for (const p of ['command.LOCATE', 'command.WIPE', 'device.update', 'audit.read', 'location.read'] as const) expect(can('HELPDESK', p)).toBe(false);
    expect(can('HELPDESK', 'command.LOCK')).toBe(true);
  });
  it('Super Admin cannot read location (segregation of duties)', () => {
    expect(can('SUPER_ADMIN', 'location.read')).toBe(false);
    expect(can('SUPER_ADMIN', 'command.LOCATE')).toBe(false);
  });
  it('Auditor is read-only', () => {
    for (const t of COMMAND_TYPES) expect(can('AUDITOR', `command.${t}`)).toBe(false);
    expect(can('AUDITOR', 'audit.read')).toBe(true);
    expect(can('AUDITOR', 'device.update')).toBe(false);
  });
  it('every role can read devices; unknown role nothing', () => {
    for (const r of ROLES) expect(can(r, 'device.read')).toBe(true);
    expect(can(undefined, 'device.read')).toBe(false);
    expect(() => assertCan('HELPDESK', 'command.LOCATE')).toThrow(ForbiddenError);
  });
});
