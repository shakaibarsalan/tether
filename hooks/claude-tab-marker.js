async () => {
  // Runs in the tab Claude Code just used, after each chrome-devtools action.
  //
  // With the Tether extension installed: tell it Claude is here. It shows the
  // orange tab group, the hourglass/check tab icon, the edge glow and the cursor.
  //
  // Without it: mark the tab in the page itself, "🤖 " in front of the title, a
  // thin orange frame and a small badge. Safe to run again and again: it only
  // installs itself once per page, and keeps the title prefix when the site
  // changes its title. Nothing here blocks clicks (pointer-events: none).
  const id = Math.random().toString(36).slice(2);
  const MARK = '🤖 ';
  // The Tether broker swaps the placeholder below for this Claude session's
  // { id, title } (base64), so each session gets its own tab group, named after
  // the chat. Without the broker it stays as it is and there's no session.
  let session = null;
  try {
    const raw = '__TETHER_SESSION__';
    if (!raw.startsWith('__')) {
      session = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
    }
  } catch (e) { session = null; }

  // Is the extension here? Its content script answers the ping with an "ack".
  // No timer decides this: on a busy page Chrome can run a timer before a
  // message that was sent earlier, so a page still loading a big app looked
  // like it had no extension. Window messages do arrive in the order they were
  // sent, though. So once our ping has gone out, we send two more messages
  // behind it; the ack was sent while the ping was being delivered, so it
  // arrives before the second one if the extension is there at all.
  const extension = await new Promise((resolve) => {
    let stuck = 0;
    const finish = (yes) => {
      removeEventListener('message', onMessage);
      clearTimeout(stuck);
      resolve(yes);
    };
    const onMessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object' || d.id !== id) return;
      if (d.tether === 'ack') finish(true);
      else if (d.tether === 'claude-active') postMessage({ tether: 'claude-active-after', id, n: 1 }, '*');
      else if (d.tether === 'claude-active-after') {
        if (d.n === 1) postMessage({ tether: 'claude-active-after', id, n: 2 }, '*');
        else finish(false);
      }
    };
    addEventListener('message', onMessage);
    postMessage({ tether: 'claude-active', id, session }, '*');
    // only if the page swallows window messages altogether
    stuck = setTimeout(() => finish(false), 5000);
  });

  if (extension) {
    // An earlier action may have marked the page itself (the extension wasn't
    // installed yet, or an older hook gave up on it too soon): take that off.
    if (window.__claudeTabMarker) {
      document.querySelectorAll('[data-claude-tab-marker]').forEach((n) => n.remove());
      if (typeof window.__claudeTabMarker === 'function') {
        window.__claudeTabMarker(); // stops keeping the title prefix
        if (document.title.startsWith(MARK)) document.title = document.title.slice(MARK.length);
      }
      window.__claudeTabMarker = false;
    }
    return 'tether extension';
  }

  const keep = () => {
    if (!document.title.startsWith(MARK)) document.title = MARK + document.title;
  };
  keep();
  if (window.__claudeTabMarker) return 'already marked';
  const titleKeeper = new MutationObserver(keep);
  titleKeeper.observe(document.head || document.documentElement,
    { subtree: true, childList: true, characterData: true });
  window.__claudeTabMarker = () => titleKeeper.disconnect();
  const frame = document.createElement('div');
  frame.setAttribute('data-claude-tab-marker', 'frame');
  frame.style.cssText = 'position:fixed;inset:0;border:3px solid #d97757;pointer-events:none;z-index:2147483647';
  const badge = document.createElement('div');
  badge.setAttribute('data-claude-tab-marker', 'badge');
  badge.textContent = '🤖 Claude';
  badge.style.cssText = 'position:fixed;top:8px;right:8px;background:#d97757;color:#1f1e1d;' +
    'font:700 12px/1 system-ui,sans-serif;padding:5px 9px;border-radius:7px;pointer-events:none;' +
    'z-index:2147483647;opacity:.92';
  (document.body || document.documentElement).append(frame, badge);
  return 'marked';
}
