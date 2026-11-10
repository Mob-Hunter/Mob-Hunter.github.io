import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Empty, ErrorBox, Field, fmtAgo, useAction, useCan, useNow, useQuery, useRuntime } from '../ui/kit';
import type { DeviceThreat } from '../core/backend';
import type { RiskBand, ThreatCategory } from '../core/threats';
import type { Platform, ThreatSeverity } from '../core/types';
import { Bars, Kpi, LegendRow, Panel, Ring } from './Overview';
import { PLATFORM_ICON, PLATFORM_LABEL } from '../ui/platform';

export const SEVERITY_TONE: Record<ThreatSeverity, 'bad' | 'warn' | 'info'> = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info' };
const SEVERITY_COLOR: Record<ThreatSeverity, string> = { critical: 'var(--bad)', high: '#f97316', medium: 'var(--warn)', low: 'var(--info)' };
const BAND_TONE: Record<RiskBand, string> = { secure: 'ok', low: 'info', medium: 'warn', high: 'bad', critical: 'bad' };

export function SeverityBadge({ severity }: { severity: ThreatSeverity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{severity}</Badge>;
}

export function RiskMeter({ score, band }: { score: number; band: RiskBand }) {
  return (
    <span className={`risk risk-${band}`} title={`Risk score ${score} / 100 (${band})`}>
      <span className="risk-track" aria-hidden>
        <span style={{ width: `${score}%` }} />
      </span>
      <strong>{score}</strong>
    </span>
  );
}

/** One-click remediation and risk acceptance for a threat on a device. */
export function ThreatActions({ deviceId, threat }: { deviceId: string; threat: DeviceThreat }) {
  const rt = useRuntime();
  const { run, busy } = useAction();
  const canManage = useCan('threat.manage');
  const canRemedy = useCan(threat.remedy ? (`command.${threat.remedy.command}` as const) : 'command.LOCK');
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(30);
  if (threat.accepted) {
    return (
      <div className="threat-actions">
        <span className="small muted">
          Accepted by {threat.accepted.byName} until {new Date(threat.accepted.until).toLocaleDateString()} — “{threat.accepted.reason}”
        </span>
        {canManage && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => rt.api.reopenThreat(deviceId, threat.key), 'Threat reopened')}>
            Reopen
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="threat-actions">
      {threat.remedy && canRemedy && (
        <button
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() =>
            void run(
              () => rt.api.issueCommand(deviceId, threat.remedy!.command === 'MESSAGE' ? { type: 'MESSAGE', params: { title: 'Security action needed', text: threat.remedy!.message } } : { type: threat.remedy!.command }),
              `${threat.remedy!.label}: sent`,
            )
          }
        >
          {threat.remedy.label}
        </button>
      )}
      <Link className="btn btn-sm" to={`/devices/${deviceId}`}>
        Open device
      </Link>
      {canManage && threat.severity !== 'critical' && !accepting && (
        <button className="btn btn-sm" onClick={() => setAccepting(true)}>
          Accept risk…
        </button>
      )}
      {accepting && (
        <form
          className="row-form accept-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await rt.api.acceptThreat(deviceId, threat.key, { reason, days });
              setAccepting(false);
            }, 'Risk accepted — recorded in the audit log');
          }}
        >
          <Field label="Why is this risk acceptable?">
            <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={300} autoFocus placeholder="e.g. Developer test phone, SEC-88" />
          </Field>
          <Field label="For">
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-primary btn-sm" disabled={busy}>
            Accept
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setAccepting(false)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

/** Thirty-day trend of open threats by severity (stacked area) with the number of devices at risk. */
function Trend({ history }: { history: { day: string; critical: number; high: number; medium: number; low: number; devicesAtRisk: number }[] }) {
  if (history.length < 2) return <p className="muted small">The trend fills in day by day — one snapshot is stored per day.</p>;
  const W = 600;
  const H = 160;
  const max = Math.max(1, ...history.map((h) => h.critical + h.high + h.medium + h.low));
  const x = (i: number) => (i / (history.length - 1)) * W;
  const y = (v: number) => H - (v / max) * (H - 12);
  const layers: ThreatSeverity[] = ['low', 'medium', 'high', 'critical'];
  const paths = layers.map((sev, li) => {
    const top = history.map((h) => layers.slice(0, li + 1).reduce((a, s) => a + h[s], 0));
    const bottom = history.map((h) => layers.slice(0, li).reduce((a, s) => a + h[s], 0));
    const d = `M${top.map((v, i) => `${x(i)},${y(v)}`).join(' L')} L${bottom.map((v, i) => `${x(i)},${y(v)}`).reverse().join(' L')} Z`;
    return <path key={sev} d={d} fill={SEVERITY_COLOR[sev]} opacity={0.75} />;
  });
  const last = history[history.length - 1];
  return (
    <figure className="trend">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Open threats over ${history.length} days; today ${last.critical} critical, ${last.high} high, ${last.medium} medium, ${last.low} low`}>
        {paths}
      </svg>
      <figcaption className="small muted">
        {history[0].day} → {last.day} · open threats by severity
      </figcaption>
    </figure>
  );
}

export function ThreatsPage() {
  const now = useNow(30_000);
  const [data, err] = useQuery((api) => api.getThreatLandscape());
  const [sev, setSev] = useState<'' | ThreatSeverity>('');
  const [cat, setCat] = useState<'' | ThreatCategory>('');
  const [plat, setPlat] = useState<'' | Platform>('');
  const [q, setQ] = useState('');
  const [showAccepted, setShowAccepted] = useState(false);
  const shown = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.threats ?? []).filter(
      (t) =>
        (showAccepted || !t.accepted) &&
        (!sev || t.severity === sev) &&
        (!cat || t.category === cat) &&
        (!plat || t.platform === plat) &&
        terms.every((w) => `${t.title} ${t.deviceName} ${t.detail} ${t.category}`.toLowerCase().includes(w)),
    );
  }, [data, sev, cat, plat, q, showAccepted]);

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!data) return <p className="muted">Loading threat landscape…</p>;
  const open = data.counts.critical + data.counts.high + data.counts.medium + data.counts.low;
  const categories = [...new Set(data.threats.map((t) => t.category))];
  const platforms = data.byPlatform.map((p) => p.platform);

  return (
    <div className="page dash">
      <header className="dash-head">
        <div>
          <p className="dash-eyebrow">Mobile threat defense</p>
          <h1>Threat landscape</h1>
          <p className="muted">
            {data.devices} managed device{data.devices === 1 ? '' : 's'} across {data.byPlatform.length} platform{data.byPlatform.length === 1 ? '' : 's'} · updated {fmtAgo(data.generatedAt, now)}
          </p>
        </div>
        <div className={`threat-level level-${data.band}`} role="status" aria-label={`Fleet threat level ${data.band}`}>
          <span className="tiny">Threat level</span>
          <strong>{data.band.toUpperCase()}</strong>
          <span className="tiny">avg risk {data.score}/100</span>
        </div>
      </header>

      <section className="kpis" aria-label="Threat numbers">
        <Kpi to="/threats" label="Open threats" value={open} sub={`${data.counts.critical} critical · ${data.counts.high} high`} tone={data.counts.critical ? 'bad' : data.counts.high ? 'warn' : open ? undefined : 'ok'} />
        <Kpi to="/threats" label="Devices at risk" value={data.devicesAtRisk} sub={`of ${data.devices} managed`} meter={data.devices ? data.devicesAtRisk / data.devices : 0} tone={data.devicesAtRisk ? 'warn' : 'ok'} />
        <Kpi to="/threats" label="Average risk" value={data.score} sub="0 = no open threats" meter={data.score / 100} tone={BAND_TONE[data.band]} />
        <Kpi to="/threats" label="Detected (7 days)" value={data.detected7d} sub="new detections" />
        <Kpi to="/threats" label="Resolved (7 days)" value={data.resolved7d} sub="cleared on the device" tone={data.resolved7d ? 'ok' : undefined} />
        <Kpi to="/threats" label="Accepted risks" value={data.accepted} sub="time-limited, audited" />
      </section>

      <section className="dash-grid">
        <Panel title="Open threats by severity">
          <div className="health">
            <Ring parts={(['critical', 'high', 'medium', 'low'] as const).map((s) => ({ v: data.counts[s], c: SEVERITY_COLOR[s], label: s }))} center={String(open)} caption="open" />
            <ul className="legend">
              {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
                <LegendRow key={s} color={SEVERITY_COLOR[s]} label={s[0].toUpperCase() + s.slice(1)} n={data.counts[s]} />
              ))}
            </ul>
          </div>
        </Panel>
        <Panel title="Attack surface">
          {data.byCategory.length ? <Bars rows={data.byCategory.map((c) => [c.category, c.count, SEVERITY_TONE[c.worst] === 'info' ? 'info' : SEVERITY_TONE[c.worst]] as const)} total={open} /> : <Empty>No open threats.</Empty>}
        </Panel>
        <Panel title="Platforms">
          <ul className="plat-list">
            {data.byPlatform.map((p) => (
              <li key={p.platform}>
                <span className="plat-icon" aria-hidden>
                  {PLATFORM_ICON[p.platform]}
                </span>
                <span>
                  <strong>{PLATFORM_LABEL[p.platform]}</strong>
                  <small className="muted">
                    {p.devices} device{p.devices === 1 ? '' : 's'} · {p.atRisk} at risk
                  </small>
                </span>
                <Badge tone={p.threats ? 'warn' : 'ok'}>{p.threats} open</Badge>
              </li>
            ))}
            {!data.byPlatform.length && <li className="muted">No managed devices yet.</li>}
          </ul>
        </Panel>

        <Panel title="Riskiest devices">
          {data.topDevices.length ? (
            <ol className="top-risk">
              {data.topDevices.map((d) => (
                <li key={d.deviceId}>
                  <Link to={`/devices/${d.deviceId}`}>{d.deviceName}</Link>
                  <span className="muted tiny">
                    {PLATFORM_LABEL[d.platform]} · {d.open} open
                  </span>
                  <RiskMeter score={d.score} band={d.band} />
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No device has open threats.</Empty>
          )}
        </Panel>

        <Panel title="Trend (30 days)" className="span-2">
          <Trend history={data.history} />
        </Panel>

        <Panel title="Detections & resolutions" className="span-2">
          {data.events.length ? (
            <ol className="feed">
              {data.events.slice(0, 12).map((e, i) => (
                <li key={i}>
                  <span className={`dot dot-${e.kind === 'resolved' ? 'ok' : e.kind === 'accepted' ? 'info' : SEVERITY_TONE[e.severity] === 'bad' ? 'bad' : 'warn'}`} aria-hidden />
                  <span className="feed-text">
                    <strong>{e.kind}</strong> {e.title} — <Link to={`/devices/${e.deviceId}`}>{e.deviceName}</Link>
                  </span>
                  <span className="muted tiny nowrap">{fmtAgo(e.at, now)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No events yet.</Empty>
          )}
        </Panel>
        <Panel title="Most common threats" className="span-4">
          {data.byThreat.length ? (
            <ul className="threat-kinds">
              {data.byThreat.map((t) => (
                <li key={t.key}>
                  <SeverityBadge severity={t.severity} />
                  <span>{t.title}</span>
                  <span className="muted small">{t.category}</span>
                  <strong>
                    {t.devices} device{t.devices === 1 ? '' : 's'}
                  </strong>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing detected. Signals refresh at every check-in.</Empty>
          )}
        </Panel>
      </section>

      <section className="card" aria-label="Threats">
        <header className="panel-head">
          <h2>Threats ({shown.length})</h2>
        </header>
        <div className="toolbar">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search threats or devices…" aria-label="Search threats" />
          <select value={sev} onChange={(e) => setSev(e.target.value as ThreatSeverity | '')} aria-label="Filter by severity">
            <option value="">All severities</option>
            {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select value={cat} onChange={(e) => setCat(e.target.value as ThreatCategory | '')} aria-label="Filter by category">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select value={plat} onChange={(e) => setPlat(e.target.value as Platform | '')} aria-label="Filter by platform">
            <option value="">All platforms</option>
            {platforms.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
          <label className="check small">
            <input type="checkbox" checked={showAccepted} onChange={(e) => setShowAccepted(e.target.checked)} /> Show accepted
          </label>
        </div>
        {shown.length ? (
          <ul className="threat-list">
            {shown.map((t) => (
              <li key={`${t.deviceId}-${t.key}`} className={`threat sev-${t.severity}${t.accepted ? ' accepted' : ''}`}>
                <div className="threat-head">
                  <SeverityBadge severity={t.severity} />
                  <strong>{t.title}</strong>
                  <span className="muted small">
                    <Link to={`/devices/${t.deviceId}`}>{t.deviceName}</Link> · {PLATFORM_LABEL[t.platform]} · {t.category} · since {fmtAgo(t.firstSeen, now)}
                  </span>
                </div>
                <p className="small">
                  <span className="muted">{t.detail}.</span> {t.why}
                </p>
                <p className="small">
                  <strong>Fix:</strong> {t.fix}
                </p>
                <ThreatActions deviceId={t.deviceId} threat={t} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{data.threats.length ? 'No threats match these filters.' : 'No threats detected — every managed device passes all checks.'}</Empty>
        )}
        <p className="tiny muted">
          Detection uses device configuration and integrity signals only (patch level, encryption, screen lock, debugging, firewall, integrity verdicts, network encryption). Mob Hunter never
          reads messages, files, photos, browsing or app usage.
        </p>
      </section>
    </div>
  );
}
