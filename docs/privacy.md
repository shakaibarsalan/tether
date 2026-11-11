# Tether for Chrome: privacy policy

*Last updated: 11 November 2026*

Tether for Chrome is a display-only extension. It shows which of your tabs Claude Code is using: it puts those tabs in an orange tab group and, in those tabs, draws a glow, a status pill, a cursor and a tab icon.

## What it collects

**Nothing.** Tether does not collect, store remotely, sell or share any personal data, browsing history, page content, or anything else.

## What it does on your computer

- **Content script.** Runs in the pages you open and waits for one message, `{ tether: 'claude-active' }`, which Claude Code's Tether hook posts in the tab Claude is using. It then draws its overlay in that page. It does not read, record or send the page's content.
- **Session storage.** Keeps, per tab, the time Claude last acted in it and whether the tab is in the "Claude" group, in `chrome.storage.session`. Chrome clears this when it closes. It never leaves your computer.
- **Tab groups.** Moves the tab Claude is using into a tab group named "Claude" in the same window.

## What it never does

- It makes **no network requests** of any kind. There is no server, no analytics and no remote code.
- It cannot control your browser and accepts no commands from websites, other extensions or other computers.
- It does not use the `debugger`, `tabs`, `cookies`, `history`, `webRequest` or any host permissions.

The source code is public: <https://github.com/shakaibarsalan/tether/tree/main/extension>. Its tests fail if the extension gains a network call or a new permission.

## Contact

Open an issue at <https://github.com/shakaibarsalan/tether/issues>.
