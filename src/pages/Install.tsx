import { useParams, Link } from 'react-router-dom';
import { Card, ErrorBox, QrImage, usePublicQuery, useRuntime } from '../ui/kit';
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
            <Card title="Using your own phone? (no factory reset)">
              <ol className="steps">
                <li>
                  Install the Mob Hunter device agent:{' '}
                  <a href={q.data.sideloadApkUrl} download>
                    download the app
                  </a>
                  .
                </li>
                <li>Come back to this page on the phone and tap the button below. The app opens and enrols the phone.</li>
              </ol>
              <a className="btn btn-primary" href={q.data.standardLink}>
                Open in the Mob Hunter app
              </a>
              <p className="small muted">
                Your organisation then sees device health and — only when it asks against a ticket, with a notification every time — the phone&apos;s location. It
                cannot wipe the phone, read your data or install apps.
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
