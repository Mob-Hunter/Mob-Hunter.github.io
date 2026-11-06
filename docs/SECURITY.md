# Security model and threat model

## Trust boundaries
| Boundary | Production (Cloudflare Worker + Android agent) | Demo (GitHub Pages / offline console APK) |
|---|---|---|
| Admin → API | Password (PBKDF2, 100k iterations) + TOTP, or Cloudflare Access SSO. HttpOnly, Secure, SameSite=Strict session cookie plus the `x-fleetguard-csrf` header. Per-IP and per-account rate limits | The same backend logic, running in the browser. An opaque session ID is held in `sessionStorage` |
| Device → API | P-256 key in the Android Keystore. CA-issued certificate plus a per-request ECDSA signature over method, path, ts, nonce and SHA-256(raw body). 5-minute window, nonce tracking, revocation on wipe or retire. HTTPS only. Optional API Shield mTLS | The simulator uses Ed25519 keys and the same signature scheme |
| Server → device | Ed25519 signature over the exact `signed` string (nonce, ≤10-minute expiry, run once). The agent pins the key's fingerprint from the QR | Identical |
| Push | FCM data message `{type: wake}` only, with no command or personal data | Simulated wake |
| Data at rest | Durable Object SQLite. The audit log is an append-only table. Location is AES-256-GCM encrypted | `localStorage`. **The key is stored alongside the data, so this protection is for demonstration only** |
| Keys | Generated inside the Durable Object on first start and never exported by any API. Agent signing key kept offline (see android/README.md) | Generated per browser |

## Threats and controls
| Threat | Control | Test |
|---|---|---|
| Forged or tampered command | Ed25519 signature over the canonical payload, checked against the pinned key | `tests/commands.test.ts`, E2E step 13 |
| Replayed command | Seen-ID and nonce sets persisted on the device | `commands.test.ts`, E2E step 13 |
| Stale command | 10-minute expiry, enforced by both the relay and the device; a lifetime over 10 min is rejected | `commands.test.ts`, `backend.test.ts` |
| Impersonated device | CA-signed certificate that must match the device record, request signature, 5-minute window, nonce tracking, revocation on wipe | `backend.test.ts › device authentication` |
| Rogue server or MITM at enrolment | Server key fingerprint pinned in the provisioning QR | `backend.test.ts › pin mismatch` |
| Stolen or reused enrolment token | 15-min TTL, single use, burnt before any other check, stored only as a SHA-256 hash, rate-limited | `backend.test.ts › Phase 2` |
| Credential stuffing | PBKDF2-SHA256 (100k iterations on Workers, 210k in the demo), lockout after 5 failures, MFA, constant-work hashing for unknown users, rate limit | `backend.test.ts › admin authentication` |
| Privilege misuse | Server-side RBAC on every call, separation of duties, four-eyes wipe, ticket-linked location access | `rbac.test.ts`, `backend.test.ts` |
| Silent tracking | The server rejects any fix without notification proof; Tier 3 only in working hours | `backend.test.ts › privacy` |
| Audit tampering | SHA-256 hash chain; verify reports the first broken row; export records the chain head | `audit.test.ts`, `backend.test.ts › audit` |
| XSS / script injection | React escaping, a strict CSP (`script-src 'self'`), labels that reject `<>`, no `dangerouslySetInnerHTML`, no third-party scripts | E2E step 17 |
| Data leakage via referrer or tiles | `referrer: no-referrer`; an SVG map with no tile requests | — |
| CSRF / clickjacking | SameSite=Strict cookie plus a required custom header; `frame-ancestors 'none'` and `X-Frame-Options: DENY` | `tests/worker-http.test.ts`, server E2E |
| Rogue app pushed to devices | INSTALL_APP limited to the approved catalogue; the agent checks the SHA-256 before installing | `worker-http.test.ts › app catalogue` |
| Malicious agent update | The provisioning QR pins the signing-certificate checksum; the release key is held offline | android/README.md |
| CSV formula injection | Exported cells starting with `= + - @` are neutralised | `tests/csv.test.ts` |
| Session theft | HttpOnly cookie; sessions revoked on role change, disable, MFA reset or password change; 30-minute idle expiry | `worker-http.test.ts`, `enterprise.test.ts` |

## Agent capability limits (non-negotiable 6)
The agent's command set is closed: LOCATE, LOST_MODE_ON/OFF, LOCK, WIPE, SYNC_POLICY, INSTALL_APP and REBOOT. It rejects anything else. There is no remote shell, no screen capture, and no access to messages, photos or browsing.

## Reporting
Please report vulnerabilities privately to the repository owner. Don't open a public issue.
