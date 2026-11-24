// Claude doesn't pull Chrome to the front. Checked against a fake Chrome that
// records what the broker sends it: a real Chrome would take the screen to show
// it, and headless Chrome has no window focus to look at.
//
//   (cd broker && npm ci)   then   node tests/broker-focus.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repo, 'broker', 'package.json'));
const { WebSocket, WebSocketServer } = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

// The fake Chrome: answers what the broker needs, and remembers every command.
const seen = [];
let oldChrome = false;       // refuse createTarget with "focus", like a Chrome that doesn't know it
let extensionHere = true;    // what the Tether extension answers in the page
let chrome = null;
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
fake.on('connection', (ws) => {
  chrome = ws;
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    seen.push(m);
    const reply = (body) => ws.send(JSON.stringify({ id: m.id, ...body, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
    if (m.method === 'Target.createTarget' && oldChrome && m.params.focus !== undefined) {
      reply({ error: { code: -32602, message: 'Invalid parameters: focus' } });
      return;
    }
    if (m.method === 'Runtime.evaluate' && m.params.awaitPromise && m.params.expression.includes('claude-front')) {
      reply({ result: { result: { type: 'boolean', value: extensionHere } } });
      return;
    }
    const result = {
      'Target.attachToBrowserTarget': { sessionId: `browser-${m.id}` },
      'Target.createTarget': { targetId: `tab-${m.id}` },
      'Target.getTargetInfo': { targetInfo: { targetId: m.params && m.params.targetId, browserContextId: 'profile-1' } },
      'Target.attachToTarget': { sessionId: `page-of-${m.params && m.params.targetId}` },
    }[m.method] || {};
    reply({ result });
  });
});
await new Promise((r) => fake.once('listening', r));
// the page in a tab loads: what Chrome tells the client that enabled the Page domain
const load = async (session, url) => {
  chrome.send(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url } }, sessionId: session }));
  chrome.send(JSON.stringify({ method: 'Page.domContentEventFired', params: { timestamp: 1 }, sessionId: session }));
  await sleep(250);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-focus-'));
fs.writeFileSync(path.join(tmp, 'DevToolsActivePort'), `${fake.address().port}\n/devtools/browser/fake\n`);
const port = 9400 + Math.floor(Math.random() * 400);
const broker = spawn(process.execPath, [path.join(repo, 'broker', 'tether-broker.mjs'), '--port', String(port), '--lazy',
  '--no-notify', '--insecure-allow-any-client', '--chrome-user-data', tmp, '--log', path.join(tmp, 'broker.log')], { stdio: 'ignore' });
const done = (code) => { broker.kill(); fake.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } process.exit(code); };
setTimeout(() => { console.log(results.join('\n')); console.log('FAIL  timed out'); done(2); }, 30000).unref();

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* not yet */ }
  await sleep(100);
}

// A client, like chrome-devtools-mcp
const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/tether`);
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const replies = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id !== undefined) replies.set(m.id, m); });
let n = 0;
const send = async (method, params = {}, sessionId) => {
  const id = ++n;
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  for (let i = 0; i < 100 && !replies.has(id); i++) await sleep(30);
  return replies.get(id);
};
const since = (i) => seen.slice(i);
const names = (list) => JSON.stringify(list.map((m) => m.method));
const probes = (list, session) => list.filter((m) => m.method === 'Runtime.evaluate' && m.sessionId === session && m.params.expression.includes('claude-front'));
const raised = (list) => list.some((m) => m.method === 'Target.activateTarget' || m.method === 'Page.bringToFront');
const newTab = async (params = { url: 'about:blank' }) => {
  const r = await send('Target.createTarget', params);
  const target = r && r.result && r.result.targetId;
  await sleep(150);
  const a = await send('Target.attachToTarget', { targetId: target, flatten: true });
  return { target, page: a && a.result && a.result.sessionId };
};

// 1. A new tab opens in the background, and the extension shows it once its page is there.
const first = await newTab();
const createdWith = seen.filter((m) => m.method === 'Target.createTarget')[0]?.params || {};
ok("a new tab opens without bringing Chrome's window to the front (focus: false)", Boolean(first.target) && createdWith.focus === false, JSON.stringify(createdWith));
let mark = seen.length;
await load(first.page, 'about:blank');
ok('the blank page it starts with is left alone', since(mark).length === 0, names(since(mark)));
mark = seen.length;
await load(first.page, 'https://example.com/');
ok('once its page is there, the extension is asked to select it in its window', probes(since(mark), first.page).length === 1, names(since(mark)));
ok("...and Chrome's window is never raised", !raised(since(mark)), names(since(mark)));
mark = seen.length;
await load(first.page, 'https://example.com/next');
ok('a tab is shown only once', since(mark).length === 0, names(since(mark)));

// 2. Without the extension: Chrome's own way, so the tab is still shown.
extensionHere = false;
const second = await newTab();
mark = seen.length;
await load(second.page, 'https://example.org/');
ok("without the extension the tab is shown Chrome's way", since(mark).some((m) => m.method === 'Target.activateTarget' && m.params.targetId === second.target), names(since(mark)));
extensionHere = true;

// 3. A page the extension can't enter (data:, chrome:): Chrome's way at once.
const third = await newTab();
mark = seen.length;
await load(third.page, 'data:text/html,<p>hi');
ok("a data: page is shown Chrome's way, without asking the extension",
  probes(since(mark), third.page).length === 0 && since(mark).some((m) => m.method === 'Target.activateTarget'), names(since(mark)));

// 4. Explicit background tabs and explicit focus are left as asked.
await send('Target.createTarget', { url: 'about:blank', background: true });
await send('Target.createTarget', { url: 'about:blank', focus: true });
const asked = seen.filter((m) => m.method === 'Target.createTarget').slice(-2).map((m) => m.params);
ok('background: true and focus: true are left as asked', asked[0].focus === undefined && asked[1].focus === true, JSON.stringify(asked));

// 5. "Bring to front" on the chat's tab: selected in its window, Chrome stays put.
mark = seen.length;
const front = await send('Page.bringToFront', {}, first.page);
await sleep(250);
ok('"bring to front" is answered', front && front.result && !front.error, JSON.stringify(front));
ok("...through the extension, and never raising Chrome's window", probes(since(mark), first.page).length === 1 && !raised(since(mark)), names(since(mark)));
mark = seen.length;
const act = await send('Target.activateTarget', { targetId: first.target });
await sleep(250);
ok('Target.activateTarget the same way', act && act.result && probes(since(mark), first.page).length === 1 && !raised(since(mark)), names(since(mark)));

// 6. The user's tab is never selected or raised.
mark = seen.length;
const theirs = await send('Target.activateTarget', { targetId: 'someone-elses-tab' });
await sleep(250);
ok("the user's tab is left where it is", theirs && theirs.result && since(mark).length === 0, names(since(mark)));

// 7. A Chrome that doesn't know "focus": the tab still opens, the way it was asked.
oldChrome = true;
const old = await send('Target.createTarget', { url: 'about:blank#old' });
const tries = seen.filter((m) => m.method === 'Target.createTarget' && m.params.url === 'about:blank#old');
ok('an older Chrome still gets its new tab', old && old.result && old.result.targetId && tries.at(-1).params.focus === undefined,
  `${tries.length} tries, ${JSON.stringify(old)}`);

ws.close();
console.log(results.join('\n'));
done(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
