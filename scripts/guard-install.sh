#!/bin/bash
# Install the guard hook: Claude Code on this Mac may only drive the Chrome
# browsers you allow (for when you keep the bridge open). macOS version of
# guard-install.ps1; uses the Python guard, hooks/chrome_browser_guard.py.
#
# Copies the guard into ~/.claude/hooks, writes the allowed-browsers file, backs
# up settings.json, adds the hook entries (PreToolUse with onFailure=block,
# PostToolUse to confirm the browser in use) and runs a self-test. Running it
# again is safe.
#
#   scripts/guard-install.sh --device-id <your-browser-deviceId> [--note "my MacBook"]
#
# Find your deviceId by asking Claude Code to run list_connected_browsers. If
# more than one browser is listed, pick the one on THIS Mac.

set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

device=''; note_text='my own browser'; claude_dir="$HOME/.claude"
while [ $# -gt 0 ]; do
  case "$1" in
    --device-id|--DeviceId) device="${2:-}"; shift ;;
    --note) note_text="${2:-}"; shift ;;
    --claude-dir) claude_dir="${2:?}"; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

device="$(printf '%s' "$device" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if ! printf '%s' "$device" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  die "That doesn't look like a browser deviceId: '$device'. Ask Claude Code to run list_connected_browsers and copy your browser's deviceId."
fi

# A real Python 3 (on a fresh Mac, /usr/bin/python3 only offers to install the developer tools).
PY=''
for p in "${TETHER_PYTHON:-}" "$(command -v python3 2>/dev/null)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -n "$p" ] && [ -x "$p" ] && "$p" -c 'import json, sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then PY="$p"; break; fi
done
[ -n "$PY" ] || die 'Python 3.8 or newer is needed for the guard (xcode-select --install, or brew install python).'
need_node

hooks_dir="$claude_dir/hooks"
guard="$hooks_dir/chrome_browser_guard.py"
allowed="$hooks_dir/chrome-allowed-devices.txt"
mkdir -p "$hooks_dir"
cp "$TETHER_REPO/hooks/chrome_browser_guard.py" "$guard"

# The allowed-browsers file keeps any IDs already in it.
if [ ! -f "$allowed" ]; then
  {
    say '# Tether guard: the ONLY browsers Claude Code on this computer may control.'
    say '# One deviceId per line. Anything after # is a note.'
  } > "$allowed"
fi
if ! sed 's/#.*//' "$allowed" | awk '{print tolower($1)}' | grep -qx "$device"; then
  printf '%s  # %s (added %s)\n' "$device" "$note_text" "$(date '+%Y-%m-%d')" >> "$allowed"
fi

backup="$("$NODE" "$TETHER_SCRIPTS/lib/claude-settings.mjs" guard --claude-dir "$claude_dir" --python "$PY" --guard "$guard")" || exit 1

# Self-test the installed guard with the same JSON Claude Code sends it.
results="$("$PY" - "$guard" "$device" "$hooks_dir" <<'PYTEST'
import json, os, subprocess, sys, uuid
guard, mine, hooks_dir = sys.argv[1], sys.argv[2], sys.argv[3]
session = "tether-selftest-" + uuid.uuid4().hex
def call(payload):
    payload["session_id"] = session
    out = subprocess.run([sys.executable, guard], input=json.dumps(payload), capture_output=True, text=True).stdout.strip()
    return "allow" if not out else json.loads(out)["hookSpecificOutput"]["permissionDecision"]
pre = lambda tool, inp: {"hook_event_name": "PreToolUse", "tool_name": "mcp__claude-in-chrome__" + tool, "tool_input": inp}
r = {}
r["browser blocked before check"] = call(pre("navigate", {"url": "https://example.com"})) == "deny"
r["broadcast connect blocked"] = call(pre("switch_browser", {})) == "deny"
r["another browser blocked"] = call(pre("select_browser", {"deviceId": str(uuid.uuid4())})) == "deny"
call({"hook_event_name": "PostToolUse", "tool_name": "mcp__claude-in-chrome__list_connected_browsers", "tool_input": {},
      "tool_response": [{"type": "text", "text": json.dumps([{"deviceId": mine, "inUse": True}])}]})
r["your browser allowed after check"] = call(pre("navigate", {"url": "https://example.com"})) == "allow"
state = os.path.join(hooks_dir, "chrome-guard-state", session)
if os.path.exists(state):
    os.remove(state)
for k, v in r.items():
    print(("PASS  " if v else "FAIL  ") + k)
PYTEST
)"

say ''
say 'Guard installed.'
say "  Allowed browser : $device"
say "  Guard           : $guard"
say "  Settings        : $claude_dir/settings.json"
[ -n "$backup" ] && say "  ${backup}"
say ''
printf '%s\n' "$results" | sed 's/^/  /'
say ''
if printf '%s\n' "$results" | grep -q '^FAIL'; then
  die 'A self-test failed. Run scripts/guard-uninstall.sh and open an issue.'
fi
good 'All self-tests passed. Start a NEW Claude Code session so the guard loads.'
