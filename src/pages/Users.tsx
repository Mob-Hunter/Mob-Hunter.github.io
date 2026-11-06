import { useState } from 'react';
import { Badge, Card, Empty, ErrorBox, Field, fmtAgo, useAction, useCan, useMe, useQuery, useRuntime } from '../ui/kit';
import { ROLES, ROLE_LABEL, type Role } from '../core/rbac';
import { MfaEnrolCard } from './Setup';

export function UsersPage() {
  const rt = useRuntime();
  const me = useMe()!;
  const canUsers = useCan('users.manage');
  const canSessions = useCan('sessions.manage');
  const [users, err] = useQuery((api) => api.listUsers());
  const [sessions] = useQuery((api) => api.listSessions(), [], { enabled: canSessions });
  const [enrol, setEnrol] = useState<{ title: string; secret: string; uri: string } | null>(null);
  const { run, busy } = useAction();

  return (
    <div className="page">
      <h1>Users &amp; access</h1>
      {err && <ErrorBox>{err}</ErrorBox>}
      {enrol && (
        <>
          <MfaEnrolCard title={enrol.title} secret={enrol.secret} uri={enrol.uri} />
          <button className="btn btn-ghost" onClick={() => setEnrol(null)}>
            Hide enrolment QR
          </button>
        </>
      )}
      {canUsers && <CreateUser onCreated={(name, secret, uri) => setEnrol({ title: `Authenticator for ${name} — hand over securely`, secret, uri })} />}
      {canUsers && (
        <Card title="Console users">
          <ul className="list">
            {users?.map((u) => (
              <li key={u.id}>
                <span>
                  <strong>{u.name}</strong> {u.disabled && <Badge tone="bad">disabled</Badge>} {u.id === me.id && <Badge>you</Badge>}
                  <div className="small muted">
                    {u.email} · {ROLE_LABEL[u.role]}
                  </div>
                </span>
                {u.id !== me.id && (
                  <span className="btn-row">
                    <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => rt.api.setUserDisabled(u.id, !u.disabled), u.disabled ? 'User enabled' : 'User disabled; sessions revoked')}>
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm(`Reset MFA for ${u.name}? Their current authenticator stops working.`)) return;
                        void run(async () => {
                          const r = await rt.api.resetUserMfa(u.id);
                          setEnrol({ title: `New authenticator for ${u.name}`, secret: r.totpSecret, uri: r.otpauthUri });
                        }, 'MFA reset');
                      }}
                    >
                      Reset MFA
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {canSessions && (
        <Card title="Active sessions">
          {sessions?.length ? (
            <ul className="list">
              {sessions.map((s) => (
                <li key={s.id}>
                  <span>
                    <strong>{s.userName}</strong> {s.current && <Badge tone="info">this session</Badge>}
                    <div className="small muted">
                      signed in {fmtAgo(s.createdAt)} · active {fmtAgo(s.lastSeenAt)}
                    </div>
                  </span>
                  {!s.current && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => rt.api.revokeSession(s.id), 'Session revoked')}>
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No active sessions.</Empty>
          )}
        </Card>
      )}
      {!canUsers && !canSessions && <ErrorBox>Your role cannot manage users or sessions.</ErrorBox>}
    </div>
  );
}

function CreateUser({ onCreated }: { onCreated: (name: string, secret: string, uri: string) => void }) {
  const rt = useRuntime();
  const [f, setF] = useState<{ name: string; email: string; role: Role; password: string }>({ name: '', email: '', role: 'HELPDESK', password: '' });
  const { run, busy } = useAction();
  return (
    <Card title="Invite a console user">
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await rt.api.createUser(f);
            onCreated(r.user.name, r.totpSecret, r.otpauthUri);
            setF({ name: '', email: '', role: 'HELPDESK', password: '' });
          }, 'User created — give them the authenticator QR and temporary password');
        }}
      >
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} />
        </Field>
        <Field label="Work e-mail">
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        </Field>
        <Field label="Role">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Temporary password" hint="≥ 12 characters; they should change it at first sign-in">
          <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={12} autoComplete="new-password" />
        </Field>
        <button className="btn btn-primary" disabled={busy}>
          Create
        </button>
      </form>
    </Card>
  );
}
