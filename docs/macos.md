# Tether on macOS

Everything Tether does on Windows also works on a Mac: the bridge block, the
local DevTools connection, the broker (Allow once per Chrome start), the connect
watch, the tab marker, the tab guard, the check and the optional guard hook. The
ideas are the same, so the [README](../README.md) applies; this page is the macOS
side of it.

**You need:** macOS 13 or newer (Apple silicon or Intel), Google Chrome 144+,
[Node.js](https://nodejs.org) 20.19+ (`brew install node` works), and Claude Code.

```bash
git clone https://github.com/shakaibarsalan/tether
cd tether
./install.sh --broker
```

Or download `tether-<version>-macos.tar.gz` from the
[latest release](https://github.com/shakaibarsalan/tether/releases/latest) and
run `./install.sh --broker` in the folder it unpacks to.

Then, once:

1. **Quit Chrome completely** (Chrome menu > Quit Google Chrome, or Cmd+Q) and open
   it again, so the extension drops its bridge connection.
2. Open `chrome://inspect/#remote-debugging` and tick **Allow remote debugging for
   this browser instance**.
3. Chrome asks **Allow?** once, for the broker. Click Allow. New Claude Code
   sessions then get in without asking.

Without `--broker`, Chrome asks **Allow?** once per Claude Code session instead.

## The commands

| What | Windows | macOS |
|---|---|---|
| Install everything | `install.ps1 [-Broker]` | `./install.sh [--broker]` |
| Undo everything | `uninstall.ps1` | `./uninstall.sh` |
| Block / unblock the bridge | `Block-Remote.bat`, `Unblock-Remote.bat` | `Block-Remote.command`, `Unblock-Remote.command` (double-click in Finder) |
| Bridge block, by hand | `scripts\bridge-block.ps1 [-Undo] [-Status]` | `scripts/bridge-block.sh [--undo] [--status]` |
| DevTools server | `scripts\devtools-setup.ps1 [-Broker] [-Undo]` | `scripts/devtools-setup.sh [--broker] [--undo]` |
| Broker | `scripts\broker-setup.ps1 [-Status] [-Undo]` | `scripts/broker-setup.sh [--status] [--undo]` |
| Connect watch | `scripts\connect-watch-setup.ps1 [-Status] [-Undo]` | `scripts/connect-watch-setup.sh [--status] [--undo]` |
| Who's connected now | `scripts\connect-watch.ps1 -Once` | `node scripts/connect-watch.mjs --once` |
| Check it's holding | `scripts\check.ps1 [-Hook]` | `scripts/check.sh [--hook]` |
| Run the check at session start | add the hook by hand | `scripts/check.sh --install-hook` (`--remove-hook`) |
| Tab marker | `scripts\tab-marker.ps1 [-Undo]` | `scripts/tab-marker.sh [--undo]` |
| Tab guard | `scripts\tab-guard.ps1 [-Undo]` | `scripts/tab-guard.sh [--undo]` |
| Guard hook | `scripts\guard-install.ps1 -DeviceId …` | `scripts/guard-install.sh --device-id …` |

## Where things live

| | |
|---|---|
| Bridge block | `/etc/hosts`, between `# >>> tether: claude-remote-browser-block` and `# <<< …`. A backup `/etc/hosts.bak-tether-<time>` on every run. |
| chrome-devtools-mcp | `~/.tether/npm` (pinned, no sudo, never updates by itself) |
| Broker | LaunchAgent `~/Library/LaunchAgents/io.github.shakaibarsalan.tether.broker.plist`, log `~/.tether/broker.log` |
| Connect watch | LaunchAgent `…/io.github.shakaibarsalan.tether.connect-watch.plist`, log `~/.tether/connect-watch.log` |
| Check cache | `~/.tether/check-cache.json` |
| Notifications on | `~/.tether/config.json` with `{ "notifications": true }` (they come from `osascript`) |

Only the bridge block needs your password (sudo), because `/etc/hosts` belongs to
root. Everything else runs as you.

## How the broker checks a session on macOS

When a program connects to `ws://127.0.0.1:9333`, the broker asks
`scripts/connect-watch.mjs --serve` who it is:

1. `lsof` finds the process on the other end of the connection, `ps` its parents.
2. It must be **chrome-devtools-mcp**, started by **Claude Code** (a program called
   `claude`, such as `~/Library/Application Support/Claude/claude-code/<version>/…/claude`),
   started by the **Claude desktop app** (`Claude.app`).
3. `codesign --verify --strict` must pass for both Claude Code and `Claude.app`, and
   `codesign -dvv` must show the signing certificate **Developer ID Application:
   Anthropic PBC** with the same team id (`Q6L2SF6YDW` on Claude Code from
   Anthropic's installer), chained to Apple's root.

Anything else (a script a session ran, `claude` started from a terminal, another
program, a web page) gets `403`, and the reason goes to `~/.tether/broker.log`.
A signature check of a large program takes a few seconds; the answer is kept for
as long as the program's file doesn't change.

## Good to know

- **Node from nvm, fnm or Volta:** the LaunchAgents and hooks store the full path
  of `node`. After switching to another Node version, run `scripts/broker-setup.sh`,
  `scripts/connect-watch-setup.sh` and `scripts/tab-guard.sh` again.
- **The "being controlled by automated test software" bar** stays while the
  broker is connected. Close it with ✕; don't turn off remote debugging.
- **`claude` in Terminal** is refused by the broker, like on Windows: it isn't the
  desktop app. Run `scripts/broker-setup.sh --undo` if you work that way; Chrome
  then asks **Allow?** per session.
- **The guard hook** uses Python 3 (`xcode-select --install` or `brew install python`).
- **A VPN or a DNS proxy that resolves names itself** can bypass `/etc/hosts`.

## How it's tested

CI runs the whole suite on `macos-latest`: the bridge block on temp hosts files,
the settings edits, the LaunchAgent file (`plutil -lint`), the guard's self-test,
the connect watch on real processes (a stand-in `claude` and `Claude.app` built
from a copy of node: the rule lets the chain through, the signature check refuses
it), `codesign` on Apple's own programs and on the real Claude Code binary from
Anthropic's installer, and the broker refusing a plain program and the stand-in
app. The broker and the extension then run end to end against a throwaway Chrome
with chrome-devtools-mcp. Last, a fresh Mac runs `./install.sh --broker` for
real, checks every piece is in place (hosts, DNS answer, LaunchAgents, broker,
MCP registration, hooks), checks that a plain program gets 403, runs
`./uninstall.sh` and checks it's all gone.

What CI can't do is run the Claude desktop app itself. If the broker refuses
your desktop sessions, `~/.tether/broker.log` says why;
`node scripts/connect-watch.mjs --explain-pid <pid of chrome-devtools-mcp>` shows
the whole chain. Please open an issue with that output.
