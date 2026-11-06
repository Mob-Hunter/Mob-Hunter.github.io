import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Card, ErrorBox, Field, QrImage, errorText, useRuntime } from '../ui/kit';

/** First-run setup on a fresh FleetGuard server: creates the first Super Admin. */
export function SetupPage() {
  const rt = useRuntime();
  const [form, setForm] = useState({ token: '', name: '', email: '', password: '', confirm: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ email: string; totpSecret: string; otpauthUri: string } | null>(null);

  if (!(rt.mode === 'server' && rt.health.needsBootstrap) && !done) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setErr('Passwords do not match');
    setBusy(true);
    setErr(null);
    try {
      setDone(await rt.api.bootstrap({ token: form.token, name: form.name, email: form.email, password: form.password }));
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="public-page">
      <div className="page narrow">
        <h1>Set up FleetGuard</h1>
        {!done ? (
          <Card title="Create the first Super Admin">
            <p className="small muted">
              This server has no administrators yet. Enter the bootstrap token you set with <code>wrangler secret put BOOTSTRAP_TOKEN</code>. It works only
              until the first account exists.
            </p>
            {err && <ErrorBox>{err}</ErrorBox>}
            <form className="stack" onSubmit={(e) => void submit(e)}>
              <Field label="Bootstrap token">
                <input type="password" value={form.token} onChange={set('token')} required autoComplete="off" />
              </Field>
              <Field label="Your name">
                <input value={form.name} onChange={set('name')} required maxLength={120} />
              </Field>
              <Field label="Work e-mail">
                <input type="email" value={form.email} onChange={set('email')} required autoComplete="username" />
              </Field>
              <Field label="Password" hint="At least 12 characters; a passphrase is best">
                <input type="password" value={form.password} onChange={set('password')} required minLength={12} autoComplete="new-password" />
              </Field>
              <Field label="Confirm password">
                <input type="password" value={form.confirm} onChange={set('confirm')} required minLength={12} autoComplete="new-password" />
              </Field>
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create administrator'}
              </button>
            </form>
          </Card>
        ) : (
          <MfaEnrolCard title="Set up your authenticator" secret={done.totpSecret} uri={done.otpauthUri} onDone={() => location.replace(location.pathname)} />
        )}
      </div>
    </div>
  );
}

/** Shows an otpauth:// QR once, for Google Authenticator / Microsoft Authenticator / 1Password etc. */
export function MfaEnrolCard({ title, secret, uri, onDone }: { title: string; secret: string; uri: string; onDone?: () => void }) {
  return (
    <Card title={title}>
      <div className="enrol-grid">
        <div className="qr-box">
          <QrImage text={uri} label="Authenticator enrolment QR code" />
        </div>
        <div className="stack">
          <p>Scan this with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…). It is shown only once.</p>
          <Field label="Or enter this key manually">
            <input readOnly value={secret} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          {onDone && (
            <button className="btn btn-primary" onClick={onDone}>
              I&apos;ve saved it — continue to sign in
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
