# FleetGuard — company-owned device management console

**Live:** https://mob-hunter.github.io/ (after the Pages workflow runs on `main`)

FleetGuard is the central dashboard, API and relay from Phases 0–2 of the build specification, written so the whole service runs on GitHub Pages. It works on phones (it's an installable PWA) and on desktop. Because GitHub Pages only hosts static files, the **reference backend runs inside the browser** and implements the same API contract the Cloudflare Worker will serve in production. Everything works end to end: sign-in, roles, enrolment, the QR code, rename, signed commands, the relay, the audit chain and location retention. Simulated Android devices stand in for real phones.

> ⚠️ **Demo, not production.** All data lives in the visitor's own browser storage and is never sent anywhere. Don't enter real employee data. To run on real devices, deploy the same contract on Cloudflare (see [Production path](#production-path)) and read [docs/GOVERNANCE.md](docs/GOVERNANCE.md).

## What's implemented

| Spec item | Where | Notes |
|---|---|---|
| Admin auth (password + MFA), server-side sessions | `src/core/backend.ts` `login` / `verifyMfa` | PBKDF2-SHA256 (210k), RFC 6238 TOTP, lockout after 5 failures, 30-min idle / 12-h absolute sessions |
| Six roles enforced in the backend | `src/core/rbac.ts` | LOCATE and Lost Mode only for Location Operator; Super Admin cannot see location; nobody can change their own role |
| Device registry, rename and assign (`PATCH /admin/devices/{id}`) | `updateDevice` | New devices show as **Unnamed device**; every change is audited with before and after values |
| Enrolment token (15-min TTL, single use), install page `/e/{token}`, QR | `createEnrollment`, `installPage`, `pages/Enrol.tsx` | The QR holds the Android device-owner provisioning JSON with an `ADMIN_EXTRAS_BUNDLE` (server URL, token, server-key pin). The sideload APK link is labelled *testing only*. Tokens are stored only as hashes |
| `POST /v1/enroll`: device ID plus client certificate | `enroll` | The key pair is generated on the device. The CA signs an Ed25519 certificate, and the agent checks the server key against the pin from the QR |
| Device authentication (mutual TLS equivalent) | `authenticateDevice` | Each request needs the CA-issued certificate and a signature over method, path, timestamp, nonce and body hash. A 5-minute window and nonce tracking block replays. Wiping a device revokes it |
| Durable-Object relay with push wake | `src/core/relay.ts` | Per-device queue with serialised processing. The FCM/APNs wake is a stub behind a `PushProvider` interface and carries no command data |
| Signed commands (Ed25519, nonce, 10-min expiry, run once) | `src/core/commands.ts` | The agent rejects tampered, expired, replayed, wrong-device and future-dated commands, and commands with too long a lifetime |
| Append-only, hash-chained audit with a verify step and SIEM export | `src/core/audit.ts` | `hash = SHA-256(prev_hash + canonical(payload))`. Denied access is logged too |
| Location encrypted at rest, 30-day purge | `storeLocation`, `runRetention` | AES-256-GCM with the AAD bound to the record and device |
| Device policy | `updatePolicy` | Tier 3 location is off by default, needs a written justification, runs no more often than every 15 min and only in working hours (policy time zone). Security and network logging are hard-wired off |
| Transparency (non-negotiables 1–3) | `src/core/agent.ts`, `pages/Transparency.tsx` | Nothing can collect location until the notice is acknowledged. Every fix triggers a notification, and Tier 3 shows a persistent low-importance one. **The server discards any location that arrives without proof the notification was shown.** Employees get a self-service page listing every request |
| Four-eyes wipe | `issueCommand` / `approveCommand` | Needs a ticket, a reason, a typed confirmation and a different approver |
| Device simulator (Phase 1 task 6) | `pages/Simulator.tsx` | Phone mock-ups showing the notification shade, the Lost Mode screen and the notice screen, plus buttons that demonstrate tamper and replay rejection |

Not in this build: the Kotlin agent (Phase 3), iOS / NanoMDM (Phase 4) and the pen test (Phase 5). These need real devices, Apple and Google accounts, and a server.

## Try it

1. Open the site and pick a demo account. Type the live 6-digit code shown next to it (a demo authenticator).
2. **Device Admin** → *Add devices* → *Mint token + QR* → *Simulate a phone scanning this QR* → *Devices* → rename the **Unnamed device**.
3. *Device simulator* → tap **I understand** on the phone's notice screen.
4. Sign in as **Location Operator** → open the device → `LOCATE` with ticket `INC-1234` and a reason. The phone shows a notification, the result comes back through the relay, and you can view it on the map against a ticket.
5. Sign in as **Helpdesk**: LOCATE isn't offered, and the API refuses it anyway. **Auditor** → *Audit log* → *Verify hash chain*.

## Develop

```bash
npm ci
npm run dev          # http://localhost:5173
npm test             # 61 unit/integration tests (Vitest, real crypto)
npm run build
npm run test:e2e     # drives the production build in Chromium at phone size (18 checks)
npm run check        # all of the above
```

Stack: React 19, TypeScript, Vite, React Router (hash routing for Pages), `@noble/ed25519`, `@noble/hashes` and WebCrypto, and `qrcode`. There are no runtime network calls and no third-party scripts, and a strict CSP is injected at build time.

## Deploy (GitHub Pages)

1. Merge to `main`.
2. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions** (one-time).
3. `.github/workflows/pages.yml` runs the type-check, unit tests, build and E2E, then deploys `dist/`.

`ci.yml` runs on every PR: `npm audit`, the type-check, the tests, the build, E2E and CodeQL (SAST).

## Production path

The UI only calls the `Backend` methods, which map one to one onto the routes in spec §3.3. To go live:

1. Put the same contract in a Hono Worker (`/api`), using D1 for tables, KV for sessions, a `DeviceRelay` Durable Object per device, Queues plus a cron for the purge, and R2 for the APK.
2. Move the keys to Workers Secrets/KMS, replace the request-signature check with real mTLS (Cloudflare API Shield client certificates), and replace TOTP with OIDC SSO through Cloudflare Access.
3. Swap the in-browser `Backend` for an HTTP client. The pages stay as they are.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and [docs/GOVERNANCE.md](docs/GOVERNANCE.md) for the privacy and governance review.
