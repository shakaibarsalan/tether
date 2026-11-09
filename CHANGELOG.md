# Changelog

## Unreleased

- **Check script:** `scripts/check.ps1` verifies the hosts block, that Chrome was restarted after it, that remote debugging is loopback-only, and whether Remote Control is off. It also scans every installed Claude in Chrome version for remote hosts it hasn't seen, and caches what it scanned. `-Hook` makes it a quiet `SessionStart` hook that only speaks up when something changes.
- **Tab marker:** `scripts/tab-marker.ps1` adds a hook that marks the tab Claude Code is driving: 🤖 in front of the title, an orange frame and a badge. It never blocks clicks. `-Undo` removes it.
- **Who's connected:** `check.ps1` names every program attached to Chrome's debugging port and what started it, and flags anything that isn't Claude's chrome-devtools-mcp.
- **DevTools setup:** the server is registered with `--no-page-id-routing`, so hooks can act on the tab Claude last used.
- **Guide video:** 25 seconds, with a Kokoro voice-over, subtitles and four quiet sounds. `video/voiceover.py` builds the audio and timeline.
- **Docs:** README explains how to run the check at session start and why to disable Remote Control on shared accounts.
- **Tests:** 47.

## 0.1.0 (2026-11-08)

First release.

- **Bridge block:** `scripts/bridge-block.ps1` with `-Undo` and `-Status`, plus `Block-Remote.bat` and `Unblock-Remote.bat`. Backs up the hosts file every run, and re-runs are safe.
- **Local control:** `scripts/devtools-setup.ps1` pins chrome-devtools-mcp 1.12.0 and registers it with `--autoConnect`.
- **One-step install:** `install.ps1` and `uninstall.ps1`.
- **Guard hook:** Python and Windows PowerShell versions, with an installer that backs up `settings.json`, replaces only its own entries and self-tests.
- **Fix:** the guard reads hook input as raw UTF-8, so Urdu and other non-English text is no longer blocked.
- **Tests:** 38 tests, and CI on `windows-latest`.
