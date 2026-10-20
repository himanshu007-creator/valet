#!/bin/bash
# Starts (or restarts) the VALET runner daemon. Uses launchctl bootstrap/bootout, not the
# deprecated load/unload — those print spurious "Input/output error" on modern macOS and can
# silently leave the daemon unloaded despite exiting 0. bootstrap/bootout/print are the
# current, reliable API (confirmed: load/unload genuinely left this daemon down mid-session).
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.valet.runner.plist"
UID_NUM="$(id -u)"

if [ ! -f "$PLIST" ]; then
  echo "not installed yet — run runner/scripts/install-daemon.sh first" >&2
  exit 1
fi

launchctl bootout "gui/$UID_NUM/com.valet.runner" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
sleep 2
exec "$(dirname "${BASH_SOURCE[0]}")/status.sh"
