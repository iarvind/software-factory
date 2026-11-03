#!/usr/bin/env bash
# The one deploy command for the software factory (make deploy).
#
# Steps: shared postgres up → database "factory" ensured → npm ci if needed → typecheck →
# vite build → restart the launchd unit (or start with nohup until `make launchd-install`
# has run) → health check. Idempotent. A deploy interrupts running agent sessions: they
# are marked interrupted on boot and the items parked as blocked, ready to retry.
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORM_DIR=${PLATFORM_DIR:-$(cd .. && pwd)/dashboard/platform}
PORT=${PORT:-8282}
DOMAIN="gui/$(id -u)"
LABEL=com.factory.web
mkdir -p data/logs data/run data/repos data/work

step() { printf '\n==> %s\n' "$*"; }
wait_http() { # <url> <seconds>
  for _ in $(seq 1 $(($2 * 2))); do
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$1" || true)
    [ "$code" = 200 ] && return 0
    sleep 0.5
  done
  return 1
}

[ -f .env ] || { echo ".env missing — cp .env.example .env, then set DATABASE_URL from: $PLATFORM_DIR/db.sh url factory" >&2; exit 1; }
set -a; source .env; set +a

step "shared postgres (platform, 127.0.0.1:5432)"
docker compose -f "$PLATFORM_DIR/compose.yml" up -d --wait postgres
"$PLATFORM_DIR/db.sh" ensure | grep -E '^(database|role) factory' || true

step "dependencies"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then npm ci; else echo "node_modules up to date"; fi

step "typecheck"
npm run -s typecheck

step "build"
npm run -s build

step "server (:$PORT)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  stray=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$stray" ] && ! launchctl print "$DOMAIN/$LABEL" | grep -q "pid = $stray"; then echo "stopping non-launchd process on :$PORT (pid $stray)"; kill "$stray" 2>/dev/null || true; sleep 1; fi
  launchctl kickstart -k "$DOMAIN/$LABEL"
  wait_http "http://127.0.0.1:$PORT/api/healthz" 30 || { tail -30 data/logs/web.log >&2; exit 1; }
  echo "restarted (launchd-managed)"
else
  pid=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pid" ] && { kill "$pid" 2>/dev/null || true; sleep 1; }
  NODE_ENV=production nohup node --disable-warning=ExperimentalWarning --env-file-if-exists=.env server/index.ts >> data/logs/web.log 2>&1 &
  echo $! > data/run/web.pid
  wait_http "http://127.0.0.1:$PORT/api/healthz" 30 || { tail -30 data/logs/web.log >&2; exit 1; }
  echo "started (pid $(cat data/run/web.pid)) — run 'make launchd-install' so it survives reboots"
fi

printf '\nDEPLOYED %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo '?') $(date '+%Y-%m-%d %H:%M:%S')"
echo "app:   http://127.0.0.1:$PORT"
echo "logs:  data/logs/web.log"
