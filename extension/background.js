// Tether background (service worker).
//
// Content scripts tell it when Claude starts or stops using a tab. It puts
// those tabs in an orange "Claude" tab group and remembers, per tab, when
// Claude last acted, so a page Claude just navigated to can pick up the
// "working" look straight away.
//
// It has no network access and listens to nothing outside this browser.

const TITLE = 'Claude';
const COLOR = 'orange';
const IDLE_MS = 20000; // keep in step with content.js

const key = (tabId) => `tab:${tabId}`;

async function getRecord(tabId) {
  const k = key(tabId);
  return (await chrome.storage.session.get(k))[k] || { last: 0, done: true, grouped: false };
}

async function setRecord(tabId, rec) {
  await chrome.storage.session.set({ [key(tabId)]: rec });
}

async function isOurGroup(groupId) {
  try {
    const g = await chrome.tabGroups.get(groupId);
    return g.title === TITLE && g.color === COLOR;
  } catch {
    return false;
  }
}

// Put the tab in this window's "Claude" group, creating it if needed. A tab
// the user already put in a group of their own, or took out of ours, is left
// where it is.
async function groupTab(tab, rec) {
  if (tab.pinned) return;
  if (tab.groupId !== -1) {
    if (await isOurGroup(tab.groupId)) rec.grouped = true;
    return;
  }
  if (rec.grouped) return; // the user took it out of the group
  const existing = await chrome.tabGroups.query({ windowId: tab.windowId, title: TITLE, color: COLOR });
  const groupId = await chrome.tabs.group(existing.length
    ? { groupId: existing[0].id, tabIds: [tab.id] }
    : { tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: TITLE, color: COLOR });
  rec.grouped = true;
}

async function handle(msg, tab) {
  const rec = await getRecord(tab.id);
  switch (msg.type) {
    case 'tether:hello':
      return { working: !rec.done && Date.now() - rec.last < IDLE_MS, last: rec.last };
    case 'tether:working':
      rec.last = Date.now();
      rec.done = false;
      try { await groupTab(tab, rec); } catch (e) { /* e.g. the tab was dragged mid-way */ }
      await setRecord(tab.id, rec);
      return { ok: true };
    case 'tether:done':
      rec.done = true;
      await setRecord(tab.id, rec);
      return { ok: true };
    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab || sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  handle(msg, sender.tab).then(sendResponse, () => sendResponse({ ok: false }));
  return true; // answer asynchronously
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(key(tabId));
});
