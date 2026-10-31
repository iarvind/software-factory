#!/usr/bin/env bash
# Install/uninstall the launchd agent so the factory survives reboots and crashes.
#
#   ops/launchd.sh install     render ops/launchd/com.factory.web.plist and bootstrap it
#   ops/launchd.sh uninstall
#   ops/launchd.sh status
#
# The unit runs `node server/index.ts` with a PATH that can find node, git, gh, the claude
# CLI (and codex/gemini when present), and HOME so claude finds its login.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
LABEL=com.factory.web

path_for_unit() {
  local p="/usr/bin:/bin:/usr/sbin:/sbin" bin dir
  for bin in node claude codex gemini gh git docker go python3 pytest pnpm yarn bun cargo uv make; do
    dir=$(command -v "$bin" 2>/dev/null || true)
    [ -n "$dir" ] || continue
    dir=$(dirname "$dir")
    case ":$p:" in *":$dir:"*) ;; *) p="$dir:$p" ;; esac
  done
  # The usual homes of user-installed tools, whether or not one is installed yet.
  for dir in "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin "$HOME/.cargo/bin" "$HOME/go/bin"; do
    [ -d "$dir" ] || continue
    case ":$p:" in *":$dir:"*) ;; *) p="$dir:$p" ;; esac
  done
  echo "$p"
}

case ${1:-} in
  install)
    mkdir -p "$AGENTS" data/logs data/run
    [ -f web/dist/index.html ] || { echo "web/dist missing — run ops/deploy.sh first (npm run build)" >&2; exit 1; }
    sed -e "s|__ROOT__|$ROOT|g" -e "s|__NODE__|$(command -v node)|g" -e "s|__PATH__|$(path_for_unit)|g" -e "s|__HOME__|$HOME|g" \
      "ops/launchd/$LABEL.plist" > "$AGENTS/$LABEL.plist"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    pid=$(lsof -t -iTCP:"${PORT:-8282}" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pid" ]; then echo "stopping process on :${PORT:-8282} (pid $pid)"; kill "$pid" 2>/dev/null || true; sleep 1; fi
    launchctl bootstrap "$DOMAIN" "$AGENTS/$LABEL.plist"
    echo "installed $LABEL" ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$AGENTS/$LABEL.plist"
    echo "removed $LABEL" ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "$LABEL: installed ($(launchctl print "$DOMAIN/$LABEL" | awk '/state =/ {print $3; exit}'))"
    else echo "$LABEL: not installed"; fi ;;
  *) echo "usage: ops/launchd.sh install|uninstall|status" >&2; exit 2 ;;
esac
