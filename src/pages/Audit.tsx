import { useMemo, useState } from 'react';
import { Badge, Card, ErrorBox, download, fmtTime, useAction, useCan, useQuery, useRuntime } from '../ui/kit';
import type { ChainVerification } from '../core/audit';

export function AuditPage() {
  const rt = useRuntime();
  const [rows, err] = useQuery((api) => api.listAudit());
  const [users] = useQuery((api) => api.listUsers());
  const [devices] = useQuery((api) => api.listDevices());
  const [filter, setFilter] = useState('');
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const canExport = useCan('audit.export');
  const { run, busy } = useAction();
  const who = (id: string) => users?.find((u) => u.id === id)?.name ?? devices?.find((d) => d.id === id)?.displayName ?? id;

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = rows ?? [];
    return (f ? list.filter((r) => JSON.stringify(r).toLowerCase().includes(f) || who(r.actor).toLowerCase().includes(f)) : list).slice(0, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter, users, devices]);

  if (err) return <ErrorBox>{err}</ErrorBox>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Audit log</h1>
        <div className="btn-row">
          <button className="btn" disabled={busy} onClick={() => void run(async () => setVerification(await rt.api.verifyAudit()))}>
            Verify hash chain
          </button>
          {canExport && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => download(`audit-${new Date().toISOString().slice(0, 10)}.json`, await rt.api.exportAudit()), 'Exported (export recorded in the log)')
              }
            >
              Export for SIEM
            </button>
          )}
        </div>
      </div>
      {verification && (
        <div className={`callout ${verification.ok ? 'callout-ok' : 'callout-bad'}`} role="status">
          {verification.ok ? (
            <>
              ✓ Chain intact — {verification.checked} rows verified. Head <code className="break">{verification.head}</code>
            </>
          ) : (
            <>
              ✗ Chain broken at row {verification.brokenAt}: {verification.reason}
            </>
          )}
        </div>
      )}
      <div className="toolbar">
        <input type="search" placeholder="Filter by action, actor, ticket…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter audit rows" />
        <span className="muted small">{rows?.length ?? 0} rows · append-only · hash = SHA-256(prev_hash + payload)</span>
      </div>
      <Card>
        <div className="table-wrap">
          <table className="audit">
            <thead>
              <tr>
                <th>#</th>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target / ticket</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.seq}>
                  <td>{r.seq}</td>
                  <td className="small nowrap">{fmtTime(r.at)}</td>
                  <td className="small">
                    {who(r.actor)}
                    <div className="tiny muted">{r.actorRole}</div>
                  </td>
                  <td>
                    <Badge tone={r.action.startsWith('security') || r.action === 'access.denied' || r.action.endsWith('failed') ? 'bad' : r.action.startsWith('location') ? 'warn' : 'neutral'}>
                      {r.action}
                    </Badge>
                    {r.detail && <details className="tiny"><summary>detail</summary><pre className="code">{JSON.stringify(r.detail, null, 1)}</pre></details>}
                  </td>
                  <td className="small">
                    {r.target ? who(r.target) : ''}
                    {r.ticket && <div><Badge tone="info">{r.ticket}</Badge></div>}
                  </td>
                  <td>
                    <code className="tiny" title={`prev ${r.prevHash}`}>{r.hash.slice(0, 12)}…</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
