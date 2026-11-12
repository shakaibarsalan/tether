#!/bin/bash
# Double-click in Finder: block Anthropic's browser bridge in /etc/hosts, so
# Claude sessions on other computers can't drive this Mac's Chrome.
cd "$(dirname "$0")" || exit 1
/bin/bash scripts/bridge-block.sh
echo
read -r -p 'Press Enter to close this window.' _
