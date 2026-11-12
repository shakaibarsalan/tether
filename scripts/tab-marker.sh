#!/bin/bash
# Mark the Chrome tabs Claude Code is driving: a robot in the title, a thin orange
# frame and a small "Claude" badge (or, with the Tether extension, its tab group).
#
# Adds a PostToolUse hook to ~/.claude/settings.json. After each chrome-devtools
# action (navigate, new tab, click, type, ...), the hook runs
# hooks/claude-tab-marker.js in the tab Claude just used, through the same
# chrome-devtools MCP server. Other tabs are left alone, and nothing blocks
# clicks. Needs the server registered with --no-page-id-routing
# (devtools-setup.sh does that). Start a new Claude Code session afterwards.
#
#   scripts/tab-marker.sh           install
#   scripts/tab-marker.sh --undo    remove
#   --server NAME   --claude-dir DIR

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

need_node
undo=0
for a in "$@"; do [ "$a" = --undo ] && undo=1; done
"$NODE" "$TETHER_SCRIPTS/lib/claude-settings.mjs" tab-marker "$@"
if [ "$undo" = 1 ]; then say 'Tab marker removed.'; else say 'Tab marker installed. Start a new Claude Code session.'; fi
