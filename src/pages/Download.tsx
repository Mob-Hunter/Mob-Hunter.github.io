import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, QrImage } from '../ui/kit';
import { APK_FILES, DOWNLOADS_URL } from '../config';

/** Absolute base for downloads: the live server when configured, else this origin. */
export function downloadsBase(): string {
  return DOWNLOADS_URL ?? `${location.origin}${location.pathname.replace(/\/[^/]*$/, '')}/downloads`;
}

/** SHA-256 per file from SHA256SUMS.txt (published next to the APKs). */
function useChecksums(base: string) {
  const [sums, setSums] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${base}/SHA256SUMS.txt`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => {
        if (!alive) return;
        const out: Record<string, string> = {};
        for (const line of t.split('\n')) {
          const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
          if (m) out[m[2]] = m[1];
        }
        setSums(out);
      })
      .catch(() => alive && setSums({}));
    return () => {
      alive = false;
    };
  }, [base]);
  return sums;
}

/** Download cards with a QR code per APK — scan with the phone's camera to download. */
export function ApkDownloads({ compact = false }: { compact?: boolean }) {
  const base = downloadsBase();
  const sums = useChecksums(base);
  return (
    <div className={compact ? 'stack' : 'grid2'}>
      {APK_FILES.map((a) => {
        const url = `${base}/${a.file}`;
        return (
          <Card
            key={a.file}
            title={
              <>
                {a.name} <Badge>{a.who}</Badge>
              </>
            }
          >
            <div className="download-card">
              <QrImage text={url} label={`QR code to download ${a.name}`} />
              <div className="stack">
                <p className="small">{a.text}</p>
                <a className="btn btn-primary" href={url} download>
                  Download APK
                </a>
                <p className="tiny muted break">
                  {url}
                  {sums?.[a.file] && (
                    <>
                      <br />
                      SHA-256 {sums[a.file]}
                    </>
                  )}
                </p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function DownloadPage() {
  return (
    <div className="public-page">
      <div className="page narrow">
        <h1>Android apps</h1>
        <p className="muted">Point the phone&apos;s camera at a QR code to download the app, or tap the button on the phone itself.</p>
        <ApkDownloads />
        <div className="callout small">
          <strong>Enrolling a company phone?</strong> Don&apos;t install the agent by hand. In the console go to <em>Add devices</em>, factory-reset the phone, tap the
          welcome screen six times and scan the enrolment QR — Android then installs the agent as device owner.
        </div>
        <p className="small">
          <Link to="/login">Sign in to the console</Link> · <Link to="/privacy">Privacy notice</Link>
        </p>
      </div>
    </div>
  );
}
