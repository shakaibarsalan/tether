# Changelog

## 0.1.0 (2026-11-08)

First release.

- **Bridge block:** `scripts/bridge-block.ps1` with `-Undo` and `-Status`, plus `Block-Remote.bat` and `Unblock-Remote.bat`. Backs up the hosts file every run, and re-runs are safe.
- **Local control:** `scripts/devtools-setup.ps1` pins chrome-devtools-mcp 1.12.0 and registers it with `--autoConnect`.
- **One-step install:** `install.ps1` and `uninstall.ps1`.
- **Guard hook:** Python and Windows PowerShell versions, with an installer that backs up `settings.json`, replaces only its own entries and self-tests.
- **Fix:** the guard reads hook input as raw UTF-8, so Urdu and other non-English text is no longer blocked.
- **Tests:** 38 tests, and CI on `windows-latest`.
