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

### 7. Hosting on GitHub Pages (Medium)
**Risk.** GitHub Pages is static, public hosting. It can't keep secrets, terminate mutual TLS, send pushes or run scheduled jobs. A backend that runs in the browser isn't a trust boundary, because the visitor controls it.
**Overcome it.** Use the Pages build for the UI, demos, training and acceptance testing, with **no real data**. Run production on Cloudflare Workers and Durable Objects with keys in Secrets/KMS, and put the console behind **Cloudflare Access** (SSO + MFA), not a public `github.io` URL.

### 8. Wi-Fi credentials in the QR (Low)
A photo of the QR would leak the password. Use an open or captive setup SSID instead. **Built in:** only the SSID can be added.

### 9. iOS location expectations (Low)
Supervised iPhones expose location only through Managed Lost Mode. Never claim background tracking for them.

## Go-live gate (before any real employee device)
- [ ] DPIA signed and legal basis recorded
- [ ] Device-use policy published, staff consulted, acknowledgements collected
- [ ] DPAs and transfer safeguards for Cloudflare, FCM and APNs
- [ ] Backend on Cloudflare with keys in Secrets/KMS, console behind Cloudflare Access
- [ ] External pen test with zero open high/critical findings
- [ ] Runbooks rehearsed: lost/stolen, leaver, non-compliant, suspected misuse
- [ ] Monthly Security review of the location-access audit, and a DSAR process
