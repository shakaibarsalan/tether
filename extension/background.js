// Tether background (service worker).
//
// Content scripts tell it when Claude starts or stops using a tab. Each Claude
// Code session gets its own orange tab group per window, named after the chat
// ("Daytime job apply run"); the Tether broker supplies the session's
// id and title. Without them (no broker) tabs share one "Claude" group. It also
// remembers, per tab, when Claude last acted, so a page Claude just navigated
// to picks up the "working" look straight away.
//
// It has no network access and listens to nothing outside this browser.

const TITLE = 'Claude';
const COLOR = 'orange';
const IDLE_MS = 20000; // keep in step with content.js
const MAX_TITLE = 34;

const get = async (k, fallback) => {
  const v = (await chrome.storage.session.get(k))[k];
  return v === undefined ? fallback : v;
};
const put = (k, v) => chrome.storage.session.set({ [k]: v });

const tabKey = (tabId) => `tab:${tabId}`;
const getRecord = (tabId) => get(tabKey(tabId), { last: 0, done: true, grouped: false });

// The chat's name itself (Chrome shows only about 20 characters on the group
// chip, so no "Claude ·" prefix; the orange colour says it's Claude). "Claude"
// until the session has a name.
function groupTitle(session) {
  const t = session && session.title ? session.title.trim() : '';
  if (!t) return TITLE;
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

function cleanSession(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !/^[\w-]{1,40}$/.test(s.id)) return null;
  return { id: s.id, title: typeof s.title === 'string' ? s.title.slice(0, 80) : '' };
}

async function groupInfo(groupId) {
  try { return await chrome.tabGroups.get(groupId); } catch { return null; }
}

// Groups this extension made (their titles vary, so they're tracked by id).
async function isOurGroup(groupId) {
  if ((await get('groups', [])).includes(groupId)) return true;
  const g = await groupInfo(groupId);
  return Boolean(g && g.title === TITLE && g.color === COLOR); // a group from an older version
}

async function rememberGroup(groupId) {
  const list = await get('groups', []);
  if (!list.includes(groupId)) { list.push(groupId); await put('groups', list.slice(-200)); }
}

// This session's group in this window, if it still exists.
async function findGroup(windowId, session) {
  const k = `group:${windowId}:${session ? session.id : '-'}`;
  const id = await get(k, null);
  if (id !== null) {
    const g = await groupInfo(id);
    if (g && g.windowId === windowId) return { id, k };
  }
  if (!session) {
    const shared = await chrome.tabGroups.query({ windowId, title: TITLE, color: COLOR });
    if (shared.length) return { id: shared[0].id, k };
  }
  return { id: null, k };
}

// Put the tab in its session's group, creating the group if needed. A tab the
// user put in a group of their own, or took out of ours, is left where it is.
async function groupTab(tab, rec, session) {
  if (tab.pinned) return;
  if (tab.groupId !== -1 && !(await isOurGroup(tab.groupId))) return;
  if (tab.groupId === -1 && rec.grouped) return;
  const { id, k } = await findGroup(tab.windowId, session);
  let groupId = id;
  if (groupId === null) {
    groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await put(k, groupId);
    await rememberGroup(groupId);
  } else if (tab.groupId !== groupId) {
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
  }
  const g = await groupInfo(groupId);
  let title = groupTitle(session);
  // a new session's title may not be known yet: never swap a chat name back to plain "Claude"
  if (title === TITLE && g && g.title) title = g.title;
  if (g && (g.color !== COLOR || g.title !== title)) await chrome.tabGroups.update(groupId, { title, color: COLOR });
  rec.grouped = true;
}

async function handle(msg, tab) {
  const rec = await getRecord(tab.id);
  switch (msg.type) {
    case 'tether:hello':
      return { working: !rec.done && Date.now() - rec.last < IDLE_MS, last: rec.last };
    case 'tether:working': {
      rec.last = Date.now();
      rec.done = false;
      const session = cleanSession(msg.session) || rec.session || null;
      if (session) rec.session = session;
      try { await groupTab(tab, rec, session); } catch (e) { /* e.g. the tab was dragged mid-way */ }
      await put(tabKey(tab.id), rec);
      return { ok: true };
    }
    case 'tether:done':
      rec.done = true;
      await put(tabKey(tab.id), rec);
      return { ok: true };
    default:
      return { ok: false };
  }
}

// One message at a time: two tabs of the same session that speak up together
// would otherwise both find no group yet, and the chat would get two groups.
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab || sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  const run = queue.then(() => handle(msg, sender.tab));
  queue = run.catch(() => {});
  run.then(sendResponse, () => sendResponse({ ok: false }));
  return true; // answer asynchronously
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
});
