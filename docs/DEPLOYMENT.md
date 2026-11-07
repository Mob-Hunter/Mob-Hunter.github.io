# Deploying Mob Hunter to production

Do this only after the governance gate in [GOVERNANCE.md](GOVERNANCE.md#go-live-gate) is met.

## 1. Cloudflare server

You need a Cloudflare account. The Workers Paid plan is recommended, because PBKDF2 sign-in needs more CPU time than the free tier allows.

```bash
npm ci
npx wrangler login
```

Edit `wrangler.toml` `[vars]`:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | The HTTPS origin, e.g. `https://fleet.example.com`. Use a custom domain on the Worker |
| `APK_DOWNLOAD_URL` | HTTPS URL of the release-signed agent APK that Android downloads during QR provisioning. Default: `https://mob-hunter.github.io/downloads/mob-hunter-agent.apk` (published by `pages.yml`) |
| `APK_SIGNATURE_CHECKSUM` | Output of `android/scripts/signature-checksum.sh` for your **release-signed** agent APK |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Optional. Enables "Sign in with company SSO" through Cloudflare Access |
| `FCM_CLIENT_CONFIG` | Optional. Firebase client options so agents can receive push wakes |

Set the secrets. They are never committed:

```bash
npx wrangler secret put BOOTSTRAP_TOKEN        # long random string; only used to create the first Super Admin
npx wrangler secret put FCM_SERVICE_ACCOUNT    # optional: Firebase service-account JSON (push wakes)
npx wrangler secret put SIEM_WEBHOOK_SECRET    # optional: HMAC key for audit forwarding
```

Build with the production URLs, then deploy:

```bash
VITE_SERVER_URL=https://mob-hunter.inbox-ashen.workers.dev VITE_DOWNLOADS_URL=https://mob-hunter.github.io/downloads npm run build
npx wrangler deploy
```

For CI deploys, add the repository secrets `CLOUDFLARE_API_TOKEN` (a token with *Workers Scripts: Edit*) and `CLOUDFLARE_ACCOUNT_ID`. `deploy-worker.yml` then deploys on every push to `main` and checks `/api/health`. If you move to your own domain, set the repository variable `MOBHUNTER_SERVER_URL` and `PUBLIC_URL` to match.

Open `PUBLIC_URL`. The console shows **Set up Mob Hunter**. Enter the bootstrap token and create the first Super Admin, then scan the authenticator QR. After that, bootstrap is permanently disabled.

### Recommended hardening

- Put the console behind **Cloudflare Access** (SSO + MFA) for `/` and `/api/admin/*`. Leave `/api/v1/*`, `/api/e/*` and `/api/transparency/*` reachable by devices.
- Turn on **WAF rate limiting** for `/api/admin/login`, `/api/admin/mfa` and `/api/v1/enroll`. These are already rate-limited inside the Worker, but adding an edge limit too means two layers of protection.
- Optionally, add **API Shield mTLS** for `/api/v1/*`. The agent's signed requests already prove possession of the device key; mTLS adds a second, transport-level check.
- Use Cloudflare **data localisation** or regional services where your DPIA requires them.

### How the server is built

- `worker/index.ts` routes `/api/*` to one `TenantDO` Durable Object and serves the console, which is embedded in the script at build time by `scripts/embed-assets.mjs`. Security headers (CSP, HSTS, frame-ancestors, no-referrer) are set in `worker/index.ts`.
- `TenantDO` runs the same `Backend` that is unit-tested, on SQLite-backed Durable Object storage (`worker/sqlstore.ts`). The audit log is an append-only table, and the rest of the state is stored as JSON chunks. A Durable Object processes one request at a time, so commands and audit appends happen in strict order. An hourly alarm and a daily cron run the 30-day purge.
- **Scale:** one Durable Object per organisation comfortably serves pilot and mid-size fleets (low thousands of devices). Beyond that, shard the per-device relay into one Durable Object per device, as the spec suggests. The `DeviceRelay` class is already isolated for that.

## 2. Android

See [android/README.md](../android/README.md): set up a release keystore, build, compute the signature checksum, upload the APK, then enrol with the QR.

## 3. Pilot checklist

- [ ] Enrol 10–20 test phones across two OEMs. Run LOCATE, Lost Mode, LOCK, WIPE (four-eyes) and INSTALL_APP.
- [ ] Verify the audit chain; export it to the SIEM.
- [ ] Confirm the 30-day purge (it shows in the audit log as `location.purged`).
- [ ] Rehearse the runbooks: lost or stolen device, leaver (Employees → Offboard, then wipe or retire), non-compliant device, suspected misuse (Security reviews `location.viewed`).
- [ ] External penetration test with no open high or critical findings.
