import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, Field, MiniMap, fmtAgo, fmtTime, useAction, useAsyncQuery, useCan, useNow, useQuery, useRuntime } from '../ui/kit';
import { LatestFix, LocationTable, toMapPoints } from '../ui/location';
import { trackStats } from '../core/tracking';
import type { IncidentRecord, IncidentSummary } from '../api/console';

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
  return (
    <div className="page">
      <h1>Lost &amp; stolen</h1>
      <div className="callout">
        Report a device lost or stolen from its device page (Location Operator or Super Admin). Active tracking takes a fix every 1–5 minutes for a limited time, the employee sees a
        persistent notice the whole time, and every viewing session is audited.
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      <Card title={`Open incidents (${open.length})`}>
        {open.length ? <IncidentList items={open} now={now} /> : <Empty>
            No device is currently reported lost or stolen. To report one, open it from <Link to="/devices">Devices</Link> and use{' '}
            <em>Report lost or stolen</em>. <Link to="/help">Guide</Link>
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
  const [resolution, setResolution] = useState<'found' | 'recovered' | 'false_alarm' | 'not_recovered'>('found');
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
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => rt.api.resolveIncident(incident.id, { resolution, note }), resolution === 'not_recovered' ? 'Closed — Lost Mode stays on; consider WIPE' : 'Closed — Lost Mode ended on the phone');
          }}
        >
          <Field label="Outcome">
            <select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
              <option value="found">Found by the employee</option>
              <option value="recovered">Recovered (e.g. by police)</option>
              <option value="false_alarm">False alarm</option>
              <option value="not_recovered">Not recovered</option>
            </select>
          </Field>
          <Field label="Note (optional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <p className="tiny muted">
            {resolution === 'not_recovered'
              ? 'Stops active tracking; Lost Mode stays on (locked screen, 5-minute fixes). Ask a Device Admin to WIPE the phone.'
              : 'Ends Lost Mode and all tracking on the phone; the employee is notified.'}
          </p>
          <div>
            <button className="btn btn-primary" disabled={busy}>
              Close incident
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
