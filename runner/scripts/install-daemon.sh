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

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "installed: $PLIST_DEST"
echo "logs: $RUNNER_DIR/.valet-runner.log"
echo "check status: launchctl list | grep com.valet.runner"
echo "uninstall: launchctl unload $PLIST_DEST && rm $PLIST_DEST"
