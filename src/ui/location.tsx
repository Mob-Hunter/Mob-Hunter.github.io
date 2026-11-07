import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, Field, MiniMap, fmtAgo, fmtTime, osmLink, useAsyncQuery, useCan, useQuery, type MapPoint, TableWrap } from './kit';
import { ROLE_LABEL } from '../core/rbac';
import type { LocationView } from '../core/backend';
import type { Command, LocationFilter } from '../api/console';

export const TIER_LABEL: Record<number, string> = { 1: 'On-demand', 2: 'Lost Mode', 3: 'Work hours' };
const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/;

/** Ticket input with suggestions from the server's ticket index (no coordinates involved). */
export function TicketPicker({ value, onChange, label = 'Ticket justifying this view' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const [tickets] = useQuery((api) => api.listLocationTickets(), [], { live: false });
  const listId = 'location-tickets';
  return (
    <>
      <Field label={label} hint={tickets?.length ? `${tickets.length} ticket(s) with location requests — start typing or pick one` : 'e.g. INC-1042'}>
        <input value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} list={listId} required autoComplete="off" placeholder="INC-1042" />
      </Field>
      <datalist id={listId}>
        {tickets?.map((t) => (
          <option key={t.ticket} value={t.ticket}>
            {`${t.devices.join(', ')} · ${t.fixes} fix(es)${t.open ? ' · Lost Mode open' : ''}`}
          </option>
        ))}
      </datalist>
    </>
  );
}

/** Latest fix per device, for the fleet view. Input sorted newest first. */
export function latestPerDevice(rows: LocationView[]): LocationView[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.deviceId) ? false : (seen.add(r.deviceId), true)));
}

export function toMapPoints(rows: LocationView[], latestIds: Set<string>): MapPoint[] {
  return rows.map((l) => ({
    lat: l.fix.lat,
    lng: l.fix.lng,
    accuracyM: l.fix.accuracyM,
    tier: l.tier,
    group: l.deviceId,
    at: l.fix.fixAt,
    highlight: latestIds.has(l.id),
    caption: latestIds.has(l.id) ? l.deviceName : undefined,
    label: `${l.deviceName} · ${fmtTime(l.fix.fixAt)} · ${TIER_LABEL[l.tier]} · ±${Math.round(l.fix.accuracyM)} m`,
  }));
}

export function LocationTable({ rows, showDevice = true }: { rows: LocationView[]; showDevice?: boolean }) {
  if (!rows.length) return <Empty>No location fixes match these filters.</Empty>;
  return (
    <TableWrap label="Location history">
      <table>
        <thead>
          <tr>
            {showDevice && <th>Device</th>}
            <th>When</th>
            <th>Tier</th>
            <th>Position</th>
            <th>Accuracy</th>
            <th>Source</th>
            <th>Ticket</th>
            <th>User notified</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              {showDevice && (
                <td>
                  <Link to={`/devices/${l.deviceId}`}>{l.deviceName}</Link>
                </td>
              )}
              <td className="small nowrap">
                {fmtTime(l.fix.fixAt)}
                <div className="tiny muted">{fmtAgo(l.fix.fixAt)}</div>
              </td>
              <td>
                <Badge tone={l.tier === 1 ? 'info' : l.tier === 2 ? 'bad' : 'warn'}>{TIER_LABEL[l.tier]}</Badge>
              </td>
              <td className="small nowrap">
                <a href={osmLink(l.fix.lat, l.fix.lng)} target="_blank" rel="noopener noreferrer">
                  {l.fix.lat.toFixed(5)}, {l.fix.lng.toFixed(5)}
                </a>
              </td>
              <td className="small">±{Math.round(l.fix.accuracyM)} m</td>
              <td className="small">{l.fix.source === 'last_known' ? `Last known${l.fix.ageSec ? ` (${Math.round(l.fix.ageSec / 60)} min old)` : ''}` : 'Live GPS / network'}</td>
              <td>{l.ticket ?? <span className="muted small">{l.tier === 3 ? 'policy' : '—'}</span>}</td>
              <td className="small">{l.fix.notification ? `✓ ${fmtTime(l.fix.notification.shownAt)}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** Summary of the most recent fix: what a responder needs at a glance. */
export function LatestFix({ fix }: { fix: LocationView }) {
  return (
    <dl className="kv latest-fix">
      <dt>Last position</dt>
      <dd>
        <a href={osmLink(fix.fix.lat, fix.fix.lng)} target="_blank" rel="noopener noreferrer">
          {fix.fix.lat.toFixed(5)}, {fix.fix.lng.toFixed(5)}
        </a>{' '}
        (±{Math.round(fix.fix.accuracyM)} m)
      </dd>
      <dt>When</dt>
      <dd>
        {fmtTime(fix.fix.fixAt)} · {fmtAgo(fix.fix.fixAt)}
      </dd>
      <dt>How</dt>
      <dd>
        {TIER_LABEL[fix.tier]} · {fix.fix.source === 'last_known' ? 'last known position' : 'live fix'}
      </dd>
      <dt>Employee notified</dt>
      <dd>{fix.fix.notification ? `Yes, ${fmtTime(fix.fix.notification.shownAt)}` : 'No'}</dd>
    </dl>
  );
}

/** Location panel on a device page — full view for the Location Operator, an explanation for everyone else. */
export function DeviceLocationPanel({ deviceId, commands, lostMode }: { deviceId: string; commands: Command[] | null; lostMode: boolean }) {
  const canRead = useCan('location.read');
  return canRead ? <OperatorDeviceLocation deviceId={deviceId} /> : <RestrictedLocation commands={commands} lostMode={lostMode} />;
}

function OperatorDeviceLocation({ deviceId }: { deviceId: string }) {
  const [ticket, setTicket] = useState('');
  const [filter, setFilter] = useState<LocationFilter | null>(null);
  // Deliberately not re-run on every change: each view is an audited access.
  const q = useAsyncQuery((api) => api.listLocationResults(filter!), [filter], !!filter);
  const latest = q.data?.[0];
  return (
    <Card title="Location">
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter({ deviceId, ticket: ticket.trim(), onlyTicket: false });
        }}
      >
        <TicketPicker value={ticket} onChange={setTicket} />
        <button className="btn btn-primary" disabled={!TICKET_RE.test(ticket.trim())}>
          Show location
        </button>
        {q.data && (
          <button type="button" className="btn btn-ghost" onClick={q.reload}>
            Refresh
          </button>
        )}
      </form>
      {q.error && <ErrorBox>{q.error}</ErrorBox>}
      {q.data &&
        (latest ? (
          <div className="stack">
            <LatestFix fix={latest} />
            <MiniMap points={toMapPoints(q.data, new Set([latest.id]))} />
            <details>
              <summary className="small">History ({q.data.length} fixes, last 30 days)</summary>
              <LocationTable rows={q.data} showDevice={false} />
            </details>
            <p className="tiny muted">This view was recorded in the audit log against {filter?.ticket}.</p>
          </div>
        ) : (
          <Empty>No location data is held for this device. Send a LOCATE command above (ticket required) — the employee is notified.</Empty>
        ))}
    </Card>
  );
}

function RestrictedLocation({ commands, lostMode }: { commands: Command[] | null; lostMode: boolean }) {
  const [users] = useQuery((api) => api.listUsers(), [], { live: false });
  const operators = (users ?? []).filter((u) => (u.role === 'LOCATION_OPERATOR' || u.role === 'SUPER_ADMIN') && !u.disabled);
  const lastRequest = (commands ?? []).find((c) => c.type === 'LOCATE' || c.type === 'LOST_MODE_ON');
  return (
    <Card title="Location">
      <div className="callout">
        <strong>Restricted.</strong> Device location is visible only to the {ROLE_LABEL.LOCATION_OPERATOR} and {ROLE_LABEL.SUPER_ADMIN} roles, only against a ticket, and every view is audited.
        {operators.length > 0 && <> Ask {joinNames(operators.map((o) => o.name))}.</>}
      </div>
      <dl className="kv">
        <dt>Lost Mode</dt>
        <dd>{lostMode ? <Badge tone="bad">On — location shared every 5 min</Badge> : 'Off'}</dd>
        <dt>Last location request</dt>
        <dd>
          {lastRequest ? (
            <>
              {lastRequest.type === 'LOCATE' ? 'Locate' : 'Lost Mode'} · {lastRequest.ticket} · {fmtAgo(lastRequest.issuedAt)} · {lastRequest.status}
            </>
          ) : (
            'None'
          )}
        </dd>
      </dl>
    </Card>
  );
}

function joinNames(names: string[]): ReactNode {
  return names.length <= 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
