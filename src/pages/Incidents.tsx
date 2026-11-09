import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, Field, MiniMap, fmtAgo, fmtTime, useAction, useAsyncQuery, useCan, useNow, useQuery, useRuntime } from '../ui/kit';
import { LatestFix, LocationTable, toMapPoints } from '../ui/location';
import { trackStats } from '../core/tracking';
import type { IncidentRecord, IncidentSummary } from '../api/console';
import { ReportIncidentCard } from './DeviceDetail';

const RESOLUTION_LABEL: Record<string, string> = {
  found: 'Found',
  recovered: 'Recovered',
  not_recovered: 'Not recovered',
  false_alarm: 'False alarm',
};

export function kindBadge(kind: 'lost' | 'stolen') {
  return <Badge tone={kind === 'stolen' ? 'bad' : 'warn'}>{kind === 'stolen' ? 'STOLEN' : 'LOST'}</Badge>;
}

export function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'ended';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min left`;
}

function TrackingState({ i, now }: { i: Pick<IncidentSummary, 'status' | 'trackingUntil' | 'trackingIntervalSec'>; now: number }) {
  if (i.status !== 'active') return <Badge>closed</Badge>;
  return now < i.trackingUntil ? (
    <span className="live">
      <i className="live-dot" aria-hidden /> Tracking every {Math.round(i.trackingIntervalSec / 60)} min · {fmtRemaining(i.trackingUntil - now)}
    </span>
  ) : (
    <Badge tone="warn">Active tracking ended — Lost Mode on</Badge>
  );
}

/** List of lost/stolen incidents. Every role sees status; positions are on the tracking page (Location Operator). */
export function IncidentsPage() {
  const [incidents, err] = useQuery((api) => api.listIncidents());
  const now = useNow(15_000);
  const open = (incidents ?? []).filter((i) => i.status === 'active');
  const closed = (incidents ?? []).filter((i) => i.status !== 'active');
  const canReport = useCan('command.LOST_MODE_ON');
  return (
    <div className="page">
      <div className="page-head">
        <h1>Lost &amp; stolen</h1>
        {canReport && (
          <Link className="btn btn-danger" to="/incidents/new">
            ⚑ Report a lost or stolen phone
          </Link>
        )}
      </div>
      <IncidentFlow current={0} />
      {err && <ErrorBox>{err}</ErrorBox>}
      <Card title={`Open incidents (${open.length})`}>
        {open.length ? <IncidentList items={open} now={now} /> : <Empty>
            No phone is reported lost or stolen.{' '}
            {canReport ? <Link to="/incidents/new">Report one</Link> : 'A Location Operator or Super Admin can report one.'}
          </Empty>}
      </Card>
      <Card title="Closed incidents">{closed.length ? <IncidentList items={closed} now={now} /> : <Empty>None yet.</Empty>}</Card>
    </div>
  );
}

function IncidentList({ items, now }: { items: IncidentSummary[]; now: number }) {
  return (
    <ul className="list">
      {items.map((i) => (
        <li key={i.id}>
          <span>
            <Link to={`/incidents/${i.id}`}>
              <strong>{i.deviceName}</strong>
            </Link>{' '}
            {kindBadge(i.kind)} <Badge tone="info">{i.ticket}</Badge>
            <div className="small muted">
              Reported {fmtAgo(i.startedAt, now)}
              {i.status === 'active'
                ? ` · last fix ${fmtAgo(i.lastFixAt, now)} · battery ${i.batteryLevel ?? '—'}%`
                : ` · ${RESOLUTION_LABEL[i.resolution ?? ''] ?? 'closed'} ${fmtAgo(i.resolvedAt, now)}`}
            </div>
          </span>
          <TrackingState i={i} now={now} />
        </li>
      ))}
    </ul>
  );
}

/** Live tracking of one incident. */
export function IncidentDetailPage() {
  const { id = '' } = useParams();
  const canTrack = useCan('location.read');
  const [incidents] = useQuery((api) => api.listIncidents());
  const summary = incidents?.find((i) => i.id === id);
  if (!canTrack) {
    return (
      <div className="page">
        <p className="crumbs">
          <Link to="/incidents">Lost &amp; stolen</Link> /
        </p>
        <h1>{summary ? summary.deviceName : 'Incident'}</h1>
        {summary && (
          <Card>
            <p>
              {kindBadge(summary.kind)} <Badge tone="info">{summary.ticket}</Badge> reported {fmtTime(summary.startedAt)}.
            </p>
            <TrackingState i={summary} now={Date.now()} />
          </Card>
        )}
        <div className="callout">Live position is visible only to the Location Operator and Super Admin roles.</div>
      </div>
    );
  }
  return <LiveTracking id={id} />;
}

function LiveTracking({ id }: { id: string }) {
  const [paused, setPaused] = useState(false);
  const q = useAsyncQuery((api) => api.trackIncident(id), [id]);
  const now = useNow(5_000);
  const live = !!q.data?.trackingActive && !paused;
  // Auto-refresh while tracking is active. Views are audited once per 15 minutes per operator.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(q.reload, 15_000);
    return () => clearInterval(t);
  }, [live, q.reload]);

  const fixes = useMemo(() => q.data?.fixes ?? [], [q.data]);
  const stats = useMemo(() => trackStats(fixes.map((f) => f.fix)), [fixes]);
  if (q.error && !q.data) return <ErrorBox>{q.error}</ErrorBox>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const { incident: inc, device } = q.data;
  const latest = fixes[0];

  return (
    <div className="page">
      <p className="crumbs">
        <Link to="/incidents">Lost &amp; stolen</Link> /
      </p>
      <div className="page-head">
        <h1>
          {device?.name ?? inc.deviceId} {kindBadge(inc.kind)}
        </h1>
        <TrackingState i={inc} now={now} />
      </div>
      <IncidentFlow current={inc.status === 'active' ? (latest ? 2 : 1) : 3} done={inc.status === 'active' ? (latest ? 1 : 0) : 3} />
      {inc.kind === 'stolen' && inc.status === 'active' && (
        <div className="callout callout-bad">
          <strong>Stolen device:</strong> share the location with the police and do not attempt recovery yourself. If the phone holds sensitive data and is unlikely to be
          recovered, wipe it.
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span className="stat-n">{latest ? fmtAgo(latest.fix.fixAt, now) : '—'}</span>
          <span className="stat-l">Last fix</span>
        </div>
        <div className="stat">
          <span className="stat-n">{fixes.length}</span>
          <span className="stat-l">Fixes</span>
        </div>
        <div className="stat">
          <span className="stat-n">{stats.distanceM >= 1000 ? `${(stats.distanceM / 1000).toFixed(1)} km` : `${Math.round(stats.distanceM)} m`}</span>
          <span className="stat-l">Moved since report</span>
        </div>
        <div className="stat">
          <span className="stat-n">{stats.speedKmh === null ? '—' : `${stats.speedKmh.toFixed(1)} km/h`}</span>
          <span className="stat-l">Current speed</span>
        </div>
        <div className="stat">
          <span className="stat-n">{device?.batteryLevel ?? '—'}%</span>
          <span className="stat-l">Battery{(device?.batteryLevel ?? 100) < 15 ? ' (slowed to 5 min)' : ''}</span>
        </div>
        <div className="stat">
          <span className="stat-n">{fmtAgo(device?.lastCheckinAt ?? null, now)}</span>
          <span className="stat-l">Last check-in</span>
        </div>
      </div>
      <Card
        title="Live map"
        actions={
          inc.status === 'active' && q.data.trackingActive ? (
            <button className="btn btn-sm btn-ghost" onClick={() => setPaused((p) => !p)}>
              {paused ? '▶ Resume live updates' : '❚❚ Pause live updates'}
            </button>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={q.reload}>
              Refresh
            </button>
          )
        }
      >
        {latest ? (
          <>
            <MiniMap title={`Live track with ${fixes.length} location fixes`} points={toMapPoints(fixes, new Set([latest.id]))} />
            <LatestFix fix={latest} />
          </>
        ) : (
          <Empty>Waiting for the first fix — the phone sends one as soon as it receives Lost Mode (it may be offline).</Empty>
        )}
      </Card>
      {inc.status === 'active' && <IncidentActions incident={inc} />}
      {inc.status !== 'active' && (
        <div className="callout">
          Closed as <strong>{RESOLUTION_LABEL[inc.resolution ?? ''] ?? '—'}</strong> {fmtTime(inc.resolvedAt)}
          {inc.note ? ` — ${inc.note}` : ''}.
        </div>
      )}
      <Card title={`Track (${fixes.length})`}>
        <LocationTable rows={fixes} showDevice={false} />
      </Card>
      <p className="tiny muted">
        Ticket {inc.ticket} · reported {fmtTime(inc.startedAt)} · reason: {inc.reason}. Your viewing session is recorded in the audit log.
      </p>
    </div>
  );
}

function IncidentActions({ incident }: { incident: Omit<IncidentRecord, 'viewAudit'> }) {
  const rt = useRuntime();
  const { run, busy } = useAction();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="grid2">
      <Card title="Tracking">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const extend = Number((form.elements.namedItem('extend') as HTMLSelectElement).value);
            const interval = Number((form.elements.namedItem('interval') as HTMLSelectElement).value);
            void run(async () => {
              await rt.api.updateIncidentTracking(incident.id, { extendHours: extend || undefined, intervalSec: interval, reason });
              setReason('');
            }, 'Tracking updated — the phone receives the new limits');
          }}
        >
          <div className="row-form">
            <Field label="Extend by">
              <select name="extend" defaultValue="0">
                <option value="0">Don&apos;t extend</option>
                <option value="4">4 hours</option>
                <option value="24">24 hours</option>
                <option value="72">72 hours (maximum)</option>
              </select>
            </Field>
            <Field label="Interval">
              <select name="interval" defaultValue={String(incident.trackingIntervalSec)}>
                <option value="60">Every minute</option>
                <option value="120">Every 2 minutes</option>
                <option value="300">Every 5 minutes</option>
              </select>
            </Field>
          </div>
          <Field label="Reason for the change">
            <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} placeholder="e.g. Police requested updates until tomorrow" />
          </Field>
          <div>
            <button className="btn" disabled={busy}>
              Update tracking
            </button>
          </div>
        </form>
      </Card>
      <Card title="Close incident">
        <div className="stack">
          <p className="small muted">One click closes the incident. Every outcome except “Not recovered” ends Lost Mode and tracking on the phone, and the employee is told.</p>
          <Field label="Note (optional)" hint="Added to the incident and the audit log">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Returned by station staff" />
          </Field>
          <div className="outcomes">
            {OUTCOMES.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`btn ${o.value === 'not_recovered' ? 'btn-danger' : o.value === 'found' || o.value === 'recovered' ? 'btn-primary' : ''}`}
                disabled={busy}
                onClick={() => {
                  if (!confirm(`Close this incident as “${o.label}”? ${o.value === 'not_recovered' ? 'Lost Mode stays on.' : 'Lost Mode and tracking end on the phone.'}`)) return;
                  void run(() => rt.api.resolveIncident(incident.id, { resolution: o.value, note }), o.value === 'not_recovered' ? 'Closed — Lost Mode stays on; consider WIPE' : 'Closed — Lost Mode ended on the phone');
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="tiny muted">
            Not recovered and holding company data? <Link to={`/devices/${incident.deviceId}`}>Open the device</Link> to wipe it (needs a second approver, company phones only).
          </p>
        </div>
      </Card>
    </div>
  );
}

const FLOW = [
  { title: 'Report', text: 'Pick the phone, add the ticket and what happened.' },
  { title: 'Lock & track', text: 'Lost Mode locks the screen with your message and shares location every 1–5 min.' },
  { title: 'Follow live', text: 'Watch the map; extend or change tracking if needed.' },
  { title: 'Close', text: 'One click: found, recovered, false alarm or not recovered.' },
];

/** The four steps of a lost/stolen incident; `current` highlights where this incident is. */
export function IncidentFlow({ current, done = -1 }: { current: number; done?: number }) {
  return (
    <ol className="flow" aria-label="Incident steps">
      {FLOW.map((f, i) => (
        <li key={f.title} className={i <= done ? 'done' : i === current ? 'current' : ''} aria-current={i === current ? 'step' : undefined}>
          <span className="flow-n" aria-hidden>
            {i <= done ? '✓' : i + 1}
          </span>
          <span>
            <strong>{f.title}</strong>
            <small>{f.text}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Report flow without hunting for the device first: pick the phone, then one form. */
export function ReportIncidentPage() {
  const [params, setParams] = useSearchParams();
  const canReport = useCan('command.LOST_MODE_ON');
  const [devices] = useQuery((api) => api.listDevices());
  const [q, setQ] = useState('');
  const chosen = devices?.find((d) => d.id === params.get('device')) ?? null;
  const eligible = (d: NonNullable<typeof devices>[number]) =>
    !d.activeIncident && d.state !== 'wiped' && d.state !== 'retired' && !d.pendingRemoval ? (d.policyAckAt ? null : 'notice not acknowledged yet') : d.activeIncident ? 'already reported' : 'not active';
  const terms = q.trim().toLowerCase();
  const list = (devices ?? []).filter((d) => !terms || `${d.displayName} ${d.serial ?? ''} ${d.model ?? ''} ${d.assignedUser?.name ?? ''}`.toLowerCase().includes(terms));
  if (!canReport) return <ErrorBox>Only a Location Operator or Super Admin can report a phone lost or stolen.</ErrorBox>;
  return (
    <div className="page narrow">
      <p className="crumbs">
        <Link to="/incidents">Lost &amp; stolen</Link> /
      </p>
      <h1>Report a lost or stolen phone</h1>
      <IncidentFlow current={0} />
      {!chosen ? (
        <Card title="1 · Which phone?">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, employee, model or serial…" aria-label="Search phones" autoFocus />
          {list.length ? (
            <ul className="pick-list">
              {list.map((d) => {
                const why = eligible(d);
                return (
                  <li key={d.id}>
                    <button type="button" className="pick" disabled={!!why} onClick={() => setParams({ device: d.id })}>
                      <span>
                        <strong>{d.displayName}</strong>
                        <small>{[d.assignedUser?.name ?? 'unassigned', d.model, d.serial !== 'unknown' ? d.serial : null].filter(Boolean).join(' · ')}</small>
                      </span>
                      {why ? <Badge tone="neutral">{why}</Badge> : <span className="pick-go" aria-hidden>→</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>{devices?.length ? 'No phone matches.' : 'No phones enrolled yet.'}</Empty>
          )}
        </Card>
      ) : (
        <>
          <div className="chosen">
            <span>
              <strong>{chosen.displayName}</strong> · {chosen.assignedUser?.name ?? 'unassigned'} · {chosen.model ?? 'unknown model'}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setParams({})}>
              Change phone
            </button>
          </div>
          {eligible(chosen) && eligible(chosen) !== 'notice not acknowledged yet' ? (
            <ErrorBox>
              This phone cannot be reported: {eligible(chosen)}.{' '}
              {chosen.activeIncident && <Link to={`/incidents/${chosen.activeIncident.id}`}>Open its incident →</Link>}
            </ErrorBox>
          ) : (
            <ReportIncidentCard deviceId={chosen.id} acknowledged={!!chosen.policyAckAt} title="2 · What happened?" />
          )}
        </>
      )}
    </div>
  );
}

const OUTCOMES = [
  { value: 'found', label: '✓ Found by the employee' },
  { value: 'recovered', label: '✓ Recovered (e.g. police)' },
  { value: 'false_alarm', label: 'False alarm' },
  { value: 'not_recovered', label: 'Not recovered' },
] as const;
