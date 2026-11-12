#!/bin/bash
# Start connect-watch.mjs at every login, in the background (macOS).
#
# Adds a LaunchAgent for your user (no sudo) that runs scripts/connect-watch.mjs,
# and starts it now. The watcher logs the program behind each "Allow?" prompt
# from Chrome's remote debugging to ~/.tether/connect-watch.log, and shows a
# notification when ~/.tether/config.json says { "notifications": true }.
#
#   scripts/connect-watch-setup.sh            install and start
#   scripts/connect-watch-setup.sh --status   running? last log lines
#   scripts/connect-watch-setup.sh --undo     remove

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

undo=0; status=0
while [ $# -gt 0 ]; do
  case "$1" in
    --undo) undo=1 ;;
    --status) status=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

need_macos
LOG="$TETHER_HOME/connect-watch.log"

if [ "$status" = 1 ]; then
  if [ -f "$(agent_plist connect-watch)" ]; then
    if agent_running connect-watch; then say "LaunchAgent $(agent_label connect-watch): running"; else say "LaunchAgent $(agent_label connect-watch): installed, not running"; fi
  else
    say 'The connect watch is not installed.'
  fi
  if [ -f "$LOG" ]; then say ''; say "Last lines of $LOG:"; tail -n 8 "$LOG" | sed 's/^/  /'; fi
  exit 0
fi

if [ "$undo" = 1 ]; then
  agent_unload connect-watch
  rm -f "$(agent_plist connect-watch)"
  say 'Connect watch removed.'
  exit 0
fi

need_node
write_agent connect-watch "$TETHER_HOME/connect-watch.out.log" "$NODE" "$TETHER_SCRIPTS/connect-watch.mjs"
agent_load connect-watch

for _ in $(seq 1 20); do
  sleep 0.5
  if agent_running connect-watch; then
    say "Connect watch installed and running. It starts at every login. Log: $LOG"
    exit 0
  fi
done
warn "The LaunchAgent is loaded but the watcher isn't running. Run: $0 --status"
exit 1
