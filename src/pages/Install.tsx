import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Card, ErrorBox, QrImage, usePublicQuery, useRuntime } from '../ui/kit';
import { COLLECTION_NOTICE } from '../core/enrollment';

const AGENT_PACKAGE = 'com.mobhunter.agent';

/**
 * Android intent URL: opens the installed agent with the enrolment link, or — when the app
 * is not installed — falls back to downloading the APK (Chrome's browser_fallback_url).
 */
export function enrolIntentUrl(standardLink: string, apkUrl: string): string {
  const query = standardLink.replace(/^mobhunter:\/\/enrol\?/, '');
  return `intent://enrol?${query}#Intent;scheme=mobhunter;package=${AGENT_PACKAGE};S.browser_fallback_url=${encodeURIComponent(apkUrl)};end`;
}

const isAndroid = () => /Android/i.test(navigator.userAgent);

/** GET /e/{token}: public enrolment page, opened by scanning the console's QR with the phone camera. */
export function InstallPage() {
  const { token = '' } = useParams();
  const rt = useRuntime();
  const q = usePublicQuery(() => rt.api.installPage(token), [token]);
  const [started, setStarted] = useState(false);
  const android = isAndroid();

  const data = q.data?.status === 'valid' ? q.data : null;
  const start = () => {
    if (!data) return;
    // The app reads this link from the clipboard on first launch, so a fresh install enrols by itself.
    void navigator.clipboard?.writeText(data.standardLink).catch(() => undefined);
    setStarted(true);
  };

  return (
    <div className="public-page">
      <div className="page narrow">
        <h1>Enrol this phone</h1>
        {q.error && <ErrorBox>{q.error}</ErrorBox>}
        {q.data && q.data.status !== 'valid' && (
          <ErrorBox>
            This enrolment link is {q.data.status === 'used' ? 'already used' : q.data.status === 'expired' ? 'expired' : 'not valid'}. Ask your IT team for a new
            one.
          </ErrorBox>
        )}
        {data && (
          <>
            {android ? (
              <Card className="enrol-hero">
                <ol className="enrol-flow">
                  <li className={started ? 'done' : 'current'}>
                    <strong>Install Mob Hunter</strong>
                    <span>Tap the button. If Android asks, allow your browser to install apps, then tap Install.</span>
                  </li>
                  <li className={started ? 'current' : ''}>
                    <strong>Open the app</strong>
                    <span>Tap Open when the install finishes. The phone enrols itself.</span>
                  </li>
                  <li>
                    <strong>Allow the permissions</strong>
                    <span>Notifications and location (“Allow all the time”), then read the notice.</span>
                  </li>
                </ol>
                <a className="btn btn-primary btn-lg btn-block" href={enrolIntentUrl(data.standardLink, data.sideloadApkUrl)} onClick={start}>
                  {started ? 'Open Mob Hunter' : 'Install Mob Hunter & enrol'}
                </a>
                {started && (
                  <p className="small muted center">
                    Download finished? Open it from the notification, install, then tap <strong>Open</strong>. If the app does not enrol by itself, come back
                    and tap the button again.
                  </p>
                )}
                <p className="tiny muted center">Works once · expires {new Date(data.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
              </Card>
            ) : (
              <Card title="Open this page on the phone">
                <div className="enrol-grid">
                  <div className="qr-box">
                    <QrImage size="lg" text={location.href} label="QR code to open this enrolment page on the phone" />
                  </div>
                  <div className="stack">
                    <p>Scan this code with the Android phone&apos;s camera. The page opens there with one button that installs Mob Hunter and enrols the phone.</p>
                    <p className="small muted">
                      Works once · expires {new Date(data.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              </Card>
            )}

            <Card title="What your organisation will be able to see">
              <ul className="lp-check">
                {COLLECTION_NOTICE.collected.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="small">
                <strong>Never collected:</strong> {COLLECTION_NOTICE.notCollected.join(' ')}
              </p>
              <p className="small muted">
                On a phone enrolled this way your organisation cannot wipe it, reboot it, install apps or read your data. {COLLECTION_NOTICE.retention}
              </p>
            </Card>

            <details className="card enrol-company">
              <summary>
                <strong>Company phone? Use zero-touch setup instead</strong>
                <span className="small muted"> — factory reset, fully managed</span>
              </summary>
              <div className="enrol-grid">
                <div className="qr-box">
                  <QrImage size="xl" text={JSON.stringify(data.provisioning)} label="Device-owner provisioning QR" />
                </div>
                <ol className="steps">
                  <li>
                    <strong>Factory-reset</strong> the company phone.
                  </li>
                  <li>
                    On the first <em>Welcome</em> screen, <strong>tap six times</strong>. A QR reader opens.
                  </li>
                  <li>Connect to Wi-Fi and scan this code. Android downloads, verifies and installs Mob Hunter by itself.</li>
                  <li>The employee reads the notice and taps “I understand”.</li>
                </ol>
              </div>
            </details>
          </>
        )}
        <p className="small">
          <Link to="/privacy">Privacy notice &amp; governance</Link>
        </p>
      </div>
    </div>
  );
}
