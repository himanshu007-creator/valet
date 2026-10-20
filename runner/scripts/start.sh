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
sleep 1  # launchd needs a moment to fully release the service label after bootout, or the
         # immediately-following bootstrap can fail with a spurious "Input/output error"
         # (reproduced live: this bit us even after switching off the deprecated load/unload).

# retry once — same race can still occasionally need a second attempt
if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/tmp/valet-bootstrap-err; then
  echo "bootstrap failed, retrying once: $(cat /tmp/valet-bootstrap-err)" >&2
  sleep 2
  launchctl bootstrap "gui/$UID_NUM" "$PLIST"
fi
sleep 2
exec "$(dirname "${BASH_SOURCE[0]}")/status.sh"
