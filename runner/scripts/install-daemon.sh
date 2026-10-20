#!/bin/bash
# Installs the VALET runner as a real macOS background service via launchd, so it survives
# this chat session ending, crashes (KeepAlive restarts it), and reboots (RunAtLoad).
set -euo pipefail

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$RUNNER_DIR/scripts/valet-runner.plist.template"
PLIST_DEST="$HOME/Library/LaunchAgents/com.valet.runner.plist"
NODE_BIN="$(command -v node)"

if [ ! -f "$RUNNER_DIR/.env" ]; then
  echo "error: $RUNNER_DIR/.env is missing — copy .env.example and fill it in first" >&2
  exit 1
fi

sed -e "s#__NODE_BIN__#$NODE_BIN#g" -e "s#__RUNNER_DIR__#$RUNNER_DIR#g" -e "s#__USER_PATH__#$PATH#g" "$PLIST_SRC" > "$PLIST_DEST"

# bootstrap/bootout, not load/unload — the legacy subcommands print spurious I/O errors and
# can silently leave the daemon unloaded on modern macOS (confirmed in production use).
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/com.valet.runner" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DEST"

echo "installed: $PLIST_DEST"
echo "logs: $RUNNER_DIR/.valet-runner.log"
echo "check status: npm run daemon:status --workspace=runner"
echo "start/restart: npm run daemon:start --workspace=runner"
echo "stop: npm run daemon:stop --workspace=runner"
