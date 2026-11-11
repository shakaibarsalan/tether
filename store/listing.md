# Chrome Web Store listing: Tether

Everything the developer dashboard asks for, ready to paste. Files are in this folder; the package is built by `store/build-zip.ps1`.

## Package

- **Zip:** `dist/tether-<version>.zip` (made by `store/build-zip.ps1`; `manifest.json` at the top level)

## Store listing tab

- **Name:** Tether *(from the manifest)*
- **Summary:** *(from the manifest)* See which tabs Claude Code is using: an orange tab group, a working and done tab icon, a soft edge glow and a cursor. Display only.
- **Category:** Developer Tools
- **Language:** English
- **Description:**

```
Tether shows you which tabs Claude Code is using in your Chrome.

When Claude Code works in your browser through Chrome DevTools (the chrome-devtools MCP server), it's hard to tell which tab it's in. Tether makes it obvious:

• The tab joins an orange "Claude" tab group.
• The tab icon becomes an hourglass while Claude works, and a green check when it's done. The check stays until you've looked at the tab.
• A soft orange glow breathes around the page, with a "Claude is working in this tab" pill at the bottom.
• An orange cursor with a "Claude" tag glides to where Claude clicks or types, and rings on a click.

Display only. Tether can't control your browser. It has no network access, no server, no analytics and no remote code, and it collects no data. It needs two permissions: tab groups (to make the Claude group) and storage (to remember, until Chrome closes, which tabs Claude used).

How it knows: Tether's Claude Code hook (free, open source) posts a small message in the tab Claude just used. Without the hook nothing happens. Setup: https://github.com/shakaibarsalan/tether

Tether is an independent open-source project, not made by or affiliated with Anthropic or Google.
```

- **Graphic assets:**
  - Store icon (128×128): `extension/icons/icon128.png`
  - Screenshots (1280×800): `screenshot-1-working.png`, `screenshot-2-typing.png`, `screenshot-3-done.png`
  - Small promo tile (440×280): `promo-small.png`
- **Official URL:** none
- **Homepage URL:** https://github.com/shakaibarsalan/tether
- **Support URL:** https://github.com/shakaibarsalan/tether/issues

## Privacy practices tab

- **Single purpose:**

```
Show the user which browser tabs Claude Code is currently using, by grouping those tabs and drawing a visual indicator in them.
```

- **Permission justification, tabGroups:**

```
Moves the tab Claude Code is using into an orange tab group named "Claude", so the user can see at a glance which tabs Claude is working in. No other tab is touched.
```

- **Permission justification, storage:**

```
Uses chrome.storage.session only, to remember per tab when Claude last acted and whether the tab was grouped, so the indicator continues after Claude navigates the tab. Cleared when Chrome closes; never sent anywhere.
```

- **Permission justification, host permission (content script on all sites):**

```
Claude Code can work on any website, so the indicator (glow, status pill, cursor, tab icon) has to be able to appear on any page. The content script only listens for one message from Claude Code's Tether hook and draws a non-interactive overlay. It does not read, store or send page content, and makes no network requests.
```

- **Remote code:** No, I am not using remote code.
- **Data usage:** collects none of the listed data types. Tick all three certifications (not sold to third parties; not used for unrelated purposes; not used for creditworthiness or lending).
- **Privacy policy URL:** https://github.com/shakaibarsalan/tether/blob/main/docs/privacy.md

## Distribution tab

- **Visibility:** Public
- **Regions:** All regions
- **Payments:** Free
- **Trader status (EU):** Non-trader (individual, free, non-commercial project)

## Test instructions for the reviewer

```
Tether only reacts to a message posted by its companion Claude Code hook. To see it without Claude Code:
1. Open any normal web page (e.g. https://example.com).
2. Open DevTools > Console and run:
   window.postMessage({ tether: 'claude-active', id: 'review' }, '*')
3. The tab moves into an orange "Claude" tab group, the tab icon becomes an hourglass, an orange glow and a "Claude is working in this tab" pill appear.
4. To see the cursor, run:
   addEventListener('click', () => postMessage({ tether: 'claude-active', id: 'review' }, '*'))
   then click anywhere on the page: an orange cursor with a "Claude" tag glides to each click.
5. Stop clicking for 20 seconds: the tab icon turns into a green check and the pill says "Claude is done".
The extension makes no network requests.
```
