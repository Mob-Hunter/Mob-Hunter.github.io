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
  const [minted, setMinted] = useState<{ token: string; expiresAt: number; provisioning: ProvisioningPayload; sideloadApkUrl: string } | null>(null);
  const [tokens] = useQuery((api) => api.listEnrollments());
  const [unnamed] = useQuery((api) => api.listDevices({ unnamedOnly: true }));
  const { run, busy } = useAction();

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
      <div className="callout">
        <strong>How enrolment works.</strong> To become <em>device owner</em> the phone must be factory-reset. On the first setup screen, tap the welcome
        screen <strong>six times</strong> to open the QR reader and scan the provisioning QR below. A plain APK link alone can <strong>not</strong> fully
        enrol a phone — it installs the agent as an ordinary app without management rights, for testing only.
      </div>

      <Card title="1 · Mint an enrolment">
        <div className="row-form">
          <Field label="Note (optional)" hint="Only visible to admins, e.g. batch or site">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Setup Wi-Fi SSID (optional)" hint="Passwords are never put in the QR">
            <input value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} />
          </Field>
          <button className="btn btn-primary" disabled={busy} onClick={() => void mint()}>
            Mint token + QR
          </button>
        </div>
      </Card>

      {!minted && (
        <Card title="2 · Scan on the factory-reset phone">
          <Empty>Mint an enrolment in step 1 and its provisioning QR appears here. It is valid for 15 minutes and can be used once.</Empty>
        </Card>
      )}
      {minted && (
        <Card
          title="2 · Scan on the factory-reset phone"
          actions={
            <Badge tone={left > 60 ? 'info' : 'warn'}>
              expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </Badge>
          }
        >
          {left === 0 ? (
            <Empty>This token has expired. Mint a new one.</Empty>
          ) : (
            <div className="enrol-grid">
              <div className="qr-box">
                <QrImage text={JSON.stringify(minted.provisioning)} label="Device-owner provisioning QR code" />
                <span className="small muted">Device-owner provisioning QR</span>
              </div>
              <div className="stack">
                <ol className="steps">
                  <li>Factory-reset the company phone.</li>
                  <li>On the welcome screen, tap six times and scan this QR.</li>
                  <li>The phone downloads the signed agent, checks its signature and becomes device owner.</li>
                  <li>The employee reads the notice and taps “I understand”.</li>
                  <li>The phone appears below as <em>Unnamed device</em> — give it a name.</li>
                </ol>
                <Field label="Install page (share with the person enrolling)">
                  <input readOnly value={installUrl(minted.token)} onFocus={(e) => e.currentTarget.select()} />
                </Field>
                <div className="btn-row">
                  <a className="btn" href={`#/e/${minted.token}`} target="_blank" rel="noreferrer">
                    Open install page
                  </a>
                  <button className="btn btn-primary" onClick={() => void simulate()} disabled={busy}>
                    ▯ Simulate a phone scanning this QR
                  </button>
                </div>
                <details>
                  <summary className="small">Raw provisioning payload</summary>
                  <pre className="code">{JSON.stringify(minted.provisioning, null, 2)}</pre>
                </details>
                <p className="small">
                  <Badge tone="warn">Testing only</Badge> Sideload APK (not device owner):{' '}
                  <code className="break">{minted.sideloadApkUrl}</code>
                </p>
              </div>
            </div>
          )}
        </Card>
      )}

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
