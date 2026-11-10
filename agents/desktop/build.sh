#!/usr/bin/env bash
# Cross-compiles the desktop agent for Windows, Linux and macOS (static, reproducible) and writes
# SHA256SUMS-desktop.txt. Usage: agents/desktop/build.sh <out-dir> [version]
set -euo pipefail
OUT="$(mkdir -p "${1:?out dir}" && cd "$1" && pwd)"
VERSION="${2:-1.0.0}"
cd "$(dirname "$0")"
for target in windows/amd64 windows/arm64 linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
  os="${target%/*}"; arch="${target#*/}"; ext=""; [ "$os" = windows ] && ext=".exe"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -buildvcs=false -ldflags "-s -w -X main.Version=$VERSION" \
    -o "$OUT/mob-hunter-agent-$os-$arch$ext" .
done
(cd "$OUT" && sha256sum mob-hunter-agent-* > SHA256SUMS-desktop.txt && cat SHA256SUMS-desktop.txt)
