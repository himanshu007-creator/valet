#!/bin/bash
# Quick answer to "is VALET actually watching my Mac right now" — checks the daemon's real
# launchd state (not just whether a plist file exists) and what the last connection event in
# its own log says.
set -euo pipefail
RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.valet.runner.plist"
LOG="$RUNNER_DIR/.valet-runner.log"
UID_NUM="$(id -u)"

if [ ! -f "$PLIST" ]; then
  echo "daemon: NOT INSTALLED — run runner/scripts/install-daemon.sh"
  exit 1
fi

# launchctl print exits non-zero when the service isn't registered at all — under `set -e`
# with a pipe, that silently killed this whole script with no output (reproduced live). "|| true"
# so a genuinely-not-loaded daemon falls through to the NOT RUNNING branch below instead.
STATE=$(launchctl print "gui/$UID_NUM/com.valet.runner" 2>/dev/null | awk -F'= ' '/^\tstate = /{print $2}' || true)
if [ "$STATE" = "running" ]; then
  echo "daemon: running"
else
  echo "daemon: NOT RUNNING (state: ${STATE:-not loaded}) — run runner/scripts/start.sh"
  exit 1
fi

if [ -f "$LOG" ]; then
  LAST=$(grep -E "^(connected to server|disconnected)" "$LOG" | tail -1)
  case "$LAST" in
    "connected to server") echo "connection: CONNECTED to the server" ;;
    disconnected*) echo "connection: DISCONNECTED — reconnecting (should self-heal within seconds; if it doesn't, try start.sh)" ;;
    *) echo "connection: no connection events logged yet (daemon just started?)" ;;
  esac
else
  echo "connection: no log file yet"
fi
