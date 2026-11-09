# Mob Hunter Android apps

| Module | Package | What it is |
|---|---|---|
| `agent` | `com.mobhunter.agent` | Device-owner agent, minSdk 30, **no launcher icon**. Installed only through device-owner provisioning |
| `console` | `com.mobhunter.console` | Admin console app: a hardened WebView. It bundles the web console for offline demo use, or connects to your server |

## Build

You need JDK 17–21 and the Android SDK (platform 36, build-tools 36). Build the web console first, because the console APK bundles `../dist`.

```bash
npm ci && npm run build            # in the repository root
cd android
./gradlew :agent:testDebugUnitTest :agent:assembleRelease :console:assembleRelease
```

The outputs are `agent/build/outputs/apk/release/agent-release.apk` and `console/build/outputs/apk/release/console-release.apk`.

### Release signing

Without these environment variables, release APKs are signed with the **debug key**. That is fine for evaluation, but **never for production**:

```bash
keytool -genkeypair -v -keystore mob-hunter-release.jks -alias mob-hunter -keyalg EC -groupname secp256r1 -validity 9125
export MH_KEYSTORE_PATH=$PWD/mob-hunter-release.jks MH_KEYSTORE_PASSWORD=… MH_KEY_ALIAS=mob-hunter MH_KEY_PASSWORD=…
```

In GitHub Actions, add the repository secrets `MH_KEYSTORE_BASE64` (`base64 -w0 mob-hunter-release.jks`), `MH_KEYSTORE_PASSWORD`, `MH_KEY_ALIAS` and `MH_KEY_PASSWORD`. Keep the keystore offline and backed up. If it is lost, every enrolled device has to be re-enrolled before it can take agent updates.

### Built-in server

`MH_SERVER_URL=https://… ./gradlew :console:assembleRelease` (or `-PmhServerUrl=`) builds the console app connected to your server, with demo mode hidden. `pages.yml` does this with the live server URL.

### Published APKs

`releases/android/` holds the current release-signed APKs and `SHA256SUMS.txt`. Signer: `CN=Mob Hunter Agent, O=Falcon 98 Corporation`, certificate SHA-256 `006c3014…6b87`. Provisioning checksum: `AGwwFGMsyDDzIquB8gN_uFlyFiwPD5ml7tnCxFeKa4c`. `pages.yml` publishes these when the signing secrets aren't set. After a rebuild with the key, replace them.

### Provisioning checksum

```bash
ANDROID_HOME=… scripts/signature-checksum.sh agent/build/outputs/apk/release/agent-release.apk
```

Put the output in `APK_SIGNATURE_CHECKSUM` in `wrangler.toml`. Android refuses to install an agent whose signing certificate doesn't match it.

## Enrolling a phone (device owner)

1. Make sure the release-signed agent is published at `APK_DOWNLOAD_URL` (by default GitHub Pages: `https://mob-hunter.github.io/downloads/mob-hunter-agent.apk`).
2. In the console, go to **Add devices → Mint token + QR**.
3. Factory-reset the phone. On the Welcome screen, **tap six times**, connect to Wi-Fi and scan the QR.
4. Android downloads the agent from `APK_DOWNLOAD_URL`, checks its signature checksum and makes it device owner.
5. The agent's **policy-compliance screen** runs inside Setup. It generates the Keystore key, enrols, checks the server key against the pin in the QR, and shows the notice. Nothing is collected until the employee taps **I understand**.
6. The phone appears in the console as **Unnamed device**. Rename it and assign it to an employee.

## Enrolling a personal or test phone (no factory reset)

For a phone that cannot be factory-reset, such as your own phone during a pilot, use **standard enrolment**:

1. Install the agent from the download page (QR code or **Download APK**). It appears in the launcher as **Mob Hunter**.
2. In the console, go to **Add devices → Mint token + QR**. Then scan the **Personal or test phone** QR with the phone's camera. It encodes a `mobhunter://enrol?server=…&token=…&pin=…` link that opens the app. Alternatively, open the install link on the phone and tap **Open in the Mob Hunter app**, or paste the install link into the app.
3. The app enrols with the same one-time token and server-key pin as the company QR. It then asks for:
   - notifications;
   - location (choose **Allow all the time** so a lost phone can still be found);
   - optionally, remote lock (device admin).
4. Read the notice and tap **I understand**. The phone appears in the console, marked **Standard**, with the permissions the user granted.

A standard enrolment is not device owner, so:
- policy cannot be enforced;
- **wipe, reboot and silent app installs are refused**, both by the server and by the phone itself;
- remote lock works only if the user allowed it.

Health, ticketed LOCATE, Lost Mode tracking (the full-screen lock is best effort) and auto-uninstall on delete all work. Without push (FCM) configured, the phone checks in every 15 minutes, which is Android's minimum for background work. A LOCATE can therefore take up to 15 minutes to arrive. Opening the app and tapping **Sync now** delivers it at once.

## What the agent does

| Area | Implementation |
|---|---|
| Identity | P-256 key in the Android Keystore (StrongBox where present). It signs every request (`X-MH-*` headers) over method, path, timestamp, nonce and SHA-256 of the body |
| Commands | Verifies the server's Ed25519 signature (Google Tink) over the exact signed string. Checks device ID, ≤10-minute lifetime, expiry, clock skew, and replay (persisted IDs and nonces) |
| Wake | FCM data message `{type: wake}` → expedited WorkManager sync. Without FCM, it syncs every 15 minutes and on boot |
| Policy | DevicePolicyManager: no factory reset, USB transfer, unknown sources or debugging; password complexity, auto-lock, update window, location kept on, the agent's own permissions granted. Security and network logging are **forced off** |
| Location | Tier 1 `getCurrentLocation` (high accuracy, 30 s, falls back to last known with its age). Tier 2 Lost Mode every 5 min. Tier 3 every ≥15 min in working hours (policy time zone). Each tier runs only after its notification is posted, and the notification timestamp is sent with the fix |
| Lost Mode | Full-screen lock-task screen with the message and phone number. It survives reboot and exits only when the server ends Lost Mode |
| Active tracking (lost/stolen incident) | The interval (60–300 s) and end time come inside the signed LOST_MODE_ON, and the phone stops at the end time by itself. The persistent notice says "tracked every N min until …". Below 15% battery the phone slows to every 5 minutes (`Tracking.kt`, mirrored by `src/core/tracking.ts` and tested on both sides). While tracking, the phone checks in every 2 minutes so "found" and changed limits arrive quickly without push |
| Install | Downloads an approved catalogue APK over HTTPS, checks its SHA-256, then installs it silently with PackageInstaller |
| Wipe | Reports success first, destroys the key and config, then calls `wipeDevice`/`wipeData` |
| Release (device deleted in the console) | Reports success first. Then it clears every user restriction, lock task, password complexity, auto-lock and the update window, stops its service and scheduled work, and erases its key and config. It tells the employee the phone is no longer managed, gives up device owner (`clearDeviceOwnerApp`) and deactivates its admin, then uninstalls itself with `PackageInstaller.uninstall`. A device-owner app can't uninstall itself while it is an admin, so ownership is released first. Where Android asks the user to confirm, the system prompt is shown, and offered again from a notification. The employee's data is not touched |
| Not present | No remote shell, screen capture or accessibility service. No SMS, contacts, call log, media or storage permissions |

## Interop test (agent ↔ real server)

`scripts/interop.sh` starts the Worker in `workerd` with fresh storage and runs `InteropTest` on the JVM. The test drives the agent's **real** `ApiClient` and `CommandVerifier` through the whole flow: enrolment with the server-key pin, DER-signed requests over raw-body hashes, check-in with acknowledgement, a signed LOCATE verified with Tink, tamper and replay rejection, the location result, the audit chain, and rejection of a forged key. CI runs it on every pull request. A software P-256 key stands in for the Keystore key; both produce the same DER `SHA256withECDSA` signatures.

## Not yet verified

These APKs compile, their unit tests and the interop test above pass, and they are checked with `apksigner`/`aapt2`. The Android-only parts have **not** been run on a phone or emulator yet, because no device was available. Those parts are the provisioning screens, DevicePolicyManager calls, Keystore, FusedLocation, notifications, Lost Mode lock task and PackageInstaller. Run the pilot checklist in `docs/DEPLOYMENT.md` on real hardware before rollout. Play Integrity is reported as `NOT_EVALUATED` until you connect a Google Cloud project.
