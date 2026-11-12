#!/bin/bash
# Remove the Tether guard hook from this Mac: only its own entries in Claude
# Code's settings (after a backup) and its files. Everything else stays.
#
#   scripts/guard-uninstall.sh [--claude-dir DIR]

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

claude_dir="$HOME/.claude"
[ "${1:-}" = --claude-dir ] && claude_dir="${2:?}"

need_node
if [ -f "$claude_dir/settings.json" ]; then
  "$NODE" "$TETHER_SCRIPTS/lib/claude-settings.mjs" guard --undo --claude-dir "$claude_dir" || exit 1
fi
rm -f "$claude_dir/hooks/chrome_browser_guard.py" "$claude_dir/hooks/chrome_browser_guard.ps1" "$claude_dir/hooks/chrome-allowed-devices.txt"
rm -rf "$claude_dir/hooks/chrome-guard-state"
say 'Guard removed. Start a new Claude Code session for it to take effect.'
