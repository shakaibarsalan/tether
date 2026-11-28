#!/bin/bash
# Tell every Claude Code session how the browser works here, at its start.
#
# Adds hooks/session-start.mjs to ~/.claude/settings.json as a SessionStart hook
# (a new chat, a fork, a resumed chat, /clear, compaction). Each session then
# knows to use Tether's chrome-devtools tools and never the Claude in Chrome
# extension (or to ask you to reconnect it), how tabs work, and your Chrome
# profiles: which one has the Tether extension, where its new tabs open.
# Also denies the extension's tools (mcp__claude-in-chrome), so no chat keeps
# trying them. Backs up settings.json.
#
#   scripts/session-start.sh           install
#   scripts/session-start.sh --undo    remove (the hook and the deny rule)
#   --claude-dir DIR

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

need_node
undo=0
for a in "$@"; do [ "$a" = --undo ] && undo=1; done
# The full path of node goes into the hook: Claude's app has a short PATH.
"$NODE" "$TETHER_SCRIPTS/lib/claude-settings.mjs" session-start --node "$NODE" "$@"
if [ "$undo" = 1 ]; then
  say 'Session start hook removed; the Claude in Chrome tools are no longer denied.'
else
  say 'Every new Claude Code session now starts knowing how the browser works here.'
  if [ ! -f "$TETHER_HOME/chrome/profiles.json" ]; then
    say 'For your Chrome profiles to be part of that: scripts/port-mirror-setup.sh (it sets up tether-chrome-profiles).'
  fi
fi
