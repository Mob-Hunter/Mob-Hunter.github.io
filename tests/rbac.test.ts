import { describe, expect, it } from 'vitest';
import { assertCan, can, COMMAND_TYPES, ForbiddenError, PERMISSIONS, ROLES } from '../src/core/rbac';

describe('RBAC matrix', () => {
  it('LOCATE, Lost Mode and location results: Location Operator and Super Admin only', () => {
    for (const perm of ['command.LOCATE', 'command.LOST_MODE_ON', 'command.LOST_MODE_OFF', 'location.read'] as const) {
      expect([...PERMISSIONS[perm]].sort()).toEqual(['LOCATION_OPERATOR', 'SUPER_ADMIN']);
    }
  });
  it('Helpdesk cannot locate, wipe, rename or read audit', () => {
    for (const p of ['command.LOCATE', 'command.WIPE', 'device.update', 'audit.read', 'location.read'] as const) expect(can('HELPDESK', p)).toBe(false);
    expect(can('HELPDESK', 'command.LOCK')).toBe(true);
  });
  it('Super Admin holds every permission', () => {
    for (const perm of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) expect(can('SUPER_ADMIN', perm)).toBe(true);
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
