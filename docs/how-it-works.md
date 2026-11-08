# How Claude in Chrome connects, and why Tether does what it does

Observed on Windows 11 with Chrome 156, the Claude in Chrome extension 1.0.105,
the Claude desktop app 4.23118 and the Claude Code CLI, November 2026.
Anthropic can change any of this. If you see different behaviour, please
[open an issue](https://github.com/shakaibarsalan/tether/issues).

## Two ways into the extension

| Path | What it is | Who can use it |
|---|---|---|
| **Hosted browser bridge**: `wss://bridge.claudeusercontent.com` | While it's signed in, the extension keeps a WebSocket open to Anthropic. Browser commands arrive over it. | Any Claude session signed in to the same account, **on any computer** |
| **Native messaging host** | When the extension loads, Chrome starts a small helper from the Claude desktop app, and one from Claude Code. The desktop helper opens a named pipe. | Programs on this computer only |

## What we saw

1. **Every connected browser on the account is listed.** `list_connected_browsers`
   returns each Chrome connected to the bridge for your account, including
   ones on other computers. Its `isLocal` field is only a hint, based on the OS.
2. **Any listed browser can be picked without asking.** `select_browser` chooses
   a browser by its device ID, and nothing appears in that browser.
   (`switch_browser` does show a Connect prompt, but it shows it in *every*
   browser on the account.)
3. **Local control goes through the bridge too.** In our tests, both the
   desktop app's Code tab and `claude --chrome` sent their browser commands
   over the bridge, even to the Chrome on the same computer. The app log showed
   the connection waiting for the extension to show up on the bridge. The
   local pipe didn't carry the commands.
4. **Blocking the bridge cuts off everyone.** With the bridge blocked in the
   hosts file, the extension lists no browsers, and both the Code tab and the
   CLI reported that the extension was not connected.

So the extension can't be limited to "this computer only". There's one door,
and the account opens it.

## What Tether does about it

1. **Closes that door.** `scripts/bridge-block.ps1` points
   `bridge.claudeusercontent.com` at `0.0.0.0` and `::` in the Windows hosts
   file. No Claude session, remote or local, can drive the extension any more.
   The extension stays installed and your logins stay where they are.
2. **Opens a local-only one.** `scripts/devtools-setup.ps1` installs Google's
   [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
   and registers it in Claude Code with `--autoConnect` (needs Chrome 144+).
   Chrome's remote debugging server listens on `127.0.0.1` only and asks
   **Allow?** for every new client. It's the same Chrome, with the same
   profiles and the same logins.
3. **Optionally guards the other direction.** If you keep the bridge open,
   the guard hook (`hooks/`) stops *your* Claude Code from driving anyone
   else's browser that happens to be on the same account.

## Is blocking the bridge safe?

- It blocks one host name. Claude's chat, Claude Code and the desktop app use
  other hosts and keep working. Only the bridge-based Claude in Chrome
  features stop.
- We haven't tested whether the extension's own side-panel chat keeps working
  with the bridge blocked. Tell us if you try it.
- `Unblock-Remote.bat` or `uninstall.ps1` undoes it. A backup of the hosts file
  is saved every time.

## Notes on remote debugging

- Port 9222 listens on `127.0.0.1`, so it can't be reached from the network.
  Any program on your own computer can *ask* to connect, and Chrome asks you
  each time. Only click Allow when you've just started a Claude session.
- chrome-devtools-mcp shows page content to the MCP client (Claude Code), the
  same as Claude in Chrome does. Don't leave tabs open that you wouldn't show it.
- You can turn it off any time at `chrome://inspect/#remote-debugging`.
