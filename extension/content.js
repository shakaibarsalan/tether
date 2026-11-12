// Tether content script: the look of a tab Claude Code is using.
//
// Chrome runs this in every page's top frame, in an "isolated world": it shares
// the page's DOM but not its JavaScript variables. It only draws: a soft orange
// glow around the page, a status pill, an orange cursor where Claude clicked,
// and an hourglass tab icon that turns into a green check when Claude is done.
// Everything sits in a closed shadow root with pointer-events: none, so it
// never gets in the way of clicks or typing, and the page's CSS can't touch it.
//
// How it knows Claude is here: after every chrome-devtools action, Tether's
// Claude Code hook runs a tiny script in the tab that posts
// { tether: 'claude-active' }. This script answers with an "ack", so the hook
// knows the extension is installed and skips its old in-page marker.
(() => {
  if (window.__tetherContent) return;
  window.__tetherContent = true;

  const IDLE_MS = 20000;          // no Claude action for this long: done
  const SEEN_MS = 4500;           // "done" and the green check stay until you've looked at the tab this long
  const CLICK_WINDOW_MS = 2500;   // a click this recent counts as Claude's
  const ORANGE = '#D97757';
  const GREEN = '#2EA36A';

  let state = 'idle';             // idle | working | done
  let lastSignal = 0;
  let idleTimer = 0;
  let seenTimer = 0;
  let faviconTimer = 0;
  let ui = null;
  let lastClick = null;
  let cursorShown = false;

  // ---------------------------------------------------------------- signals

  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.tether !== 'claude-active') return;
    try { postMessage({ tether: 'ack', id: String(d.id || '') }, '*'); } catch (err) { /* ignore */ }
    onSignal(true, Date.now(), cleanSession(d.session));
  });

  // Which Claude session this is ({ id, title }, filled in by the Tether broker),
  // so each session gets its own tab group named after the chat.
  function cleanSession(s) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^[\w-]{1,40}$/.test(s.id)) return null;
    const title = typeof s.title === 'string' ? s.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '';
    return { id: s.id, title };
  }

  addEventListener('pointerdown', (e) => {
    if (e.isTrusted) lastClick = { x: e.clientX, y: e.clientY, t: Date.now() };
  }, { capture: true, passive: true });

  // A page Claude just navigated to: keep the working look going.
  send('tether:hello', null, (res) => {
    if (res && res.working && state === 'idle') onSignal(false, res.last);
  });

  function send(type, extra, cb) {
    try {
      chrome.runtime.sendMessage({ type, ...(extra || {}) }, (res) => {
        void chrome.runtime.lastError; // the extension was reloaded: ignore
        if (cb) cb(res);
      });
    } catch (err) { /* extension context gone */ }
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function onSignal(fromClaude, at, session) {
    lastSignal = Math.max(lastSignal, at || Date.now());
    if (fromClaude) send('tether:working', { session: session || null });
    whenReady(() => {
      if (state !== 'working') startWorking();
      if (fromClaude) showAction();
    });
    clearTimeout(idleTimer);
    idleTimer = setTimeout(checkIdle, Math.max(250, lastSignal + IDLE_MS - Date.now()));
  }

  function checkIdle() {
    const left = lastSignal + IDLE_MS - Date.now();
    if (left > 100) { idleTimer = setTimeout(checkIdle, left); return; }
    if (state === 'working') finish();
  }

  // ----------------------------------------------------------------- states

  function startWorking() {
    state = 'working';
    clearTimeout(seenTimer);
    const u = ensureUI();
    u.glow.classList.add('on');
    setPill('working');
    startHourglass();
  }

  function finish() {
    state = 'done';
    send('tether:done', null);
    const u = ensureUI();
    u.glow.classList.remove('on');
    setPill('done');
    stopHourglass();
    setFavicon(DONE_ICON);
    armSeen();
  }

  function toIdle() {
    if (state !== 'done') return;
    state = 'idle';
    if (ui) ui.pill.classList.remove('on');
    restoreFavicon();
    hideCursor();
  }

  // "Claude is done" and the green check stay until you've actually looked at
  // the tab: it's in front AND Chrome is the window you're using. A tab that is
  // in front while you're in another app doesn't count.
  const seen = () => document.visibilityState === 'visible' && document.hasFocus();
  function armSeen() {
    clearTimeout(seenTimer);
    if (state === 'done' && seen()) seenTimer = setTimeout(() => { if (seen()) toIdle(); else armSeen(); }, SEEN_MS);
  }
  document.addEventListener('visibilitychange', armSeen);
  addEventListener('focus', armSeen);
  addEventListener('blur', () => clearTimeout(seenTimer));

  // ----------------------------------------------------------------- cursor

  // Claude's clicks are real mouse events, so the last click that came just
  // before the signal is where Claude clicked. When Claude typed instead, point
  // at the field it typed into.
  function showAction() {
    const now = Date.now();
    if (lastClick && now - lastClick.t < CLICK_WINDOW_MS) {
      moveCursor(lastClick.x, lastClick.y, true);
      lastClick = null;
      return;
    }
    const el = document.activeElement;
    if (el && el !== document.body && el !== document.documentElement &&
        (el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) moveCursor(r.left + Math.min(24, r.width / 2), r.top + r.height / 2, false);
    }
  }

  let restTimer = 0;

  // The cursor is a small arrow with a "Claude" tag, like a collaborator's
  // cursor. It glides to the spot, rings on a click, and after a moment at rest
  // the tag fades and the arrow shrinks back.
  function moveCursor(x, y, click) {
    const u = ensureUI();
    clearTimeout(restTimer);
    u.cursor.classList.remove('rest');
    const place = () => { u.cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`; };
    if (!cursorShown) {
      // first appearance: fade in a little up and left of the target, then glide
      u.cursor.style.transition = 'none';
      u.cursor.style.transform = `translate(${Math.round(x - 60)}px, ${Math.round(y - 40)}px)`;
      void u.cursor.offsetWidth;
      u.cursor.style.transition = '';
      cursorShown = true;
    }
    u.cursor.classList.add('on');
    requestAnimationFrame(place);
    if (click) {
      setTimeout(() => {
        u.ring.classList.remove('go');
        void u.ring.offsetWidth;
        u.ring.classList.add('go');
      }, 420);
    }
    restTimer = setTimeout(() => u.cursor.classList.add('rest'), 1600);
  }

  function hideCursor() {
    if (!ui) return;
    ui.cursor.classList.remove('on');
    cursorShown = false;
  }

  // -------------------------------------------------------------------- pill

  function setPill(kind) {
    const u = ensureUI();
    u.pillIcon.className = kind === 'working' ? 'icon spin' : 'icon check';
    u.pillText.textContent = kind === 'working' ? 'Claude is working in this tab' : 'Claude is done';
    u.pill.classList.toggle('done', kind === 'done');
    u.pill.classList.add('on');
  }

  // ------------------------------------------------------------------ favicon

  const svgUrl = (body) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`);

  // An hourglass drawn on the 16 px tab-icon grid: solid caps, a tinted glass,
  // and sand that runs from the top bulb to the bottom. Then it turns over.
  function hourglass(level, turn) {
    const r = (n) => Math.round(n * 100) / 100;
    const bulbs = 'M4 3v1.7C4 6.7 6.3 7.4 7.3 8 6.3 8.6 4 9.3 4 11.3V13h8v-1.7C12 9.3 9.7 8.6 8.7 8 9.7 7.4 12 6.7 12 4.7V3z';
    let body = `<path d="${bulbs}" fill="${ORANGE}" fill-opacity=".2" stroke="${ORANGE}" stroke-width="1.3" stroke-linejoin="round"/>`;
    if (level > 0) {
      const y = 4.1 + (1 - level) * 3.1;
      const w = 2.9 * level + 0.5;
      body += `<path d="M${r(8 - w)} ${r(y)}h${r(2 * w)}L8.6 7.9H7.4z" fill="${ORANGE}"/>`;
    }
    const b = 1 - level;
    if (b > 0) {
      const h = 0.7 + b * 3.4;
      const w = 1.6 + b * 2.1;
      body += `<path d="M${r(8 - w)} 12.3h${r(2 * w)}L8 ${r(12.3 - h)}z" fill="${ORANGE}"/>`;
      if (level > 0) body += `<rect x="7.55" y="7.9" width=".9" height="${r(12.3 - h - 7.9 + 0.3)}" fill="${ORANGE}"/>`;
    }
    body += `<rect x="2.5" y="1.2" width="11" height="2.1" rx="1" fill="${ORANGE}"/><rect x="2.5" y="12.7" width="11" height="2.1" rx="1" fill="${ORANGE}"/>`;
    return svgUrl(turn ? `<g transform="rotate(${turn} 8 8)">${body}</g>` : body);
  }

  // [icon, how long it shows]: five steps of sand, a pause, then a quick turn over
  const HOURGLASS = [
    [hourglass(1, 0), 300], [hourglass(0.75, 0), 300], [hourglass(0.5, 0), 300],
    [hourglass(0.25, 0), 300], [hourglass(0, 0), 420], [hourglass(0, 60), 110], [hourglass(0, 120), 110],
  ];
  const DONE_ICON = svgUrl(`<circle cx="8" cy="8" r="7.4" fill="${GREEN}"/><path d="M4.7 8.3l2.2 2.2 4.4-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`);

  let savedIcons = null;
  let iconLink = null;
  let iconObserver = null;

  function setFavicon(url) {
    const parent = document.head || document.documentElement;
    if (!savedIcons) {
      savedIcons = [...document.querySelectorAll('link[rel~="icon" i]')];
      savedIcons.forEach((l) => l.remove());
      // the site may set its own icon again while Claude works: keep ours on top
      iconObserver = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n !== iconLink && n.nodeName === 'LINK' && /(^|\s)icon(\s|$)/i.test(n.getAttribute('rel') || '')) {
              savedIcons.push(n);
              n.remove();
            }
          }
        }
      });
      iconObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    if (!iconLink || !iconLink.isConnected) {
      iconLink = document.createElement('link');
      iconLink.rel = 'icon';
      iconLink.type = 'image/svg+xml';
      iconLink.setAttribute('data-tether', '');
      parent.appendChild(iconLink);
    }
    iconLink.href = url;
  }

  function restoreFavicon() {
    stopHourglass();
    if (iconObserver) iconObserver.disconnect();
    iconObserver = null;
    if (iconLink) iconLink.remove();
    iconLink = null;
    if (!savedIcons) return;
    const parent = document.head || document.documentElement;
    if (savedIcons.length) {
      savedIcons.forEach((l) => parent.appendChild(l));
    } else {
      const l = document.createElement('link');
      l.rel = 'icon';
      l.href = new URL('/favicon.ico', location.href).href;
      parent.appendChild(l);
    }
    savedIcons = null;
  }

  function startHourglass() {
    stopHourglass();
    let i = 0;
    const tick = () => {
      const [icon, ms] = HOURGLASS[i++ % HOURGLASS.length];
      setFavicon(icon);
      faviconTimer = setTimeout(tick, ms);
    };
    tick();
  }

  function stopHourglass() {
    clearTimeout(faviconTimer);
    faviconTimer = 0;
  }

  // ---------------------------------------------------------------------- UI

  const CSS = `
    .glow { position: fixed; inset: 0; opacity: 0; transition: opacity .7s ease; }
    .glow.on { opacity: 1; }
    .halo {
      position: absolute; inset: 0;
      box-shadow:
        inset 0 0 14px rgba(217, 119, 87, .66),
        inset 0 0 26px rgba(217, 119, 87, .44),
        inset 0 0 40px rgba(217, 119, 87, .20),
        inset 0 0 110px 10px rgba(232, 144, 111, .07);
      animation: breathe 3.2s ease-in-out infinite;
    }
    .sheen {
      position: absolute; top: 0; left: 0; height: 2px; width: 34%;
      background: linear-gradient(90deg, rgba(255, 214, 190, 0), rgba(255, 214, 190, .95), rgba(255, 214, 190, 0));
      filter: blur(.4px);
      animation: sheen 3.6s cubic-bezier(.45, 0, .2, 1) infinite;
    }
    .sheen.low { top: auto; bottom: 0; animation-direction: reverse; animation-delay: -1.8s; opacity: .7; }
    @keyframes breathe { 0%, 100% { opacity: .78; } 50% { opacity: 1; } }
    @keyframes sheen { 0% { transform: translateX(-110%); } 100% { transform: translateX(310%); } }

    .cursor {
      position: fixed; left: 0; top: 0; width: 0; height: 0; opacity: 0;
      transition: transform .55s cubic-bezier(.22, 1, .36, 1), opacity .2s ease-out;
      will-change: transform;
    }
    .cursor.on { opacity: 1; }
    .arrow {
      position: absolute; left: -3px; top: -2px; width: 22px; height: 22px; overflow: visible;
      transform-origin: 3px 2px; transition: transform .2s ease-out, opacity .2s ease-out;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .3));
    }
    .tag {
      position: absolute; left: 14px; top: 16px; height: 22px; box-sizing: border-box; padding: 3px 8px;
      border-radius: 6px; background: ${ORANGE}; color: #fff; white-space: nowrap;
      font: 600 12px/16px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      box-shadow: 0 4px 14px rgba(217, 119, 87, .3), 0 1px 2px rgba(0, 0, 0, .2);
      transition: opacity .3s ease;
    }
    .cursor.rest .arrow { transform: scale(.8); opacity: .6; }
    .cursor.rest .tag { opacity: 0; }
    .ring {
      position: absolute; left: -15px; top: -15px; width: 30px; height: 30px; box-sizing: border-box;
      border-radius: 50%; border: 2px solid ${ORANGE}; opacity: 0;
    }
    .ring.go { animation: ring .65s ease-out forwards; }
    @keyframes ring { 0% { opacity: .9; transform: scale(.3); } 100% { opacity: 0; transform: scale(1.5); } }

    .pill {
      position: fixed; left: 50%; bottom: 22px; display: flex; align-items: center; gap: 10px;
      padding: 11px 16px 11px 13px; border-radius: 12px;
      background: #FAF9F5; color: #141413; border: .5px solid rgba(31, 30, 29, .3);
      font: 500 14px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      white-space: nowrap;
      box-shadow: 0 18px 40px rgba(0, 0, 0, .14), 0 4px 14px rgba(217, 119, 87, .24);
      opacity: 0; transform: translate(-50%, 16px) scale(.98);
      transition: opacity .35s ease, transform .5s cubic-bezier(.22, 1, .36, 1), box-shadow .4s ease;
    }
    .pill.on { opacity: 1; transform: translate(-50%, 0) scale(1); }
    .pill.done { box-shadow: 0 18px 40px rgba(0, 0, 0, .14), 0 4px 14px rgba(46, 163, 106, .22); }
    .icon { width: 15px; height: 15px; flex: none; border-radius: 50%; position: relative; }
    .icon.spin { border: 2px solid rgba(217, 119, 87, .22); border-top-color: ${ORANGE}; border-right-color: ${ORANGE}; box-sizing: border-box; animation: spin .85s linear infinite; }
    .icon.check { background: ${GREEN}; animation: pop .45s cubic-bezier(.34, 1.56, .64, 1); }
    .icon.check::after {
      content: ""; position: absolute; left: 5px; top: 2.6px; width: 3.4px; height: 7px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(42deg);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pop { 0% { transform: scale(.4); } 100% { transform: scale(1); } }

    @media (prefers-reduced-motion: reduce) {
      .halo, .sheen, .icon.spin, .icon.check, .ring.go { animation: none; }
      .sheen { display: none; }
      .cursor { transition: opacity .2s ease; }
    }
  `;

  function el(tag, cls, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function ensureUI() {
    if (ui) {
      if (!ui.host.isConnected) document.documentElement.appendChild(ui.host);
      return ui;
    }
    const host = document.createElement('tether-overlay');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; display: block;';
    // decoration only: keep it out of the accessibility tree, which is also what
    // Claude reads when it takes a page snapshot
    host.setAttribute('aria-hidden', 'true');
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];

    const glow = el('div', 'glow', root);
    el('div', 'halo', glow);
    el('div', 'sheen', glow);
    el('div', 'sheen low', glow);

    const cursor = el('div', 'cursor', root);
    const ring = el('div', 'ring', cursor);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'arrow');
    svg.setAttribute('viewBox', '0 0 18 18');
    const arrow = document.createElementNS(NS, 'path');
    // a slim, tilted pointer whose tip sits at (3, 2)
    arrow.setAttribute('d', 'M3 2 L15.9 8.2 L9.9 10.1 L7.6 16.2 Z');
    arrow.setAttribute('fill', ORANGE);
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.2');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
    cursor.appendChild(svg);
    const tag = el('div', 'tag', cursor);
    tag.textContent = 'Claude';

    const pill = el('div', 'pill', root);
    const pillIcon = el('span', 'icon', pill);
    const pillText = el('span', 'text', pill);

    document.documentElement.appendChild(host);
    ui = { host, glow, cursor, ring, pill, pillIcon, pillText };
    return ui;
  }
})();
