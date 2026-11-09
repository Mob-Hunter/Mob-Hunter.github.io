import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, QrImage } from '../ui/kit';
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

/** File size from a HEAD request (Content-Length is readable cross-origin). */
function useFileSize(url: string) {
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url, { method: 'HEAD', cache: 'no-store' })
      .then((r) => {
        const n = Number(r.headers.get('content-length'));
        if (alive && r.ok && n > 0) setSize(n);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [url]);
  return size;
}

function CopyButton({ text, label, done = 'Copied' }: { text: string; label: string; done?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={copy} aria-live="polite">
      {copied ? `✓ ${done}` : label}
    </button>
  );
}

function ApkCard({ app, base, sha }: { app: (typeof APK_FILES)[number]; base: string; sha?: string }) {
  const url = `${base}/${app.file}`;
  const size = useFileSize(url);
  return (
    <article className="apk-card">
      <header className="apk-head">
        <span className="apk-icon" aria-hidden>
          {app.file.includes('agent') ? '⛨' : '◈'}
        </span>
        <div>
          <h3>{app.name}</h3>
          <Badge>{app.who}</Badge>
        </div>
      </header>
      <div className="apk-body">
        <figure className="apk-qr">
          <QrImage size="sm" text={url} label={`QR code to download ${app.name}`} />
          <figcaption>Scan with the phone camera</figcaption>
        </figure>
        <div className="apk-info">
          <p>{app.text}</p>
          <div className="apk-actions">
            <a className="btn btn-primary" href={url} download>
              ↓ Download APK{size ? <span className="apk-size">{(size / 1048576).toFixed(1)} MB</span> : null}
            </a>
            <CopyButton text={url} label="Copy link" done="Link copied" />
          </div>
        </div>
      </div>
      {sha && (
        <details className="apk-verify">
          <summary>Verify this file (SHA-256)</summary>
          <code className="apk-sha">{sha}</code>
          <div className="apk-verify-row">
            <span className="tiny muted">
              Compare with <code>sha256sum {app.file}</code> before installing.
            </span>
            <CopyButton text={sha} label="Copy hash" />
          </div>
        </details>
      )}
    </article>
  );
}

/** Download cards with a QR code per APK — scan with the phone's camera to download. */
export function ApkDownloads({ compact = false }: { compact?: boolean }) {
  const base = downloadsBase();
  const sums = useChecksums(base);
  if (sums && !Object.keys(sums).length)
    return (
      <div className="callout" role="status">
        The Android apps are not published at <code className="break">{base}</code> yet. They appear here after the next release build.
      </div>
    );
  return (
    <div className={compact ? 'apk-grid apk-grid-compact' : 'apk-grid'}>
      {APK_FILES.map((a) => (
        <ApkCard key={a.file} app={a} base={base} sha={sums?.[a.file]} />
      ))}
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
