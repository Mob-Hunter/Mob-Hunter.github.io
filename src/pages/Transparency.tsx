import { useParams, Link } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, MiniMap, fmtTime, usePublicQuery, useRuntime } from '../ui/kit';

/** Employee-facing page linked from every on-device notification. No admin login needed; protected by an unguessable per-device key. */
export function TransparencyPage() {
  const { deviceId = '', key = '' } = useParams();
  const rt = useRuntime();
  const q = usePublicQuery(() => rt.api.transparency(deviceId, key), [deviceId, key, rt.version]);

  return (
    <div className="public-page">
      <div className="page narrow">
        <h1>Your company device</h1>
        {q.error && <ErrorBox>This page is not available. Use the link in a notification on your device.</ErrorBox>}
        {q.data && (
          <>
            <Card title={q.data.deviceName}>
              <ul className="checklist">
                <li className={q.data.acknowledgedAt ? 'yes' : 'no'}>Notice acknowledged {q.data.acknowledgedAt ? fmtTime(q.data.acknowledgedAt) : '— not yet'}</li>
                <li className={q.data.lostMode ? 'yes' : 'no'}>
                  Lost Mode{' '}
                  {q.data.lostMode
                    ? q.data.tracking
                      ? `is ON — the phone was reported ${q.data.tracking.kind} and is tracked every ${Math.round(q.data.tracking.intervalSec / 60)} min until ${fmtTime(q.data.tracking.until)}`
                      : 'is ON — location is shared every 5 minutes'
                    : 'is off'}
                </li>
                <li className={q.data.continuousLocation ? 'yes' : 'no'}>Work-hours location sharing {q.data.continuousLocation ? 'is ON (with a persistent notification)' : 'is off'}</li>
              </ul>
            </Card>
            <Card title="Location requests in the last 30 days">
              {q.data.events.length ? (
                <ul className="list">
                  {q.data.events.map((e, i) => (
                    <li key={i}>
                      <span>
                        <strong>{e.type.replace(/_/g, ' ')}</strong> {e.ticket && <Badge tone="info">{e.ticket}</Badge>}
                      </span>
                      <span className="small">
                        {fmtTime(e.at)} · {e.status}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>No location or security actions were taken on your device in the last 30 days.</Empty>
              )}
            </Card>
            <Card title="Location data held about this device">
              {q.data.locations.length ? (
                <MiniMap points={q.data.locations.map((l, i) => ({ ...l, label: fmtTime(l.at), highlight: i === 0 }))} />
              ) : (
                <Empty>No location data is stored.</Empty>
              )}
              <p className="tiny muted">{q.data.notice.retention}</p>
            </Card>
            <Card title="What is and is not collected">
              <ul>
                {q.data.notice.collected.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p>
                <strong>Never collected:</strong> {q.data.notice.notCollected.join(' ')}
              </p>
              <p className="small">{q.data.notice.rights}</p>
            </Card>
          </>
        )}
        <p className="small">
          <Link to="/privacy">Full privacy notice</Link>
        </p>
      </div>
    </div>
  );
}
