import { Link } from 'react-router-dom';
import { Badge, Empty, fmtAgo, useAction, useCan, useNow, useRuntime } from '../ui/kit';
import { COLLECTION_NOTICE } from '../core/enrollment';
import type { SimulatedAgent } from '../core/agent';

export function SimulatorPage() {
  const rt = useRuntime();
  const agents = [...rt.agents.values()];
  return (
    <div className="page">
      <div className="page-head">
        <h1>Device simulator</h1>
        {useCan('enrollment.create') && (
          <Link className="btn" to="/enrol">
            ＋ Enrol another simulated phone
          </Link>
        )}
      </div>
      <div className="callout">
        {rt.mode === 'server' && <strong>Test devices on your live server. </strong>}
        Each phone below runs the same protocol as the Android agent: Ed25519 key generated on the device, certificate pinning, signed requests, push wake →
        pull, signature/expiry/replay checks, and the mandatory transparency notifications. Nothing here can turn those notifications off.
      </div>
      {agents.length ? (
        <div className="phones">
          {agents.map((a) => (
            <Phone key={a.state.simId} agent={a} />
          ))}
        </div>
      ) : (
        <Empty>No simulated phones. Mint an enrolment on “Add devices” and press “Simulate a phone scanning this QR”.</Empty>
      )}
    </div>
  );
}

function Phone({ agent }: { agent: SimulatedAgent }) {
  const rt = useRuntime();
  const now = useNow(5000);
  const { run, busy } = useAction();
  const s = agent.state;
  const save = () => rt.saveAgents();
  const act = (fn: () => Promise<unknown> | unknown, ok?: string) => run(async () => {
    try {
      return await fn();
    } finally {
      save();
    }
  }, ok);
  const recentLocation = s.notifications.some((n) => (n.channel === 'location_request' && now - n.at < 60_000) || (n.persistent && n.channel !== 'management'));
  const device = s.deviceId;

  const tamper = () =>
    act(async () => {
      if (!s.lastEnvelope) throw new Error('No command received yet — send one first');
      const forged = { ...s.lastEnvelope, payload: { ...s.lastEnvelope.payload, id: `${s.lastEnvelope.payload.id}x`, type: 'WIPE' as const } };
      const r = await agent.verify(forged);
      if (r.ok) throw new Error('Tampered command was accepted — this must never happen');
      return r.reason;
    }, 'Tampered command rejected: bad_signature');
  const replay = () =>
    act(async () => {
      if (!s.lastEnvelope) throw new Error('No command received yet — send one first');
      const r = await agent.verify(s.lastEnvelope);
      if (r.ok) throw new Error('Replay accepted — this must never happen');
      return r.reason;
    }, 'Replayed command rejected');

  return (
    <div className="phone-wrap">
      <div className={`phone ${s.wiped ? 'phone-off' : ''}`} aria-label={`Simulated phone ${s.hardware.model}`}>
        <div className="phone-status">
          <span>{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="phone-icons">
            {recentLocation && (
              <span className="loc-dot" title="OS location indicator">
                ⌖
              </span>
            )}
            {device && !s.wiped && <span title="Managed device">🏢</span>}
            <span>🔋{s.battery}%</span>
          </span>
        </div>
        <div className="phone-screen">
          {s.wiped ? (
            <div className="phone-center">
              <p>Factory reset</p>
              <p className="tiny">Agent, keys and data erased.</p>
            </div>
          ) : s.released ? (
            <div className="shade">
              <div className="shade-managed">Personal phone — not managed</div>
              {s.notifications.slice(0, 2).map((n) => (
                <div key={n.id} className="notif notif-low">
                  <div className="notif-title">{n.title}</div>
                  <div className="notif-text">{n.text}</div>
                </div>
              ))}
              <p className="tiny center">Mob Hunter agent uninstalled · restrictions removed · data kept</p>
            </div>
          ) : !device ? (
            <div className="phone-center">Not enrolled</div>
          ) : !s.acknowledgedAt ? (
            <div className="notice-screen">
              <h3>{COLLECTION_NOTICE.title}</h3>
              <p className="tiny">This phone is owned and managed by your organisation.</p>
              <p className="tiny">
                <strong>Collected:</strong>
              </p>
              <ul className="tiny">
                {COLLECTION_NOTICE.collected.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="tiny">
                <strong>Never:</strong> {COLLECTION_NOTICE.notCollected.join(' ')}
              </p>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    agent.acknowledge();
                    await agent.checkin();
                  }, 'Notice acknowledged — device is now active')
                }
              >
                I understand
              </button>
            </div>
          ) : s.lostMode ? (
            <div className="lost-screen">
              <h3>Lost device</h3>
              <p>{s.lostMessage}</p>
              <p className="tiny">Location is shared with your organisation while Lost Mode is on.</p>
            </div>
          ) : (
            <>
              {s.locked && (
                <button className="locked-banner" onClick={() => { s.locked = false; save(); }}>
                  🔒 Locked by IT — tap to unlock (PIN)
                </button>
              )}
              <div className="shade">
                <div className="shade-managed">This device belongs to your organisation</div>
                {s.notifications.length === 0 && <p className="tiny muted center">No notifications</p>}
                {s.notifications.slice(0, 6).map((n) => (
                  <div key={n.id} className={`notif ${n.persistent ? 'notif-persist' : ''} notif-${n.importance}`}>
                    <div className="notif-title">
                      {n.title} {n.persistent && <Badge>ongoing</Badge>}
                    </div>
                    <div className="notif-text">{n.text}</div>
                    <div className="notif-meta">
                      {fmtAgo(n.at, now)}
                      {n.link && (
                        <>
                          {' · '}
                          <a href={`#${n.link}`} target="_blank" rel="noreferrer">
                            See details
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="phone-controls">
        <div className="small">
          <strong>{s.hardware.model}</strong> · {s.hardware.serial}
          {device && (
            <>
              {' · '}
              <Link to={`/devices/${device}`}>open in console</Link>
            </>
          )}
        </div>
        {device && !s.wiped && !s.released && (
          <>
            <div className="btn-row">
              <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => agent.checkin(), 'Checked in')}>
                Check in
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void act(async () => (await agent.poll()).length, 'Pulled pending commands')}>
                Pull now
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => agent.tick())}>
                Run periodic work
              </button>
            </div>
            <label className="check small">
              <input
                type="checkbox"
                checked={!!s.autoPull}
                onChange={(e) => {
                  s.autoPull = e.target.checked;
                  save();
                }}
              />{' '}
              Pull automatically on push wake
            </label>
            <div className="btn-row">
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void tamper()}>
                Test: tampered command
              </button>
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void replay()}>
                Test: replay
              </button>
            </div>
          </>
        )}
        <details>
          <summary className="small">Agent log</summary>
          <ul className="log">
            {s.log.slice(0, 15).map((l, i) => (
              <li key={i}>
                <span className="muted">{fmtAgo(l.at, now)}</span> {l.text}
              </li>
            ))}
          </ul>
        </details>
        <button className="btn btn-sm btn-ghost" onClick={() => rt.removeAgent(s.simId)}>
          Remove simulator
        </button>
      </div>
    </div>
  );
}
