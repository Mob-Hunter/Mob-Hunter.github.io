#!/usr/bin/env bash
# Prints PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM for an APK:
# URL-safe base64 (no padding) of the SHA-256 of its signing certificate.
# Usage: scripts/signature-checksum.sh agent/build/outputs/apk/release/agent-release.apk
set -euo pipefail
APK="${1:?usage: $0 <apk>}"
BT="${ANDROID_HOME:?set ANDROID_HOME}/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)"
HEX=$("$BT/apksigner" verify --print-certs "$APK" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
[ -n "$HEX" ] || { echo "could not read signing certificate" >&2; exit 1; }
python3 -c "import base64,sys; print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).decode().rstrip(\"=\"))" "$HEX"
