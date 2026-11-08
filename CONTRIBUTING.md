# Contributing

Thanks for helping. A few ground rules keep Tether trustworthy:

- **Fail closed.** If the guard can't tell, it blocks. Keep it that way.
- **Never touch real files in tests.** Tests work on temp copies of the hosts file and Claude settings (see `tests/`).
- **Back up before changing anything** on the user's machine, and make every change undoable.
- **Say what you measured.** If you document how Claude or Chrome behaves, include the versions you tested.

Run the tests before opening a PR:

```powershell
python -m unittest discover -s tests -v
```

Wanted:

- macOS and Linux versions of `bridge-block` and `devtools-setup`
- checks for newer Claude in Chrome versions (does the bridge still carry local commands?)
