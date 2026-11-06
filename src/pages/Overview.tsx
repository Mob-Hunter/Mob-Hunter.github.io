import { Link } from 'react-router-dom';
import { Badge, Card, Empty, fmtAgo, useMe, useQuery } from '../ui/kit';
import { ROLE_LABEL, can } from '../core/rbac';

export function OverviewPage() {
  const me = useMe()!;
  const [stats] = useQuery((api) => api.stats());
  const [wakes] = useQuery(async (api) => (await api.pushLog()).slice(0, 6));
  const [cmds] = useQuery(async (api) => (await api.listCommands()).slice(0, 6));
  const [devices] = useQuery((api) => api.listDevices());
  const name = (id: string) => devices?.find((d) => d.id === id)?.displayName ?? id;

  return (
    <div className="page">
      <h1>Overview</h1>
      <p className="muted">
        Signed in as <strong>{me.name}</strong> · {ROLE_LABEL[me.role]}
      </p>
      {stats && (
        <div className="stats">
          <Link to="/devices" className="stat">
            <span className="stat-n">{stats.total}</span>
            <span className="stat-l">Devices</span>
          </Link>
          <Link to="/devices?unnamed=1" className="stat">
            <span className="stat-n">{stats.unnamed}</span>
            <span className="stat-l">Unnamed</span>
          </Link>
          <div className="stat">
            <span className="stat-n">{stats.online}</span>
            <span className="stat-l">Seen &lt;15 min</span>
          </div>
          <div className="stat">
            <span className="stat-n">{stats.awaitingAck}</span>
            <span className="stat-l">Awaiting notice ack</span>
          </div>
          <div className="stat">
            <span className="stat-n">{stats.lost}</span>
            <span className="stat-l">In Lost Mode</span>
          </div>
          <div className="stat">
            <span className="stat-n">{stats.pendingApprovals}</span>
            <span className="stat-l">Awaiting approval</span>
          </div>
        </div>
      )}
      <div className="grid2">
        <Card title="Recent commands">
          {cmds?.length ? (
            <ul className="list">
              {cmds.map((c) => (
                <li key={c.id}>
                  <Link to={`/devices/${c.deviceId}`}>
                    <strong>{c.type}</strong> → {name(c.deviceId)}
                  </Link>
                  <span>
                    <StatusBadge status={c.status} /> <span className="muted small">{fmtAgo(c.issuedAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No commands yet.</Empty>
          )}
        </Card>
        <Card title="Relay · push wakes (FCM/APNs stub)">
          {wakes?.length ? (
            <ul className="list">
              {wakes.map((w) => (
                <li key={w.id}>
                  <span>
                    Wake <strong>{name(w.deviceId)}</strong> <span className="muted small">({w.reason})</span>
                  </span>
                  <span className="muted small">{fmtAgo(w.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No wakes sent yet. Wakes carry no command data — the device pulls over its authenticated channel.</Empty>
          )}
        </Card>
      </div>
      <Card title="What you can do with this role">
        <ul className="checklist">
          <li className={can(me.role, 'enrollment.create') ? 'yes' : 'no'}>Enrol new devices and rename / assign them</li>
          <li className={can(me.role, 'command.LOCK') ? 'yes' : 'no'}>Lock, reboot, sync policy</li>
          <li className={can(me.role, 'command.WIPE') ? 'yes' : 'no'}>Request a wipe (needs a second approver)</li>
          <li className={can(me.role, 'command.LOCATE') ? 'yes' : 'no'}>Locate a device / Lost Mode (ticket required)</li>
          <li className={can(me.role, 'location.read') ? 'yes' : 'no'}>View location results</li>
          <li className={can(me.role, 'audit.read') ? 'yes' : 'no'}>Read and verify the audit log</li>
          <li className={can(me.role, 'roles.manage') ? 'yes' : 'no'}>Manage roles</li>
        </ul>
        <p className="tiny muted">These checks are enforced by the backend on every call; the menu only hides what you cannot use.</p>
      </Card>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'succeeded' ? 'ok' : status === 'failed' || status === 'rejected' || status === 'expired' ? 'bad' : status === 'pending_approval' ? 'warn' : 'info';
  return <Badge tone={tone}>{status.replace('_', ' ')}</Badge>;
}
