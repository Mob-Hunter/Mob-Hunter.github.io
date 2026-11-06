# FleetGuard Android apps

| Module | Package | What it is |
|---|---|---|
| `agent` | `com.fleetguard.agent` | Device-owner agent, minSdk 30, **no launcher icon**. Installed only through device-owner provisioning |
| `console` | `com.fleetguard.console` | Admin console app: a hardened WebView. It bundles the web console for offline demo use, or connects to your server |

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
keytool -genkeypair -v -keystore fleetguard-release.jks -alias fleetguard -keyalg EC -groupname secp256r1 -validity 9125
export FG_KEYSTORE_PATH=$PWD/fleetguard-release.jks FG_KEYSTORE_PASSWORD=… FG_KEY_ALIAS=fleetguard FG_KEY_PASSWORD=…
```

In GitHub Actions, add the repository secrets `FG_KEYSTORE_BASE64` (`base64 -w0 fleetguard-release.jks`), `FG_KEYSTORE_PASSWORD`, `FG_KEY_ALIAS` and `FG_KEY_PASSWORD`. Keep the keystore offline and backed up. If it is lost, every enrolled device has to be re-enrolled before it can take agent updates.

### Provisioning checksum

```bash
ANDROID_HOME=… scripts/signature-checksum.sh agent/build/outputs/apk/release/agent-release.apk
```

Put the output in `APK_SIGNATURE_CHECKSUM` in `wrangler.toml`. Android refuses to install an agent whose signing certificate doesn't match it.

## Enrolling a phone (device owner)

1. Upload the release APK to R2 (see `docs/DEPLOYMENT.md`).
2. In the console, go to **Add devices → Mint token + QR**.
3. Factory-reset the phone. On the Welcome screen, **tap six times**, connect to Wi-Fi and scan the QR.
4. Android downloads the agent from `/api/apk/<version>`, checks its signature checksum and makes it device owner.
5. The agent's **policy-compliance screen** runs inside Setup. It generates the Keystore key, enrols, checks the server key against the pin in the QR, and shows the notice. Nothing is collected until the employee taps **I understand**.
6. The phone appears in the console as **Unnamed device**. Rename it and assign it to an employee.

A sideloaded agent (installed from the APK link) is an ordinary app without device-owner rights. It is for developer testing only.

## What the agent does

| Area | Implementation |
|---|---|
| Identity | P-256 key in the Android Keystore (StrongBox where present). It signs every request (`X-FG-*` headers) over method, path, timestamp, nonce and SHA-256 of the body |
| Commands | Verifies the server's Ed25519 signature (Google Tink) over the exact signed string. Checks device ID, ≤10-minute lifetime, expiry, clock skew, and replay (persisted IDs and nonces) |
| Wake | FCM data message `{type: wake}` → expedited WorkManager sync. Without FCM, it syncs every 15 minutes and on boot |
| Policy | DevicePolicyManager: no factory reset, USB transfer, unknown sources or debugging; password complexity, auto-lock, update window, location kept on, the agent's own permissions granted. Security and network logging are **forced off** |
| Location | Tier 1 `getCurrentLocation` (high accuracy, 30 s, falls back to last known with its age). Tier 2 Lost Mode every 5 min. Tier 3 every ≥15 min in working hours (policy time zone). Each tier runs only after its notification is posted, and the notification timestamp is sent with the fix |
| Lost Mode | Full-screen lock-task screen with the message and phone number. It survives reboot and exits only when the server ends Lost Mode |
| Install | Downloads an approved catalogue APK over HTTPS, checks its SHA-256, then installs it silently with PackageInstaller |
| Wipe | Reports success first, destroys the key and config, then calls `wipeDevice`/`wipeData` |
| Not present | No remote shell, screen capture or accessibility service. No SMS, contacts, call log, media or storage permissions |

## Not yet verified

These APKs compile, their unit tests pass, and they are checked with `apksigner`/`aapt2`. They have **not** been run on a physical phone in this environment, because no device or emulator was available. Run the pilot checklist in `docs/DEPLOYMENT.md` on real hardware before rollout. Play Integrity is reported as `NOT_EVALUATED` until you connect a Google Cloud project.
