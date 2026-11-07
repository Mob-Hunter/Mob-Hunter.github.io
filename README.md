# FleetGuard — company-owned device management

FleetGuard manages company-owned Android phones (and, later, supervised iPhones) as the build specification describes. Transparency and least privilege are built into the code rather than left to configuration.

| Part | What it is | Where |
|---|---|---|
| **Console** | Responsive React admin console. The same build runs as a static demo, on a real server, or inside the console APK | `src/` |
| **Server** | Cloudflare Worker with Hono. A Durable Object holds the tenant, using SQLite storage and the per-device relay queues. Optional FCM push, Cloudflare Access SSO and SIEM forwarding | `worker/`, `wrangler.toml` |
| **Device agent APK** | Kotlin device-owner agent (minSdk 30), with no launcher icon. It enrols with the provisioning QR, uses a P-256 key in the Android Keystore, verifies signed commands and posts the mandatory notifications | `android/agent` |
| **Console APK** | The console as an Android app. It runs as an offline demo, or connects to your server | `android/console` |

## Live

| | URL |
|---|---|
| **Console + API (production server)** | https://fleetguard.inbox-ashen.workers.dev |
| **Landing page + Android downloads (QR codes)** | https://mob-hunter.github.io |

- **GitHub Pages** hosts the public landing page. It shows a QR code that opens the console on the server, plus a QR code and download button for each **release-signed** APK, with its SHA-256. The same QR codes appear in the console under *Settings → Android apps* and on `#/download`.
- The **server** is the Cloudflare Worker. It holds all data, secrets and keys. GitHub Pages can't keep secrets, so it never runs a backend.
- Before real employee phones are enrolled, complete the [governance gate](docs/GOVERNANCE.md#go-live-gate).

## Modes

The console works out how it is running at start-up:

- **Server ("Live").** Served by the Worker, so `/api/health` answers. Every call goes to the real backend over HTTPS. The session lives in an HttpOnly, Secure, SameSite=Strict cookie, and requests also carry a CSRF header.
- **Demo.** A build without `VITE_SERVER_URL`, served statically (local `npm run dev`/`preview`, or the console APK offline when no server is built in). It is not published. The reference backend runs in the browser with seeded demo accounts and simulated phones. Nothing leaves the device.

Both modes run the same backend code (`src/core/backend.ts`), so every rule is tested once and enforced identically.

## Features

**Security and the non-negotiables**

- Admin sign-in uses a password (PBKDF2) plus TOTP MFA, with lockout and rate limits. Cloudflare Access SSO is optional. Sessions expire after 30 minutes idle and 12 hours in total.
- Six roles are enforced on the server for every call. Only the Location Operator can locate a device or read location data, and Super Admin can't. A wipe needs a different second approver. Nobody can change their own role, and a role change revokes that user's sessions.
- Commands are signed with Ed25519 and carry a nonce and a 10-minute expiry. They run once, and the agent rejects tampered, expired, replayed, wrong-device or overly long-lived commands.
- Device identity uses a P-256 key in the Android Keystore (StrongBox where available) and a certificate from FleetGuard's own CA. Every request is signed over method, path, timestamp, nonce and body hash. The agent pins the server's signing key from the QR.
- The audit log is append-only and hash-chained, covering every action and every denied attempt. It has a verify button, a SIEM export, and optional HMAC-signed webhook forwarding.
- Location data is encrypted with AES-256-GCM and purged after 30 days. Viewing it requires a ticket and is itself audited. **The server discards any location that arrives without proof that the phone showed the notification.**
- Nothing is collected until the employee has acknowledged the notice. Employees have a self-service transparency page. Continuous tracking is off by default, needs a written justification, and runs only during working hours with a persistent notification.

**Operations**

- Enrolment: 15-minute single-use tokens, the device-owner QR, an install page, and a clearly labelled sideload link. New phones appear as "Unnamed device" and can be renamed or assigned inline.
- Commands: LOCATE, Lost Mode on and off, LOCK, WIPE (four-eyes), SYNC_POLICY, INSTALL_APP (from the approved catalogue, with SHA-256 checked on the device), and REBOOT.
- Compliance view: stale check-ins, patch age, Play Integrity, battery, storage, acknowledgement and assignment. Inventory exports to CSV, with spreadsheet formula injection neutralised.
- Employees: add, import from HR CSV, leaver offboarding, and DSAR export (Security only, ticketed and audited).
- Users and access: invite users with an authenticator QR, disable accounts, reset MFA, and list or revoke sessions.
- Settings: organisation name and DPO contact (both shown in the employee notice), SIEM webhook, approved app catalogue, and change password.
- Device lifecycle: retirement revokes the device's certificate immediately. **Deleting** a device needs a reason and a typed `DELETE`, and the audit log keeps a snapshot of the record:
  - **Active device:** the phone receives a signed RELEASE command. It lifts every restriction, tells the employee it is no longer managed, gives up device-owner rights and **uninstalls the agent** (nothing is wiped). The record, its command history and its encrypted location data are deleted when the phone confirms. The command is re-signed for phones that are offline longer than the 10-minute command lifetime, and a pending removal can be cancelled.
  - **Retired or wiped device:** deleted at once.
- **Lost & stolen incidents with active tracking:**
  - The Location Operator reports a device lost or stolen against a ticket, choosing a fix every 1, 2 or 5 minutes for up to 72 hours (extendable).
  - The live tracking page shows the device's track, distance moved, current speed, battery and last check-in, refreshing every 15 seconds. Each viewing session is audited once per 15 minutes.
  - The phone shows a persistent notice saying how often and until when it is tracked, and stops by itself at the limit.
  - Below 15% battery it drops to every 5 minutes.
  - Closing the incident as found, recovered or a false alarm ends Lost Mode. "Not recovered" keeps the phone locked and prompts a WIPE.
  - Every role sees incident status; only the Location Operator sees positions.
- Devices list: state tabs (active, awaiting acknowledgement, Lost Mode, unnamed, retired/wiped) and bulk actions (sync policy, lock, retire, delete).
- **Location workspace** (Location Operator only):
  - a ticket index (ticket references and device names, never coordinates);
  - a fleet map of each device's latest position, with tracks, accuracy circles, scale and legend;
  - a "latest position per device" list and full history;
  - filters by device, tier and period;
  - "only fixes recorded under this ticket" switched on by default (purpose limitation);
  - Lost Mode fixes filed under the Lost Mode ticket.

  Every other role sees a "Restricted" panel naming who can help, plus the device's last location request. The demo seeds ticket `INC-1001`.

## Develop

```bash
npm ci
npm run dev              # console in demo mode (http://localhost:5173)
npm run dev:server       # console + real Worker locally in workerd (http://127.0.0.1:8787)
npm test                 # unit, integration and HTTP API tests
npm run test:e2e         # browser E2E against the static build (demo mode)
npm run test:e2e:server  # browser E2E against the Worker (server mode)
npm run android          # agent unit tests + both release APKs (needs the Android SDK)
```

## Deploy

- **Landing page and APKs:** merge to `main`. `pages.yml` runs all the tests, makes the production build (`VITE_SERVER_URL`) and publishes it with the APKs under `/downloads/`. With the `FG_KEYSTORE_*` secrets set, it rebuilds and signs the APKs. Without them, it publishes the release-signed APKs committed in `releases/android/` (it checks their SHA-256 first). Debug-signed APKs are never published.
- **Server:** `deploy-worker.yml` deploys the Worker on every push to `main` once the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set. You can also deploy by hand with `npm run build && npx wrangler deploy`. The console is embedded in the Worker script (`scripts/embed-assets.mjs`), so deploying needs only *Workers Scripts: Edit* permission.
- **Production server:** follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: `wrangler secret put BOOTSTRAP_TOKEN`, `npm run deploy`, open the URL and create the first Super Admin.
- **APKs:** pushing a `v*` tag runs `release.yml`, which attaches signed APKs and checksums to a GitHub Release. See [android/README.md](android/README.md) for signing and enrolment.

Docs: [Deployment](docs/DEPLOYMENT.md) · [Android](android/README.md) · [Security model](docs/SECURITY.md) · [Governance review](docs/GOVERNANCE.md)
