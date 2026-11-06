import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, Field, MiniMap, fmtAgo, fmtTime, useAction, useAsyncQuery, useCan, useMe, useQuery, useRuntime } from '../ui/kit';
import { COMMAND_TYPES, DUAL_CONTROL, TICKET_REQUIRED, can, type CommandType } from '../core/rbac';
import { StatusBadge } from './Overview';
import { stateBadge } from './Devices';

const COMMAND_HELP: Record<CommandType, string> = {
  LOCATE: 'One-off high-accuracy fix. The user always gets a notification.',
  LOST_MODE_ON: 'Shows a Lost Mode screen and shares a fix every 5 minutes, with a persistent notification.',
  LOST_MODE_OFF: 'Ends Lost Mode and stops location sharing.',
  LOCK: 'Locks the screen immediately.',
  WIPE: 'Factory reset. Irreversible — needs a second approver.',
  SYNC_POLICY: 'Device pulls and applies its current policy.',
  INSTALL_APP: 'Silently installs a company app by package name.',
  REBOOT: 'Reboots the device.',
};

export function DeviceDetailPage() {
  const { id = '' } = useParams();
  const rt = useRuntime();
  const me = useMe()!;
  const [device, err] = useQuery((sid) => rt.backend.getDevice(sid, id), [id]);
  const [commands] = useQuery((sid) => rt.backend.listCommands(sid, id), [id]);
  const [employees] = useQuery((sid) => rt.backend.listEmployees(sid));
  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!device) return null;
  const allowed = COMMAND_TYPES.filter((t) => can(me.role, `command.${t}`));

  return (
    <div className="page">
      <p className="crumbs">
        <Link to="/devices">Devices</Link> /
      </p>
      <div className="page-head">
        <h1>{device.displayName}</h1>
        {stateBadge(device)}
      </div>

      <div className="grid2">
        <Card title="Device">
          <dl className="kv">
            <dt>Assigned to</dt>
            <dd>{device.assignedUser ? `${device.assignedUser.name} (${device.assignedUser.department})` : '—'}</dd>
            <dt>Model</dt>
            <dd>{device.model ?? '—'}</dd>
            <dt>Serial</dt>
            <dd>{device.serial ?? '—'}</dd>
            <dt>OS / patch</dt>
            <dd>
              {device.os ?? '—'} · {device.telemetry?.patchLevel ?? '—'}
            </dd>
            <dt>Enrolled</dt>
            <dd>{fmtTime(device.enrolledAt)}</dd>
            <dt>Last check-in</dt>
            <dd>{fmtAgo(device.lastCheckinAt)}</dd>
            <dt>Notice acknowledged</dt>
            <dd>{device.policyAckAt ? `${fmtTime(device.policyAckAt)} (${device.policyAckVersion})` : <Badge tone="warn">Not yet — no location possible</Badge>}</dd>
            <dt>Client certificate</dt>
            <dd>
              <code>{device.certSerial}</code> · valid to {fmtTime(device.certNotAfter)}
            </dd>
            <dt>Device ID</dt>
            <dd>
              <code>{device.id}</code>
            </dd>
          </dl>
        </Card>
        <Card title="Health">
          {device.telemetry ? (
            <dl className="kv">
              <dt>Battery</dt>
              <dd>
                {device.telemetry.batteryLevel}% · {device.telemetry.batteryHealth} · {device.telemetry.batteryTempC} °C
              </dd>
              <dt>Storage</dt>
              <dd>
                {device.telemetry.storageFreeGb} GB free of {device.telemetry.storageTotalGb} GB
              </dd>
              <dt>Play Integrity</dt>
              <dd>
                <Badge tone={device.telemetry.integrity === 'FAILED' ? 'bad' : 'ok'}>{device.telemetry.integrity}</Badge>
              </dd>
            </dl>
          ) : (
            <Empty>No telemetry yet.</Empty>
          )}
        </Card>
      </div>

      {useCan('device.update') && <RenameCard id={device.id} label={device.label} assigned={device.assignedUserId} employees={employees ?? []} />}

      <Card title="Commands">
        {allowed.length ? (
          <CommandForm deviceId={device.id} allowed={allowed} disabled={device.state === 'wiped'} />
        ) : (
          <p className="muted">Your role cannot send commands to devices.</p>
        )}
        <h3>History</h3>
        {commands?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Command</th>
                  <th>Status</th>
                  <th>Ticket</th>
                  <th>Issued</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.type}</strong>
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                      {c.status === 'pending_approval' && can(me.role, 'command.approve') && c.issuedBy !== me.id && <ApproveButtons id={c.id} />}
                      {c.status === 'pending_approval' && c.issuedBy === me.id && <div className="tiny muted">Needs a different approver</div>}
                    </td>
                    <td>{c.ticket ?? '—'}</td>
                    <td className="small">{fmtAgo(c.issuedAt)}</td>
                    <td className="small">{c.resultSummary ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No commands sent to this device.</Empty>
        )}
      </Card>

      <PolicyCard deviceId={device.id} policy={device.policy} />
      {useCan('location.read') && <DeviceLocations deviceId={device.id} />}
    </div>
  );
}

function RenameCard({ id, label, assigned, employees }: { id: string; label: string | null; assigned: string | null; employees: { id: string; name: string; department: string }[] }) {
  const rt = useRuntime();
  const [name, setName] = useState(label ?? '');
  const [emp, setEmp] = useState(assigned ?? '');
  const { run, busy } = useAction();
  return (
    <Card title="Identify this device">
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => rt.backend.updateDevice(rt.sessionId!, id, { label: name.trim() || null, assignedUserId: emp || null }), 'Saved — recorded in the audit log');
        }}
      >
        <Field label="Device name">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Nimal's field phone" />
        </Field>
        <Field label="Assigned employee">
          <select value={emp} onChange={(e) => setEmp(e.target.value)}>
            <option value="">— Unassigned —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.department}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn btn-primary" disabled={busy}>
          Save
        </button>
      </form>
    </Card>
  );
}

function CommandForm({ deviceId, allowed, disabled }: { deviceId: string; allowed: CommandType[]; disabled: boolean }) {
  const rt = useRuntime();
  const [type, setType] = useState<CommandType>(allowed[0]);
  const [ticket, setTicket] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('This phone belongs to the company. Please call IT.');
  const [phone, setPhone] = useState('+94 11 000 0000');
  const [pkg, setPkg] = useState('com.company.timesheets');
  const [confirmWipe, setConfirmWipe] = useState('');
  const { run, busy } = useAction();
  const needsTicket = TICKET_REQUIRED.has(type);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const params = type === 'LOST_MODE_ON' ? { message, phone } : type === 'INSTALL_APP' ? { packageName: pkg } : {};
    void run(async () => {
      const c = await rt.backend.issueCommand(rt.sessionId!, deviceId, { type, ticket: ticket.trim().toUpperCase() || undefined, reason, params });
      setReason('');
      setConfirmWipe('');
      return c;
    }, DUAL_CONTROL.has(type) ? 'Submitted — waiting for a second approver' : 'Signed and queued in the relay; push wake sent');
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="row-form">
        <Field label="Command">
          <select value={type} onChange={(e) => setType(e.target.value as CommandType)} disabled={disabled}>
            {allowed.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        {needsTicket && (
          <Field label="Ticket reference" hint="e.g. INC-1042">
            <input value={ticket} onChange={(e) => setTicket(e.target.value)} required pattern="[A-Za-z][A-Za-z0-9]{1,9}-\d{1,8}" />
          </Field>
        )}
      </div>
      <p className="small muted">{COMMAND_HELP[type]}</p>
      {needsTicket && (
        <Field label="Why is this necessary?">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} rows={2} />
        </Field>
      )}
      {type === 'LOST_MODE_ON' && (
        <div className="row-form">
          <Field label="Lost Mode message">
            <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Contact phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={24} />
          </Field>
        </div>
      )}
      {type === 'INSTALL_APP' && (
        <Field label="Package name">
          <input value={pkg} onChange={(e) => setPkg(e.target.value)} />
        </Field>
      )}
      {type === 'WIPE' && (
        <Field label='Type "WIPE" to confirm'>
          <input value={confirmWipe} onChange={(e) => setConfirmWipe(e.target.value)} />
        </Field>
      )}
      <div>
        <button className={`btn ${type === 'WIPE' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || disabled || (type === 'WIPE' && confirmWipe !== 'WIPE')}>
          Send {type}
        </button>
      </div>
    </form>
  );
}

function ApproveButtons({ id }: { id: string }) {
  const rt = useRuntime();
  const { run, busy } = useAction();
  return (
    <div className="btn-row">
      <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void run(() => rt.backend.approveCommand(rt.sessionId!, id, true), 'Approved and relayed')}>
        Approve
      </button>
      <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => rt.backend.approveCommand(rt.sessionId!, id, false), 'Rejected')}>
        Reject
      </button>
    </div>
  );
}

function PolicyCard({ deviceId, policy }: { deviceId: string; policy: import('../core/types').DevicePolicy }) {
  const rt = useRuntime();
  const canEdit = useCan('device.policy');
  const [justification, setJustification] = useState('');
  const { run, busy } = useAction();
  return (
    <Card title={`Policy v${policy.version}`}>
      <ul className="checklist">
        <li className="yes">Factory reset, USB file transfer, unknown sources and debugging blocked</li>
        <li className="yes">
          Password ≥ {policy.passwordMinLength} chars · auto-lock {policy.maxTimeToLockSec}s
        </li>
        <li className="yes">Location kept on for the agent; OS location indicator stays visible</li>
        <li className="no">Security logging and network logging — permanently off</li>
        <li className={policy.continuousLocation ? 'yes' : 'no'}>
          Tier 3 work-hours location {policy.continuousLocation ? `ON every ${policy.continuousIntervalMin} min, ${policy.workingHours.startHour}:00–${policy.workingHours.endHour}:00 Mon–Fri (${policy.workingHours.timeZone})` : 'OFF'}
        </li>
      </ul>
      {canEdit && (
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await rt.backend.updatePolicy(rt.sessionId!, deviceId, { continuousLocation: !policy.continuousLocation }, justification);
              setJustification('');
            }, 'Policy updated; device told to sync');
          }}
        >
          <Field label="Justification (DPIA / programme reference)">
            <input value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} placeholder="e.g. Lone-worker safety, DPIA-12" />
          </Field>
          <button className="btn" disabled={busy}>
            {policy.continuousLocation ? 'Turn Tier 3 off' : 'Turn Tier 3 on'}
          </button>
        </form>
      )}
    </Card>
  );
}

function DeviceLocations({ deviceId }: { deviceId: string }) {
  const rt = useRuntime();
  const [ticket, setTicket] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  // Deliberately NOT re-run on every change: each view is an audited access.
  const q = useAsyncQuery((sid) => rt.backend.listLocationResults(sid, { deviceId, ticket: submitted! }), [deviceId, submitted], !!submitted);
  return (
    <Card title="Location results (Location Operator)">
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(ticket.trim().toUpperCase());
        }}
      >
        <Field label="Ticket justifying this view">
          <input value={ticket} onChange={(e) => setTicket(e.target.value)} required placeholder="INC-1042" />
        </Field>
        <button className="btn">Show locations</button>
        {q.data && (
          <button type="button" className="btn btn-ghost" onClick={q.reload}>
            Refresh
          </button>
        )}
      </form>
      {q.error && <ErrorBox>{q.error}</ErrorBox>}
      {q.data && (
        <>
          <MiniMap points={q.data.map((l, i) => ({ ...l.fix, label: `${fmtTime(l.fix.fixAt)} · tier ${l.tier}`, highlight: i === 0 }))} />
          <p className="tiny muted">Your view was recorded in the audit log against {submitted}.</p>
        </>
      )}
    </Card>
  );
}
