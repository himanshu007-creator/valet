#!/bin/bash
# Stops the VALET runner daemon. It won't restart on its own or on reboot until you run
# start.sh again — this is a real stop, not a pause.
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.valet.runner.plist"
UID_NUM="$(id -u)"

if [ ! -f "$PLIST" ]; then
  echo "not installed — nothing to stop"
  exit 0
fi

launchctl bootout "gui/$UID_NUM/com.valet.runner" 2>/dev/null || true
echo "stopped. Any job already running on your Mac keeps running (opencode isn't tied to the" \
  "runner process) — it just won't be tracked or reported until you start the runner again."
