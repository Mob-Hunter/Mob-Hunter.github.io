import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../ui/kit';

type Guide = { id: string; title: string; icon: string; summary: string; keywords: string; body: ReactNode };

const GUIDES: Guide[] = [
  {
    id: 'existing-phone',
    title: 'Enrol an existing phone (no factory reset)',
    icon: '＋',
    summary: 'One QR scan, then Install and Open — about a minute.',
    keywords: 'enrol enroll personal byod qr camera install apk',
    body: (
      <>
        <ol className="steps">
          <li>
            Open <Link to="/enrol">Add devices</Link> and tap <strong>Mint token + QR</strong>. Keep <em>Existing phone</em> selected.
          </li>
          <li>On the Android phone, open the camera and scan the QR code.</li>
          <li>
            Tap <strong>Install Mob Hunter &amp; enrol</strong>, then <strong>Install</strong> and <strong>Open</strong>. If Android asks, allow the browser to
            install apps.
          </li>
          <li>The app enrols the phone by itself and asks for notifications and location (“Allow all the time”), then shows the notice.</li>
          <li>
            The phone appears in <Link to="/devices?unnamed=1">Devices → Unnamed</Link>. Give it a name and assign it to an employee.
          </li>
        </ol>
        <p className="small muted">
          A phone enrolled this way cannot be wiped, rebooted or sent apps, and policy is not enforced. Use a factory-reset company phone when you need those.
        </p>
      </>
    ),
  },
  {
    id: 'company-phone',
    title: 'Enrol a company phone (factory reset, zero-touch)',
    icon: '⛨',
    summary: 'Fully managed: policy, lock, wipe and silent app installs.',
    keywords: 'device owner provisioning factory reset welcome six taps',
    body: (
      <ol className="steps">
        <li>
          Open <Link to="/enrol">Add devices</Link>, tap <strong>Mint token + QR</strong> and choose <em>Factory-reset company phone</em>.
        </li>
        <li>Factory-reset the phone. On the Welcome screen, tap six times to open the QR reader.</li>
        <li>Connect to Wi-Fi and scan the code. Android downloads, verifies and installs Mob Hunter as device owner.</li>
        <li>The employee reads the notice and taps “I understand”. The phone appears as an unnamed device.</li>
      </ol>
    ),
  },
  {
    id: 'computers',
    title: 'Add a Windows, Linux or Mac computer',
    icon: '⊞',
    summary: 'One command in an admin terminal installs the desktop agent and enrols the computer.',
    keywords: 'computer laptop desktop pc windows linux macos mac agent powershell sudo install service',
    body: (
      <>
        <ol className="steps">
          <li>
            Open <Link to="/enrol?platform=desktop">Add devices → Computer</Link>, tap <strong>Mint token + QR</strong> and choose Windows, Linux or macOS.
          </li>
          <li>
            Copy the command. On Windows paste it into <em>PowerShell (Admin)</em>; on Linux or macOS into a terminal (it uses <code>sudo</code>).
          </li>
          <li>Read the notice to the employee and type “I understand”. A background service starts and the computer appears in Devices within a minute.</li>
        </ol>
        <p className="small muted">
          Computers support lock, message, restart and policy sync, and report security settings for the threat landscape. Locate, Lost Mode, ring, app installs and wipe are
          phone-only. <code>mob-hunter-agent posture</code> shows exactly what a computer reports; <code>mob-hunter-agent uninstall</code> removes it locally.
        </p>
      </>
    ),
  },
  {
    id: 'threats',
    title: 'Review and fix security threats',
    icon: '⚠',
    summary: 'Threat landscape: risk per device, one-click fixes, time-limited risk acceptance.',
    keywords: 'threat mtd mobile threat defense risk score root jailbreak malware patch encryption screen lock usb debugging wifi firewall accept',
    body: (
      <ol className="steps">
        <li>
          Open <Link to="/threats">Threat landscape</Link>. The threat level follows the worst open threat; each device gets a risk score from 0 to 100.
        </li>
        <li>
          Filter by severity, category or platform. Each threat says why it matters and how to fix it. <strong>Send instructions</strong> sends the employee the exact
          steps; <strong>Lock device</strong> is offered for compromised devices.
        </li>
        <li>Threats resolve by themselves at the next check-in once the device is fixed — the timeline shows detections and resolutions.</li>
        <li>
          When a risk is known and acceptable (a developer phone with USB debugging), use <strong>Accept risk…</strong> with a reason for 7, 30 or 90 days. It is audited and
          reopens automatically. Critical threats cannot be accepted.
        </li>
      </ol>
    ),
  },
  {
    id: 'ios',
    title: 'iPhone and iPad',
    icon: '▯',
    summary: 'iOS needs an Apple MDM push certificate first.',
    keywords: 'ios iphone ipad apple mdm apns abm business manager',
    body: (
      <p>
        Apple manages iOS devices only through its MDM service. Your organisation needs an Apple push (APNs) MDM certificate and, for company iPhones, Apple Business Manager.
        Until then Mob Hunter does not offer iOS enrolment, because the devices could not receive any command. See <Link to="/enrol">Add devices → iPhone / iPad</Link>.
      </p>
    ),
  },
  {
    id: 'name-assign',
    title: 'Name and assign a device',
    icon: '✎',
    summary: 'New phones arrive as “Unnamed device”.',
    keywords: 'rename label assign employee unnamed',
    body: (
      <p>
        Open <Link to="/devices?unnamed=1">Devices → Unnamed</Link> and type a name in the row, or open the device and use <em>Identify this device</em> to set
        the name and the employee together. Add employees first in <Link to="/employees">Employees</Link> (one at a time or by CSV).
      </p>
    ),
  },
  {
    id: 'locate',
    title: 'Find where a phone is',
    icon: '⌖',
    summary: 'A one-off location fix against a ticket; the employee is notified.',
    keywords: 'locate location map gps ticket',
    body: (
      <>
        <ol className="steps">
          <li>
            Open the device from <Link to="/devices">Devices</Link>. In <em>Commands</em>, choose <strong>LOCATE</strong>, enter a ticket like INC-1042 and
            why it is needed, then send it.
          </li>
          <li>The phone shows a notification, takes one fix and sends it back.</li>
          <li>
            See the result in <Link to="/locations">Locations</Link>: enter the same ticket to view the map and history. Every view is written to the audit
            log.
          </li>
        </ol>
        <p className="small muted">
          Without push messaging the phone checks in every 15 minutes, so a request can take that long. Opening the Mob Hunter app on the phone and tapping{' '}
          <em>Sync now</em> delivers it at once.
        </p>
      </>
    ),
  },
  {
    id: 'lost',
    title: 'A phone is lost or stolen',
    icon: '⚑',
    summary: 'Lock it with a message and track it for a limited time.',
    keywords: 'lost stolen incident lost mode tracking recover found',
    body: (
      <ol className="steps">
        <li>
          Open the device and use <strong>Report lost or stolen</strong>: choose lost or stolen, the ticket, how often to track (1–5 minutes) and for how long.
        </li>
        <li>The phone shows your message and phone number and shares its position on that schedule. The employee sees a persistent notice.</li>
        <li>
          Follow it live from <Link to="/incidents">Lost &amp; stolen</Link>. Extend or slow down tracking there, and close the incident as found or not
          recovered.
        </li>
      </ol>
    ),
  },
  {
    id: 'actions',
    title: 'Lock, message, ring, sync policy, wipe or install an app',
    icon: '⛨',
    summary: 'Signed commands with a 10-minute expiry; wipes need a second person.',
    keywords: 'lock reboot wipe install uninstall app sync policy message ring approve four eyes',
    body: (
      <ul>
        <li>
          Open the device and pick the command. Commands this phone cannot run are hidden, with the reason shown under the form.
        </li>
        <li>
          <strong>Wipe</strong> needs a ticket and a second administrator, who approves it on the same device page. It only exists for company
          (factory-reset) phones. The Overview shows how many requests are awaiting approval.
        </li>
        <li>
          Apps are installed only from the approved catalogue in <Link to="/settings">Settings</Link>, and the phone checks each file&apos;s SHA-256.
        </li>
      </ul>
    ),
  },
  {
    id: 'groups-bulk',
    title: 'Groups and commands to many phones at once',
    icon: '⧉',
    summary: 'Tag devices (Sales, Colombo…), filter by group, then message, ring, lock or install on all of them.',
    keywords: 'group tag bulk mass many all message broadcast ring find lock install uninstall asset tag notes',
    body: (
      <ol className="steps">
        <li>
          Open a device and fill in <strong>Groups</strong> (comma-separated), and optionally an <strong>Asset tag</strong> and notes. Search finds devices by
          any of them.
        </li>
        <li>
          In <Link to="/devices">Devices</Link>, choose a group in <em>All groups</em> (or click a group chip), then <strong>Select all</strong>.
        </li>
        <li>
          Use the bar that appears: <strong>Message…</strong> shows your text as a notification, <strong>Ring</strong> plays an alarm for 30 seconds to find a
          misplaced phone, and <strong>Sync policy</strong>, <strong>Lock</strong>, <strong>Install app…</strong> and <strong>Uninstall app…</strong> work as
          on a single device.
        </li>
        <li>The result says how many phones received it and which were skipped and why. Each phone is checked and audited on its own.</li>
      </ol>
    ),
  },
  {
    id: 'restrictions',
    title: 'Restrictions: camera, screenshots, Bluetooth, Wi-Fi, users',
    icon: '⊘',
    summary: 'Switch them on per device with a justification; company phones apply them at the next sync.',
    keywords: 'restriction policy camera screenshot screen capture bluetooth wifi user profile disable block kiosk',
    body: (
      <p>
        Open the device and use the switches under <em>Restrictions</em> in the policy card, add a justification and tap <strong>Save policy</strong>. The
        change creates a new policy version, is recorded in the audit log and is pushed to the phone. Restrictions are enforced on company (factory-reset)
        phones; a phone enrolled without a factory reset shows a note instead.
      </p>
    ),
  },
  {
    id: 'remove',
    title: 'Remove a device',
    icon: '↺',
    summary: 'Retire it, or delete it and the agent uninstalls itself.',
    keywords: 'delete retire remove uninstall offboard release',
    body: (
      <p>
        Open the device. <strong>Retire</strong> revokes its certificate when a phone is returned or written off. <strong>Delete</strong> sends a signed release:
        the phone lifts every restriction, gives up management and uninstalls Mob Hunter, then the record is deleted. Nothing personal on the phone is erased.
        Several devices can be removed at once from <Link to="/devices">Devices</Link> using the checkboxes.
      </p>
    ),
  },
  {
    id: 'team',
    title: 'Invite colleagues and choose their role',
    icon: '⚿',
    summary: 'Six roles; everyone signs in with an authenticator app.',
    keywords: 'users invite admin role mfa authenticator reset sessions',
    body: (
      <>
        <p>
          In <Link to="/users">Users &amp; access</Link>, enter the name, work e-mail, role and a temporary password. Give the new user the authenticator QR
          shown once. <Link to="/roles">Roles</Link> lists exactly what each role can do.
        </p>
        <p className="small muted">Good practice: one Super Admin, a Device Admin for day-to-day work, a Location Operator, and Security to approve wipes.</p>
      </>
    ),
  },
  {
    id: 'employees',
    title: 'Import employees from HR',
    icon: '☺',
    summary: 'CSV with name, email and department.',
    keywords: 'csv import hr staff offboard dsar',
    body: (
      <p>
        In <Link to="/employees">Employees</Link>, choose a CSV file with the columns <code>name,email,department</code>. Rows are matched by e-mail, so
        re-importing updates people. Offboarding an employee unassigns their phones.
      </p>
    ),
  },
  {
    id: 'audit',
    title: 'Audit, privacy and data requests',
    icon: '⛓',
    summary: 'Every action and every denied attempt is recorded and tamper-evident.',
    keywords: 'audit export verify privacy dpia notice retention dsar transparency',
    body: (
      <p>
        <Link to="/audit">Audit log</Link> shows who did what, against which ticket; <em>Verify hash chain</em> proves nothing was altered, and Security or
        Auditors can export it. <Link to="/privacy">Privacy &amp; governance</Link> holds the employee notice and the go-live checklist. Location results are
        encrypted and deleted after 30 days.
      </p>
    ),
  },
];

const FAQ: { q: string; a: ReactNode; keywords: string }[] = [
  {
    q: 'The phone does not appear in the console',
    keywords: 'not reporting missing enrol failed',
    a: (
      <>
        Open the Mob Hunter app on the phone. If it says <em>Enrol this phone</em>, the enrolment did not finish: mint a new QR (they expire after 15 minutes
        and work once) and scan again. If it shows a <em>Last check-in problem</em>, that message says what went wrong. Phones from before agent 1.1 have no app
        screen — install the latest version from <Link to="/apps">Agents &amp; apps</Link>.
      </>
    ),
  },
  {
    q: 'A command says “not available on this phone”',
    keywords: 'not supported wipe reboot lock standard',
    a: <>The phone was enrolled without a factory reset. Remote lock works once the user allows it in the app; wipe, reboot and app installs need a company (factory-reset) enrolment.</>,
  },
  {
    q: 'A location request is still pending',
    keywords: 'locate pending slow delay',
    a: <>The phone collects it at its next check-in (at most 15 minutes), or straight away when someone taps Sync now in the app. It also needs location permission — the device page shows what the user allowed.</>,
  },
  {
    q: 'I cannot see a page or button',
    keywords: 'permission role missing hidden',
    a: (
      <>
        Menus only show what your role may use; <Link to="/roles">Roles</Link> lists the permissions. Super Admin has every permission. If the console was just
        updated, reload the page.
      </>
    ),
  },
];

export function HelpPage() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const match = (text: string) => terms.every((t) => text.toLowerCase().includes(t));
  const guides = GUIDES.filter((g) => match(`${g.title} ${g.summary} ${g.keywords}`));
  const faq = FAQ.filter((f) => match(`${f.q} ${f.keywords}`));
  return (
    <div className="page">
      <h1>Help &amp; guides</h1>
      <p className="muted">Step-by-step guides for everyday tasks. Each one links straight to the right screen.</p>
      <div className="toolbar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the guides…" aria-label="Search the guides" />
        <span className="small muted">
          Tip: press <kbd>Ctrl</kbd> <kbd>K</kbd> anywhere to search devices, people and pages.
        </span>
      </div>
      <div className="help-grid">
        {guides.map((g) => (
          <details key={g.id} id={g.id} className="help-item" open={open === g.id || terms.length > 0} onToggle={(e) => (e.currentTarget.open ? setOpen(g.id) : null)}>
            <summary>
              <span className="help-icon" aria-hidden>
                {g.icon}
              </span>
              <span>
                <strong>{g.title}</strong>
                <small>{g.summary}</small>
              </span>
            </summary>
            <div className="help-body">{g.body}</div>
          </details>
        ))}
      </div>
      {guides.length === 0 && faq.length === 0 && <p className="muted">No guides match “{q}”.</p>}
      {faq.length > 0 && (
        <Card title="Troubleshooting">
          <dl className="faq">
            {faq.map((f) => (
              <div key={f.q}>
                <dt>{f.q}</dt>
                <dd>{f.a}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
    </div>
  );
}
