import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, fmtAgo, useAction, useCan, useQuery, useRuntime } from '../ui/kit';
import type { DeviceView } from '../core/backend';

export function stateBadge(d: Pick<DeviceView, 'state' | 'lostMode' | 'policyAckAt'>) {
  if (d.lostMode) return <Badge tone="bad">Lost Mode</Badge>;
  if (d.state === 'wiped') return <Badge tone="neutral">Wiped</Badge>;
  if (d.state === 'retired') return <Badge tone="neutral">Retired</Badge>;
  if (d.state === 'enrolled') return <Badge tone="warn">Awaiting notice ack</Badge>;
  return <Badge tone="ok">Active</Badge>;
}

export function DevicesPage() {
  const [params, setParams] = useSearchParams();
  // Local state keeps the checkbox instant; the URL keeps the filter shareable.
  const [unnamedOnly, setUnnamedOnly] = useState(params.get('unnamed') === '1');
  const [q, setQ] = useState('');
  const [devices, err] = useQuery((api) => api.listDevices({ q, unnamedOnly }), [q, unnamedOnly]);
  const canRename = useCan('device.update');

  return (
    <div className="page">
      <div className="page-head">
        <h1>Devices</h1>
        {useCan('enrollment.create') && (
          <Link className="btn btn-primary" to="/enrol">
            ＋ Add devices
          </Link>
        )}
      </div>
      <div className="toolbar">
        <input type="search" placeholder="Search name, serial, model, employee…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search devices" />
        <label className="check">
          <input type="checkbox" checked={unnamedOnly} onChange={(e) => {
              setUnnamedOnly(e.target.checked);
              setParams(e.target.checked ? { unnamed: '1' } : {}, { replace: true });
            }} /> New / unnamed only
        </label>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      <Card>
        {devices?.length ? (
          <ul className="device-list">
            {devices.map((d) => (
              <li key={d.id} className={!d.label ? 'unnamed' : ''}>
                <div className="device-main">
                  <Link to={`/devices/${d.id}`} className="device-name">
                    {d.displayName}
                  </Link>
                  <span className="muted small">
                    {d.model ?? 'Unknown model'} · {d.serial ?? 'serial pending'} · {d.assignedUser ? d.assignedUser.name : 'unassigned'}
                  </span>
                </div>
                <div className="device-meta">
                  {stateBadge(d)}
                  {d.telemetry && <span className="small">🔋 {d.telemetry.batteryLevel}%</span>}
                  <span className="muted small">seen {fmtAgo(d.lastCheckinAt)}</span>
                  {!d.label && canRename && <InlineRename id={d.id} />}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{unnamedOnly ? 'No unnamed devices — every device has been identified.' : 'No devices match.'}</Empty>
        )}
      </Card>
    </div>
  );
}

function InlineRename({ id }: { id: string }) {
  const rt = useRuntime();
  const [name, setName] = useState('');
  const { run, busy } = useAction();
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => rt.api.updateDevice(id, { label: name }), 'Device renamed');
      }}
    >
      <input placeholder="Name this device" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} aria-label="New device name" />
      <button className="btn btn-sm" disabled={busy || !name.trim()}>
        Save
      </button>
    </form>
  );
}
