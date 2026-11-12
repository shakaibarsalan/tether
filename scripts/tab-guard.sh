#!/bin/bash
# Keep Claude out of the tab you're using: it has to open its own.
#
# Adds hooks/tab-guard.mjs to ~/.claude/settings.json as a PreToolUse hook on
# every chrome-devtools tool and a PostToolUse hook on new_page. Claude can look
# at any tab, but before it navigates, clicks or types it has to open its own
# tab (new_page) or deliberately pick one (select_page). Picking or closing a tab
# it didn't open is refused once with the reason; Claude repeats the call only
# when you asked for that tab. Backs up settings.json.
#
#   scripts/tab-guard.sh           install
#   scripts/tab-guard.sh --undo    remove
#   --server NAME   --claude-dir DIR

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

need_node
undo=0
for a in "$@"; do [ "$a" = --undo ] && undo=1; done
# The full path of node goes into the hook: Claude's app has a short PATH.
"$NODE" "$TETHER_SCRIPTS/lib/claude-settings.mjs" tab-guard --node "$NODE" "$@"
if [ "$undo" = 1 ]; then say 'Tab guard removed.'; else say 'Tab guard installed. Claude now opens its own tab before acting.'; fi
