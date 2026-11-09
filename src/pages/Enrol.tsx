import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, Field, QrImage, fmtAgo, useAction, useNow, useQuery, useRuntime, TableWrap } from '../ui/kit';
import type { ProvisioningPayload } from '../core/types';

export function installUrl(token: string): string {
  return `${location.origin}${location.pathname}#/e/${token}`;
}

export function EnrolPage() {
  const rt = useRuntime();
  const now = useNow(1000);
  const [note, setNote] = useState('');
  const [ssid, setSsid] = useState('');
  const [minted, setMinted] = useState<{ token: string; expiresAt: number; provisioning: ProvisioningPayload; sideloadApkUrl: string; standardLink: string } | null>(null);
  const [tokens] = useQuery((api) => api.listEnrollments());
  const [unnamed] = useQuery((api) => api.listDevices({ unnamedOnly: true }));
  const { run, busy } = useAction();
  const [kind, setKind] = useState<'existing' | 'company'>('existing');

  const mint = () =>
    run(async () => {
      const r = await rt.api.createEnrollment({ note: note || undefined, wifiSsid: ssid || undefined });
      setMinted(r);
      return r;
    }, 'Enrolment token minted (valid 15 minutes, single use)');

  const simulate = () =>
    run(async () => {
      if (!minted) return;
      await rt.addAgent(minted.provisioning);
      setMinted(null);
    }, 'Simulated phone scanned the QR and enrolled — see Device simulator');

  const left = minted ? Math.max(0, Math.round((minted.expiresAt - now) / 1000)) : 0;

  return (
    <div className="page">
      <h1>Add devices</h1>
      <p className="muted">Mint a one-time enrolment, then scan its QR code with the phone. It is valid for 15 minutes and works once.</p>

      <Card title="1 · Mint an enrolment">
        <div className="row-form">
          <Field label="Note (optional)" hint="Only visible to admins, e.g. batch or site">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Setup Wi-Fi SSID (optional)" hint="Company phones only. Passwords are never put in the QR">
            <input value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} />
          </Field>
          <button className="btn btn-primary" disabled={busy} onClick={() => void mint()}>
            Mint token + QR
          </button>
        </div>
      </Card>

      <Card
        title="2 · Scan it with the phone"
        actions={
          minted && left > 0 ? (
            <Badge tone={left > 60 ? 'info' : 'warn'}>
              expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </Badge>
          ) : undefined
        }
      >
        <div className="seg" role="tablist" aria-label="Type of phone">
          <button role="tab" aria-selected={kind === 'existing'} className={kind === 'existing' ? 'on' : ''} onClick={() => setKind('existing')}>
            Existing phone
            <small>no reset · 1 minute</small>
          </button>
          <button role="tab" aria-selected={kind === 'company'} className={kind === 'company' ? 'on' : ''} onClick={() => setKind('company')}>
            Factory-reset company phone
            <small>zero-touch · fully managed</small>
          </button>
        </div>
        {!minted ? (
          <Empty>Mint an enrolment in step 1 and its QR code appears here.</Empty>
        ) : left === 0 ? (
          <Empty>This enrolment has expired. Mint a new one.</Empty>
        ) : kind === 'existing' ? (
          <div className="enrol-grid">
            <div className="qr-box">
              <QrImage size="lg" text={installUrl(minted.token)} label="Enrolment QR for an existing phone" />
              <span className="small muted">Scan with the phone&apos;s camera</span>
            </div>
            <div className="stack">
              <ol className="steps">
                <li>Open the camera on the Android phone and scan this code.</li>
                <li>
                  Tap <strong>Install Mob Hunter &amp; enrol</strong>, then <strong>Install</strong> and <strong>Open</strong>. The phone enrols itself.
                </li>
                <li>Allow notifications and location, then read the notice and tap “I understand”.</li>
                <li>The phone appears below within a minute.</li>
              </ol>
              <p className="small muted">
                The organisation sees health and, only against a ticket, location. It cannot wipe the phone, reboot it, install apps or enforce policy — use a
                factory-reset company phone for that.
              </p>
              <Field label="Or send this link to the phone">
                <input readOnly value={installUrl(minted.token)} onFocus={(e) => e.currentTarget.select()} />
              </Field>
            </div>
          </div>
        ) : (
          <div className="enrol-grid">
            <div className="qr-box">
              <QrImage size="xl" text={JSON.stringify(minted.provisioning)} label="Device-owner provisioning QR code" />
              <span className="small muted">Scan on the phone&apos;s Welcome screen</span>
            </div>
            <div className="stack">
              <ol className="steps">
                <li>Factory-reset the company phone.</li>
                <li>
                  On the <em>Welcome</em> screen, <strong>tap six times</strong> to open the QR reader, connect to Wi-Fi and scan this code.
                </li>
                <li>Android downloads, verifies and installs Mob Hunter by itself and makes it device owner.</li>
                <li>The employee reads the notice and taps “I understand”. The phone appears below.</li>
              </ol>
              <div className="btn-row">
                <a className="btn" href={`#/e/${minted.token}`} target="_blank" rel="noreferrer">
                  Open enrolment page
                </a>
                <button className="btn" onClick={() => void simulate()} disabled={busy}>
                  ▯ Simulate a phone scanning this QR
                </button>
              </div>
              <details>
                <summary className="small">Raw provisioning payload</summary>
                <pre className="code">{JSON.stringify(minted.provisioning, null, 2)}</pre>
              </details>
            </div>
          </div>
        )}
      </Card>

      <Card title="3 · New / unnamed devices" actions={<Link to="/devices?unnamed=1">Open list</Link>}>
        {unnamed?.length ? (
          <ul className="list">
            {unnamed.map((d) => (
              <li key={d.id}>
                <Link to={`/devices/${d.id}`}>
                  <strong>Unnamed device</strong> · {d.model ?? 'model pending'} · {d.serial ?? ''}
                </Link>
                <span className="muted small">enrolled {fmtAgo(d.enrolledAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No unnamed devices.</Empty>
        )}
      </Card>

      <Card title="Enrolment tokens">
        {tokens?.length ? (
          <TableWrap label="Enrolment tokens">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <code>{t.id}</code>
                    </td>
                    <td>{t.usedAt ? <Badge tone="ok">used</Badge> : t.expiresAt < now ? <Badge>expired</Badge> : <Badge tone="info">valid</Badge>}</td>
                    <td className="small">{fmtAgo(t.createdAt, now)}</td>
                    <td className="small">{t.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : (
          <Empty>No tokens yet.</Empty>
        )}
        <p className="tiny muted">Only a SHA-256 hash of each token is stored; the token itself is shown once.</p>
      </Card>
    </div>
  );
}
