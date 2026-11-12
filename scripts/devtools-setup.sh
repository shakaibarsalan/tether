#!/bin/bash
# Let Claude Code drive your real Chrome over a local DevTools connection (macOS).
#
# Installs chrome-devtools-mcp (Google's official DevTools MCP server), pinned to
# one version, into ~/.tether/npm (no sudo, never changes under you), and
# registers it in Claude Code's user config with --autoConnect. Claude Code
# then attaches to the Chrome you already have open, with all your profiles and
# logins, over 127.0.0.1. Nothing goes through a Claude account, so nobody on
# another computer can use this path.
#
# After running this, turn on chrome://inspect/#remote-debugging in Chrome once.
# Chrome then asks "Allow?" each time a new Claude Code session connects.
#
#   scripts/devtools-setup.sh                       install and register (--autoConnect)
#   scripts/devtools-setup.sh --broker [--broker-port 9333]
#                                                   register with --wsEndpoint to the Tether broker
#   scripts/devtools-setup.sh --undo                unregister and uninstall
#   --version 1.12.0   --name chrome-devtools

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

version='1.12.0'; name='chrome-devtools'; broker=0; broker_port=9333; undo=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?}"; shift ;;
    --name) name="${2:?}"; shift ;;
    --broker) broker=1 ;;
    --broker-port) broker_port="${2:?}"; shift ;;
    --undo) undo=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

need_macos
PREFIX="$TETHER_HOME/npm"

# The "claude" command: on PATH, the native installer's place, or the Claude
# Code that the desktop app keeps (newest one).
find_claude() {
  local c
  for c in "${TETHER_CLAUDE:-}" "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" \
           /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  c="$(ls -t "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude "$HOME/Library/Application Support/Claude/claude-code"/*/claude 2>/dev/null | head -n 1)"
  [ -n "$c" ] && [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  return 1
}
CLAUDE="$(find_claude)" || die 'Claude Code (the "claude" command) was not found. Install Claude Code first: https://code.claude.com'

if [ "$undo" = 1 ]; then
  "$CLAUDE" mcp remove "$name" -s user >/dev/null 2>&1 || true
  rm -rf "$PREFIX/node_modules/chrome-devtools-mcp"
  say "Removed the '$name' MCP server and uninstalled chrome-devtools-mcp."
  say 'You can also turn off chrome://inspect/#remote-debugging in Chrome.'
  exit 0
fi

need_node

# Chrome 144+ (needed for --autoConnect).
for app in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app"; do
  if [ -f "$app/Contents/Info.plist" ]; then
    cv="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist" 2>/dev/null || true)"
    if [ -n "$cv" ] && [ "${cv%%.*}" -lt 144 ] 2>/dev/null; then
      die "Chrome $cv is too old for --autoConnect. Update Chrome to 144 or newer."
    fi
    break
  fi
done

pkg="$PREFIX/node_modules/chrome-devtools-mcp/package.json"
installed="$("$NODE" -e 'try{console.log(require(process.argv[1]).version)}catch{}' "$pkg" 2>/dev/null || true)"
if [ "$installed" = "$version" ]; then
  say "chrome-devtools-mcp@$version is already installed."
else
  say "Installing chrome-devtools-mcp@$version ..."
  mkdir -p "$PREFIX"
  npm_cmd install --prefix "$PREFIX" --no-audit --no-fund --save-exact "chrome-devtools-mcp@$version" >/dev/null \
    || die 'npm install failed.'
fi

entry="$PREFIX/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
[ -f "$entry" ] || die "Installed, but the entry file is missing: $entry"
if [ "$broker" = 1 ]; then connect="--wsEndpoint=ws://127.0.0.1:$broker_port/devtools/browser/tether"; else connect='--autoConnect'; fi

say "Registering the '$name' MCP server in Claude Code (user scope) ..."
"$CLAUDE" mcp remove "$name" -s user >/dev/null 2>&1 || true
# --no-page-id-routing: tools act on the tab Claude last used, so hooks (like
# tab-marker.sh) can call them without a numeric page id. Each Claude Code
# session runs its own server, so sessions still don't share a "current tab".
"$CLAUDE" mcp add --scope user "$name" \
  -e CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 \
  -- "$NODE" "$entry" "$connect" --no-page-id-routing --no-usage-statistics --no-performance-crux \
  --screenshotFormat=jpeg --screenshotMaxWidth=1400 >/dev/null || die 'claude mcp add failed.'

if [ "$broker" = 1 ]; then
  good "Done. New Claude Code sessions connect through the Tether broker (port $broker_port)."
  say 'Sessions that are already open keep the old setting until you start them again.'
  exit 0
fi

say ''
good 'Done. Two steps left, once:'
say '  1. In Chrome, open  chrome://inspect/#remote-debugging  and tick'
say '     "Allow remote debugging for this browser instance".'
say '  2. Start a NEW Claude Code session. The first time it uses the browser,'
say '     Chrome asks "Allow?" - click Allow.'
say ''
say 'Tip: before leaving Claude to work on its own, ask it to connect to the'
say 'browser first, so the Allow prompt comes up while you are still there.'
