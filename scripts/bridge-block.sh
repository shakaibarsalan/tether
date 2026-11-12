#!/bin/bash
# Cut Claude sessions on OTHER computers off from this Mac's Chrome.
#
# The Claude in Chrome extension takes browser commands from Anthropic's hosted
# bridge, wss://bridge.claudeusercontent.com. Any Claude session signed in to
# the same account can send commands through it, from any computer, and pick
# your browser without a prompt in the browser.
#
# This points that one host name at 0.0.0.0 (and ::) in /etc/hosts. The
# extension can no longer reach the bridge, so nothing outside this Mac can
# drive it. The extension stays installed and your logins stay as they are.
# Claude on this Mac drives Chrome over a local DevTools connection instead
# (devtools-setup.sh).
#
# /etc/hosts belongs to root, so this asks for your password (sudo). It saves a
# backup next to it on every run, and running it twice is safe.
#
#   scripts/bridge-block.sh            add the block
#   scripts/bridge-block.sh --undo     remove it
#   scripts/bridge-block.sh --status   only report; changes nothing
#   --hosts-file FILE                  edit FILE instead (the tests): no sudo, no DNS flush

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

BRIDGE_HOST='bridge.claudeusercontent.com'
BEGIN_MARK='# >>> tether: claude-remote-browser-block'
END_MARK='# <<< tether: claude-remote-browser-block'

undo=0; status=0; hosts=''
while [ $# -gt 0 ]; do
  case "$1" in
    --undo) undo=1 ;;
    --status) status=1 ;;
    --hosts-file) hosts="${2:?--hosts-file needs a path}"; shift ;;
    --hosts-file=*) hosts="${1#*=}" ;;
    --no-pause) ;;  # same flags as the Windows script; nothing waits here
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

system=0
if [ -z "$hosts" ]; then hosts=/etc/hosts; system=1; fi

# Blocked when an uncommented line maps the bridge to a dead address.
is_blocked() {
  [ -f "$1" ] || return 1
  awk -v host="$BRIDGE_HOST" '
    { sub(/#.*/, ""); n = split($0, f, /[ \t]+/); first = 0
      for (i = 1; i <= n; i++) if (f[i] != "") { if (!first) { first = i; addr = f[i]; continue }
        if ((addr == "0.0.0.0" || addr == "::" || addr == "127.0.0.1" || addr == "::1") && tolower(f[i]) == host) found = 1 } }
    END { exit found ? 0 : 1 }' "$1"
}

if [ "$status" = 1 ]; then
  if is_blocked "$hosts"; then
    say "Blocked: $BRIDGE_HOST is pointed at a dead address. Other computers can't drive this Chrome."
  else
    say "Open: $BRIDGE_HOST is reachable. Any session on your Claude account can drive this Chrome."
  fi
  exit 0
fi

if [ "$system" = 1 ]; then
  need_macos
  if [ "$(id -u)" != 0 ]; then
    say 'Changing /etc/hosts needs your Mac password (sudo).'
    args=(); [ "$undo" = 1 ] && args+=(--undo)
    exec sudo /bin/bash "$0" ${args[@]+"${args[@]}"}
  fi
fi

backup=''
if [ -f "$hosts" ]; then
  backup="$hosts.bak-tether-$(timestamp)"
  cp -p "$hosts" "$backup"
fi

# Drop any block this script added before, so re-running never duplicates it.
new="$(mktemp "${TMPDIR:-/tmp}/tether-hosts.XXXXXX")"
trap 'rm -f "$new"' EXIT
if [ -f "$hosts" ]; then
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    index($0, b) == 1 { skip = 1; next }
    skip && index($0, e) == 1 { skip = 0; next }
    !skip { print }' "$hosts" > "$new"
fi
if [ "$undo" = 0 ]; then
  {
    printf '%s (added %s)\n' "$BEGIN_MARK" "$(date '+%Y-%m-%d')"
    printf '0.0.0.0 %s\n' "$BRIDGE_HOST"
    printf ':: %s\n' "$BRIDGE_HOST"
    printf '%s\n' "$END_MARK"
  } >> "$new"
fi
# Write in place, so the file keeps its owner and permissions.
cat "$new" > "$hosts"

if [ "$system" = 1 ]; then
  dscacheutil -flushcache 2>/dev/null || true
  killall -HUP mDNSResponder 2>/dev/null || true
fi

say ''
if [ "$undo" = 1 ]; then
  warn 'Block REMOVED. Claude sessions on other computers can reach this Chrome again.'
else
  good 'Block ADDED. Claude sessions on other computers can no longer drive this Chrome.'
fi
[ -n "$backup" ] && say "  Hosts backup: $backup"
if [ "$system" = 1 ]; then
  say ''
  note 'NEXT: quit Chrome completely (Chrome menu > Quit Google Chrome, or Cmd+Q), then open it again.'
  say  '      The extension keeps its current bridge connection until Chrome restarts.'
fi
exit 0
