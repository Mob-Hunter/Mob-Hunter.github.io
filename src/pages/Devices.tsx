import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, Field, fmtAgo, useAction, useCan, useQuery, useRuntime, useToast, errorText } from '../ui/kit';
import type { DeviceView } from '../core/backend';

export function stateBadge(d: Pick<DeviceView, 'state' | 'lostMode' | 'policyAckAt'> & { pendingRemoval?: DeviceView['pendingRemoval'] }) {
  if (d.lostMode) return <Badge tone="bad">Lost Mode</Badge>;
  if (d.state === 'wiped') return <Badge tone="neutral">Wiped</Badge>;
  if (d.state === 'retired') return <Badge tone="neutral">Retired</Badge>;
  if (d.state === 'released') return <Badge tone="neutral">Released</Badge>;
  if (d.pendingRemoval) return <Badge tone="warn">Removal pending</Badge>;
  if (d.state === 'enrolled') return <Badge tone="warn">Awaiting notice ack</Badge>;
  return <Badge tone="ok">Active</Badge>;
}

type Tab = 'all' | 'active' | 'pending' | 'lost' | 'unnamed' | 'decommissioned';
const TABS: { id: Tab; label: string; match: (d: DeviceView) => boolean }[] = [
  { id: 'all', label: 'All', match: (d) => d.state !== 'retired' && d.state !== 'wiped' && d.state !== 'released' },
  { id: 'active', label: 'Active', match: (d) => d.state === 'active' && !d.lostMode },
  { id: 'pending', label: 'Awaiting ack', match: (d) => d.state === 'enrolled' },
  { id: 'lost', label: 'Lost Mode', match: (d) => d.lostMode },
  { id: 'unnamed', label: 'Unnamed', match: (d) => !d.label && d.state !== 'retired' && d.state !== 'wiped' },
  { id: 'decommissioned', label: 'Retired / wiped', match: (d) => d.state === 'retired' || d.state === 'wiped' || d.state === 'released' },
];

const isDecommissioned = (d: DeviceView) => d.state === 'retired' || d.state === 'wiped' || d.state === 'released';

export function DevicesPage() {
  const [params, setParams] = useSearchParams();
  const initial = (params.get('unnamed') === '1' ? 'unnamed' : (params.get('tab') as Tab)) || 'all';
  // Local state keeps the tabs instant; the URL keeps the filter shareable.
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.id === initial) ? initial : 'all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [devices, err] = useQuery((api) => api.listDevices({ q }), [q]);
  const canRename = useCan('device.update');
  const canEnrol = useCan('enrollment.create');

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.id, (devices ?? []).filter(t.match).length])) as Record<Tab, number>, [devices]);
  const shown = (devices ?? []).filter(TABS.find((t) => t.id === tab)!.match);
  const selectedDevices = shown.filter((d) => selected.has(d.id));
  const choose = (t: Tab) => {
    setTab(t);
    setSelected(new Set());
    setParams(t === 'all' ? {} : t === 'unnamed' ? { unnamed: '1' } : { tab: t }, { replace: true });
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Devices</h1>
        {canEnrol && (
          <Link className="btn btn-primary" to="/enrol">
            ＋ Add devices
          </Link>
        )}
      </div>
      <div className="tabs" role="tablist" aria-label="Device state">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'tab-on' : ''}`} onClick={() => choose(t.id)}>
            {t.label} <span className="tab-count">{counts[t.id] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="toolbar">
        <input type="search" placeholder="Search devices…" title="Search by name, serial, model or employee" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search devices" />
        {shown.length > 0 && (
          <label className="check small">
            <input
              type="checkbox"
              aria-label="Select all shown devices"
              checked={shown.length > 0 && shown.every((d) => selected.has(d.id))}
              onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((d) => d.id)) : new Set())}
            />{' '}
            Select all
          </label>
        )}
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      {selectedDevices.length > 0 && <BulkBar devices={selectedDevices} onDone={() => setSelected(new Set())} />}
      <Card>
        {shown.length ? (
          <ul className="device-list">
            {shown.map((d) => (
              <li key={d.id} className={`${!d.label ? 'unnamed' : ''} ${selected.has(d.id) ? 'selected' : ''}`}>
                <input type="checkbox" className="row-check" checked={selected.has(d.id)} onChange={() => toggle(d.id)} aria-label={`Select ${d.displayName}`} />
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
                  {!d.label && canRename && !isDecommissioned(d) && <InlineRename id={d.id} />}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            {tab === 'unnamed'
              ? 'No unnamed devices — every device has been identified.'
              : tab === 'decommissioned'
                ? 'No retired or wiped devices.'
                : tab === 'all' && !q.trim()
                  ? (
                      <>
                        No devices yet. <Link to="/enrol">Add your first phone</Link> — one QR scan, about a minute. <Link to="/help">How enrolment works</Link>
                      </>
                    )
                  : 'No devices match.'}
          </Empty>
        )}
      </Card>
    </div>
  );
}

/** Bulk actions on the selected devices. Every action is still checked and audited per device by the backend. */
function BulkBar({ devices, onDone }: { devices: DeviceView[]; onDone: () => void }) {
  const rt = useRuntime();
  const toast = useToast();
  const canLock = useCan('command.LOCK');
  const canSync = useCan('command.SYNC_POLICY');
  const canRetire = useCan('device.retire');
  const canDelete = useCan('device.delete');
  const [mode, setMode] = useState<null | 'retire' | 'delete'>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const live = devices.filter((d) => !isDecommissioned(d));
  const dead = devices.filter(isDecommissioned);

  const each = async (label: string, list: DeviceView[], fn: (d: DeviceView) => Promise<unknown>) => {
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const d of list) {
      try {
        await fn(d);
        ok++;
      } catch (e) {
        failed.push(`${d.displayName}: ${errorText(e)}`);
      }
    }
    setBusy(false);
    rt.emit();
    if (failed.length) toast('err', `${label}: ${ok} done, ${failed.length} failed — ${failed[0]}`);
    else toast('ok', `${label}: ${ok} device(s)`);
    setMode(null);
    setReason('');
    setConfirm('');
    onDone();
  };

  return (
    <Card className="bulk-bar">
      <div className="bulk-head">
        <strong>{devices.length} selected</strong>
        <div className="btn-row">
          {canSync && live.length > 0 && (
            <button className="btn btn-sm" disabled={busy} onClick={() => void each('Sync policy', live, (d) => rt.api.issueCommand(d.id, { type: 'SYNC_POLICY' }))}>
              Sync policy
            </button>
          )}
          {canLock && live.length > 0 && (
            <button className="btn btn-sm" disabled={busy} onClick={() => void each('Lock', live, (d) => rt.api.issueCommand(d.id, { type: 'LOCK' }))}>
              Lock
            </button>
          )}
          {canRetire && live.length > 0 && (
            <button className="btn btn-sm" disabled={busy} onClick={() => setMode('retire')}>
              Retire…
            </button>
          )}
          {canDelete && (
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setMode('delete')}>
              Delete…
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onDone}>
            Clear
          </button>
        </div>
      </div>
      {mode === 'retire' && (
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            void each('Retired', live, (d) => rt.api.retireDevice(d.id, reason));
          }}
        >
          <Field label={`Reason for retiring ${live.length} device(s)`}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} autoFocus />
          </Field>
          <button className="btn btn-danger" disabled={busy}>
            Retire {live.length}
          </button>
        </form>
      )}
      {mode === 'delete' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void each('Delete', devices.filter((d) => !d.pendingRemoval), async (d) => {
              const r = await rt.api.deleteDevice(d.id, { reason, confirm });
              if (r.status === 'deleted') rt.forgetDevice(d.id);
            });
          }}
        >
          <p className="small">
            {dead.length > 0 && (
              <>
                <strong>{dead.length}</strong> retired/wiped record(s) are deleted at once, with their command history and encrypted location data.{' '}
              </>
            )}
            {live.length > 0 && (
              <>
                <strong>{live.length}</strong> active phone(s) will release management and <strong>uninstall the Mob Hunter agent</strong> (nothing is wiped); each record is
                deleted when its phone confirms.{' '}
              </>
            )}
            The audit log keeps a record of every deletion.
          </p>
          <div className="row-form">
            <Field label="Reason">
              <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} autoFocus />
            </Field>
            <Field label='Type "DELETE" to confirm'>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="off" />
            </Field>
            <button className="btn btn-danger" disabled={busy || confirm !== 'DELETE'}>
              Delete {devices.length}
            </button>
          </div>
        </form>
      )}
    </Card>
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
