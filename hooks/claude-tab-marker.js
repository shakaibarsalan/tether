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
  const extension = await new Promise((resolve) => {
    const onMessage = (e) => {
      if (e.data && e.data.tether === 'ack' && e.data.id === id) {
        removeEventListener('message', onMessage);
        resolve(true);
      }
    };
    addEventListener('message', onMessage);
    postMessage({ tether: 'claude-active', id, session }, '*');
    setTimeout(() => { removeEventListener('message', onMessage); resolve(false); }, 300);
  });
  if (extension) return 'tether extension';

  const MARK = '🤖 ';
  const keep = () => {
    if (!document.title.startsWith(MARK)) document.title = MARK + document.title;
  };
  keep();
  if (window.__claudeTabMarker) return 'already marked';
  window.__claudeTabMarker = true;
  new MutationObserver(keep).observe(document.head || document.documentElement,
    { subtree: true, childList: true, characterData: true });
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
