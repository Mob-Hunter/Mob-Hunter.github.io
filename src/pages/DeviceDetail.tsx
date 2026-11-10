import { RESTRICTION_KEYS, unsupportedReason, type DeviceView } from '../core/backend';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Card, Empty, ErrorBox, Field, fmtAgo, fmtTime, useAction, useCan, useMe, useQuery, useRuntime, TableWrap } from '../ui/kit';
import { DeviceLocationPanel } from '../ui/location';
import { COMMAND_TYPES, DUAL_CONTROL, TICKET_REQUIRED, can, type CommandType } from '../core/rbac';
import { StatusBadge } from './Overview';
import { stateBadge } from './Devices';
import { RiskMeter, SeverityBadge, ThreatActions } from './Threats';
import { PLATFORM_ICON, PLATFORM_LABEL, isComputer } from '../ui/platform';
import type { SecurityPosture } from '../core/types';
import { SYNC_CHOICES, fmtInterval } from '../ui/sync';

const COMMAND_HELP: Record<CommandType, string> = {
  LOCATE: 'One-off high-accuracy fix. The user always gets a notification.',
  LOST_MODE_ON: 'Shows a Lost Mode screen and shares a fix every 5 minutes, with a persistent notification.',
  LOST_MODE_OFF: 'Ends Lost Mode and stops location sharing.',
  LOCK: 'Locks the screen immediately.',
  WIPE: 'Factory reset. Irreversible — needs a second approver.',
  SYNC_POLICY: 'Device pulls and applies its current policy.',
  INSTALL_APP: 'Silently installs a company app by package name.',
  REBOOT: 'Reboots the device.',
  RELEASE: 'Removes management and uninstalls the agent — sent by “Delete device”.',
  MESSAGE: 'Shows your message to the employee as a notification on the phone.',
  RING: 'Plays an alarm at full volume for 30 seconds, even on silent — to find a phone nearby. The employee sees why.',
  UNINSTALL_APP: 'Removes an app that was installed from the approved catalogue. Personal apps can never be removed.',
};

export function DeviceDetailPage() {
  const { id = '' } = useParams();
  const me = useMe()!;
  const [device, err] = useQuery((api) => api.getDevice(id), [id]);
  const [commands] = useQuery((api) => api.listCommands(id), [id]);
  const [employees] = useQuery((api) => api.listEmployees());
  const canUpdate = useCan('device.update');
  const canRetire = useCan('device.retire');
  const canDelete = useCan('device.delete');
  const canReportLost = useCan('command.LOST_MODE_ON');
  if (err && !device) return <ErrorBox>{err}</ErrorBox>;
  if (!device) return null;
  // RELEASE is only sent by the delete flow, never from the generic command form.
  const permitted = COMMAND_TYPES.filter((t) => t !== 'RELEASE' && can(me.role, `command.${t}`));
  // A phone enrolled without a factory reset cannot be wiped, rebooted or sent silent installs.
  const allowed = permitted.filter((t) => !unsupportedReason(device, t));
  const unavailable = permitted.filter((t) => unsupportedReason(device, t));

  return (
    <div className="page">
      <p className="crumbs">
        <Link to="/devices">Devices</Link> /
      </p>
      <div className="page-head">
        <h1>{device.displayName}</h1>
        <div className="page-head-actions">
          {stateBadge(device)}
          {canReportLost && !isComputer(device.platform) && !device.activeIncident && device.state !== 'wiped' && device.state !== 'retired' && !device.pendingRemoval && (
            <Link className="btn btn-danger btn-sm" to={`/incidents/new?device=${device.id}`}>
              ⚑ Report lost or stolen
            </Link>
          )}
        </div>
      </div>

      {device.activeIncident && (
        <div className={`callout ${device.activeIncident.kind === 'stolen' ? 'callout-bad' : 'callout-warn'}`}>
          <strong>Reported {device.activeIncident.kind}</strong> ({device.activeIncident.ticket}) {fmtAgo(device.activeIncident.startedAt)}.{' '}
          {device.activeIncident.trackingUntil > Date.now() ? (
            <>
              Active tracking every {Math.round(device.activeIncident.trackingIntervalSec / 60)} min until {fmtTime(device.activeIncident.trackingUntil)}.
            </>
          ) : (
            <>Active tracking has ended; Lost Mode is on.</>
          )}{' '}
          <Link to={`/incidents/${device.activeIncident.id}`}>Open incident →</Link>
        </div>
      )}
      <div className="grid2">
        <Card title="Device">
          <dl className="kv">
            <dt>Platform</dt>
            <dd>
              <span aria-hidden>{PLATFORM_ICON[device.platform]}</span> {PLATFORM_LABEL[device.platform]}
              {device.telemetry?.security?.agentVersion ? <span className="muted small"> · agent {device.telemetry.security.agentVersion}</span> : null}
            </dd>
            <dt>Assigned to</dt>
            <dd>{device.assignedUser ? `${device.assignedUser.name} (${device.assignedUser.department})` : '—'}</dd>
            <dt>Model</dt>
            <dd>{device.model ?? '—'}</dd>
            <dt>Serial</dt>
            <dd>{device.serial ?? '—'}</dd>
            <dt>{isComputer(device.platform) ? 'OS / last update' : 'OS / patch'}</dt>
            <dd>
              {device.os ?? '—'} · {device.telemetry?.patchLevel ?? '—'}
            </dd>
            <dt>Enrolled</dt>
            <dd>{fmtTime(device.enrolledAt)}</dd>
            <dt>Enrolment type</dt>
            <dd>
              {isComputer(device.platform) ? (
                device.managementMode === 'standard' ? (
                  <>
                    <Badge tone="info">Desktop agent</Badge> user mode (no reboot)
                  </>
                ) : (
                  <>
                    <Badge tone="ok">Desktop agent</Badge> system service
                  </>
                )
              ) : device.managementMode === 'standard' ? (
                <>
                  <Badge tone="info">Standard</Badge> existing phone, no factory reset
                </>
              ) : (
                <>
                  <Badge tone="ok">Company device</Badge> fully managed (device owner)
                </>
              )}
            </dd>
            {device.capabilities && (
              <>
                <dt>Allowed on the phone</dt>
                <dd className="cap-list">
                  <Badge tone={device.capabilities.notifications ? 'ok' : 'warn'}>Notifications {device.capabilities.notifications ? 'on' : 'off'}</Badge>{' '}
                  <Badge tone={device.capabilities.location === 'background' ? 'ok' : device.capabilities.location === 'foreground' ? 'info' : 'warn'}>
                    Location {device.capabilities.location === 'background' ? 'all the time' : device.capabilities.location === 'foreground' ? 'while open' : 'off'}
                  </Badge>{' '}
                  {!device.capabilities.deviceOwner && <Badge tone={device.capabilities.deviceAdmin ? 'ok' : 'neutral'}>Remote lock {device.capabilities.deviceAdmin ? 'on' : 'off'}</Badge>}
                </dd>
              </>
            )}
            <dt>Last check-in</dt>
            <dd>
              {fmtAgo(device.lastCheckinAt)} <Badge tone={device.sync.online ? 'ok' : 'neutral'}>{device.sync.online ? 'online' : 'offline'}</Badge>{' '}
              <span className="muted small">checks in every {fmtInterval(device.sync.minutes)}</span>
            </dd>
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
                {device.telemetry.noBattery ? 'Mains power (no battery)' : `${device.telemetry.batteryLevel}% · ${device.telemetry.batteryHealth} · ${device.telemetry.batteryTempC} °C`}
              </dd>
              <dt>Storage</dt>
              <dd>
                {device.telemetry.storageFreeGb} GB free of {device.telemetry.storageTotalGb} GB
              </dd>
              {device.platform === 'android' && (
                <>
                  <dt>Play Integrity</dt>
                  <dd>
                    <Badge tone={device.telemetry.integrity === 'FAILED' ? 'bad' : device.telemetry.integrity === 'NOT_EVALUATED' ? 'neutral' : 'ok'}>{device.telemetry.integrity}</Badge>
                  </dd>
                </>
              )}
              {device.telemetry.security && (
                <>
                  <dt>Security settings</dt>
                  <dd className="cap-list">
                    <Posture s={device.telemetry.security} />
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <Empty>No telemetry yet.</Empty>
          )}
        </Card>
      </div>

      <Card
        title={
          <>
            Security posture <RiskMeter score={device.risk.score} band={device.risk.band} />
          </>
        }
        actions={<Link to="/threats">Threat landscape →</Link>}
      >
        {device.risk.threats.length ? (
          <ul className="threat-list">
            {device.risk.threats.map((t) => (
              <li key={t.key} className={`threat sev-${t.severity}${t.accepted ? ' accepted' : ''}`}>
                <div className="threat-head">
                  <SeverityBadge severity={t.severity} />
                  <strong>{t.title}</strong>
                  <span className="muted small">
                    {t.category} · since {fmtAgo(t.firstSeen)}
                  </span>
                </div>
                <p className="small">
                  <span className="muted">{t.detail}.</span> {t.why} <strong>Fix:</strong> {t.fix}
                </p>
                <ThreatActions deviceId={device.id} threat={t} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No threats detected on this device. Checks run at every check-in.</Empty>
        )}
      </Card>

      <SyncCard key={`${device.id}-${device.policy.version}`} device={device} />

      {canUpdate && <RenameCard key={device.id} device={device} employees={(employees ?? []).filter((e) => e.status !== 'leaver')} />}

      <Card title="Commands">
        {allowed.length ? (
          <CommandForm deviceId={device.id} allowed={allowed} disabled={device.state === 'wiped'} />
        ) : (
          <p className="muted">Your role cannot send commands to devices.</p>
        )}
        {unavailable.length > 0 && (
          <p className="small muted">
            Not available on this phone: {unavailable.join(', ')}. {unsupportedReason(device, unavailable[0])}
          </p>
        )}
        <h3>History</h3>
        {commands?.length ? (
          <TableWrap label="Command history">
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
          </TableWrap>
        ) : (
          <Empty>No commands sent to this device.</Empty>
        )}
      </Card>

      {canReportLost && !device.activeIncident && device.state !== 'wiped' && device.state !== 'retired' && !device.pendingRemoval && (
        <ReportIncidentCard deviceId={device.id} acknowledged={!!device.policyAckAt} />
      )}
      {!isComputer(device.platform) && <PolicyCard deviceId={device.id} policy={device.policy} standard={device.managementMode === 'standard'} />}
      <DeviceLocationPanel deviceId={device.id} commands={commands} lostMode={device.lostMode} />
      {canRetire && device.state !== 'retired' && device.state !== 'wiped' && <RetireCard deviceId={device.id} />}
      {canDelete && (device.pendingRemoval ? <RemovalPendingCard device={device} /> : <DeleteCard deviceId={device.id} name={device.displayName} state={device.state} />)}
    </div>
  );
}

function RenameCard({ device, employees }: { device: DeviceView; employees: { id: string; name: string; department: string }[] }) {
  const rt = useRuntime();
  const [name, setName] = useState(device.label ?? '');
  const [emp, setEmp] = useState(device.assignedUserId ?? '');
  const [tags, setTags] = useState((device.tags ?? []).join(', '));
  const [assetTag, setAssetTag] = useState(device.assetTag ?? '');
  const [notes, setNotes] = useState(device.notes ?? '');
  const { run, busy } = useAction();
  return (
    <Card title="Identify this device">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              rt.api.updateDevice(device.id, {
                label: name.trim() || null,
                assignedUserId: emp || null,
                tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
                assetTag: assetTag.trim() || null,
                notes: notes.trim() || null,
              }),
            'Saved — recorded in the audit log',
          );
        }}
      >
        <div className="row-form">
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
        </div>
        <div className="row-form">
          <Field label="Groups" hint="Comma-separated, e.g. Sales, Colombo. Used to filter and send commands to many phones.">
            <input value={tags} onChange={(e) => setTags(e.target.value)} maxLength={300} placeholder="Sales, Colombo" />
          </Field>
          <Field label="Asset tag">
            <input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} maxLength={40} placeholder="e.g. MH-000123" />
          </Field>
        </div>
        <Field label="Notes (admins only)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} placeholder="e.g. Screen protector replaced 2026-10" />
        </Field>
        <div>
          <button className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
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
  const [settings] = useQuery((api) => api.getSettings(), [], { live: false });
  const [pkg, setPkg] = useState('');
  const [msgTitle, setMsgTitle] = useState('');
  const [msgText, setMsgText] = useState('');
  const [confirmWipe, setConfirmWipe] = useState('');
  const { run, busy } = useAction();
  const needsTicket = TICKET_REQUIRED.has(type);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const params =
      type === 'LOST_MODE_ON'
        ? { message, phone }
        : type === 'INSTALL_APP' || type === 'UNINSTALL_APP'
          ? { packageName: pkg }
          : type === 'MESSAGE'
            ? { title: msgTitle, text: msgText }
            : {};
    void run(async () => {
      const c = await rt.api.issueCommand(deviceId, { type, ticket: ticket.trim().toUpperCase() || undefined, reason, params });
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
      {type === 'MESSAGE' && (
        <>
          <Field label="Title (optional)">
            <input value={msgTitle} onChange={(e) => setMsgTitle(e.target.value)} maxLength={60} placeholder="Message from your IT team" />
          </Field>
          <Field label="Message">
            <textarea value={msgText} onChange={(e) => setMsgText(e.target.value)} required maxLength={300} rows={3} placeholder="e.g. Please bring this phone to IT on Friday for an update." />
          </Field>
        </>
      )}
      {(type === 'INSTALL_APP' || type === 'UNINSTALL_APP') && (
        <Field label="App (approved catalogue)" hint={<Link to="/settings">Manage the app catalogue</Link>}>
          <select value={pkg} onChange={(e) => setPkg(e.target.value)} required>
            <option value="">— choose an app —</option>
            {settings?.apps.map((a) => (
              <option key={a.packageName} value={a.packageName}>
                {a.name} ({a.packageName})
              </option>
            ))}
          </select>
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
      <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void run(() => rt.api.approveCommand(id, true), 'Approved and relayed')}>
        Approve
      </button>
      <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => rt.api.approveCommand(id, false), 'Rejected')}>
        Reject
      </button>
    </div>
  );
}

const RESTRICTIONS: { key: (typeof RESTRICTION_KEYS)[number]; label: string; hint: string }[] = [
  { key: 'cameraDisabled', label: 'Disable camera', hint: 'For secure sites and labs.' },
  { key: 'screenCaptureDisabled', label: 'Block screenshots & screen recording', hint: 'Applies on the phone; the console never sees the screen.' },
  { key: 'bluetoothDisabled', label: 'Disable Bluetooth', hint: 'Stops pairing and file transfer over Bluetooth.' },
  { key: 'disallowAddUser', label: 'Block extra user profiles', hint: 'Only the work user on the phone.' },
  { key: 'disallowConfigWifi', label: 'Lock Wi-Fi settings', hint: 'Employees cannot change Wi-Fi networks.' },
];

function PolicyCard({ deviceId, policy, standard }: { deviceId: string; policy: import('../core/types').DevicePolicy; standard: boolean }) {
  const rt = useRuntime();
  const canEdit = useCan('device.policy');
  const [justification, setJustification] = useState('');
  const current = Object.fromEntries(RESTRICTION_KEYS.map((k) => [k, !!policy[k]])) as Record<(typeof RESTRICTION_KEYS)[number], boolean>;
  const [draft, setDraft] = useState({ ...current, continuousLocation: policy.continuousLocation });
  useEffect(() => setDraft({ ...current, continuousLocation: policy.continuousLocation }), [policy.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = (Object.keys(draft) as (keyof typeof draft)[]).filter((k) => draft[k] !== (k === 'continuousLocation' ? policy.continuousLocation : current[k as keyof typeof current]));
  const { run, busy } = useAction();
  return (
    <Card title={`Policy v${policy.version}`}>
      {standard && (
        <p className="callout small">This phone was enrolled without a factory reset, so restrictions below cannot be enforced on it. They apply to company (factory-reset) phones.</p>
      )}
      <ul className="checklist">
        <li className="yes">Factory reset, USB file transfer, unknown sources and debugging blocked</li>
        <li className="yes">
          Password ≥ {policy.passwordMinLength} chars · auto-lock {policy.maxTimeToLockSec}s
        </li>
        <li className="yes">Location kept on for the agent; OS location indicator stays visible</li>
        <li className="no">Security logging and network logging — permanently off</li>
      </ul>
      <h3>Restrictions</h3>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const patch = Object.fromEntries(changed.map((k) => [k, draft[k]]));
          void run(async () => {
            await rt.api.updatePolicy(deviceId, patch, justification);
            setJustification('');
          }, 'Policy updated; the phone applies it at its next sync');
        }}
      >
        <div className="toggles">
          {RESTRICTIONS.map((r) => (
            <label key={r.key} className="toggle">
              <input type="checkbox" role="switch" checked={draft[r.key]} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, [r.key]: e.target.checked })} />
              <span>
                <strong>{r.label}</strong>
                <small>{r.hint}</small>
              </span>
            </label>
          ))}
          <label className="toggle">
            <input type="checkbox" role="switch" checked={draft.continuousLocation} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, continuousLocation: e.target.checked })} />
            <span>
              <strong>Work-hours location (Tier 3)</strong>
              <small>
                Every {policy.continuousIntervalMin} min, {policy.workingHours.startHour}:00–{policy.workingHours.endHour}:00 Mon–Fri ({policy.workingHours.timeZone}), with a
                persistent notification. Needs a DPIA.
              </small>
            </span>
          </label>
        </div>
        {canEdit && (
          <div className="row-form">
            <Field label="Justification (DPIA / ticket / programme)">
              <input value={justification} onChange={(e) => setJustification(e.target.value)} required minLength={5} placeholder="e.g. Secure-site policy, SEC-12" />
            </Field>
            <button className="btn btn-primary" disabled={busy || changed.length === 0}>
              {changed.length ? `Save policy (${changed.length} change${changed.length > 1 ? 's' : ''})` : 'No changes'}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

function RetireCard({ deviceId }: { deviceId: string }) {
  const rt = useRuntime();
  const [reason, setReason] = useState('');
  const { run, busy } = useAction();
  return (
    <Card title="Retire device">
      <p className="small muted">
        Use when a phone is returned, lost for good or replaced. Its certificate is revoked immediately, so it can no longer reach the server; queued commands are
        cancelled. Wipe it first if it is still in someone&apos;s hands.
      </p>
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => rt.api.retireDevice(deviceId, reason), 'Device retired and certificate revoked');
        }}
      >
        <Field label="Reason">
          <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} placeholder="e.g. Returned by leaver, screen broken" />
        </Field>
        <button className="btn btn-danger" disabled={busy}>
          Retire
        </button>
      </form>
    </Card>
  );
}

/** Deleting a device: an active phone first releases management and uninstalls the agent; a retired/wiped one is deleted at once. */
function DeleteCard({ deviceId, name, state }: { deviceId: string; name: string; state: string }) {
  const rt = useRuntime();
  const nav = useNavigate();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const { run, busy } = useAction();
  const managed = state === 'enrolled' || state === 'active' || state === 'lost';
  return (
    <Card title="Delete device" className="danger-zone">
      {managed ? (
        <div className="small stack">
          <p>
            Deleting <strong>{name}</strong> removes it from management. The phone receives a signed command, lifts every restriction, tells the employee it is no longer
            managed, gives up device-owner rights and <strong>uninstalls the Mob Hunter agent</strong>. The record is deleted once the phone confirms.
          </p>
          <p className="muted">
            Nothing on the phone is wiped — the employee keeps it with their data. To erase it instead, use WIPE. If the phone is lost or never comes back online, retire it.
          </p>
        </div>
      ) : (
        <p className="small">
          Permanently removes <strong>{name}</strong> from the console, with its command history and encrypted location data. The agent is already gone or unreachable (
          {state}). The audit log keeps a record of what was deleted, by whom and why.
        </p>
      )}
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await rt.api.deleteDevice(deviceId, { reason, confirm });
            if (r.status === 'deleted') {
              rt.forgetDevice(deviceId);
              nav('/devices', { replace: true });
            }
            setReason('');
            setConfirm('');
            return r;
          }, managed ? 'Removal sent — the agent will uninstall itself and the record will be deleted' : 'Device deleted (recorded in the audit log)');
        }}
      >
        <Field label="Reason for deletion">
          <input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} placeholder={managed ? 'e.g. Employee left, phone kept as personal' : 'e.g. Disposed via certified e-waste, ref EW-221'} />
        </Field>
        <Field label='Type "DELETE" to confirm'>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="off" />
        </Field>
        <button className="btn btn-danger" disabled={busy || confirm !== 'DELETE'}>
          {managed ? 'Uninstall agent & delete' : 'Delete permanently'}
        </button>
      </form>
    </Card>
  );
}

function RemovalPendingCard({ device }: { device: import('../core/backend').DeviceView }) {
  const rt = useRuntime();
  const { run, busy } = useAction();
  const [users] = useQuery((api) => api.listUsers(), [], { live: false });
  const pr = device.pendingRemoval!;
  const who = users?.find((u) => u.id === pr.requestedBy)?.name ?? 'an administrator';
  return (
    <Card title="Removal pending" className="danger-zone">
      <p className="small">
        Requested {fmtAgo(pr.requestedAt)} by {who}: “{pr.reason}”. Waiting for <strong>{device.displayName}</strong> to come online, release management and uninstall the
        agent — then the record is deleted automatically. The command is re-signed for as long as it takes.
      </p>
      <p className="small muted">If the phone is lost or will never come back online, retire it (revokes access at once) and delete the record.</p>
      <button className="btn" disabled={busy} onClick={() => void run(() => rt.api.cancelRemoval(device.id), 'Removal cancelled — the device stays managed')}>
        Cancel removal
      </button>
    </Card>
  );
}

/** Report lost or stolen: Lost Mode + time-boxed active tracking (Location Operator). */
export function ReportIncidentCard({ deviceId, acknowledged, title = 'Report lost or stolen' }: { deviceId: string; acknowledged: boolean; title?: string }) {
  const rt = useRuntime();
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [f, setF] = useState({ kind: 'lost' as 'lost' | 'stolen', ticket: '', reason: '', intervalSec: 120, durationHours: 24, message: 'This phone belongs to the company. Please call the number below.', phone: '' });
  return (
    <Card title={title}>
      {!acknowledged ? (
        <p className="small muted">The employee has not acknowledged the device notice yet, so location cannot be collected.</p>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const inc = await rt.api.reportIncident(deviceId, { ...f, ticket: f.ticket.trim().toUpperCase() });
              nav(`/incidents/${inc.id}`);
              return inc;
            }, 'Reported — Lost Mode and active tracking sent to the phone');
          }}
        >
          <p className="small muted">
            Turns on Lost Mode (locked screen with your message) and tracks the phone every 1–5 minutes for a limited time. The employee sees a persistent notice saying
            how often and until when; tracking stops on the phone by itself when the time is up.
          </p>
          <div className="row-form">
            <Field label="Report as">
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'lost' | 'stolen' })}>
                <option value="lost">Lost</option>
                <option value="stolen">Stolen</option>
              </select>
            </Field>
            <Field label="Incident ticket" hint="e.g. INC-1042">
              <input value={f.ticket} onChange={(e) => setF({ ...f, ticket: e.target.value })} required pattern="[A-Za-z][A-Za-z0-9]{1,9}-\d{1,8}" />
            </Field>
            <Field label="Tracking interval">
              <select value={f.intervalSec} onChange={(e) => setF({ ...f, intervalSec: Number(e.target.value) })}>
                <option value={60}>1 minute</option>
                <option value={120}>2 minutes</option>
                <option value={300}>5 minutes</option>
              </select>
            </Field>
            <Field label="Tracking duration">
              <select value={f.durationHours} onChange={(e) => setF({ ...f, durationHours: Number(e.target.value) })}>
                <option value={4}>4 hours</option>
                <option value={24}>24 hours</option>
                <option value={72}>72 hours (maximum)</option>
              </select>
            </Field>
          </div>
          <Field label="What happened (justification for tracking)">
            <textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} rows={2} placeholder="e.g. Employee reports phone taken from car, police report 2026/1123" />
          </Field>
          <div className="row-form">
            <Field label="Lost Mode message">
              <input value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={200} />
            </Field>
            <Field label="Contact phone">
              <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={24} placeholder="+94 11 000 0000" />
            </Field>
          </div>
          <div>
            <button className="btn btn-danger" disabled={busy}>
              Report {f.kind} &amp; start tracking
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

const POSTURE: { key: keyof SecurityPosture; good: boolean; on: string; off: string }[] = [
  { key: 'screenLock', good: true, on: 'Screen lock', off: 'No screen lock' },
  { key: 'encrypted', good: true, on: 'Encrypted', off: 'Not encrypted' },
  { key: 'firewall', good: true, on: 'Firewall on', off: 'Firewall off' },
  { key: 'antivirus', good: true, on: 'Antivirus on', off: 'Antivirus off' },
  { key: 'secureBoot', good: true, on: 'Secure Boot', off: 'Secure Boot off' },
  { key: 'compromised', good: false, on: 'Compromised', off: 'Integrity OK' },
  { key: 'usbDebugging', good: false, on: 'USB debugging on', off: 'USB debugging off' },
  { key: 'unknownSources', good: false, on: 'Unknown sources allowed', off: 'Unknown sources blocked' },
  { key: 'openWifi', good: false, on: 'Open Wi-Fi', off: 'Secure network' },
];

/** The device's reported security settings as badges (green = safe). */
function Posture({ s }: { s: SecurityPosture }) {
  return (
    <>
      {POSTURE.filter((p) => typeof s[p.key] === 'boolean').map((p) => {
        const v = s[p.key] as boolean;
        const safe = v === p.good;
        return (
          <Badge key={p.key} tone={safe ? 'ok' : 'bad'}>
            {v ? p.on : p.off}
          </Badge>
        );
      })}
      {typeof s.pendingUpdates === 'number' && <Badge tone={s.pendingUpdates ? 'warn' : 'ok'}>{s.pendingUpdates ? `${s.pendingUpdates} updates pending` : 'Up to date'}</Badge>}
    </>
  );
}

/** This device's automatic check-in frequency: the organisation default or its own interval. */
function SyncCard({ device }: { device: DeviceView }) {
  const rt = useRuntime();
  const canEdit = useCan('device.policy');
  const own = device.policy.syncIntervalMin ?? null;
  const [v, setV] = useState<string>(own === null ? 'org' : String(own));
  const { run, busy } = useAction();
  const next = device.lastCheckinAt ? device.lastCheckinAt + device.sync.minutes * 60_000 : null;
  const changed = v !== (own === null ? 'org' : String(own));
  const android = device.platform === 'android';
  return (
    <Card title="Automatic check-in">
      <p className="small">
        Checks in every <strong>{fmtInterval(device.sync.minutes)}</strong> ({device.sync.source === 'device' ? 'set for this device' : 'organisation default'})
        {android && device.sync.requested < device.sync.minutes ? ` — ${fmtInterval(device.sync.requested)} requested; Android allows 15 minutes at most often` : ''}.{' '}
        {next ? <span className="muted">Next expected {next > Date.now() ? `in about ${fmtAgo(next).replace('in ', '')}` : `${fmtAgo(next)} (overdue)`}.</span> : null}
      </p>
      {canEdit && (
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => rt.api.updatePolicy(device.id, { syncIntervalMin: v === 'org' ? null : Number(v) }, ''), 'Check-in frequency saved; the device applies it at its next sync');
          }}
        >
          <Field label="Check in every">
            <select value={v} onChange={(e) => setV(e.target.value)}>
              <option value="org">Organisation default</option>
              {SYNC_CHOICES.map((m) => (
                <option key={m} value={String(m)}>
                  {fmtInterval(m)}
                  {android && m < 15 ? ' (15 min on Android)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-primary" disabled={busy || !changed}>
            Save
          </button>
        </form>
      )}
    </Card>
  );
}
