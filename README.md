<div align="center">

<img src="assets/logo.svg" width="112" alt="Tether logo">

<h1>Tether</h1>

**Keep Claude's control of your Chrome on this computer only.**

Any Claude session signed in to your account, on any computer, can drive the Chrome where the Claude extension is signed in. Tether closes that door and gives Claude Code a local-only one, with the same browser, the same tabs and the same logins.

**And it works with any Claude account.** The extension only worked when it was signed in to the same account as your Claude app. With Tether, whichever account you're using, Claude Code drives the Chrome you already have open, with Vercel, DigitalOcean, Hostinger, Gmail and everything else already logged in.

[![tests](https://github.com/shakaibarsalan/tether/actions/workflows/test.yml/badge.svg)](https://github.com/shakaibarsalan/tether/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-d97757.svg)](LICENSE)
![Platform: Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-1f1e1d)
![Works with Claude Code](https://img.shields.io/badge/works%20with-Claude%20Code-1f1e1d)

<br>

<a href="video/tether-guide.mp4"><img src="assets/demo.gif" width="600" alt="25-second guide: Claude on another computer reaches your Chrome through Anthropic's browser bridge. Tether blocks other computers, and your own Claude keeps working with the same tabs and logins."></a>

<sub>▶ <a href="video/tether-guide.mp4"><b>Watch with sound</b></a> (25 s)</sub>

</div>

---

## The problem

The Claude in Chrome extension takes its commands from Anthropic's hosted browser bridge. The bridge addresses browsers by **account**:

- `list_connected_browsers` shows every Chrome on your account, on every computer.
- `select_browser` picks any of them by ID, and **nothing appears in that browser**.

So if your account is signed in anywhere else (an office PC, an old laptop you never signed out of, or someone who has your login), a Claude session there can open tabs in *your* Chrome, with your Gmail, your banking and your client dashboards logged in. It also works the other way: your Claude can wander into a browser that isn't yours.

You can't fix this from inside the extension. We measured it: even Claude on the **same** computer talks to the extension through the bridge ([details](docs/how-it-works.md)). There's one door, and the account opens it.

## One browser, any Claude account

Tying the browser to an account causes a second problem. If you use more than one Claude account (work and personal, or a second one for when you hit a usage limit), the browser only follows the account the extension is signed in to.

| | Claude in Chrome | With Tether |
|---|---|---|
| **Which Claude account can use the browser** | Only the one the extension is signed in to | Any account you use in Claude Code on this computer |
| **Switching accounts** (say, after hitting a usage limit) | Sign the extension in again, or keep a Chrome profile for each account | Nothing to do |
| **Your logins** (Vercel, DigitalOcean, Hostinger, Gmail…) | Only in the profile whose extension matches | Every Chrome profile you have open |
| **Who else can reach it** | Any Claude session on that account, from any computer | Only programs on this computer, after you click **Allow** |

The connection is local, so it follows the computer, not the account. Sign in to the sites you use once, and every Claude account you switch to can use them.

<a href="video/any-account/tether-any-account.mp4"><img src="assets/any-account.jpg" width="600" alt="Short video: three Claude account badges go into the same Chrome on one laptop, and the logged-in tabs open above it."></a>

<sub>▶ <a href="video/any-account/tether-any-account.mp4"><b>Watch: one browser, any Claude account</b></a> (22 s, with sound)</sub>

## What Tether does

| | |
|---|---|
| **Closes the remote door** | Points `bridge.claudeusercontent.com` at `0.0.0.0` in the Windows hosts file. No other computer can drive your Chrome, whatever account they use. |
| **Keeps your browser as it is** | The extension stays installed. Your profiles, tabs and logins are untouched. Nothing to re-login. |
| **Gives Claude Code a local door** | Installs Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) with `--autoConnect`. Claude Code drives your real Chrome over `127.0.0.1`, and Chrome asks **Allow?** for each new session. |
| **Works with any Claude account** | Everything lives on the computer, not the account. Switch Claude accounts as often as you like, and the browser and all its logins come with you. |
| **Undoes cleanly** | One script to undo each part. Every change is backed up first. |
| **Optional guard** | If you keep the bridge open, a Claude Code hook stops *your* Claude from driving anyone else's browser. |

## How it works

```mermaid
flowchart LR
    subgraph before["Before"]
        A1["Claude on your PC"] --> B1(("Anthropic<br/>browser bridge"))
        A2["Claude on any other PC<br/>signed in to your account"] --> B1
        B1 --> C1["Your Chrome<br/>(extension)"]
    end
    subgraph after["With Tether"]
        A3["Claude on any other PC"] -. blocked .-x B2(("bridge<br/>0.0.0.0"))
        A4["Claude Code on your PC"] -- "127.0.0.1:9222<br/>Allow? in Chrome" --> C2["Your Chrome<br/>same tabs and logins"]
    end
```

What we measured, the version numbers and the open questions are in [docs/how-it-works.md](docs/how-it-works.md).

## Install

**You need:** Windows 10 or 11, Chrome 144+, [Node.js](https://nodejs.org) 20.19+, and [Claude Code](https://code.claude.com).

```powershell
git clone https://github.com/shakaibarsalan/tether
cd tether
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` does two things:

1. **DevTools setup.** It installs `chrome-devtools-mcp` (pinned to a version) and registers it in Claude Code as `chrome-devtools`.
2. **Bridge block.** It adds two lines to the hosts file. Windows asks for admin.

Then, once:

1. **Restart Chrome completely**, so the extension drops its bridge connection.
2. In Chrome, open `chrome://inspect/#remote-debugging` and tick **Allow remote debugging for this browser instance**.
3. Start a **new** Claude Code session. The first time it touches the browser, Chrome asks **Allow?**. Click Allow.

Prefer clicking? `Block-Remote.bat` and `Unblock-Remote.bat` do the bridge part on their own.

## Daily use

- Ask Claude Code to do browser work as usual. It uses the `chrome-devtools` tools on your real Chrome.
- **Leaving Claude to work on its own?** Ask it to connect first ("list my open tabs"), click **Allow**, then go.
- Check the block any time:
  ```powershell
  powershell -File .\scripts\bridge-block.ps1 -Status
  ```
- **Clicking "Allow?"** Only programs on this computer can bring up that prompt, because the port isn't reachable from the network. Allow it when you've just given Claude a browser task. If it pops up out of nowhere, click Deny. `check.ps1` shows exactly which program is connected.

## See which tab Claude is using

The extension put its tabs in an orange "Claude" group. The DevTools connection doesn't, so Tether can mark them for you: a 🤖 in front of the tab title, a thin orange frame, and a small "🤖 Claude" badge. Clicks and typing are unaffected.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tab-marker.ps1
```

This adds a hook that, after each browser action Claude takes, marks the tab it just used. `-Undo` removes it.

All your Chrome profiles run in one Chrome, so the DevTools connection can reach the open windows of **every** profile, whatever Claude account you use. The marker shows you where Claude is working.

## Check it's still holding

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check.ps1
```

```
OK    hosts file blocks bridge.claudeusercontent.com
OK    Chrome was restarted after the block
OK    extension versions 1.0.102_0, 1.0.104_0, 1.0.105_0: no unknown remote hosts
OK    Chrome remote debugging is on loopback only (port 9222)
OK    connected to Chrome: chrome-devtools-mcp (pid 37240), started by claude.exe <- claude.exe <- explorer.exe
OK    Remote Control is disabled in Claude Code settings
```

The `connected to Chrome` line answers "who asked for that Allow prompt?". It names every program attached to Chrome's debugging port and what started it. Anything other than chrome-devtools-mcp started by Claude is flagged.

The important line is the third one. When the extension updates, `check.ps1` scans the new version for remote hosts. A host it hasn't seen before could be a new bridge that the block doesn't cover. Scanned versions are cached, so later runs take a couple of seconds.

**Run it automatically.** Add it as a Claude Code `SessionStart` hook in `~/.claude/settings.json`. It stays silent while everything holds, and warns you (and Claude) at the start of a session when something changes:

```json
"SessionStart": [
  { "hooks": [ { "type": "command", "command": "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      "args": ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:/path/to/tether/scripts/check.ps1", "-Hook"],
      "timeout": 120 } ] }
]
```

**On a shared Claude account, also turn off Remote Control.** Otherwise someone on the account can drive your Claude Code session itself. Add `"disableRemoteControl": true` to `~/.claude/settings.json`.

## Undo

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

This removes the DevTools server and the bridge block. You can also turn remote debugging off at `chrome://inspect/#remote-debugging`.

## Optional: the guard hook

If you'd rather keep the bridge open, so the extension works the old way, you can at least make sure *your* Claude Code only drives *your* browser:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\guard-install.ps1 -DeviceId <your-browser-deviceId>
```

Ask Claude Code to run `list_connected_browsers` to find the ID. The guard:

- refuses every browser tool until the browser in use is confirmed as yours;
- always refuses `switch_browser`, which sends a Connect prompt to every browser on the account;
- fails closed if anything goes wrong.

There's a Python version (`hooks/chrome_browser_guard.py`) and a Windows PowerShell version, so Python isn't required. Remove it with `scripts\guard-uninstall.ps1`.

The guard protects other people from your Claude. **It doesn't stop other computers from driving your Chrome. Only the bridge block does that.**

## Limits

- **Windows only for now.** The same idea works on macOS and Linux (hosts file plus `--autoConnect`). PRs welcome.
- **Claude in Chrome stops working** while the bridge is blocked, for everyone including you. That's the point. Browser work moves to the DevTools tools.
- **Hooks and MCP servers are Claude Code features.** The Chat and Cowork tabs in the Claude app don't use them.
- **Chrome has to be running** for `--autoConnect`, and it asks **Allow?** once per new session.
- **A VPN or proxy that resolves DNS itself** can bypass the hosts file.
- **Anthropic can change how the extension connects.** `check.ps1` flags new remote hosts after an update. If they add per-device approval, you may not need the block at all.

## Tests

```powershell
python -m unittest discover -s tests -v
```

47 tests. The same 13 rules run against both guards, plus the bridge block, the guard installer, the check script and the tab-marker installer, always on temp copies, never your real hosts file or settings. CI runs them on `windows-latest`.

## License

[MIT](LICENSE). Not affiliated with Anthropic or Google.
