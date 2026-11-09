import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, fmtAgo, useMe, useQuery } from '../ui/kit';
import { ROLE_LABEL, can, type Role } from '../core/rbac';
import { DOWNLOADS_URL } from '../config';

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
        {greeting()}, <strong>{me.name.split(' ')[0]}</strong> · {ROLE_LABEL[me.role]}
      </p>
      <QuickActions role={me.role} />
      <GettingStarted role={me.role} devices={devices?.length ?? null} />
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
          <Link to="/devices?tab=pending" className="stat">
            <span className="stat-n">{stats.awaitingAck}</span>
            <span className="stat-l">Awaiting notice ack</span>
          </Link>
          <Link to="/incidents" className="stat">
            <span className="stat-n">{stats.lost}</span>
            <span className="stat-l">Lost / stolen</span>
          </Link>
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
        <Card title="Recent device wake-ups">
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

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** The most common next actions for this role, one tap away. */
function QuickActions({ role }: { role: Role }) {
  const actions: { to: string; label: string; primary?: boolean; show: boolean }[] = [
    { to: '/enrol', label: '＋ Add a device', primary: true, show: can(role, 'enrollment.create') },
    { to: '/devices', label: '▤ Find a device', show: true },
    { to: '/locations', label: '⌖ Locations', show: can(role, 'location.read') },
    { to: '/incidents', label: '⚑ Lost & stolen', show: can(role, 'location.read') },
    { to: '/compliance', label: '✓ Compliance', show: !can(role, 'enrollment.create') },
    { to: '/users', label: '⚿ Invite a user', show: can(role, 'users.manage') },
    { to: '/audit', label: '⛓ Audit log', show: can(role, 'audit.read') },
  ];
  return (
    <nav className="quick-actions" aria-label="Quick actions">
      {actions
        .filter((a) => a.show)
        .map((a) => (
          <Link key={a.to} to={a.to} className={`btn btn-sm ${a.primary ? 'btn-primary' : ''}`}>
            {a.label}
          </Link>
        ))}
    </nav>
  );
}

const DISMISS_KEY = 'mob-hunter.getting-started.dismissed';

/**
 * First-run checklist for people who set the organisation up. Every step is
 * worked out from real data, so it ticks itself off and disappears when done.
 */
function GettingStarted({ role, devices }: { role: Role; devices: number | null }) {
  const admin = can(role, 'settings.manage') || can(role, 'enrollment.create');
  const [settings] = useQuery((api) => api.getSettings(), [], { enabled: admin, live: false });
  const [users] = useQuery((api) => api.listUsers(), [], { enabled: admin, live: false });
  const [employees] = useQuery((api) => api.listEmployees(), [], { enabled: admin, live: false });
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!admin || dismissed || !settings || !users || !employees || devices === null) return null;

  const steps = [
    {
      done: settings.orgName !== 'Mob Hunter' && !!settings.dpoContact,
      to: '/settings',
      title: 'Name your organisation',
      text: 'Add your company name and the Data Protection Officer contact. Both appear on the employee notice.',
      show: can(role, 'settings.manage'),
    },
    {
      done: users.filter((u) => !u.disabled).length > 1,
      to: '/users',
      title: 'Invite your team',
      text: 'Add a Device Admin, a Location Operator and Security, so no one person holds every key.',
      show: can(role, 'users.manage'),
    },
    {
      done: employees.length > 0,
      to: '/employees',
      title: 'Add employees',
      text: 'Import your HR list as CSV so phones can be assigned to people.',
      show: can(role, 'employee.manage'),
    },
    {
      done: devices > 0,
      to: '/enrol',
      title: 'Enrol your first phone',
      text: 'Mint a QR, factory-reset a phone, tap its welcome screen six times and scan.',
      show: can(role, 'enrollment.create'),
    },
  ].filter((x) => x.show);
  const complete = steps.filter((x) => x.done).length;
  if (!steps.length || complete === steps.length) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode: dismiss for this visit only */
    }
    setDismissed(true);
  };
  return (
    <Card
      title="Get started"
      className="getting-started"
      actions={
        <button className="btn btn-ghost btn-sm" onClick={dismiss}>
          Hide
        </button>
      }
    >
      <div className="gs-progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={complete} aria-label="Setup progress">
        <span style={{ width: `${(complete / steps.length) * 100}%` }} />
      </div>
      <p className="small muted">
        {complete} of {steps.length} done
        {DOWNLOADS_URL && (
          <>
            {' · '}
            <Link to="/download">Get the Android apps</Link>
          </>
        )}
      </p>
      <ol className="gs-steps">
        {steps.map((x) => (
          <li key={x.to} className={x.done ? 'done' : ''}>
            <span className="gs-mark" aria-hidden>
              {x.done ? '✓' : ''}
            </span>
            <div>
              {x.done ? <strong>{x.title}</strong> : <Link to={x.to}>{x.title}</Link>}
              <span className="sr-only">{x.done ? ' (done)' : ''}</span>
              <p className="small muted">{x.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
