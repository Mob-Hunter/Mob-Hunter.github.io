# Mob Hunter desktop agent (Windows, Linux, macOS)

A single static Go binary that manages a computer with the same signed protocol as the Android agent:

- **Device key:** Ed25519, generated on the computer and certified by the server's CA at enrolment.
- **Signed requests:** every request is signed over `METHOD\nPATH\nTS\nNONCE\nSHA-256(body)`.
- **Verified commands:** commands are verified against the server key pinned from the enrolment link. Each one must be no more than 10 minutes old, addressed to this device, and never seen before.

## What it does

| | Windows | Linux | macOS |
|---|---|---|---|
| Inventory | model, serial, OS, storage, battery | same | same |
| Security posture | BitLocker, firewall, Defender real-time protection, Secure Boot, last hotfix, pending updates | LUKS, ufw / firewalld / nftables, Secure Boot, last package update, pending updates | FileVault, application firewall, System Integrity Protection, pending updates |
| MESSAGE | `msg.exe` to every session | `notify-send` in each graphical session, plus `wall` | Notification Center |
| LOCK | locks the active session | `loginctl lock-sessions` | display sleep (locks) |
| REBOOT (service mode) | `shutdown /r /t 60` | `shutdown -r +1` | `shutdown -r +1` |
| SYNC_POLICY, RELEASE | yes | yes | yes |
| Background service | scheduled task at boot as SYSTEM | systemd unit | launch daemon |

The command set is closed. There is no shell, no file access, no screen capture, and no app or browsing inventory. Run `mob-hunter-agent posture` to print exactly what the computer reports.

LOCATE, Lost Mode, RING, app installs and WIPE are phone-only. The server refuses them for computers before signing.

## Install

In the console, open **Add devices → Computer** and copy the command for the OS. It downloads the agent and runs `enrol` with the one-time link, which installs the service:

```
mob-hunter-agent enrol 'mobhunter://enrol?server=…&token=…&pin=…' [--accept-notice] [--no-service]
mob-hunter-agent status | posture | sync | acknowledge | uninstall | version
```

Binaries and `SHA256SUMS-desktop.txt` are published under `/downloads` with the site.

## Build and test

```
go test ./...                                  # verifier, link parsing, config
GOOS=windows go vet ./... && GOOS=darwin go vet ./...
./interop.sh                                   # real client against the Worker in workerd
./build.sh out/ 1.0.0                          # all six binaries + checksums
```
