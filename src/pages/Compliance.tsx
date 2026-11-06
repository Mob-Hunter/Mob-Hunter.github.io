import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, download, fmtTime, useQuery } from '../ui/kit';
import { toCsv } from '../ui/csv';

export function CompliancePage() {
  const [rows, err] = useQuery((api) => api.compliance());
  const [devices] = useQuery((api) => api.listDevices());
  const [only, setOnly] = useState<'all' | 'ok' | 'bad' | 'warn'>('all');
  const toggle = (v: 'ok' | 'bad' | 'warn') => setOnly((cur) => (cur === v ? 'all' : v));

  const counts = useMemo(() => {
    const r = rows ?? [];
    return {
      compliant: r.filter((x) => x.issues.length === 0).length,
      bad: r.filter((x) => x.issues.some((i) => i.severity === 'bad')).length,
      warn: r.filter((x) => x.issues.length > 0 && !x.issues.some((i) => i.severity === 'bad')).length,
    };
  }, [rows]);
  const isBad = (r: { issues: { severity: string }[] }) => r.issues.some((i) => i.severity === 'bad');
  const shown = (rows ?? []).filter((r) =>
    only === 'all' ? true : only === 'ok' ? r.issues.length === 0 : only === 'bad' ? isBad(r) : r.issues.length > 0 && !isBad(r),
  );

  const exportInventory = () => {
    const issuesBy = new Map((rows ?? []).map((r) => [r.deviceId, r.issues.map((i) => i.text).join('; ')]));
    const csv = toCsv(
      ['Device ID', 'Name', 'Assigned to', 'Department', 'State', 'Model', 'Serial', 'OS', 'Patch', 'Battery %', 'Integrity', 'Last check-in', 'Enrolled', 'Compliance issues'],
      (devices ?? []).map((d) => [
        d.id,
        d.displayName,
        d.assignedUser?.name ?? '',
        d.assignedUser?.department ?? '',
        d.state,
        d.model ?? '',
        d.serial ?? '',
        d.os ?? '',
        d.telemetry?.patchLevel ?? '',
        d.telemetry?.batteryLevel ?? '',
        d.telemetry?.integrity ?? '',
        d.lastCheckinAt ? new Date(d.lastCheckinAt).toISOString() : '',
        new Date(d.enrolledAt).toISOString(),
        issuesBy.get(d.id) ?? '',
      ]),
    );
    download(`device-inventory-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Compliance</h1>
        <button className="btn" onClick={exportInventory} disabled={!devices}>
          Export inventory (CSV)
        </button>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      <div className="stats stats-3">
        <button className={`stat stat-btn ${only === 'ok' ? 'stat-on' : ''}`} onClick={() => toggle('ok')} aria-pressed={only === 'ok'}>
          <span className="stat-n">{counts.compliant}</span>
          <span className="stat-l">Compliant</span>
        </button>
        <button className={`stat stat-btn ${only === 'warn' ? 'stat-on' : ''}`} onClick={() => toggle('warn')} aria-pressed={only === 'warn'}>
          <span className="stat-n">{counts.warn}</span>
          <span className="stat-l">Need attention</span>
        </button>
        <button className={`stat stat-btn ${only === 'bad' ? 'stat-on' : ''}`} onClick={() => toggle('bad')} aria-pressed={only === 'bad'}>
          <span className="stat-n">{counts.bad}</span>
          <span className="stat-l">Non-compliant</span>
        </button>
      </div>
      <Card>
        {shown.length ? (
          <ul className="list">
            {shown.map((r) => (
              <li key={r.deviceId}>
                <span>
                  <Link to={`/devices/${r.deviceId}`}>
                    <strong>{r.deviceName}</strong>
                  </Link>
                </span>
                <span className="issue-list">
                  {r.issues.length === 0 ? (
                    <Badge tone="ok">Compliant</Badge>
                  ) : (
                    r.issues.map((i) => (
                      <Badge key={i.code + i.text} tone={i.severity === 'bad' ? 'bad' : 'warn'}>
                        {i.text}
                      </Badge>
                    ))
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{only === 'all' ? 'No active devices.' : 'No devices in this group.'}</Empty>
        )}
      </Card>
      <p className="tiny muted">
        Rules: no check-in for 24 h, security patch older than 90/180 days, Play Integrity failed or not evaluated, battery under 15%, storage under 10%, notice not
        acknowledged, device not named/assigned, Lost Mode. Generated {fmtTime(Date.now())}.
      </p>
    </div>
  );
}
