# Troubleshooting

### Claude Code says the DevTools server can't connect
- Chrome has to be **running**. `--autoConnect` attaches to an open Chrome; it doesn't start one.
- Open `chrome://inspect/#remote-debugging` and check that **Allow remote debugging for this
  browser instance** is ticked. The page should say `Server running at: 127.0.0.1:9222`.
- Look for an **Allow?** prompt in Chrome. It can sit behind other windows.
- The MCP server only loads in a **new** Claude Code session.

### Chrome never asks "Allow?" and I'm away
The prompt comes when a session first connects. Before you leave Claude working
on its own, ask it to connect to the browser first (for example "list my open
tabs"), click Allow, then go.

### `chrome://inspect` didn't open from the script
Chrome won't open `chrome://` pages from the command line. Type the address
yourself.

### The bridge is still reachable after Block-Remote.bat
- Did you approve the admin prompt? Run `powershell -File scripts\bridge-block.ps1 -Status`.
- **Restart Chrome completely** (close every window). The extension keeps its
  existing connection until then.
- A VPN or proxy that resolves names itself can bypass the hosts file.
- Some antivirus tools protect the hosts file. Allow the change and run again.

### I want Claude in Chrome back the old way
Run `Unblock-Remote.bat`, then restart Chrome. Remember that this reopens the
bridge to every session on your account.

### The guard blocks my own browser
Ask Claude to run `list_connected_browsers`. If your browser's deviceId changed
(after reinstalling the extension, for example), run `scripts\guard-install.ps1`
again with the new ID. The old one is kept.

### Removing everything
`uninstall.ps1` removes the broker, the DevTools server, the connect watch and
the bridge block. `scripts\guard-uninstall.ps1` removes the guard. Both back up
what they change. On a Mac: `./uninstall.sh` and `scripts/guard-uninstall.sh`.

## macOS

### The bridge is still reachable after Block-Remote.command
- Run `scripts/bridge-block.sh --status`. Did you type your password when sudo asked?
- **Quit Chrome completely** (Cmd+Q, not just closing the window), then open it again.
- `python3 -c "import socket; print(socket.gethostbyname('bridge.claudeusercontent.com'))"`
  should print `0.0.0.0`. If not, a VPN or DNS tool is answering instead of `/etc/hosts`.

### The broker refuses my Claude desktop sessions
`~/.tether/broker.log` says why. `node scripts/connect-watch.mjs --once` lists what
is connected to Chrome, and `--explain-pid <pid>` shows the whole chain for one
process. Please open an issue with that output.

### The broker or the watch stopped after I changed Node versions
The LaunchAgents keep the full path of `node`. Run `scripts/broker-setup.sh` and
`scripts/connect-watch-setup.sh` again (and `scripts/tab-guard.sh` if you use it).
`scripts/broker-setup.sh --status` shows whether it's running.
