#!/bin/bash
# Undo install.sh on macOS: remove the broker, the DevTools MCP server, the
# connect watch and the bridge block.

set -uo pipefail
cd "$(dirname "$0")"
source scripts/lib/common.sh
need_macos

if [ -f "$(agent_plist broker)" ]; then
  agent_unload broker
  rm -f "$(agent_plist broker)"
  say 'Broker removed.'
fi
/bin/bash scripts/devtools-setup.sh --undo
/bin/bash scripts/connect-watch-setup.sh --undo
say ''
say 'Removing the bridge block (macOS will ask for your password) ...'
/bin/bash scripts/bridge-block.sh --undo
