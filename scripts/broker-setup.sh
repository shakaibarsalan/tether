#!/bin/bash
# Click "Allow?" once per Chrome start, not once per Claude session (macOS).
#
# Sets up the Tether broker (broker/tether-broker.mjs):
#   1. installs its one dependency (ws, pinned in broker/package-lock.json);
#   2. adds a LaunchAgent for your user that starts it at login, and starts it
#      now (no sudo);
#   3. re-registers Claude Code's chrome-devtools server to connect to the broker
#      (ws://127.0.0.1:9333) instead of straight to Chrome.
#
# The broker connects to Chrome once; Chrome asks "Allow?". After that, Claude
# Code sessions get in without a prompt, but only chrome-devtools-mcp started by
# a Claude desktop session whose Claude Code and Claude.app are both signed by
# Anthropic (Developer ID, checked with codesign). Anything else is refused and
# logged in ~/.tether/broker.log.
#
#   scripts/broker-setup.sh            install, start at login, point Claude Code at it
#   scripts/broker-setup.sh --status   Chrome connected? which sessions are in?
#   scripts/broker-setup.sh --undo     back to "Allow?" per session

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

undo=0; status=0; port=9333
while [ $# -gt 0 ]; do
  case "$1" in
    --undo) undo=1 ;;
    --status) status=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

need_macos
LOG="$TETHER_HOME/broker.log"

broker_status() { curl -s --max-time 3 "http://127.0.0.1:$port/status" 2>/dev/null; }

if [ "$status" = 1 ]; then
  if [ -f "$(agent_plist broker)" ]; then
    if agent_running broker; then say "LaunchAgent $(agent_label broker): running"; else say "LaunchAgent $(agent_label broker): installed, not running"; fi
  else
    say 'The broker LaunchAgent is not installed.'
  fi
  s="$(broker_status || true)"
  if [ -n "$s" ]; then say "Broker: $s"; else say "Broker is not answering on 127.0.0.1:$port."; fi
  if [ -f "$LOG" ]; then say ''; say "Last lines of $LOG:"; tail -n 10 "$LOG" | sed 's/^/  /'; fi
  exit 0
fi

if [ "$undo" = 1 ]; then
  agent_unload broker
  rm -f "$(agent_plist broker)"
  # a broker started by hand from this folder, without --port (test brokers always pass one)
  pkill -f "$TETHER_REPO/broker/tether-broker.mjs\$" 2>/dev/null || true
  /bin/bash "$TETHER_SCRIPTS/devtools-setup.sh"
  say 'Broker removed. New Claude Code sessions connect straight to Chrome again (Allow? per session).'
  exit 0
fi

need_node
say 'Installing the broker dependency (ws, pinned) ...'
(cd "$TETHER_REPO/broker" && npm_cmd ci --omit=dev --no-audit --no-fund >/dev/null 2>&1) || die 'npm ci failed in broker/'

write_agent broker "$TETHER_HOME/broker.out.log" "$NODE" "$TETHER_REPO/broker/tether-broker.mjs"
agent_load broker

up=''
for _ in $(seq 1 30); do
  sleep 0.5
  up="$(broker_status || true)"
  [ -n "$up" ] && break
done
[ -n "$up" ] || { warn "The LaunchAgent is loaded but the broker isn't answering. Run: $0 --status"; exit 1; }

say 'Pointing Claude Code at the broker ...'
/bin/bash "$TETHER_SCRIPTS/devtools-setup.sh" --broker --broker-port "$port"

say ''
good 'Broker running. It starts at every login.'
say 'Chrome asks "Allow?" once now (for "Tether"). Click Allow.'
say 'After that, new Claude Code sessions use Chrome without asking. Open sessions: start them again.'
say "Log: $LOG"
