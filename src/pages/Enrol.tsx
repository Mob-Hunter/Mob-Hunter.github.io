import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DOWNLOADS_URL } from '../config';
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
  const [params] = useSearchParams();
  const [kind, setKind] = useState<'existing' | 'company' | 'computer' | 'ios'>(params.get('platform') === 'desktop' ? 'computer' : 'existing');
  const [os, setOs] = useState<'windows' | 'linux' | 'macos'>('windows');

  const mint = () =>
    run(async () => {
      const r = await rt.api.createEnrollment({ note: note || undefined, wifiSsid: ssid || undefined });
      setMinted(r);
      return r;
    }, 'Enrolment token minted (valid 15 minutes, single use)');

  const simulateComputer = () =>
    run(async () => {
      if (!minted) return;
      const seed =
        os === 'windows'
          ? { platform: 'windows' as const, hardware: { serial: `PC${Math.random().toString(36).slice(2, 9).toUpperCase()}`, model: 'HP EliteBook 840 G11', os: 'Windows 11 Pro 24H2' }, posture: { patchLevel: '2026-10-14', security: { encrypted: true, firewall: true, antivirus: true, secureBoot: true, pendingUpdates: 2 } } }
          : os === 'linux'
            ? { platform: 'linux' as const, hardware: { serial: `LX${Math.random().toString(36).slice(2, 9).toUpperCase()}`, model: 'Dell OptiPlex 7020', os: 'Ubuntu 24.04.3 LTS' }, posture: { patchLevel: '2026-11-01', noBattery: true, security: { encrypted: true, firewall: false, pendingUpdates: 0 } } }
            : { platform: 'macos' as const, hardware: { serial: `C02${Math.random().toString(36).slice(2, 9).toUpperCase()}`, model: 'Apple Mac15,3', os: 'macOS 15.7' }, posture: { security: { encrypted: true, firewall: true, compromised: false, pendingUpdates: 1 } } };
      const a = await rt.addAgent(minted.provisioning, { seed });
      a.acknowledge();
      await a.checkin();
      setMinted(null);
    }, 'Simulated computer enrolled with the desktop agent');

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
      <p className="muted">Mint a one-time enrolment, then scan its QR code with the phone — or run one command on a computer. It is valid for 15 minutes and works once.</p>

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
        title={kind === 'computer' ? '2 · Run it on the computer' : '2 · Scan it with the phone'}
        actions={
          minted && left > 0 ? (
            <Badge tone={left > 60 ? 'info' : 'warn'}>
              expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </Badge>
          ) : undefined
        }
      >
        <div className="seg" role="tablist" aria-label="Type of device">
          <button role="tab" aria-selected={kind === 'existing'} className={kind === 'existing' ? 'on' : ''} onClick={() => setKind('existing')}>
            Existing phone
            <small>no reset · 1 minute</small>
          </button>
          <button role="tab" aria-selected={kind === 'company'} className={kind === 'company' ? 'on' : ''} onClick={() => setKind('company')}>
            Factory-reset company phone
            <small>zero-touch · fully managed</small>
          </button>
          <button role="tab" aria-selected={kind === 'computer'} className={kind === 'computer' ? 'on' : ''} onClick={() => setKind('computer')}>
            Computer
            <small>Windows · Linux · macOS</small>
          </button>
          <button role="tab" aria-selected={kind === 'ios'} className={kind === 'ios' ? 'on' : ''} onClick={() => setKind('ios')}>
            iPhone / iPad
            <small>needs Apple MDM certificate</small>
          </button>
        </div>
        {kind === 'ios' ? (
          <IosNotice />
        ) : !minted ? (
          <Empty>Mint an enrolment in step 1 and its {kind === 'computer' ? 'install command' : 'QR code'} appears here.</Empty>
        ) : left === 0 ? (
          <Empty>This enrolment has expired. Mint a new one.</Empty>
        ) : kind === 'computer' ? (
          <ComputerSteps link={minted.standardLink} os={os} setOs={setOs} onSimulate={rt.mode === 'demo' ? () => void simulateComputer() : undefined} busy={busy} />
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

const DL = DOWNLOADS_URL ?? 'https://mob-hunter.github.io/downloads';

/** One command per OS: download the signed-checksum agent, enrol with the one-time link, install the service. */
export function computerCommand(os: 'windows' | 'linux' | 'macos', link: string): string {
  if (os === 'windows') {
    return [
      `$d="$env:ProgramFiles\\MobHunter"; New-Item -ItemType Directory -Force $d | Out-Null`,
      `$a=if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){'arm64'}else{'amd64'}`,
      `Invoke-WebRequest "${DL}/mob-hunter-agent-windows-$a.exe" -OutFile "$d\\mob-hunter-agent.exe"`,
      `& "$d\\mob-hunter-agent.exe" enrol '${link}'`,
    ].join('\n');
  }
  const goos = os === 'linux' ? 'linux' : 'darwin';
  return [
    `curl -fsSL -o /tmp/mob-hunter-agent "${DL}/mob-hunter-agent-${goos}-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"`,
    `sudo install -m 755 /tmp/mob-hunter-agent /usr/local/bin/mob-hunter-agent`,
    `sudo mob-hunter-agent enrol '${link}'`,
  ].join('\n');
}

function ComputerSteps({ link, os, setOs, onSimulate, busy }: { link: string; os: 'windows' | 'linux' | 'macos'; setOs: (o: 'windows' | 'linux' | 'macos') => void; onSimulate?: () => void; busy: boolean }) {
  const cmd = computerCommand(os, link);
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack">
      <div className="seg seg-sm" role="tablist" aria-label="Operating system">
        {(
          [
            ['windows', 'Windows 10 / 11'],
            ['linux', 'Linux'],
            ['macos', 'macOS'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={os === k} className={os === k ? 'on' : ''} onClick={() => setOs(k)}>
            {label}
          </button>
        ))}
      </div>
      <ol className="steps">
        <li>{os === 'windows' ? 'Open PowerShell as Administrator (right-click Start → Terminal (Admin)).' : 'Open a terminal on the computer (you need sudo).'}</li>
        <li>
          Paste this and press Enter. It downloads the Mob Hunter agent, enrols the computer and installs a background {os === 'windows' ? 'task that runs as SYSTEM' : os === 'linux' ? 'systemd service' : 'launch daemon'}.
        </li>
        <li>Read the notice to the employee and type “I understand”. The computer appears below within a minute.</li>
      </ol>
      <pre className="code cmd" aria-label="Install command">
        {cmd}
      </pre>
      <div className="btn-row">
        <button
          className="btn btn-primary"
          onClick={() => {
            void navigator.clipboard?.writeText(cmd).then(() => setCopied(true));
          }}
        >
          {copied ? '✓ Copied' : 'Copy command'}
        </button>
        <a className="btn" href={`${DL}/SHA256SUMS-desktop.txt`} target="_blank" rel="noreferrer">
          SHA-256 checksums
        </a>
        {onSimulate && (
          <button className="btn" onClick={onSimulate} disabled={busy}>
            ⊞ Simulate this computer enrolling
          </button>
        )}
      </div>
      <p className="small muted">
        On computers the console can see security settings and health, lock the screen, show a message, restart (service mode) and sync policy. Locate, Lost Mode, ring,
        app installs and wipe are phone-only. The agent never reads files, the screen, messages or browsing — run <code>mob-hunter-agent posture</code> to see exactly what it reports.
      </p>
    </div>
  );
}

function IosNotice() {
  return (
    <div className="stack">
      <p>
        <strong>iPhone and iPad are managed through Apple&apos;s MDM service, not an app.</strong> Apple only lets an organisation manage iOS devices after it has:
      </p>
      <ol className="steps">
        <li>An Apple Push Notification service <em>MDM certificate</em> for your organisation (issued by Apple through an MDM vendor CSR, renewed every year).</li>
        <li>Apple Business Manager (free) to assign company iPhones to this server for zero-touch, supervised enrolment.</li>
        <li>A signed enrolment profile (SCEP or a per-device identity certificate) served by this console.</li>
      </ol>
      <p className="small muted">
        Without the Apple push certificate an iPhone cannot receive any command, so Mob Hunter does not offer iOS enrolment yet rather than enrol devices it cannot manage. The threat
        landscape, platform model and audit log are ready for iOS: once the certificate is available, the iOS channel plugs into the same signed-command, notice and audit flow.
      </p>
    </div>
  );
}
