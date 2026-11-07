import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, Field, MiniMap, fmtAgo, fmtTime, useAction, useAsyncQuery, useCan, useQuery, useRuntime } from '../ui/kit';
import { LocationTable, TicketPicker, TIER_LABEL, latestPerDevice, toMapPoints } from '../ui/location';
import type { LocationFilter } from '../api/console';

const PERIODS = [
  { label: 'All retained (30 days)', ms: 0 },
  { label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
  { label: 'Last 24 hours', ms: 24 * 3600_000 },
];
const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,8}$/;

export function LocationsPage() {
  const canRead = useCan('location.read');
  const canPurge = useCan('location.purge');
  if (!canRead && !canPurge) return <ErrorBox>Location data is only available to the Location Operator role.</ErrorBox>;
  return (
    <div className="page">
      <h1>Locations</h1>
      <div className="callout">
        Location results are encrypted at rest (AES-256-GCM), deleted after 30 days, and every view is written to the audit log against the ticket you enter. The employee
        is notified on their phone for every fix.
      </div>
      {canRead && <LocationWorkspace />}
      {canPurge && <RetentionCard />}
    </div>
  );
}

function LocationWorkspace() {
  const [tickets, ticketErr] = useQuery((api) => api.listLocationTickets());
  const [devices] = useQuery((api) => api.listDevices());
  const [ticket, setTicket] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [tier, setTier] = useState('');
  const [period, setPeriod] = useState(0);
  const [onlyTicket, setOnlyTicket] = useState(true);
  const [filter, setFilter] = useState<LocationFilter | null>(null);
  // One audited read per submit — not refreshed on every change.
  const q = useAsyncQuery((api) => api.listLocationResults(filter!), [filter], !!filter);

  const submit = (t = ticket) => {
    const tk = t.trim().toUpperCase();
    setTicket(tk);
    setFilter({ ticket: tk, deviceId: deviceId || undefined, tier: tier ? (Number(tier) as 1 | 2 | 3) : undefined, sinceMs: PERIODS[period].ms || undefined, onlyTicket });
  };

  const latest = useMemo(() => latestPerDevice(q.data ?? []), [q.data]);
  const latestIds = useMemo(() => new Set(latest.map((l) => l.id)), [latest]);
  const lostNow = (devices ?? []).filter((d) => d.lostMode);

  return (
    <>
      <Card title="Search location data">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="row-form">
            <TicketPicker value={ticket} onChange={setTicket} />
            <Field label="Device">
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">All devices</option>
                {devices?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tier">
              <select value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="">All tiers</option>
                <option value="1">On-demand (LOCATE)</option>
                <option value="2">Lost Mode</option>
                <option value="3">Work hours</option>
              </select>
            </Field>
            <Field label="Period">
              <select value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
                {PERIODS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <label className="check small">
            <input type="checkbox" checked={onlyTicket} onChange={(e) => setOnlyTicket(e.target.checked)} /> Only fixes recorded under this ticket (recommended —
            purpose limitation)
          </label>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={!TICKET_RE.test(ticket.trim().toUpperCase())}>
              Show locations
            </button>
            {q.data && (
              <button type="button" className="btn btn-ghost" onClick={q.reload}>
                Refresh
              </button>
            )}
          </div>
        </form>
      </Card>

      {lostNow.length > 0 && (
        <div className="callout callout-bad">
          <strong>{lostNow.length} device(s) in Lost Mode:</strong>{' '}
          {lostNow.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ', '}
              <Link to={`/devices/${d.id}`}>{d.displayName}</Link>
            </span>
          ))}
        </div>
      )}

      {q.error && <ErrorBox>{q.error}</ErrorBox>}
      {q.data && (
        <>
          <div className="stats stats-3">
            <div className="stat">
              <span className="stat-n">{latest.length}</span>
              <span className="stat-l">Devices located</span>
            </div>
            <div className="stat">
              <span className="stat-n">{q.data.length}</span>
              <span className="stat-l">Fixes</span>
            </div>
            <div className="stat">
              <span className="stat-n">{latest[0] ? fmtAgo(latest[0].fix.fixAt) : '—'}</span>
              <span className="stat-l">Most recent</span>
            </div>
          </div>
          {q.data.length ? (
            <>
              <Card title="Fleet map">
                <MiniMap points={toMapPoints(q.data, latestIds)} />
              </Card>
              <Card title="Latest position per device">
                <ul className="list">
                  {latest.map((l) => (
                    <li key={l.id}>
                      <span>
                        <Link to={`/devices/${l.deviceId}`}>
                          <strong>{l.deviceName}</strong>
                        </Link>
                        <div className="small muted">
                          {l.fix.lat.toFixed(5)}, {l.fix.lng.toFixed(5)} · ±{Math.round(l.fix.accuracyM)} m · {fmtTime(l.fix.fixAt)}
                        </div>
                      </span>
                      <span>
                        <Badge tone={l.tier === 2 ? 'bad' : l.tier === 3 ? 'warn' : 'info'}>{TIER_LABEL[l.tier]}</Badge>{' '}
                        <span className="small muted">{fmtAgo(l.fix.fixAt)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title={`History (${q.data.length})`}>
                <LocationTable rows={q.data} />
              </Card>
            </>
          ) : (
            <Empty>No location fixes match these filters. Location data older than 30 days is deleted automatically.</Empty>
          )}
          <p className="tiny muted">This view was recorded in the audit log against {filter?.ticket}.</p>
        </>
      )}

      <Card title="Tickets with location activity">
        {ticketErr && <ErrorBox>{ticketErr}</ErrorBox>}
        {tickets?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Devices</th>
                  <th>Requests</th>
                  <th>Fixes</th>
                  <th>Last activity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.ticket}>
                    <td>
                      <strong>{t.ticket}</strong> {t.open && <Badge tone="bad">Lost Mode on</Badge>}
                    </td>
                    <td className="small">{t.devices.join(', ')}</td>
                    <td>{t.requests}</td>
                    <td>{t.fixes}</td>
                    <td className="small nowrap">{fmtAgo(t.lastAt)}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => submit(t.ticket)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            No location requests yet. Open a device and send <strong>LOCATE</strong> with a ticket reference — the employee is notified and the result appears here.
          </Empty>
        )}
        <p className="tiny muted">This index shows ticket references and device names only; positions are revealed (and audited) when you open a ticket.</p>
      </Card>
    </>
  );
}

function RetentionCard() {
  const rt = useRuntime();
  const { run, busy } = useAction();
  return (
    <Card title="Retention (Security)">
      <p className="small muted">Location fixes older than 30 days are purged automatically every hour. You can run the job now; the purge is recorded in the audit log.</p>
      <button className="btn" disabled={busy} onClick={() => void run(async () => `${await rt.api.purgeNow()}`, 'Retention job ran')}>
        Run 30-day purge now
      </button>
    </Card>
  );
}
