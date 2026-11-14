# Tether for Chrome

See at a glance which tabs Claude Code is using in your real Chrome.

| While Claude works | When it's done |
|---|---|
| The tab joins an orange **Claude** tab group | The tab icon turns into a green ✓ until you've looked at the tab |
| The tab icon is an hourglass with running sand | A **Claude is done** pill, also until you're back on the tab; then it all fades out |
| A soft orange glow breathes around the page | |
| An orange cursor with a **Claude** tag glides to where Claude clicks or types, and rings on a click | |
| A **Claude is working in this tab** pill at the bottom | |

It's the look Claude in Chrome had, for the local DevTools connection Tether uses instead.

**It only shows things. It can't drive your browser.** It has no network access, no debugger access, and no way for a website or another extension to send it commands. Claude Code still drives Chrome only through `chrome-devtools-mcp` on `127.0.0.1`, after you click **Allow**.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension` folder.
4. Pin it if you like. It has no popup; the icon only tells you it's installed.

Run `scripts\tab-marker.ps1` once (`install.ps1` doesn't do it) so Claude Code tells the extension which tab it's using. Start a new Claude Code session afterwards.

After you change a file here, click the reload arrow on the extension's card in `chrome://extensions`, then reload the page you're testing.

## How it works

```
Claude Code ──(chrome-devtools-mcp, 127.0.0.1)──▶ your tab
    │
    └─ after each browser action, a PostToolUse hook runs
       hooks/claude-tab-marker.js in that tab:
           postMessage({ tether: 'claude-active' })
           (two more messages follow it; if no "ack" comes back
            before the second one, there's no extension and the
            hook draws its own frame and badge instead)
                         │
                         ▼
       content.js (in the page)      ──▶  background.js (service worker)
       • answers "ack"                    • puts the tab in the orange
       • glow, pill, cursor, icon           "Claude" group
       • 20 s with no action = done       • remembers the tab across
                                            Claude's navigations
```

The files, in the order Chrome reads them:

- **`manifest.json`**: the extension's ID card. Its name, version, icons, the two permissions it asks for, and which scripts run where. Chrome reads it first.
- **`content.js`**: a *content script*. Chrome injects it into every page you open, in an "isolated world": it can see and change the page's DOM, but the page's own JavaScript can't see its variables. It listens for the hook's message and draws the overlay in a closed shadow root with `pointer-events: none`, so the page's CSS can't touch it and it never blocks a click.
- **`background.js`**: the *service worker*. Chrome starts it when a content script sends a message and stops it when it's idle. It handles the one thing a page can't do, putting a tab in a tab group. It keeps a small per-tab record in `chrome.storage.session`, which is cleared when Chrome closes.
- **`icons/`**: the Tether logo at 16, 32, 48 and 128 px.

The hook waits 0.3 s for the extension's "ack". If none comes (the extension isn't installed, or the page is one Chrome doesn't let extensions into), it falls back to the old in-page marker: 🤖 in the title and an orange frame.

### Permissions

| Permission | Why |
|---|---|
| `tabGroups` | Create the orange **Claude** group and name it. |
| `storage` | Remember, per tab, when Claude last acted (session storage only). |
| Content script on all sites | Claude can work on any site, so the overlay has to be able to appear on any site. Chrome shows this as "Read and change all your data on all websites". The script only reacts to the hook's message and never reads or sends page content. |

`tests/test_extension.py` fails if a change adds a permission, a network call, a debugger call or a way for other extensions to message it.

## Limits

- Chrome doesn't let extensions into `chrome://` pages, the Chrome Web Store or other extensions' pages. There, the hook's in-page marker can't run either, so nothing is shown.
- "Done" means 20 seconds without a Claude action in that tab. If Claude pauses longer to think, you'll see ✓ and then the hourglass again.
- A web page can post the same `claude-active` message itself and make its own tab look like Claude is using it, and it can tell from the "ack" that the extension is installed. Neither gives it any control, but don't treat the glow as proof.
- The overlay is drawn in the top frame. Clicks inside iframes don't move the cursor.

## Test

```powershell
python -m unittest tests.test_extension -v          # static safety checks, no browser
npm install --no-save puppeteer-core@24
node tests/extension-e2e.mjs                         # loads it in a throwaway Chrome
```

The end-to-end test starts a separate Chrome with a temporary profile and no debugging port, loads the extension, then clicks, types and navigates like Claude Code would. It checks the tab group, the tab icon, the fallback and page errors, and saves screenshots of each state.

## Publishing to the Chrome Web Store

1. Register as a Chrome Web Store developer (a one-time fee, paid by you).
2. Zip the **contents** of this folder (`manifest.json` at the top level of the zip).
3. In the developer dashboard: upload the zip, add the description, at least one 1280×800 screenshot, a 128×128 icon, a privacy policy URL and the single-purpose statement ("Shows which tabs Claude Code is using").
4. Justify each permission with the table above.

Keep the name and logo Tether's own. The Web Store rejects extensions that look like another company's product, and "Claude" is Anthropic's name.
