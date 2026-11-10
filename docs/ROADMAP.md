# Mob Hunter: feature roadmap against the MDM / UEM market

This plan compares Mob Hunter with the capabilities that today's leading device-management products offer, and sets out the order in which to close the gaps.

The comparison covers these products:

| Product | Category |
|---|---|
| Microsoft Intune | Unified endpoint management (UEM) |
| VMware / Omnissa Workspace ONE | UEM |
| IBM MaaS360 | UEM |
| Ivanti | UEM |
| SOTI MobiControl | UEM |
| ManageEngine Endpoint Central / MDM Plus | UEM |
| Hexnode | UEM |
| Scalefusion | UEM |
| Jamf Pro | Apple-first management |
| Kandji | Apple-first management |
| Mosyle | Apple-first management |
| Google Endpoint Management | Android / Chrome |
| Esper | Android / Chrome |

Every phase keeps Mob Hunter's non-negotiables:

- Employees are always told what is collected, and get a notification every time.
- There is no silent location. Location is only collected against a ticket, and every access is audited.
- Commands are signed and expire after 10 minutes.
- There is no remote shell, screen capture, or access to messages, photos, files or browsing.
- Location data is encrypted and deleted after 30 days.

Where a market feature conflicts with these rules, the feature is marked **out of scope by design**.

Legend:

- ✅ done
- 🟡 partial
- ⬜ not started
- ⛔ out of scope by design

## 1. Where Mob Hunter stands today

| Capability domain | Market baseline | Mob Hunter |
|---|---|---|
| **Enrolment** | QR / zero-touch Android, Apple ADE, Windows Autopilot, agent installers, BYOD work profile | ✅ Android QR, both company (device owner) and existing phone. ✅ One-line Windows, Linux and macOS agent install. ⬜ Android work profile (BYOD). ⬜ Apple ADE. ⬜ Autopilot. |
| **Inventory** | Hardware, OS, disks, network, software, certificates, battery, compliance | ✅ Full inventory on Windows, Linux, macOS and Android, plus fleet software search. ⬜ Certificates. ⬜ Warranty lookup. |
| **Check-in and sync** | Configurable intervals, push wake | ✅ Console-set intervals (org, group, device). ✅ FCM wake. ⬜ APNs (iOS). |
| **Remote actions** | Lock, wipe, reboot, message, locate, lost mode, ring, app install and uninstall | ✅ All on Android. ✅ Lock, message, reboot and inventory on computers. ⬜ Remote wipe for computers (BitLocker / FileVault key escrow first). |
| **Policies and restrictions** | Passcode, camera, screenshots, Bluetooth, Wi-Fi, USB, VPN, Wi-Fi profiles, kiosk | ✅ Passcode, camera, screenshots, Bluetooth, users and Wi-Fi lock on Android. ⬜ Wi-Fi / VPN / email profiles. ⬜ Kiosk / single-app mode. ⬜ Computer policies (password, firewall, BitLocker / FileVault enforcement). |
| **App management** | Catalogue, silent install, updates, blocklist, managed configuration, VPP | 🟡 Signed catalogue with silent install and uninstall on Android. ⬜ App updates and version pinning. ⬜ Managed Google Play. ⬜ Computer software deployment (MSI / PKG / DEB). ⬜ Blocklist. |
| **Patch management** | OS update policies, deferrals, third-party patching | 🟡 Patch level and pending updates reported; threat rules on patch age. ⬜ Update rings / deferrals. ⬜ Scheduled install windows on computers. |
| **Security and threat defence** | Compliance rules, conditional access, MTD (root/jailbreak, risky networks), risk scores | ✅ Threat landscape: 18 rules, risk scores, accepted risk, remediation. ✅ Compliance view. ⬜ Custom compliance rules. ⬜ Conditional access (IdP integration). |
| **Encryption key escrow** | BitLocker / FileVault recovery keys | ⬜ |
| **Certificates and identity** | SCEP / PKCS, Wi-Fi / VPN certificates, SSO | 🟡 Device certificates for the agent channel; Cloudflare Access SSO for the console. ⬜ SCEP for user and device certificates. |
| **Location and lost devices** | Locate, lost mode, geofencing, history | ✅ Ticketed locate, lost/stolen incidents, active tracking. ⬜ Geofencing alerts (opt-in, work hours only). |
| **Remote support** | Remote control, screen view, file transfer, remote shell | ⛔ Screen view, remote shell and file transfer: out of scope by design. ⬜ Consent-based assist: employee-initiated, time-boxed, with a visible banner. |
| **Reporting** | Dashboards, scheduled reports, exports, audit | ✅ Command center, threat landscape, inventory CSV, tamper-evident audit log. ⬜ Scheduled e-mailed reports. ⬜ Custom report builder. |
| **Administration** | RBAC, MFA, SSO, multi-tenant, API, webhooks | ✅ Six-role RBAC, TOTP MFA, SSO, four-eyes wipe, SIEM webhook. ⬜ Scoped admins (by group or site). ⬜ Public REST API with tokens. ⬜ Multi-tenant MSP mode. |
| **Platforms** | Android, iOS / iPadOS, macOS, Windows, Linux, ChromeOS | ✅ Android, Windows, Linux, macOS. ⬜ iOS / iPadOS (needs APNs MDM certificate). ⬜ ChromeOS. |
| **Agent operations** | Proper services, logs, self-update, health | ✅ Windows service with Event Log, systemd unit, launch daemon, rotating logs. ⬜ Signed self-update. ⬜ Agent health dashboard. |

## 2. Plan, step by step

Each step ships on its own, behind tests, through a PR with CI on all platforms. The real-OS service test runs on Windows, macOS and Linux machines. Each step ends with the same definition of done:

- Tests at every level are green.
- The Help guide is updated, and the README if anything changed.
- The employee notice is bumped if collection changes.
- The change is deployed and verified on the live site.

### Phase 1: Foundations for computers (this release)
1. ✅ **Proper Windows service.**
   - Runs as LocalSystem with automatic, delayed start.
   - The Service Control Manager restarts it on failure.
   - Logs to the Event Log and to rotating log files.
   - `install-service` upgrades the 1.x scheduled task.
2. ✅ **Full inventory on every platform**, with Inventory tabs on each device page, a fleet software search page, and the `COLLECT_INVENTORY` command.
3. ✅ **Console-controlled check-in frequency.**
4. ⬜ **Signed agent self-update.**
   - The agent downloads the new build and verifies its SHA-256 against a signed release manifest from the server.
   - It swaps the binary and restarts the service.
   - The console shows agent versions and has an "Update agents" action.
   - *Tests:* manifest signature, downgrade refusal, rollback on failed start.

### Phase 2: Computer policy and protection
5. ⬜ **Disk encryption enforcement and key escrow.**
   - Turn on BitLocker or FileVault from the console.
   - Escrow the recovery key, encrypted at rest.
   - Show a key only against a ticket, audited, with four-eyes approval like wipe.
6. ⬜ **Computer configuration policies**, applied by the agent and reported back as compliant or non-compliant:
   - password and screen-lock requirements;
   - firewall on;
   - Defender real-time protection on;
   - automatic updates on;
   - USB storage blocked;
   - guest account and auto-login off.
7. ⬜ **Patch management.**
   - Update rings with deferral days.
   - Maintenance windows.
   - "Install updates now" command.
   - Per-ring compliance.
8. ⬜ **Software deployment for computers.**
   - Catalogue entries for MSI, MSIX, PKG and DEB/RPM, with SHA-256 checking.
   - Silent install and uninstall.
   - Version pinning and "update to latest".
   - Results reported per device.
9. ⬜ **Remote wipe for computers.** Only once key escrow exists:
   - Windows: the "Reset this PC" CSP.
   - macOS: Erase All Content and Settings.
   - Linux: a crypto-erase of the LUKS header.
   - Ticket plus four-eyes approval, as on phones.

### Phase 3: Mobile depth
10. ⬜ **Android work profile (BYOD).** Personal and work data are separated, and only the work profile is managed. This is the most privacy-friendly enrolment.
11. ⬜ **Managed Google Play** with managed app configuration and silent updates.
12. ⬜ **Wi-Fi, VPN and e-mail profiles.** Credentials come from SCEP-issued certificates, never passwords in QR codes.
13. ⬜ **Kiosk / dedicated-device mode.** Single app or multi-app launcher with lock-task.
14. ⬜ **iOS / iPadOS through Apple MDM.**
    - Prerequisites: an APNs MDM certificate, Apple Business Manager, and SCEP / ACME identity.
    - Scope: enrolment profile, check-in and command server, DeviceInformation, SecurityInfo, DeviceLock, EraseDevice, InstallApplication and restrictions.

### Phase 4: Security operations
15. ⬜ **Custom compliance rules.** Build rules from inventory and posture fields, with actions: notify, message, lock, or mark non-compliant.
16. ⬜ **Conditional access.** Publish compliance to the identity provider (Entra ID, Okta, Google) so non-compliant devices are blocked from company apps.
17. ⬜ **Geofencing alerts.** Opt-in, work hours only, with the same notification rules as location.
18. ⬜ **Consent-based remote assist.** The employee starts it, it is time-limited, a banner is always visible, and it is audited. No silent screen access, ever.

### Phase 5: Scale and integration
19. ⬜ **Scoped administrators.** Limit an admin to sites or groups.
20. ⬜ **Public REST API** with scoped tokens, plus outbound webhooks for every event, and ServiceNow / Jira ticket links.
21. ⬜ **Scheduled reports** (PDF / CSV by e-mail) and a custom report builder.
22. ⬜ **Multi-tenant MSP mode.**
23. ⬜ **ChromeOS** through the Chrome Enterprise API.

## 3. How each step is tested before it is deployed

| Layer | What runs | Where |
|---|---|---|
| Core rules | Vitest unit tests: backend, RBAC, threats, inventory, sync | CI |
| HTTP API | Hono routes in workerd: auth, CSRF, signed device requests | CI |
| Console | Playwright E2E in demo and server modes, axe WCAG 2.1 AA, 390 px layout, CSP | CI |
| Android agent | Kotlin unit tests, plus interop with the real Worker | CI (`android/scripts/interop.sh`) |
| Desktop agent | Go unit tests on Windows, macOS and Linux, plus interop with the real Worker | CI (`agents/desktop/interop.sh`) |
| Desktop service | Real install on Windows, macOS and Linux machines: service running, Event Log / logs, inventory, commands from the service loop, release and uninstall | CI (`e2e/desktop-service.mjs`) |
| Release | Signed APKs (cert pinned), checksummed binaries, downloads index | Pages build |
| Production | Health check, new screens present, downloads verified against their checksums | After every deploy |
