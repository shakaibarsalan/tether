#!/bin/bash
# Set up Tether on macOS: local-only Chrome control for Claude Code, and no
# remote access.
#
#   1. scripts/devtools-setup.sh       Claude Code drives your real Chrome over
#                                      127.0.0.1 through chrome-devtools-mcp.
#   2. scripts/connect-watch-setup.sh  a background watcher (LaunchAgent) that
#                                      logs the program behind each "Allow?".
#   3. scripts/broker-setup.sh         with --broker: Chrome asks "Allow?" once
#                                      per Chrome start, not once per session.
#   4. scripts/bridge-block.sh         blocks Anthropic's hosted browser bridge in
#                                      /etc/hosts. Asks for your password (sudo).
#
#   ./install.sh [--broker] [--skip-devtools] [--skip-watch] [--skip-block]
#
# Run ./uninstall.sh to undo all of it.

set -euo pipefail
cd "$(dirname "$0")"
source scripts/lib/common.sh

skip_devtools=0; skip_watch=0; broker=0; skip_block=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-devtools) skip_devtools=1 ;;
    --skip-watch) skip_watch=1 ;;
    --broker) broker=1 ;;
    --skip-block) skip_block=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done
need_macos

if [ "$skip_devtools" = 0 ]; then
  /bin/bash scripts/devtools-setup.sh || die 'DevTools setup failed; the bridge was not blocked.'
  if [ "$skip_watch" = 0 ]; then
    say ''
    /bin/bash scripts/connect-watch-setup.sh || warn 'The connect watch did not start (the rest of the setup is fine).'
  fi
  if [ "$broker" = 1 ]; then
    say ''
    /bin/bash scripts/broker-setup.sh || warn 'The broker did not start; Claude Code still connects straight to Chrome.'
  fi
fi

if [ "$skip_block" = 0 ]; then
  say ''
  say 'Blocking the remote browser bridge (macOS will ask for your password) ...'
  /bin/bash scripts/bridge-block.sh
fi
