import { Card } from '../ui/kit';
import { COLLECTION_NOTICE } from '../core/enrollment';

type Risk = { level: 'High' | 'Medium' | 'Low'; issue: string; why: string; fix: string[]; built: string };

/** Governance and privacy risks found in the build specification, with mitigations. Kept in sync with docs/GOVERNANCE.md. */
export const RISKS: Risk[] = [
  {
    level: 'High',
    issue: 'Employee location tracking',
    why: 'Location is personal data under Sri Lanka’s PDPA (No. 9 of 2022), GDPR and similar laws. Tracking staff is lawful only if it is necessary, proportionate, transparent and has a documented legal basis. Consent from an employee is rarely “freely given”, so do not rely on consent alone.',
    fix: [
      'Complete and sign a DPIA before any real enrolment; record the legal basis (legitimate interest / contract) and the balancing test.',
      'Use location only to recover a lost or stolen device or for a documented safety programme — never for performance monitoring or attendance.',
      'Keep Tier 3 (continuous) off by default; enable per device only with a written justification tied to the DPIA, during working hours only.',
      'Consult staff / unions where required and publish the policy before rollout.',
    ],
    built: 'LOCATE needs a ticket + reason; viewing results needs a ticket; Tier 3 is off by default, needs a justification, ≥15 min, working hours in the policy time zone, and always shows a persistent notification.',
  },
  {
    level: 'High',
    issue: '“Headless” agent with no launcher icon',
    why: 'An icon-less app that collects location looks like stalkerware and can breach transparency duties and Google Play / Android policy if it hides itself.',
    fix: [
      'Never suppress Android’s “device is managed” disclosure, the OS location indicator or the per-fix notification.',
      'Give every notification a link to a self-service transparency page showing the employee’s own data.',
      'Show the collection notice at enrolment and block collection until it is acknowledged.',
    ],
    built: 'No code path or setting suppresses notifications; the server even discards any location that arrives without proof the notification was shown, and flags it as a security event. Location cannot be requested until the notice is acknowledged.',
  },
  {
    level: 'High',
    issue: 'Insider misuse by administrators',
    why: 'A console that can locate or wipe phones can be abused (e.g. to follow a colleague).',
    fix: [
      'Segregate duties: only the Location Operator can locate; Super Admin cannot see location.',
      'Four-eyes approval for wipes; nobody can change their own role.',
      'Security reviews location-access reports monthly; misuse is a disciplinary matter written into the policy.',
    ],
    built: 'Server-side RBAC on every call, ticket-linked access, four-eyes wipe, self-role-change blocked, every action and every denial in a hash-chained audit log.',
  },
  {
    level: 'High',
    issue: 'Remote wipe of a device that may contain personal data',
    why: 'Company-owned phones often still hold personal photos/messages. An unannounced wipe can destroy personal data.',
    fix: ['Prohibit personal use or allow a separate work profile in the policy.', 'Require a ticket, a reason and a second approver; notify the employee except where theft is confirmed.'],
    built: 'WIPE requires ticket, reason, typed confirmation and a different approver.',
  },
  {
    level: 'Medium',
    issue: 'Cross-border transfer (Cloudflare, FCM, APNs)',
    why: 'Data processed outside the country needs a transfer mechanism and the processor terms must be in place.',
    fix: [
      'Sign DPAs with Cloudflare, Google and Apple; use Cloudflare data-localisation (Regional Services / D1 location hints) where available.',
      'Push messages must carry no personal data — only a wake signal.',
      'Record the transfers in the DPIA and the privacy notice.',
    ],
    built: 'Push wakes contain no command data or personal data; the device pulls over its own authenticated channel.',
  },
  {
    level: 'Medium',
    issue: 'Retention and data-subject rights',
    why: 'Keeping location longer than needed, or not letting staff see it, breaches storage-limitation and access rights.',
    fix: ['30-day automatic purge of location; 1-year retention for audit; define a DSAR process with the DPO.'],
    built: 'Location encrypted with AES-256-GCM at rest and purged after 30 days; employees see every request and every stored fix for their device on the transparency page.',
  },
  {
    level: 'Medium',
    issue: 'Hosting on GitHub Pages',
    why: 'GitHub Pages is static, public hosting: it cannot keep server secrets, terminate mutual TLS, send FCM/APNs pushes or run scheduled jobs. A backend that runs in the browser is not a trust boundary.',
    fix: [
      'Use this Pages build as the console UI, demo and acceptance-test harness only — with no real employee data.',
      'Deploy the same API contract on Cloudflare Workers + Durable Objects (Phase 0–1), keep keys in Workers Secrets/KMS, and point the console at it.',
      'Put the production console behind Cloudflare Access (SSO + MFA) — never on a public github.io URL.',
    ],
    built: 'All data stays in the visitor’s own browser storage; nothing is sent anywhere. A strict Content-Security-Policy blocks third-party scripts.',
  },
  {
    level: 'Low',
    issue: 'Wi-Fi credentials in the provisioning QR',
    why: 'A QR photo would leak the Wi-Fi password.',
    fix: ['Use an open or captive setup SSID, or let the user pick Wi-Fi on the device.'],
    built: 'Only the SSID can be added; passwords are not supported.',
  },
  {
    level: 'Low',
    issue: 'iOS location expectations',
    why: 'Supervised iOS only exposes location through Managed Lost Mode; promising more would be misleading.',
    fix: ['Document that iPhones are locatable only in Lost Mode; never claim background tracking.'],
    built: 'Spec guardrail kept; iOS is out of scope for this static build.',
  },
];

export function PrivacyPage() {
  return (
    <div className="page narrow">
      <h1>Privacy notice &amp; governance</h1>
      <Card title={COLLECTION_NOTICE.title}>
        <p className="small muted">Version {COLLECTION_NOTICE.version}. Shown to every employee at enrolment; collection starts only after they acknowledge it.</p>
        <h3>What is collected</h3>
        <ul>
          {COLLECTION_NOTICE.collected.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <h3>What is never collected</h3>
        <ul>
          {COLLECTION_NOTICE.notCollected.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p>{COLLECTION_NOTICE.retention}</p>
        <p>{COLLECTION_NOTICE.rights}</p>
      </Card>

      <h2>Governance review of the build specification</h2>
      <p className="muted">
        These are the points in the specification that could breach privacy law or policy if implemented carelessly, and how this build (and your rollout) should
        address them. This is engineering guidance, not legal advice — have your DPO or counsel confirm it for your jurisdiction.
      </p>
      {RISKS.map((r) => (
        <Card
          key={r.issue}
          title={
            <>
              <span className={`risk risk-${r.level.toLowerCase()}`}>{r.level}</span> {r.issue}
            </>
          }
        >
          <p>{r.why}</p>
          <h3>What to do</h3>
          <ul>
            {r.fix.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="small">
            <strong>Built in:</strong> {r.built}
          </p>
        </Card>
      ))}
      <Card title="Go-live checklist (gate before any real employee device)">
        <ul className="checklist">
          <li>DPIA completed and signed; legal basis recorded</li>
          <li>Device-use policy published, staff consulted, acknowledgements collected</li>
          <li>DPAs with Cloudflare, Google (FCM) and Apple (APNs); transfer safeguards recorded</li>
          <li>Backend on Cloudflare Workers with keys in Secrets/KMS; console behind Cloudflare Access</li>
          <li>Independent penetration test with zero open high/critical findings</li>
          <li>Runbooks rehearsed: lost/stolen, leaver, non-compliant, suspected misuse</li>
          <li>Monthly review of location-access audit by Security; DSAR process with the DPO</li>
        </ul>
      </Card>
    </div>
  );
}
