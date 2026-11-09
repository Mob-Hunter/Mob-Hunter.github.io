import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { ApkDownloads } from './Download';
import { QrImage } from '../ui/kit';
import { SERVER_URL } from '../config';
import { COLLECTION_NOTICE } from '../core/enrollment';

/**
 * Public product page, shown on copies of the console that are not the live
 * server (GitHub Pages). It explains the product, sends people to the console
 * and offers the Android apps. It never holds data.
 */
export function Landing() {
  const target = `${SERVER_URL}/`;
  useEffect(() => {
    document.title = 'Mob Hunter — company device management';
    // Console deep links (#/e/…, #/transparency/…, #/devices/…) belong to the server.
    if (/^#\/./.test(location.hash)) location.replace(`${target}${location.hash}`);
  }, [target]);

  return (
    <div className="lp">
      <a className="skip-link" href="#lp-main">
        Skip to content
      </a>
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden>
              ◈
            </span>
            Mob Hunter
          </span>
          <nav aria-label="Page sections" className="lp-links">
            <JumpLink to="how">How it works</JumpLink>
            <JumpLink to="features">Features</JumpLink>
            <JumpLink to="privacy">Privacy</JumpLink>
            <JumpLink to="apps">Apps</JumpLink>
          </nav>
          <a className="btn btn-primary btn-sm" href={target}>
            Open console
          </a>
        </div>
      </header>

      <main id="lp-main">
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-grid">
            <div className="lp-hero-copy">
              <p className="lp-eyebrow">Company-owned Android phones</p>
              <h1>Manage every company phone — and find a lost one — without spying on anyone.</h1>
              <p className="lp-lead">
                Enrol phones with one QR scan, keep them secure and up to date, and track a lost or stolen device. Employees are notified every time
                their location is requested.
              </p>
              <div className="lp-cta-row">
                <a className="btn btn-primary btn-lg" href={target}>
                  Open the console →
                </a>
                <JumpLink to="apps" className="btn btn-lg">
                  Get the Android apps
                </JumpLink>
              </div>
              <ul className="lp-trust" aria-label="Security at a glance">
                <li>Signed commands</li>
                <li>Encrypted location</li>
                <li>Tamper-evident audit</li>
                <li>Auto-deleted after 30 days</li>
              </ul>
            </div>
            <PhoneIllustration />
          </div>
        </section>

        <section id="how" className="lp-section" aria-labelledby="how-h">
          <div className="lp-wrap">
            <SectionHead id="how-h" kicker="How it works" title="From box to managed phone in three steps" lead="No cables, no MDM vendor account. A factory-reset Android phone and one QR code are all it takes." />
            <ol className="lp-steps">
              <Step n={1} title="Create an enrolment QR">
                In the console, open <em>Add devices</em> and mint a one-time QR. It is valid for 15 minutes and works once.
              </Step>
              <Step n={2} title="Scan it on a factory-reset phone">
                Tap the welcome screen six times and scan. Android installs the signed Mob Hunter agent as device owner and checks its signature.
              </Step>
              <Step n={3} title="The employee reads the notice">
                Nothing is collected until they tap <em>I understand</em>. The phone then appears in the console, ready to name and assign.
              </Step>
            </ol>
          </div>
        </section>

        <section id="features" className="lp-section lp-alt" aria-labelledby="features-h">
          <div className="lp-wrap">
            <SectionHead id="features-h" kicker="Features" title="Everything IT needs. Nothing it shouldn't have." lead="Device health, policy, lost-device tracking and safe remote actions — with no remote screen, no shell and no access to personal content." />
            <div className="lp-features">
              <Feature icon="▤" title="Fleet at a glance">
                Battery, storage, OS patch level, integrity and last check-in for every phone, with compliance alerts and CSV export.
              </Feature>
              <Feature icon="⚑" title="Lost & stolen tracking">
                Report a phone lost and it locks with your message, then shares its position every 1–5 minutes for a limited time.
              </Feature>
              <Feature icon="⌖" title="Ticketed locate">
                A one-off location fix needs a ticket and a reason. The phone shows a notification, and the employee can see every request.
              </Feature>
              <Feature icon="✓" title="Policies that stick">
                Screen lock, password rules, update window, no factory reset or USB transfer, approved apps only — enforced on the phone.
              </Feature>
              <Feature icon="⛨" title="Safe remote actions">
                Lock, reboot, wipe and app install are Ed25519-signed with a 10-minute expiry. Wipes need a second approver.
              </Feature>
              <Feature icon="↺" title="Clean offboarding">
                Delete a device and the agent releases every restriction, gives up management and uninstalls itself. Personal data stays.
              </Feature>
            </div>
          </div>
        </section>

        <section id="privacy" className="lp-section" aria-labelledby="privacy-h">
          <div className="lp-wrap">
            <SectionHead id="privacy-h" kicker="Privacy by design" title="Transparent to employees, by default" lead="Employees read exactly this list before anything is collected, and their phone tells them every time a location is requested." />
            <div className="lp-privacy">
              <div className="lp-list-card">
                <h3>What the phone shares</h3>
                <ul className="lp-check">
                  {COLLECTION_NOTICE.collected.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <div className="lp-list-card lp-never">
                <h3>What it never touches</h3>
                <ul className="lp-cross">
                  {COLLECTION_NOTICE.notCollected.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <p className="small muted">{COLLECTION_NOTICE.retention}</p>
              </div>
            </div>
            <p className="lp-more">
              <a href={`${target}#/privacy`}>Read the full privacy notice &amp; governance review →</a>
            </p>
          </div>
        </section>

        <section className="lp-section lp-alt" aria-labelledby="roles-h">
          <div className="lp-wrap">
            <SectionHead id="roles-h" kicker="Access control" title="The right access for each person" lead="Multi-factor sign-in for everyone. Permissions are enforced on the server on every request, and every action lands in the audit log." />
            <div className="lp-roles">
              <Role name="Super Admin">Runs the organisation: users, roles, settings, and every action.</Role>
              <Role name="Device Admin">Enrols, names and assigns phones; sets policy; requests wipes.</Role>
              <Role name="Helpdesk">Sees device health; can lock, reboot and re-sync a phone.</Role>
              <Role name="Location Operator">Locates or tracks a phone against a ticket — every view is audited.</Role>
              <Role name="Security">Reviews the audit log, approves wipes, purges data, handles access requests.</Role>
              <Role name="Auditor">Read-only access to the fleet and the tamper-evident audit log.</Role>
            </div>
          </div>
        </section>

        <section id="apps" className="lp-section" aria-labelledby="apps-h">
          <div className="lp-wrap">
            <SectionHead id="apps-h" kicker="Android apps" title="Scan to download" lead="Point the phone's camera at a code, or tap Download on the phone itself. Every file can be checked against its published SHA-256." />
            <ApkDownloads />
          </div>
        </section>

        <section className="lp-section lp-final" aria-labelledby="final-h">
          <div className="lp-wrap lp-final-grid">
            <div>
              <h2 id="final-h">Ready to sign in?</h2>
              <p className="lp-lead">Open the console on this computer, or scan the code with your phone.</p>
              <a className="btn btn-primary btn-lg" href={target}>
                Open the console →
              </a>
              <p className="tiny muted break">{target}</p>
            </div>
            <div className="lp-final-qr">
              <QrImage size="lg" text={target} label="QR code to open the Mob Hunter console" />
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-inner">
          <span>
            <span className="brand-mark" aria-hidden>
              ◈
            </span>{' '}
            Mob Hunter · company device management
          </span>
          <span>
            <a href={`${target}#/privacy`}>Privacy &amp; governance</a> · <a href={target}>Console</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** In-page link that scrolls without changing the URL hash (the hash belongs to console deep links). */
function JumpLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const go = (e: MouseEvent) => {
    e.preventDefault();
    const el = document.getElementById(to);
    if (!el) return;
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  };
  return (
    <a href={`#${to}`} onClick={go} className={className}>
      {children}
    </a>
  );
}

function SectionHead({ id, kicker, title, lead }: { id: string; kicker: string; title: string; lead: string }) {
  return (
    <div className="lp-head">
      <div>
        <p className="lp-eyebrow">{kicker}</p>
        <h2 id={id} tabIndex={-1}>
          {title}
        </h2>
      </div>
      <p className="lp-head-lead">{lead}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="lp-step">
      <span className="lp-step-n" aria-hidden>
        {n}
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

function Feature({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className="lp-feature">
      <span className="lp-icon" aria-hidden>
        {icon}
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Role({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="lp-role">
      <h3>{name}</h3>
      <p>{children}</p>
    </div>
  );
}

/** A phone showing the transparency notification — drawn with CSS, no images. */
function PhoneIllustration() {
  return (
    <div className="lp-phone-wrap" aria-hidden>
      <div className="lp-phone">
        <div className="lp-phone-bar">
          <span>09:41</span>
          <span>● 86%</span>
        </div>
        <div className="lp-notif lp-notif-alert">
          <strong>Your device location was requested</strong>
          <span>Requested by IT for ticket INC-1042. Tap to see every request.</span>
        </div>
        <div className="lp-notif">
          <strong>This device is managed by your organisation</strong>
          <span>IT can see device health and, when needed, its location.</span>
        </div>
        <div className="lp-track">
          <svg viewBox="0 0 220 96" role="presentation">
            <path className="lp-grid" d="M0 24H220M0 48H220M0 72H220M44 0V96M88 0V96M132 0V96M176 0V96" />
            <path className="lp-route" d="M18 78 C 52 70, 60 40, 96 44 S 150 22, 176 30" />
            <circle className="lp-acc" cx="176" cy="30" r="14" />
            <circle className="lp-pin" cx="176" cy="30" r="5" />
          </svg>
          <span>Lost Mode · tracked every 2 min · ends 18:00</span>
        </div>
        <div className="lp-phone-stats">
          <div>
            <b>Patch</b>
            <span>Oct 2026</span>
          </div>
          <div>
            <b>Policy</b>
            <span>Compliant</span>
          </div>
          <div>
            <b>Lock</b>
            <span>5 min</span>
          </div>
        </div>
      </div>
    </div>
  );
}
