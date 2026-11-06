import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, Field, MiniMap, fmtTime, useAction, useAsyncQuery, useCan, useRuntime } from '../ui/kit';

export function LocationsPage() {
  const canRead = useCan('location.read');
  const [ticket, setTicket] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const q = useAsyncQuery((api) => api.listLocationResults({ ticket: submitted! }), [submitted], canRead && !!submitted);

  if (!canRead) return <ErrorBox>Location data is only available to the Location Operator role.</ErrorBox>;

  return (
    <div className="page">
      <h1>Location results</h1>
      <div className="callout">
        Location results are encrypted at rest (AES-256-GCM), deleted after 30 days, and every view is written to the audit log against the ticket you enter.
      </div>
      <Card>
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(ticket.trim().toUpperCase());
          }}
        >
          <Field label="Ticket justifying this view" hint="e.g. INC-1042">
            <input value={ticket} onChange={(e) => setTicket(e.target.value)} required />
          </Field>
          <button className="btn btn-primary">Show results</button>
          {q.data && (
            <button type="button" className="btn btn-ghost" onClick={q.reload}>
              Refresh
            </button>
          )}
        </form>
      </Card>
      {q.error && <ErrorBox>{q.error}</ErrorBox>}
      {q.data &&
        (q.data.length ? (
          <>
            <Card title="Map">
              <MiniMap points={q.data.map((l, i) => ({ ...l.fix, label: `${l.deviceName} · ${fmtTime(l.fix.fixAt)}`, highlight: i === 0 }))} />
            </Card>
            <Card title={`${q.data.length} results`}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Tier</th>
                      <th>Fix</th>
                      <th>Ticket</th>
                      <th>When</th>
                      <th>User notified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <Link to={`/devices/${l.deviceId}`}>{l.deviceName}</Link>
                        </td>
                        <td>
                          <Badge tone={l.tier === 1 ? 'info' : l.tier === 2 ? 'bad' : 'warn'}>{l.tier === 1 ? 'On-demand' : l.tier === 2 ? 'Lost Mode' : 'Work hours'}</Badge>
                        </td>
                        <td className="small">
                          {l.fix.lat.toFixed(5)}, {l.fix.lng.toFixed(5)} ±{Math.round(l.fix.accuracyM)} m
                        </td>
                        <td>{l.ticket ?? '—'}</td>
                        <td className="small">{fmtTime(l.fix.fixAt)}</td>
                        <td className="small">{l.fix.notification ? `✓ ${fmtTime(l.fix.notification.shownAt)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        ) : (
          <Empty>No location results in the last 30 days.</Empty>
        ))}
      <RetentionCard />
    </div>
  );
}

function RetentionCard() {
  const rt = useRuntime();
  const { run, busy } = useAction();
  const canPurge = useCan('location.purge');
  if (!canPurge) return null;
  return (
    <Card title="Retention">
      <button className="btn" disabled={busy} onClick={() => void run(async () => `${await rt.api.purgeNow()}`, 'Retention job ran')}>
        Run 30-day purge now
      </button>
    </Card>
  );
}
