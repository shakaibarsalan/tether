# Changelog

## 0.3.0 (2026-11-13)

- **macOS:** everything Tether does on Windows now works on a Mac. `./install.sh [--broker]` and `./uninstall.sh`; `scripts/bridge-block.sh` (`/etc/hosts`, asks for your password once, flushes the DNS cache) with `Block-Remote.command` and `Unblock-Remote.command` to double-click; `scripts/devtools-setup.sh` (chrome-devtools-mcp pinned in `~/.tether/npm`, no sudo); the broker and the connect watch as LaunchAgents (`broker-setup.sh`, `connect-watch-setup.sh`, each with `--status` and `--undo`); `scripts/check.sh` (`--hook`, and `--install-hook` to run it at every session start); `tab-marker.sh`, `tab-guard.sh`, `guard-install.sh` and `guard-uninstall.sh`. Every PowerShell command has a twin; [docs/macos.md](docs/macos.md) lists them.
- **Broker on macOS:** `scripts/connect-watch.mjs --serve` answers its checks. `lsof` and `ps` find who connected; Claude Code and `Claude.app` must both pass `codesign --verify --strict` and be signed with Anthropic's Developer ID ("Developer ID Application: Anthropic PBC", team id matching, chained to Apple's root). Windows is unchanged.
- **Releases:** pushing a `v*` tag runs every test on Windows and macOS, then publishes `tether-<version>-windows.zip`, `tether-<version>-macos.tar.gz`, the extension zip and `SHA256SUMS.txt`, with the notes from this file.
- **CI:** `macos-latest` runs the unit tests, the broker and extension end-to-end tests against a throwaway Chrome, and a full `./install.sh --broker`, check and `./uninstall.sh` on a fresh Mac.
- **Tests:** 114 (19 of them macOS only).

- **Tab guard:** `hooks/tab-guard.mjs` (installed by `scripts/tab-guard.ps1`) stops Claude from acting in the tab you're using: it must open its own tab or pick one first, and a tab it didn't open is refused once. A session had taken over a Gmail tab the user was working in.
- **One tab group per session, named after the chat:** the broker fills the tab-marker hook's `__TETHER_SESSION__` placeholder with the client's session id and title (looked up again every 30 s, since new sessions get a title later); the extension keeps a group per session per window and renames it when the title arrives.
- **Broker checks:** a long-lived PowerShell worker (`connect-watch.ps1 -Serve`) answers in about a second instead of a new PowerShell per check, which on a full disk timed out and refused real sessions; reconnecting processes that were already let in skip the check (pid via netstat).
- **Notifications off by default:** turn them on with `{ "notifications": true }` in `%USERPROFILE%\.tether\config.json`.

- **Broker:** `broker/tether-broker.mjs` holds one DevTools connection to Chrome, so Chrome asks **Allow?** once per Chrome start instead of once per Claude Code session. Sessions connect to it on `ws://127.0.0.1:9333` and get in only if they are chrome-devtools-mcp started by a Claude desktop session whose `claude.exe` and app are both validly signed by Anthropic, PBC; everything else gets 403 and a notification. Each session gets its own browser session (`Target.attachToBrowserTarget`); `Browser.close`, `Browser.crash` and `Target.exposeDevToolsProtocol` are refused; requests with an Origin or a foreign Host are refused. One dependency, `ws`, pinned. `scripts/broker-setup.ps1` installs it as a login task and points Claude Code at it (`-Status`, `-Undo`); `install.ps1 -Broker` includes it.
- **Connect watch:** names the broker ("Tether wants Chrome"), shows the broker's decisions, answers its `-VerifyClientPort` checks, and finds the title of brand-new sessions (no id on the command line) by start time.
- **Check script:** recognises the broker as a known client.
- **DevTools setup:** `-Broker` registers chrome-devtools-mcp with `--wsEndpoint` to the broker; skips `npm install` when the pinned version is already there.
- **Extension:** Claude's cursor style: a slim tilted arrow with a **Claude** tag that rings on a click and settles after a moment; a richer edge glow; a cream status pill.
- **Tests:** 69, plus `tests/broker-e2e.mjs`.
- **Chrome Web Store package:** the extension is 1.0.0. `store/` holds the listing text with permission justifications and reviewer steps (`listing.md`), three 1280×800 screenshots and the 440×280 promo tile (made by `store/make-assets.mjs` with the real extension), and `store/build-zip.ps1`, which builds `dist/tether-<version>.zip`. Privacy policy: `docs/privacy.md`.

- **Connect watch:** `scripts/connect-watch.ps1` pops up a Windows notification the moment a program connects to Chrome's debugging port, which is when Chrome shows **Allow?**. It names the Claude Code session behind chrome-devtools-mcp (its title, folder and account folder), flags scripts a session ran itself, and keeps a notification on screen for anything else. Every connection is logged to `%USERPROFILE%\.tether\connect-watch.log`. `scripts/connect-watch-setup.ps1` runs it at every login with no window (Task Scheduler, no admin), with `-Status` and `-Undo`. `install.ps1` and `uninstall.ps1` include it.
- **Chrome extension:** `extension/` shows which tabs Claude Code is using: an orange **Claude** tab group, an hourglass tab icon that turns into a green ✓ when Claude stops, a breathing orange edge glow, a status pill and an orange cursor that glides to Claude's clicks and typing. Display only: two permissions (`tabGroups`, `storage`), no network, no debugger, top frame only.
- **Tab-marker hook:** now asks the extension first (`postMessage`, 0.3 s wait for an ack) and falls back to the in-page marker without it. Re-run `scripts\tab-marker.ps1` to update an installed hook.
- **Tests:** 61, plus `tests/extension-e2e.mjs`, which loads the extension in a throwaway Chrome and acts like Claude Code.

## 0.2.0 (2026-11-09)

- **Check script:** `scripts/check.ps1` verifies the hosts block, that Chrome was restarted after it, that remote debugging is loopback-only, and whether Remote Control is off. It also scans every installed Claude in Chrome version for remote hosts it hasn't seen, and caches what it scanned. `-Hook` makes it a quiet `SessionStart` hook that only speaks up when something changes.
- **Tab marker:** `scripts/tab-marker.ps1` adds a hook that marks the tab Claude Code is driving: 🤖 in front of the title, an orange frame and a badge. It never blocks clicks. `-Undo` removes it.
- **Who's connected:** `check.ps1` names every program attached to Chrome's debugging port and what started it, and flags anything that isn't Claude's chrome-devtools-mcp.
- **DevTools setup:** the server is registered with `--no-page-id-routing`, so hooks can act on the tab Claude last used.
- **Guide video:** 25 seconds, with a Kokoro voice-over, subtitles and four quiet sounds. `video/voiceover.py` builds the audio and timeline.
- **Docs:** README explains how to run the check at session start and why to disable Remote Control on shared accounts. The guide video now plays at the top of the README.
- **Tests:** 47.

## 0.1.0 (2026-11-08)

First release.

- **Bridge block:** `scripts/bridge-block.ps1` with `-Undo` and `-Status`, plus `Block-Remote.bat` and `Unblock-Remote.bat`. Backs up the hosts file every run, and re-runs are safe.
- **Local control:** `scripts/devtools-setup.ps1` pins chrome-devtools-mcp 1.12.0 and registers it with `--autoConnect`.
- **One-step install:** `install.ps1` and `uninstall.ps1`.
- **Guard hook:** Python and Windows PowerShell versions, with an installer that backs up `settings.json`, replaces only its own entries and self-tests.
- **Fix:** the guard reads hook input as raw UTF-8, so Urdu and other non-English text is no longer blocked.
- **Tests:** 38 tests, and CI on `windows-latest`.
