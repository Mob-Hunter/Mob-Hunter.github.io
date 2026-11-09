import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, fmtAgo, useMe, useNow, useQuery } from '../ui/kit';
import { ROLE_LABEL, can, type Role } from '../core/rbac';
import { DOWNLOADS_URL } from '../config';

export function OverviewPage() {
  const me = useMe()!;
  const now = useNow(30_000);
  const [stats] = useQuery((api) => api.stats());
  const [devices] = useQuery((api) => api.listDevices());
  const [compliance] = useQuery((api) => api.compliance());
  const [incidents] = useQuery((api) => api.listIncidents());
  const [cmds] = useQuery((api) => api.listCommands());
  const canAudit = can(me.role, 'audit.read');
  const [audit] = useQuery((api) => api.listAudit(), [], { enabled: canAudit });
  const name = (id: string) => devices?.find((d) => d.id === id)?.displayName ?? id;

  const active = (devices ?? []).filter((d) => d.state !== 'retired' && d.state !== 'wiped');
  const issuesById = new Map((compliance ?? []).map((c) => [c.deviceId, c.issues]));
  const health = { healthy: 0, warn: 0, critical: 0 };
  for (const d of active) {
    const iss = issuesById.get(d.id) ?? [];
    if (iss.some((x) => x.severity === 'bad')) health.critical++;
    else if (iss.length) health.warn++;
    else health.healthy++;
  }
  const score = active.length ? Math.round((health.healthy / active.length) * 100) : 100;
  const fresh = bucket(active, (d) => {
    const age = d.lastCheckinAt ? now - d.lastCheckinAt : Infinity;
    return age < 15 * 60_000 ? 0 : age < 3_600_000 ? 1 : age < 86_400_000 ? 2 : 3;
  }, 4);
  const battery = bucket(active.filter((d) => d.telemetry), (d) => {
    const b = d.telemetry!.batteryLevel;
    return b < 20 ? 0 : b < 50 ? 1 : b < 80 ? 2 : 3;
  }, 4);
  const issueCounts = new Map<string, { text: string; n: number; severity: string }>();
  for (const c of compliance ?? [])
    for (const x of c.issues) {
      const cur = issueCounts.get(x.code) ?? { text: ISSUE_LABEL[x.code] ?? x.code, n: 0, severity: x.severity };
      cur.n++;
      if (x.severity === 'bad') cur.severity = 'bad';
      issueCounts.set(x.code, cur);
    }
  const attention = (compliance ?? [])
    .filter((c) => c.issues.length)
    .sort((a, b) => rank(b.issues) - rank(a.issues))
    .slice(0, 6);
  const openIncidents = (incidents ?? []).filter((i) => i.status === 'active');
  const approvals = (cmds ?? []).filter((c) => c.status === 'pending_approval');
  const dayAgo = now - 86_400_000;
  const locates24h = (cmds ?? []).filter((c) => (c.type === 'LOCATE' || c.type === 'LOST_MODE_ON') && c.issuedAt > dayAgo).length;
  const feed: { at: number; text: ReactNode; tone: string }[] = canAudit
    ? (audit ?? []).slice(-8).reverse().map((r) => ({ at: r.at, tone: toneOf(r.action), text: <><code>{r.action}</code> · {r.actorRole === 'DEVICE' ? name(r.actor) : r.actor === 'system' ? 'system' : (r.actorRole ?? '').replace('_', ' ').toLowerCase()}{r.ticket ? ` · ${r.ticket}` : ''}</> }))
    : (cmds ?? []).slice(0, 8).map((c) => ({ at: c.issuedAt, tone: c.status === 'succeeded' ? 'ok' : c.status === 'failed' || c.status === 'rejected' ? 'bad' : 'info', text: <><code>{c.type}</code> → {name(c.deviceId)} · {c.status.replace('_', ' ')}</> }));

  return (
    <div className="page dash">
      <header className="dash-head">
        <div>
          <p className="dash-eyebrow">Command center</p>
          <h1>Overview</h1>
          <p className="muted">
            {greeting()}, <strong>{me.name.split(' ')[0]}</strong> · {ROLE_LABEL[me.role]} · updated {fmtAgo(now)}
          </p>
        </div>
        <QuickActions role={me.role} />
      </header>
      <GettingStarted role={me.role} devices={devices?.length ?? null} />

      {stats && (
        <section className="kpis" aria-label="Key numbers">
          <Kpi to="/devices" label="Devices" value={stats.total} sub={`${active.length} active`} />
          <Kpi to="/devices" label="Online now" value={stats.online} sub={pct(stats.online, active.length)} meter={ratio(stats.online, active.length)} />
          <Kpi to="/compliance" label="Compliance" value={`${score}%`} sub={`${health.critical + health.warn} with issues`} meter={score / 100} tone={score >= 90 ? 'ok' : score >= 70 ? 'warn' : 'bad'} />
          <Kpi to="/incidents" label="Lost / stolen" value={openIncidents.length} sub={openIncidents.length ? 'tracking now' : 'none open'} tone={openIncidents.length ? 'bad' : undefined} />
          <Kpi to="/devices?tab=pending" label="Needs action" value={stats.unnamed + stats.awaitingAck + stats.pendingApprovals} sub={`${stats.unnamed} unnamed · ${stats.awaitingAck} notice · ${stats.pendingApprovals} approval`} tone={stats.unnamed + stats.awaitingAck + stats.pendingApprovals ? 'warn' : undefined} />
          <Kpi to={can(me.role, 'location.read') ? '/locations' : '/audit'} label="Location requests" value={locates24h} sub="last 24 h · all audited" />
        </section>
      )}

      <section className="dash-grid">
        <Panel title="Fleet health" className="span-2">
          <div className="health">
            <Ring
              parts={[
                { v: health.healthy, c: 'var(--ok)', label: 'Healthy' },
                { v: health.warn, c: 'var(--warn)', label: 'Warnings' },
                { v: health.critical, c: 'var(--bad)', label: 'Critical' },
              ]}
              center={`${score}%`}
              caption="compliant"
            />
            <ul className="legend">
              <LegendRow color="var(--ok)" label="Healthy" n={health.healthy} />
              <LegendRow color="var(--warn)" label="Warnings" n={health.warn} />
              <LegendRow color="var(--bad)" label="Critical" n={health.critical} />
            </ul>
          </div>
        </Panel>
        <Panel title="Check-in freshness">
          <Bars rows={[['< 15 min', fresh[0], 'ok'], ['< 1 hour', fresh[1], 'info'], ['< 24 hours', fresh[2], 'warn'], ['Older / never', fresh[3], 'bad']]} total={active.length} />
        </Panel>
        <Panel title="Battery">
          <Bars rows={[['Below 20%', battery[0], 'bad'], ['20–49%', battery[1], 'warn'], ['50–79%', battery[2], 'info'], ['80–100%', battery[3], 'ok']]} total={battery.reduce((a, b) => a + b, 0)} />
        </Panel>

        <Panel title="Needs attention" action={<Link to="/compliance">Compliance →</Link>} className="span-2">
          {attention.length ? (
            <ul className="attn">
              {attention.map((c) => (
                <li key={c.deviceId}>
                  <span className={`dot dot-${c.issues.some((x) => x.severity === 'bad') ? 'bad' : 'warn'}`} aria-hidden />
                  <Link to={`/devices/${c.deviceId}`}>{c.deviceName}</Link>
                  <span className="muted small">{c.issues.map((x) => ISSUE_LABEL[x.code] ?? x.code).join(' · ')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{active.length ? 'Every active device is healthy.' : 'No devices yet — add your first phone.'}</Empty>
          )}
        </Panel>
        <Panel title="Issues by type">
          {issueCounts.size ? (
            <Bars rows={[...issueCounts.values()].sort((a, b) => b.n - a.n).map((x) => [x.text, x.n, x.severity === 'bad' ? 'bad' : 'warn'] as const)} total={active.length} />
          ) : (
            <Empty>No open issues.</Empty>
          )}
        </Panel>
        <Panel title="Lost & stolen" action={<Link to={openIncidents.length ? '/incidents' : '/incidents/new'}>{openIncidents.length ? 'Open →' : 'Report →'}</Link>}>
          {openIncidents.length ? (
            <ul className="attn">
              {openIncidents.slice(0, 4).map((i) => (
                <li key={i.id}>
                  <span className="dot dot-bad pulse" aria-hidden />
                  <Link to={`/incidents/${i.id}`}>{i.deviceName}</Link>
                  <span className="muted small">
                    {i.kind} · {i.ticket} · last fix {fmtAgo(i.lastFixAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No phone is reported lost or stolen.</Empty>
          )}
        </Panel>

        <Panel title="Waiting for approval">
          {approvals.length ? (
            <ul className="attn">
              {approvals.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <span className="dot dot-warn" aria-hidden />
                  <Link to={`/devices/${c.deviceId}`}>
                    {c.type} → {name(c.deviceId)}
                  </Link>
                  <span className="muted small">
                    {c.ticket ?? ''} · {fmtAgo(c.issuedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing is waiting for a second approver.</Empty>
          )}
        </Panel>
        <Panel title={canAudit ? 'Live activity (audit log)' : 'Recent commands'} action={canAudit ? <Link to="/audit">Audit log →</Link> : undefined} className="span-3">
          {feed.length ? (
            <ol className="feed">
              {feed.map((f, k) => (
                <li key={k}>
                  <span className={`dot dot-${f.tone}`} aria-hidden />
                  <span className="feed-text">{f.text}</span>
                  <span className="muted tiny nowrap">{fmtAgo(f.at)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No activity yet.</Empty>
          )}
        </Panel>
      </section>
    </div>
  );
}

const ISSUE_LABEL: Record<string, string> = {
  not_acknowledged: 'Notice not acknowledged',
  stale_checkin: 'Not seen recently',
  never_checked_in: 'Never checked in',
  low_battery: 'Low battery',
  integrity: 'Integrity check',
  old_patch: 'Old security patch',
  low_storage: 'Low storage',
  unassigned: 'Not assigned',
};

function rank(issues: { severity: string }[]) {
  return issues.reduce((a, x) => a + (x.severity === 'bad' ? 10 : 1), 0);
}
function bucket<T>(items: T[], f: (x: T) => number, n: number): number[] {
  const out = new Array(n).fill(0);
  for (const x of items) out[f(x)]++;
  return out;
}
const ratio = (a: number, b: number) => (b ? a / b : 0);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}% of active` : '—');
function toneOf(action: string) {
  if (action.startsWith('security') || action === 'access.denied' || action.endsWith('failed')) return 'bad';
  if (action.startsWith('location') || action.startsWith('incident')) return 'warn';
  if (action.startsWith('device') || action.startsWith('command')) return 'info';
  return 'ok';
}

function Kpi({ to, label, value, sub, meter, tone }: { to: string; label: string; value: ReactNode; sub: string; meter?: number; tone?: string }) {
  return (
    <Link to={to} className={`kpi${tone ? ` kpi-${tone}` : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {meter !== undefined && (
        <span className="kpi-meter" aria-hidden>
          <span style={{ width: `${Math.round(Math.min(1, Math.max(0, meter)) * 100)}%` }} />
        </span>
      )}
      <span className="kpi-sub" title={sub}>
        {sub}
      </span>
    </Link>
  );
}

function Panel({ title, action, className = '', children }: { title: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`card panel ${className}`} aria-label={title}>
      <header className="panel-head">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** Donut chart; the legend next to it carries the same numbers as text. */
function Ring({ parts, center, caption }: { parts: { v: number; c: string; label: string }[]; center: string; caption: string }) {
  const total = parts.reduce((a, p) => a + p.v, 0);
  const r = 52;
  const len = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg className="ring" viewBox="0 0 140 140" role="img" aria-label={`${center} ${caption}: ${parts.map((p) => `${p.v} ${p.label.toLowerCase()}`).join(', ')}`}>
      <circle cx="70" cy="70" r={r} className="ring-track" />
      {total > 0 &&
        parts.map((p) => {
          const l = (p.v / total) * len;
          const el = p.v ? (
            <circle key={p.label} cx="70" cy="70" r={r} stroke={p.c} strokeDasharray={`${Math.max(0, l - 2)} ${len}`} strokeDashoffset={-offset} className="ring-seg" />
          ) : null;
          offset += l;
          return el;
        })}
      <text x="70" y="68" className="ring-value">
        {center}
      </text>
      <text x="70" y="88" className="ring-caption">
        {caption}
      </text>
    </svg>
  );
}

function LegendRow({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <li>
      <span className="swatch" style={{ background: color }} aria-hidden />
      <span>{label}</span>
      <strong>{n}</strong>
    </li>
  );
}

function Bars({ rows, total }: { rows: readonly (readonly [string, number, string])[]; total: number }) {
  return (
    <ul className="bars">
      {rows.map(([label, n, tone]) => (
        <li key={label}>
          <span className="bars-label">{label}</span>
          <span className="bars-track" aria-hidden>
            <span className={`bars-fill fill-${tone}`} style={{ width: `${total ? Math.max(n ? 4 : 0, (n / total) * 100) : 0}%` }} />
          </span>
          <strong className="bars-n">{n}</strong>
        </li>
      ))}
    </ul>
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
    { to: '/incidents/new', label: '⚑ Report lost / stolen', show: can(role, 'command.LOST_MODE_ON') },
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
