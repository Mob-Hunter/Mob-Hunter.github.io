import { useParams, Link } from 'react-router-dom';
import { Badge, Card, ErrorBox, QrImage, usePublicQuery, useRuntime } from '../ui/kit';
import { COLLECTION_NOTICE } from '../core/enrollment';

/** GET /e/{token}: public install page. Works without signing in. */
export function InstallPage() {
  const { token = '' } = useParams();
  const rt = useRuntime();
  const q = usePublicQuery(() => rt.api.installPage(token), [token]);

  return (
    <div className="public-page">
      <div className="page narrow">
        <h1>Enrol a company phone</h1>
        {q.error && <ErrorBox>{q.error}</ErrorBox>}
        {q.data && q.data.status !== 'valid' && (
          <ErrorBox>
            This enrolment link is {q.data.status === 'used' ? 'already used' : q.data.status === 'expired' ? 'expired' : 'not valid'}. Ask your IT admin for a
            new one.
          </ErrorBox>
        )}
        {q.data?.status === 'valid' && (
          <>
            <Card title="Scan this on the phone's setup screen">
              <div className="qr-box">
                <QrImage size="xl" text={JSON.stringify(q.data.provisioning)} label="Device-owner provisioning QR" />
              </div>
              <ol className="steps">
                <li>
                  <strong>Factory-reset</strong> the phone (Settings → System → Reset). Back up nothing personal — this is a company device.
                </li>
                <li>
                  On the first <em>Welcome</em> screen, <strong>tap the screen six times</strong>. A QR reader opens.
                </li>
                <li>Connect to Wi-Fi if asked, then scan the QR above.</li>
                <li>The phone installs the company agent and becomes managed. Read the notice and tap “I understand”.</li>
              </ol>
              <p className="small muted">This link works once and expires {new Date(q.data.expiresAt).toLocaleTimeString()}.</p>
            </Card>
            <Card title="What your organisation will be able to see">
              <ul>
                {COLLECTION_NOTICE.collected.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p>
                <strong>Never collected:</strong> {COLLECTION_NOTICE.notCollected.join(' ')}
              </p>
              <p className="small">{COLLECTION_NOTICE.retention}</p>
            </Card>
            <Card title={<>Sideload APK <Badge tone="warn">testing only</Badge></>}>
              <p className="small">
                Installing from this link gives an ordinary app <strong>without</strong> device-owner rights. It cannot enforce policy and is only for
                developer testing: <code className="break">{q.data.sideloadApkUrl}</code>
              </p>
            </Card>
          </>
        )}
        <p className="small">
          <Link to="/privacy">Privacy notice &amp; governance</Link>
        </p>
      </div>
    </div>
  );
}
