#!/usr/bin/env bash
# Runs the agent's real ApiClient + CommandVerifier against the Mob Hunter Worker
# in workerd (fresh storage). Requires: npm ci && npm run build in the repo root,
# ANDROID_HOME set. Usage: android/scripts/interop.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8797}"
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
cd android
MH_INTEROP_URL="http://127.0.0.1:$PORT" MH_INTEROP_BOOTSTRAP="$TOKEN" ./gradlew --no-daemon :agent:testDebugUnitTest --tests '*InteropTest*' --rerun-tasks
grep -q 'skipped="0"' agent/build/test-results/testDebugUnitTest/TEST-com.mobhunter.agent.InteropTest.xml || { echo "InteropTest was skipped" >&2; exit 1; }
echo "Agent <-> server interop: passed"
