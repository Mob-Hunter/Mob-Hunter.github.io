import { Card, ErrorBox, useAction, useCan, useMe, useQuery, useRuntime, TableWrap } from '../ui/kit';
import { PERMISSIONS, ROLES, ROLE_LABEL, type Permission, type Role } from '../core/rbac';

const PERM_LABEL: Partial<Record<Permission, string>> = {
  'device.read': 'View devices',
  'device.update': 'Rename / assign devices',
  'device.policy': 'Change device policy',
  'enrollment.create': 'Enrol devices',
  'command.LOCK': 'Lock / reboot / sync',
  'command.INSTALL_APP': 'Install company apps',
  'command.WIPE': 'Request wipe',
  'command.approve': 'Approve wipe (4-eyes)',
  'command.LOCATE': 'Locate / Lost Mode',
  'location.read': 'View location results',
  'location.purge': 'Run retention purge',
  'audit.read': 'Read audit log',
  'audit.export': 'Export audit log',
  'roles.manage': 'Manage roles',
  'users.manage': 'Create / disable users, reset MFA',
  'sessions.manage': 'View / revoke sessions',
  'employee.manage': 'Manage employees, leavers',
  'device.retire': 'Retire devices',
  'device.delete': 'Delete retired/wiped devices',
  'apps.manage': 'Manage app catalogue',
  'settings.manage': 'Organisation settings',
  'privacy.dsar': 'Data-subject access export',
};

export function RolesPage() {
  const rt = useRuntime();
  const me = useMe()!;
  const [users, err] = useQuery((api) => api.listUsers());
  const canManage = useCan('roles.manage');
  const { run, busy } = useAction();

  return (
    <div className="page">
      <h1>Roles &amp; permissions</h1>
      {err && <ErrorBox>{err}</ErrorBox>}
      <Card title="Permission matrix (enforced server-side)">
        <TableWrap label="Permission matrix" stack={false}>
          <table className="matrix">
            <thead>
              <tr>
                <th>Permission</th>
                {ROLES.map((r) => (
                  <th key={r}>{ROLE_LABEL[r]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(Object.keys(PERM_LABEL) as Permission[]).map((p) => (
                <tr key={p}>
                  <td>{PERM_LABEL[p]}</td>
                  {ROLES.map((r) => (
                    <td key={r} className="center" aria-label={PERMISSIONS[p].includes(r) ? 'allowed' : 'denied'}>
                      {PERMISSIONS[p].includes(r) ? <span className="yes-dot">●</span> : <span className="no-dot">·</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="tiny muted">
          Segregation of duties: Super Admin cannot see location; only the Location Operator can, and only against a ticket. Wipes need a second approver. Nobody can
          change their own role.
        </p>
      </Card>
      <Card title="Console users">
        <ul className="list">
          {users?.map((u) => (
            <li key={u.id}>
              <span>
                <strong>{u.name}</strong> <span className="muted small">{u.email}</span>
              </span>
              {canManage && u.id !== me.id ? (
                <select
                  aria-label={`Role for ${u.name}`}
                  value={u.role}
                  disabled={busy}
                  onChange={(e) => void run(() => rt.api.setUserRole(u.id, e.target.value as Role), 'Role changed; their sessions were revoked')}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="small">{ROLE_LABEL[u.role]}{u.id === me.id ? ' (you)' : ''}</span>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
