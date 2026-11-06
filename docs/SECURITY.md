# Security model and threat model

## Trust boundaries
| Boundary | Production (Cloudflare) | This GitHub Pages build |
|---|---|---|
| Admin → API | OIDC SSO with MFA through Cloudflare Access; server-side sessions in KV | Password (PBKDF2) plus TOTP; sessions held in backend state, and the browser keeps only an opaque ID in `sessionStorage` |
| Device → API | mTLS with client certificates (API Shield) plus server-certificate pinning | Ed25519 certificate from the device CA plus a per-request signature (method, path, ts, nonce, body hash); the agent pins the server key fingerprint from the QR |
| Server → device | Ed25519-signed commands (nonce, 10-min expiry, run once) | Identical |
| Data at rest | D1 plus AES-256-GCM for location (key in Secrets/KMS) | `localStorage` plus AES-256-GCM for location. **The key sits in the same storage, so this is a demonstration only** |
| Keys | Workers Secrets/KMS, never in code | Generated per browser on first run; none are committed to the repository |

## Threats and controls
| Threat | Control | Test |
|---|---|---|
| Forged or tampered command | Ed25519 signature over the canonical payload, checked against the pinned key | `tests/commands.test.ts`, E2E step 13 |
| Replayed command | Seen-ID and nonce sets persisted on the device | `commands.test.ts`, E2E step 13 |
| Stale command | 10-minute expiry, enforced by both the relay and the device; a lifetime over 10 min is rejected | `commands.test.ts`, `backend.test.ts` |
| Impersonated device | CA-signed certificate that must match the device record, request signature, 5-minute window, nonce tracking, revocation on wipe | `backend.test.ts › device authentication` |
| Rogue server or MITM at enrolment | Server key fingerprint pinned in the provisioning QR | `backend.test.ts › pin mismatch` |
| Stolen or reused enrolment token | 15-min TTL, single use, burnt before any other check, stored only as a SHA-256 hash, rate-limited | `backend.test.ts › Phase 2` |
| Credential stuffing | PBKDF2 210k, lockout after 5 failures, MFA, constant-work hashing for unknown users, rate limit | `backend.test.ts › admin authentication` |
| Privilege misuse | Server-side RBAC on every call, separation of duties, four-eyes wipe, ticket-linked location access | `rbac.test.ts`, `backend.test.ts` |
| Silent tracking | The server rejects any fix without notification proof; Tier 3 only in working hours | `backend.test.ts › privacy` |
| Audit tampering | SHA-256 hash chain; verify reports the first broken row; export records the chain head | `audit.test.ts`, `backend.test.ts › audit` |
| XSS / script injection | React escaping, a strict CSP (`script-src 'self'`), labels that reject `<>`, no `dangerouslySetInnerHTML`, no third-party scripts | E2E step 17 |
| Data leakage via referrer or tiles | `referrer: no-referrer`; an SVG map with no tile requests | — |

## Agent capability limits (non-negotiable 6)
The agent's command set is closed: LOCATE, LOST_MODE_ON/OFF, LOCK, WIPE, SYNC_POLICY, INSTALL_APP and REBOOT. It rejects anything else. There is no remote shell, no screen capture, and no access to messages, photos or browsing.

## Reporting
Please report vulnerabilities privately to the repository owner. Don't open a public issue.
