import { useEffect } from 'react';
import { ApkDownloads } from './Download';
import { QrImage } from '../ui/kit';
import { SERVER_URL } from '../config';

/**
 * Shown on copies of the console that are not the live server (e.g. GitHub Pages)
 * when a production server is configured. No demo, no data — it sends people to the server.
 */
export function Landing() {
  const target = `${SERVER_URL}/`;
  useEffect(() => {
    // Deep links (enrolment pages, employee transparency links, a specific console page) go straight to the server.
    if (location.hash && location.hash !== '#/' && location.hash !== '#') location.replace(`${target}${location.hash}`);
  }, [target]);
  return (
    <div className="public-page">
      <div className="page narrow">
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden>
            ◈
          </span>
          FleetGuard
        </div>
        <h1>Company device management</h1>
        <div className="card landing-card">
          <div className="download-card">
            <QrImage text={target} label="QR code to open the FleetGuard console" />
            <div className="stack">
              <p>The FleetGuard console runs on your organisation&apos;s secure server.</p>
              <a className="btn btn-primary" href={target}>
                Open the console →
              </a>
              <p className="tiny muted break">{target}</p>
            </div>
          </div>
        </div>
        <h2>Android apps</h2>
        <ApkDownloads />
        <p className="tiny muted">
          <a href={`${target}#/privacy`}>Privacy notice &amp; governance</a>
        </p>
      </div>
    </div>
  );
}
