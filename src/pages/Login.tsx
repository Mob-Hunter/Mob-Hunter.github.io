import { useState, useEffect, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useMe, useRuntime, useNow, errorText, ErrorBox } from '../ui/kit';
import { totp } from '../core/totp';
import { ROLE_LABEL } from '../core/rbac';
import { DEMO_PASSWORD } from '../runtime';

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

  if (me) return <Navigate to={from} replace />;

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setChallenge((await rt.backend.login(email, password)).challengeId);
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };
  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const { sessionId } = await rt.backend.verifyMfa(challenge!, code);
      rt.sessionId = sessionId;
      nav(from, { replace: true });
    } catch (x) {
      setErr(errorText(x));
      if ((x as { code?: string }).code === 'mfa_expired') setChallenge(null);
    } finally {
      setBusy(false);
    }
  };
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
            <button className="btn btn-primary" disabled={busy}>
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
          Production uses OIDC SSO with MFA from your identity provider. <Link to="/privacy">Privacy &amp; governance</Link>
        </p>
      </div>

      <div className="card demo-card">
        <h2>Demo accounts</h2>
        <p className="muted small">
          This GitHub Pages build runs a complete reference backend <strong>inside your browser</strong>. Data never leaves this device. Pick a role, then type
          the live code from the demo authenticator.
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
      </div>
    </div>
  );
}
