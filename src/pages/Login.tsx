import { useState, useEffect, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useMe, useRuntime, useNow, errorText, ErrorBox } from '../ui/kit';
import { totp } from '../core/totp';
import { ROLE_LABEL } from '../core/rbac';
import { DEMO_PASSWORD } from '../runtime';
import { DOWNLOADS_URL } from '../config';

function LiveCode({ secret }: { secret: string }) {
  const now = useNow(1000);
  const [code, setCode] = useState('······');
  useEffect(() => {
    void totp(secret, now).then(setCode);
  }, [secret, Math.floor(now / 30_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = 30 - (Math.floor(now / 1000) % 30);
  return (
    <span className="totp">
      <code>{code}</code> <small>{left}s</small>
    </span>
  );
}

export function LoginPage() {
  const rt = useRuntime();
  const me = useMe();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (rt.mode === 'server' && rt.health.needsBootstrap) return <Navigate to="/setup" replace />;
  if (me) return <Navigate to={from} replace />;

  const attempt = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (x) {
      setErr(errorText(x));
      if ((x as { code?: string }).code === 'mfa_expired') setChallenge(null);
    } finally {
      setBusy(false);
    }
  };
  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void attempt(async () => setChallenge((await rt.api.login(email, password)).challengeId));
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    void attempt(async () => {
      await rt.signedIn(await rt.api.verifyMfa(challenge!, code));
      nav(from, { replace: true });
    });
  };
  const sso = () =>
    void attempt(async () => {
      await rt.signedIn(await rt.api.sso());
      nav(from, { replace: true });
    });
  const fill = (acc: { email: string }) => {
    setEmail(acc.email);
    setPassword(DEMO_PASSWORD);
    setChallenge(null);
    setCode('');
  };

  return (
    <div className="login-wrap">
      <div className="login-card card">
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden>
            ◈
          </span>
          FleetGuard
        </div>
        <p className="muted">Company-owned device management console</p>
        {err && <ErrorBox>{err}</ErrorBox>}
        {rt.health.sso && (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={sso}>
              Sign in with company SSO
            </button>
            <p className="tiny muted center">or use a console account</p>
          </>
        )}
        {!challenge ? (
          <form onSubmit={submitPassword} className="stack">
            <label className="field">
              <span className="field-label">Work e-mail</span>
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className={`btn ${rt.health.sso ? '' : 'btn-primary'}`} disabled={busy}>
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="stack">
            <label className="field">
              <span className="field-label">Authenticator code (MFA)</span>
              <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setChallenge(null)}>
              Back
            </button>
          </form>
        )}
        <p className="tiny muted">
          {rt.mode === 'server' ? `Connected to FleetGuard server v${rt.health.version}. ` : 'Demo mode — everything runs in this browser. '}
          <Link to="/privacy">Privacy &amp; governance</Link>
        </p>
      </div>

      {rt.mode === 'demo' && (
        <div className="card demo-card">
          <h2>Demo accounts</h2>
          <p className="muted small">
            This build runs a complete reference backend <strong>inside your browser</strong>. Data never leaves this device. Pick a role, then type the live code
            from the demo authenticator.
          </p>
          <ul className="demo-list">
            {rt.demoAccounts.map((a) => (
              <li key={a.email}>
                <button className="linkish" onClick={() => fill(a)}>
                  <strong>{ROLE_LABEL[a.role]}</strong>
                  <span className="muted small">{a.email}</span>
                </button>
                <LiveCode secret={a.totpSecret} />
              </li>
            ))}
          </ul>
          <p className="tiny muted">
            Password for all demo accounts: <code>{DEMO_PASSWORD}</code>
          </p>
          <p className="tiny muted">
            Location data is visible only to the <strong>Location Operator</strong>: open <em>Locations</em> and pick ticket <code>INC-1001</code>.
          </p>
        </div>
      )}
      {DOWNLOADS_URL && (
        <p className="login-apps small center">
          <Link to="/download">📱 Get the Android apps (QR codes)</Link>
        </p>
      )}
    </div>
  );
}
