import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Empty, ErrorBox, Field, useAction, useCan, useQuery, useRuntime } from '../ui/kit';
import { ApkDownloads, downloadsBase } from './Download';
import { DOWNLOADS_URL } from '../config';
import type { AppCatalogEntry } from '../core/types';

export function SettingsPage() {
  const rt = useRuntime();
  const [settings, err] = useQuery((api) => api.getSettings());
  const canSettings = useCan('settings.manage');
  const canApps = useCan('apps.manage');
  return (
    <div className="page narrow">
      <h1>Settings</h1>
      {err && <ErrorBox>{err}</ErrorBox>}
      <Card title="Connection">
        <dl className="kv">
          <dt>Mode</dt>
          <dd>{rt.mode === 'server' ? `Mob Hunter server v${rt.health.version}` : 'Demo — in-browser reference backend (no data leaves this device)'}</dd>
          <dt>Single sign-on</dt>
          <dd>{rt.health.sso ? 'Cloudflare Access enabled' : 'Not configured'}</dd>
          <dt>Console origin</dt>
          <dd>
            <code className="break">{location.origin}</code>
          </dd>
        </dl>
      </Card>
      {settings && <OrgCard key={settings.orgName + settings.dpoContact} orgName={settings.orgName} dpoContact={settings.dpoContact} siem={settings.siemWebhookUrl ?? ''} editable={canSettings} />}
      {settings && <AppsCard apps={settings.apps} editable={canApps} />}
      <MobileAppsCard />
      <PasswordCard />
    </div>
  );
}

function OrgCard({ orgName, dpoContact, siem, editable }: { orgName: string; dpoContact: string; siem: string; editable: boolean }) {
  const rt = useRuntime();
  const [f, setF] = useState({ orgName, dpoContact, siemWebhookUrl: siem });
  useEffect(() => setF({ orgName, dpoContact, siemWebhookUrl: siem }), [orgName, dpoContact, siem]);
  const { run, busy } = useAction();
  return (
    <Card title="Organisation">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => rt.api.updateSettings(f), 'Settings saved');
        }}
      >
        <Field label="Organisation name" hint="Shown on the employee notice and authenticator entries">
          <input value={f.orgName} onChange={(e) => setF({ ...f, orgName: e.target.value })} disabled={!editable} required maxLength={80} />
        </Field>
        <Field label="Data Protection Officer contact" hint="Added to the employee notice and transparency page">
          <input value={f.dpoContact} onChange={(e) => setF({ ...f, dpoContact: e.target.value })} disabled={!editable} maxLength={200} placeholder="dpo@company.com" />
        </Field>
        <Field label="SIEM webhook (optional)" hint="Every audit row is POSTed here, HMAC-signed with SIEM_WEBHOOK_SECRET (server mode)">
          <input value={f.siemWebhookUrl} onChange={(e) => setF({ ...f, siemWebhookUrl: e.target.value })} disabled={!editable} placeholder="https://siem.example.com/ingest" />
        </Field>
        {editable && (
          <div>
            <button className="btn btn-primary" disabled={busy}>
              Save
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

function AppsCard({ apps, editable }: { apps: AppCatalogEntry[]; editable: boolean }) {
  const rt = useRuntime();
  const [f, setF] = useState<AppCatalogEntry>({ packageName: '', name: '', url: '', sha256: '' });
  const { run, busy } = useAction();
  return (
    <Card title="Approved app catalogue">
      <p className="small muted">Only these apps can be pushed with INSTALL_APP. The device downloads the APK over HTTPS and refuses it unless its SHA-256 matches.</p>
      {apps.length ? (
        <ul className="list">
          {apps.map((a) => (
            <li key={a.packageName}>
              <span>
                <strong>{a.name}</strong>
                <div className="tiny muted break">
                  {a.packageName} · sha256 {a.sha256.slice(0, 16)}…
                </div>
              </span>
              {editable && (
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run(() => rt.api.removeApp(a.packageName), 'Removed from catalogue')}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No approved apps yet.</Empty>
      )}
      {editable && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await rt.api.upsertApp(f);
              setF({ packageName: '', name: '', url: '', sha256: '' });
            }, 'App saved to catalogue');
          }}
        >
          <h3 className="h3">Add or update an app</h3>
          <div className="row-form">
            <Field label="Name">
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} />
            </Field>
            <Field label="Package name">
              <input value={f.packageName} onChange={(e) => setF({ ...f, packageName: e.target.value.trim() })} required placeholder="com.company.app" />
            </Field>
          </div>
          <Field label="APK URL (https)">
            <input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value.trim() })} required placeholder="https://…/app.apk" />
          </Field>
          <Field label="APK SHA-256" hint="sha256sum app.apk">
            <input value={f.sha256} onChange={(e) => setF({ ...f, sha256: e.target.value.trim() })} required pattern="[0-9a-fA-F]{64}" />
          </Field>
          <div>
            <button className="btn" disabled={busy}>
              Add / update app
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

function PasswordCard() {
  const rt = useRuntime();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const { run, busy } = useAction();
  return (
    <Card title="Change my password">
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.next !== f.confirm) return void run(async () => Promise.reject(new Error('New passwords do not match')));
          void run(async () => {
            await rt.api.changePassword(f.current, f.next);
            setF({ current: '', next: '', confirm: '' });
          }, 'Password changed; your other sessions were signed out');
        }}
      >
        <Field label="Current password">
          <input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required autoComplete="current-password" />
        </Field>
        <Field label="New password">
          <input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required minLength={12} autoComplete="new-password" />
        </Field>
        <Field label="Confirm">
          <input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required minLength={12} autoComplete="new-password" />
        </Field>
        <button className="btn" disabled={busy}>
          Change
        </button>
      </form>
    </Card>
  );
}

/** Android apps with QR codes — shown when the build names a downloads location (VITE_DOWNLOADS_URL) and the APKs are published there. */
export function MobileAppsCard() {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!DOWNLOADS_URL) return;
    let alive = true;
    fetch(`${downloadsBase()}/SHA256SUMS.txt`, { method: 'HEAD', cache: 'no-store' }).then(
      (r) => alive && setAvailable(r.ok),
      () => alive && setAvailable(false),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!available) return null;
  return (
    <Card title="Android apps" actions={<Link to="/download">Open download page</Link>}>
      <p className="small muted">Scan a QR code with the phone&apos;s camera to download, or share the download page link.</p>
      <ApkDownloads compact />
    </Card>
  );
}
