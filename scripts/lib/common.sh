# Shared by Tether's macOS scripts. Source it, don't run it.

TETHER_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TETHER_SCRIPTS="$TETHER_REPO/scripts"
TETHER_HOME="${TETHER_HOME:-$HOME/.tether}"
TETHER_LABEL_PREFIX="io.github.shakaibarsalan.tether"
LAUNCH_AGENTS="${TETHER_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_OFF=''
fi

say()  { printf '%s\n' "$*"; }
good() { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_OFF"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_OFF"; }
note() { printf '%s%s%s\n' "$C_CYAN" "$*" "$C_OFF"; }
die()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

# Apps started from the Dock or by launchd get a short PATH, so look in the
# usual places too: Homebrew, the nodejs.org installer, nvm, Volta, asdf, fnm.
find_node() {
  local n
  for n in "${TETHER_NODE:-}" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node \
           "$HOME"/.volta/bin/node "$HOME"/.asdf/shims/node "$HOME"/.local/share/fnm/aliases/default/bin/node; do
    [ -n "$n" ] && [ -x "$n" ] && { printf '%s\n' "$n"; return 0; }
  done
  # newest nvm install
  n="$(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -n 1)"
  [ -n "$n" ] && [ -x "$n" ] && { printf '%s\n' "$n"; return 0; }
  return 1
}

# Node.js 20.19 or newer (chrome-devtools-mcp's own requirement).
need_node() {
  NODE="$(find_node)" || die 'Node.js 20.19 or newer is needed: https://nodejs.org (or: brew install node)'
  local v major minor
  v="$("$NODE" -v 2>/dev/null)"; v="${v#v}"
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  if [ "${major:-0}" -lt 20 ] || { [ "$major" -eq 20 ] && [ "${minor:-0}" -lt 19 ]; }; then
    die "Node.js $v is too old ($NODE). Install 20.19 or newer."
  fi
  export NODE
  # npm and npx start with "#!/usr/bin/env node", so node's folder goes on PATH.
  PATH="$(dirname "$NODE"):$PATH"
  export PATH
}

# The folder that holds node also holds npm and npx.
npm_cmd() { "$(dirname "$NODE")/npm" "$@"; }

timestamp() { date '+%Y%m%d-%H%M%S'; }

need_macos() {
  [ "$(uname -s)" = Darwin ] || [ -n "${TETHER_ALLOW_ANY_PLATFORM:-}" ] || die 'This is the macOS version. On Windows use the .ps1 scripts.'
}

# launchd: load / unload a LaunchAgent for the user who is logged in.
agent_plist() { printf '%s/%s.%s.plist\n' "$LAUNCH_AGENTS" "$TETHER_LABEL_PREFIX" "$1"; }
agent_label() { printf '%s.%s\n' "$TETHER_LABEL_PREFIX" "$1"; }

agent_unload() {
  local label; label="$(agent_label "$1")"
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || launchctl remove "$label" >/dev/null 2>&1 || true
}

agent_load() {
  local plist; plist="$(agent_plist "$1")"
  agent_unload "$1"
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load -w "$plist"
}

agent_running() {
  launchctl print "gui/$(id -u)/$(agent_label "$1")" 2>/dev/null | grep -q 'state = running'
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

# write_agent NAME LOGFILE PROGRAM [ARGS...]: a LaunchAgent that starts at login,
# restarts after a crash (not after a clean exit) and has a PATH with node in it.
write_agent() {
  local name="$1" log="$2"; shift 2
  local plist; plist="$(agent_plist "$name")"
  mkdir -p "$LAUNCH_AGENTS" "$(dirname "$log")"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    printf '<plist version="1.0">\n<dict>\n'
    printf '  <key>Label</key><string>%s</string>\n' "$(agent_label "$name")"
    printf '  <key>ProgramArguments</key>\n  <array>\n'
    local a
    for a in "$@"; do printf '    <string>%s</string>\n' "$(xml_escape "$a")"; done
    printf '  </array>\n'
    printf '  <key>RunAtLoad</key><true/>\n'
    printf '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n'
    printf '  <key>ThrottleInterval</key><integer>30</integer>\n'
    printf '  <key>ProcessType</key><string>Background</string>\n'
    printf '  <key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string></dict>\n' \
      "$(xml_escape "$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin")"
    printf '  <key>StandardOutPath</key><string>%s</string>\n' "$(xml_escape "$log")"
    printf '  <key>StandardErrorPath</key><string>%s</string>\n' "$(xml_escape "$log")"
    printf '</dict>\n</plist>\n'
  } > "$plist"
  if command -v plutil >/dev/null 2>&1; then plutil -lint "$plist" >/dev/null || die "Wrote a broken $plist"; fi
}
