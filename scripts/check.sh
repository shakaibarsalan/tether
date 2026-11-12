#!/bin/bash
# Check that Tether's protection still holds (macOS). See check.mjs.
#
#   scripts/check.sh                  print the checks; exit 1 if something needs attention
#   scripts/check.sh --hook           for a Claude Code SessionStart hook: silent while all
#                                     holds, a JSON warning when something changed
#   scripts/check.sh --install-hook   add that SessionStart hook to ~/.claude/settings.json
#   scripts/check.sh --remove-hook    take it out again

set -uo pipefail
source "$(dirname "$0")/lib/common.sh"

case "${1:-}" in
  --install-hook|--remove-hook)
    need_node
    undo=(); [ "$1" = --remove-hook ] && undo=(--undo)
    "$NODE" "$TETHER_SCRIPTS/lib/claude-settings.mjs" check-hook --script "$TETHER_SCRIPTS/check.sh" ${undo[@]+"${undo[@]}"} || exit 1
    if [ "$1" = --install-hook ]; then say 'The check now runs at the start of every Claude Code session.'; else say 'Check hook removed.'; fi
    exit 0 ;;
esac

if ! NODE="$(find_node)"; then
  # A SessionStart hook must never fail loudly; say it once, as a hook message.
  if [ "${1:-}" = --hook ]; then
    printf '{"systemMessage":"Tether check: Node.js was not found, so the check did not run."}'
    exit 0
  fi
  die 'Node.js 20.19 or newer is needed: https://nodejs.org'
fi
exec "$NODE" "$TETHER_SCRIPTS/check.mjs" "$@"
