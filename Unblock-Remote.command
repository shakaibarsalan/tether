#!/bin/bash
# Double-click in Finder: remove Tether's bridge block from /etc/hosts.
cd "$(dirname "$0")" || exit 1
/bin/bash scripts/bridge-block.sh --undo
echo
read -r -p 'Press Enter to close this window.' _
