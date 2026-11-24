#!/bin/bash
# Newer Chrome on macOS keeps its data folder private: only Chrome, and programs you
# allow, can read it. The broker and the connect watch need one small file from it
# (DevToolsActivePort: the debugging port, no secrets). This builds a tiny program
# that copies just that file to ~/.tether/chrome/ every 2 seconds and runs it as a
# LaunchAgent. You give Full Disk Access to that one program, not to node.
#
#   scripts/port-mirror-setup.sh            build, install and start it
#   scripts/port-mirror-setup.sh --status   is it running, can it read the file?
#   scripts/port-mirror-setup.sh --undo     remove it
#
# Rebuilding changes the program, and macOS then asks for the permission again,
# so an existing build is kept (--rebuild to force one).
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

undo=0; status=0; rebuild=0
while [ $# -gt 0 ]; do
  case "$1" in
    --undo) undo=1 ;;
    --status) status=1 ;;
    --rebuild) rebuild=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

need_macos
NAME=port-mirror
BIN="$TETHER_HOME/bin/tether-port-mirror"
LOG="$TETHER_HOME/port-mirror.log"
COPY="$TETHER_HOME/chrome/DevToolsActivePort"
CHROME_FILE="$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"

allowed() { [ -f "$LOG" ] && ! tail -n 1 "$LOG" | grep -q 'no permission'; }

if [ "$status" = 1 ]; then
  if [ -f "$(agent_plist $NAME)" ]; then
    if agent_running $NAME; then say "LaunchAgent $(agent_label $NAME): running"; else say "LaunchAgent $(agent_label $NAME): installed, not running"; fi
  else
    say 'The port mirror is not installed.'
  fi
  if [ -f "$COPY" ]; then good "Copy of Chrome's port file: $COPY (port $(head -n 1 "$COPY"))"; else say "No copy yet ($COPY): Chrome closed, remote debugging off, or no permission."; fi
  if [ -f "$LOG" ]; then say ''; say "Last lines of $LOG:"; tail -n 5 "$LOG" | sed 's/^/  /'; fi
  exit 0
fi

if [ "$undo" = 1 ]; then
  if [ -f "$(agent_plist $NAME)" ]; then agent_unload $NAME; rm -f "$(agent_plist $NAME)"; fi
  rm -f "$BIN" "$COPY" "$COPY.tmp"
  rmdir "$TETHER_HOME/chrome" 2>/dev/null || true
  say 'Port mirror removed. You can also take tether-port-mirror out of Full Disk Access in System Settings.'
  exit 0
fi

need_node   # write_agent puts node's folder on the agent's PATH, like the other agents
if [ ! -x "$BIN" ] || [ "$rebuild" = 1 ]; then
  command -v clang >/dev/null 2>&1 || die 'clang is needed to build it: run  xcode-select --install  and try again.'
  mkdir -p "$(dirname "$BIN")"
  clang -O2 -Wall -o "$BIN" "$TETHER_REPO/mac/port-mirror.c" || die 'Building the port mirror failed.'
  say "Built $BIN"
fi

write_agent $NAME "$LOG" "$BIN"
agent_load $NAME
sleep 3

if [ -f "$COPY" ]; then
  good "Port mirror running. Chrome's port file is copied to $COPY."
elif allowed; then
  good 'Port mirror running. It copies the port file as soon as Chrome turns remote debugging on.'
else
  warn 'One step left: give the port mirror (only it) permission to read that file.'
  say  '  1. System Settings opens at Privacy & Security > Full Disk Access.'
  say  '  2. Click +, press Cmd+Shift+G, paste the path below, click Open, and switch it on:'
  note "     $BIN"
  say  '  3. Then run:  scripts/port-mirror-setup.sh --status'
  open 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles' 2>/dev/null \
    || open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles' 2>/dev/null || true
fi
