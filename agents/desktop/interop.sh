#!/usr/bin/env bash
# Runs the desktop agent's real client, verifier and command loop (fake OS layer) against the
# Mob Hunter Worker in workerd with fresh storage. Requires: npm ci && npm run build in the repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8798}"
TOKEN="interop-$(date +%s)-$RANDOM"
STATE="$(mktemp -d)"
LOG="$STATE/wrangler.log"
cd "$ROOT"
setsid npx wrangler dev --port "$PORT" --ip 127.0.0.1 --persist-to "$STATE" \
  --var "PUBLIC_URL:http://127.0.0.1:$PORT" --var INSECURE_DEV_COOKIES:true --var "BOOTSTRAP_TOKEN:$TOKEN" >"$LOG" 2>&1 &
WPID=$!
cleanup() { kill -- -"$WPID" 2>/dev/null || true; rm -rf "$STATE"; }
trap cleanup EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { cat "$LOG"; exit 1; }
cd agents/desktop
MH_INTEROP_URL="http://127.0.0.1:$PORT" MH_INTEROP_BOOTSTRAP="$TOKEN" go test -count=1 -run TestInteropWithRealServer -v ./... | tee "$STATE/go.log"
grep -q -- '--- PASS: TestInteropWithRealServer' "$STATE/go.log" || { echo "Interop test did not pass (skipped?)" >&2; exit 1; }
echo "Desktop agent <-> server interop: passed"
