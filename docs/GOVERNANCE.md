# Governance and privacy review

This review covers the build specification (*Build prompt — company device management service*). It is engineering guidance, not legal advice, so have your DPO or counsel confirm it for your jurisdiction. The same content appears in the app under **Privacy & governance**.

Reference law: Sri Lanka **Personal Data Protection Act No. 9 of 2022** (PDPA). The spec plans go-live around its obligations, so check the operative dates with counsel. The same principles apply under GDPR and similar laws.

## Findings and how to overcome them

### 1. Employee location tracking (High)
**Risk.** Location is personal data. Monitoring staff is lawful only if it is necessary, proportionate, transparent and has a documented legal basis. An employee's consent is rarely freely given, so don't rely on it.
**Overcome it.**
- Complete and sign a **DPIA** before any real enrolment. Record the legal basis (legitimate interest or contract) and the balancing test.
- Limit the **purpose** to recovering lost or stolen devices and documented safety programmes. Never use location for performance, attendance or disciplinary monitoring.
- Keep **Tier 3 continuous location off by default**. Enable it per device only with a written justification tied to the DPIA, and only during working hours.
- Consult staff or unions where required, and publish the policy before rollout.

**Built in:** LOCATE needs a ticket and a reason, and viewing results needs a ticket. Tier 3 is off by default, needs a justification, runs no more often than every 15 min, only in working hours (in the policy's time zone), and always shows a persistent notification.

### 2. "Headless" agent with no launcher icon (High)
**Risk.** An icon-less app that collects location looks like stalkerware. If it hides itself, it can breach transparency duties and Android/Google policy.
**Overcome it.** Never suppress Android's managed-device disclosure, the OS location indicator or the per-fix notification. Put a link to a self-service transparency page in every notification. Block collection until the employee has acknowledged the notice.
**Built in:** no setting or code path suppresses notifications. The server **discards any location that arrives without proof that the notification was shown** and logs it as `security.silent_location_blocked`. Location can't be requested until the notice is acknowledged.

### 3. Insider misuse by administrators (High)
**Risk.** A console that can locate or wipe phones can be abused, for example to follow a colleague.
**Overcome it.** Segregate duties. Require four-eyes approval for destructive actions. Have Security review location-access reports every month. Write misuse into the disciplinary policy.
**Built in:** only the Location Operator can locate, and the Super Admin can't see location. Wipes need a second, different approver, and nobody can change their own role. Every action and every denied attempt is written to a hash-chained audit log, and changing a role revokes that person's sessions.

### 4. Remote wipe and personal data (High)
**Risk.** Company phones often still hold personal photos and messages, which a wipe destroys.
**Overcome it.** Either ban personal use or use a work profile. Require a ticket, a reason and a second approver. Tell the employee unless the theft is confirmed.
**Built in:** a wipe needs a ticket, a reason, a typed `WIPE` confirmation and a different approver.

### 5. Cross-border transfers: Cloudflare, FCM, APNs (Medium)
**Overcome it.** Sign DPAs with Cloudflare, Google and Apple. Use Cloudflare data localisation (Regional Services, D1 location hints) where you can. Keep personal data out of push payloads. Record every transfer in the DPIA and the privacy notice.
**Built in:** a push wake carries no command or personal data. The device pulls commands over its own authenticated channel.

### 6. Retention and data-subject rights (Medium)
**Overcome it.** Purge location automatically after 30 days and keep audit records for 1 year. Set up a DSAR (access request) process with the DPO.
**Built in:** location is stored encrypted with AES-256-GCM and purged after 30 days. The employee transparency page shows every request and every stored fix for their device.

### Device deletion and the right to erasure
Deleting a device record erases its command history and encrypted location data, which supports storage limitation and erasure requests. The append-only audit log is kept, with a snapshot of the deleted record, the reason and the actor, because accountability requires it. State this in the privacy notice.
**Built in:** only Super Admin or Device Admin can delete. The device must already be retired or wiped, and deletion needs a reason plus a typed `DELETE`.

### Releasing a phone when it is deleted
Deleting an active device returns the phone to the employee as an unmanaged phone with the agent uninstalled. Make sure that is the intended outcome: for a company phone being returned, or one that might hold company data, **wipe** it instead.
**Built in:** release needs Super Admin or Device Admin, a reason and a typed `DELETE`. The employee is told the phone is no longer managed, and the request, the phone's confirmation and the deletion are all audited. A pending release can be cancelled. If your policy demands it, add a second approver as is already done for WIPE; the hook is `DUAL_CONTROL` in `src/core/rbac.ts`.

### Active tracking of lost or stolen devices
High-frequency tracking is the most intrusive location feature, so it is tightly bounded.
**Built in:**
- Location Operator only, with a ticket and a written justification.
- At most 72 hours at a time. The end time is signed into the command and enforced by the phone itself, and every extension needs a reason and is audited.
- The employee sees a persistent notice saying how often and until when.
- Low battery slows tracking to 5 minutes.
- Fixes are filed under the incident's ticket. Live viewing sessions are audited.
- The incident closes automatically if Lost Mode ends or the phone is wiped, retired or deleted.
- For stolen phones the console warns staff to share the location with the police rather than attempt recovery themselves; tell staff this in your runbook too.

### Purpose limitation for location views
Viewing location under ticket X should show the fixes collected for ticket X, not everything.
**Built in:** "Only fixes recorded under this ticket" is on by default. Lost Mode fixes are filed under the ticket that turned Lost Mode on. Widening a view is a deliberate choice, and the audit row records which filter was used.

### 7. Agent APK signing key = control of every phone (High)
**Risk.** Whoever holds the agent's signing key can ship an "update" that every enrolled device-owner phone will accept.
**Overcome it.** Generate the release keystore offline. Store it in a hardware security module or an offline vault with two named custodians, and give CI access only through encrypted secrets (`MH_KEYSTORE_*`). Never use the debug-signed evaluation APKs on staff phones. Record the key's fingerprint in the DPIA.
**Built in:** release signing reads only from CI secrets. The provisioning QR pins the signing-certificate checksum, so Android refuses an agent signed with any other key. CI warns loudly when it falls back to debug signing.

### 8. Admin console on a phone (Medium)
**Risk.** Someone who finds an unlocked admin phone could act as that administrator.
**Overcome it.** Use SSO with MFA and short sessions. Enrol the admins' own phones in Mob Hunter with a screen lock enforced. Revoke sessions from *Users & access* when a phone is lost.
**Built in:** the console APK is locked to one origin, has backup disabled and allows HTTPS only. Sessions are HttpOnly cookies that expire after 30 minutes idle and 12 hours in total, and can be revoked centrally.

### 9. SIEM forwarding and DSAR exports carry personal data (Medium)
**Overcome it.** Forward the audit log only to a SIEM covered by your DPA and retention policy. Have DSAR exports go through the DPO.
**Built in:** webhooks must be HTTPS and are HMAC-signed. Only the Security role can produce a DSAR export, it needs a ticket, and every export is audited.

### 10. Hosting on GitHub Pages (Medium)
**Risk.** GitHub Pages is static, public hosting. It can't keep secrets, terminate mutual TLS, send pushes or run scheduled jobs. A backend that runs in the browser isn't a trust boundary, because the visitor controls it.
**Overcome it.** Use the Pages build only for demos, training and acceptance testing, with **no real data**. Production runs on the included Cloudflare Worker (`worker/`, see [DEPLOYMENT.md](DEPLOYMENT.md)), with keys in Workers Secrets and the console behind **Cloudflare Access** (SSO + MFA).

### 11. Wi-Fi credentials in the QR (Low)
A photo of the QR would leak the password. Use an open or captive setup SSID instead. **Built in:** only the SSID can be added.

### 12. iOS location expectations (Low)
Supervised iPhones expose location only through Managed Lost Mode. Never claim background tracking for them.

## Go-live gate (before any real employee device)
- [ ] DPIA signed and legal basis recorded
- [ ] Device-use policy published, staff consulted, acknowledgements collected
- [ ] DPAs and transfer safeguards for Cloudflare, FCM and APNs
- [ ] Backend on Cloudflare with keys in Secrets/KMS, console behind Cloudflare Access
- [ ] Agent release keystore generated offline, custodians named, `APK_SIGNATURE_CHECKSUM` set; no debug-signed APK on staff phones
- [ ] External pen test with zero open high/critical findings
- [ ] Runbooks rehearsed: lost/stolen, leaver, non-compliant, suspected misuse
- [ ] Monthly Security review of the location-access audit, and a DSAR process
