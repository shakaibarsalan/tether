() => {
  // Marks a tab Claude Code is driving: "🤖 " in front of the title, a thin
  // orange frame and a small badge. Safe to run again and again: it only
  // installs itself once per page, and keeps the title prefix when the site
  // changes its title. Nothing here blocks clicks (pointer-events: none).
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
