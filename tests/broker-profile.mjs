// Which Chrome profile Claude's tabs open in, and a chat's tabs kept across a
// broker restart. Against a fake Chrome with two profiles that records what the
// broker sends it (a real Chrome would show windows).
//
//   (cd broker && npm ci)   then   node tests/broker-profile.mjs
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// The ID Chrome gives the unpacked extension in this repo (what the broker looks for).
const extDir = fs.realpathSync(path.join(repo, 'extension'));
const tetherId = createHash('sha256').update(Buffer.from(extDir, process.platform === 'win32' ? 'utf16le' : 'utf8')).digest('hex')
  .slice(0, 32).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

// The fake Chrome: the default profile (no logins, no extension) and yours.
const seen = [];
const tabs = new Map([['user-tab', 'your-profile'], ['default-tab', 'default-profile']]);   // tab -> profile
let workerRunning = false;   // the extension's service worker, in your profile
let n = 0;
const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
fake.on('connection', (ws) => ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  seen.push(m);
  const reply = (result) => ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
  const p = m.params || {};
  if (m.method === 'Target.attachToBrowserTarget') reply({ sessionId: `browser-${++n}` });
  else if (m.method === 'Target.createTarget') {
    const t = `tab-${++n}`;
    tabs.set(t, p.browserContextId || 'default-profile');
    reply({ targetId: t });
  } else if (m.method === 'Target.getTargetInfo') reply({ targetInfo: { targetId: p.targetId, type: 'page', browserContextId: tabs.get(p.targetId) } });
  else if (m.method === 'Target.getTargets') {
    const infos = [...tabs].map(([t, ctx]) => ({ targetId: t, type: 'page', url: 'https://example.com/', browserContextId: ctx }));
    if (workerRunning) infos.push({ targetId: 'sw', type: 'service_worker', url: `chrome-extension://${tetherId}/background.js`, browserContextId: 'your-profile' });
    infos.push({ targetId: 'other-sw', type: 'service_worker', url: `chrome-extension://${'b'.repeat(32)}/background.js`, browserContextId: 'default-profile' });
    reply({ targetInfos: infos });
  } else if (m.method === 'Target.attachToTarget') reply({ sessionId: `page-of-${p.targetId}` });
  else reply({});
}));
await new Promise((r) => fake.once('listening', r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-profile-'));
const portFile = (wsPath) => fs.writeFileSync(path.join(tmp, 'DevToolsActivePort'), `${fake.address().port}\n${wsPath}\n`);
portFile('/devtools/browser/run-1');
const brokers = [];
const done = (code) => { for (const b of brokers) b.kill(); fake.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } process.exit(code); };
setTimeout(() => { console.log(results.join('\n')); console.log('FAIL  timed out'); done(2); }, 60000).unref();

async function startBroker() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const b = spawn(process.execPath, [path.join(repo, 'broker', 'tether-broker.mjs'), '--port', String(port), '--lazy', '--no-notify',
    '--insecure-allow-any-client', '--chrome-user-data', tmp, '--log', path.join(tmp, 'broker.log')],
  { stdio: 'ignore', env: { ...process.env, TETHER_HOME: path.join(tmp, 'home'), TETHER_TEST_CLAUDE_PID: String(process.pid) } });
  brokers.push(b);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* not yet */ }
    await sleep(100);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/tether`);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const replies = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id !== undefined) replies.set(m.id, m); });
  let id = 0;
  const send = async (method, params = {}, sessionId) => {
    const i = ++id;
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
    for (let k = 0; k < 150 && !replies.has(i); k++) await sleep(30);
    return replies.get(i);
  };
  return { b, ws, send, port };
}
const lastCreate = () => seen.filter((m) => m.method === 'Target.createTarget').at(-1).params;
const log = () => (fs.existsSync(path.join(tmp, 'broker.log')) ? fs.readFileSync(path.join(tmp, 'broker.log'), 'utf8') : '');

// 1. No profile with the extension known yet: Chrome's default, as before, and the log says so.
let one = await startBroker();
const t1 = (await one.send('Target.createTarget', { url: 'about:blank' })).result.targetId;
ok("with no profile known to have the extension, a tab opens in Chrome's default", lastCreate().browserContextId === undefined, JSON.stringify(lastCreate()));
ok('...and the log says so', /no profile with the Tether extension found/.test(log()));

// 2. The extension's service worker runs in your profile: the chat's next tab goes there,
//    even though its first tab is in the default profile. Another extension doesn't count.
workerRunning = true;
await one.send('Target.createTarget', { url: 'about:blank' });
ok("once the extension is seen in your profile, the chat's next tab opens there", lastCreate().browserContextId === 'your-profile', JSON.stringify(lastCreate()));
ok('...and the log says so', /its tabs open in the profile with the Tether extension/.test(log()));

// 3. The worker stops (idle): the profile is still known.
workerRunning = false;
await one.send('Target.createTarget', { url: 'about:blank' });
ok('the profile is remembered while the extension sleeps', lastCreate().browserContextId === 'your-profile', JSON.stringify(lastCreate()));

// 4. A profile asked for explicitly is left as asked.
await one.send('Target.createTarget', { url: 'about:blank', browserContextId: 'test-context' });
ok('a profile the client asks for is left as asked', lastCreate().browserContextId === 'test-context');

// 5. The broker restarts (same Chrome run): the chat still owns its tab, not the user's.
await sleep(1500);   // saved within a second
one.b.kill(); one.ws.close();
await sleep(300);
let two = await startBroker();
const adopt = async (port) => (await (await fetch(`http://127.0.0.1:${port}/adopt`, { method: 'POST',
  body: JSON.stringify({ pid: process.pid, chat: true }) })).json()).lent;
ok('no lending without a "not yours" first', (await adopt(two.port)) === 0);
let page = (await two.send('Target.attachToTarget', { targetId: t1, flatten: true })).result.sessionId;
let nav = await two.send('Page.navigate', { url: 'https://example.com/again' }, page);
ok('after a broker restart the chat still owns its tab', nav && !nav.error, JSON.stringify(nav && nav.error));
const userPage = (await two.send('Target.attachToTarget', { targetId: 'user-tab', flatten: true })).result.sessionId;
const theirs = await two.send('Page.navigate', { url: 'https://example.com/' }, userPage);
ok("...and the user's tab is still not the chat's", theirs && theirs.error && /didn't open/.test(theirs.error.message), JSON.stringify(theirs));
await two.send('Target.createTarget', { url: 'about:blank' });
ok('...and its profile is still known', lastCreate().browserContextId === 'your-profile', JSON.stringify(lastCreate()));

// 5b. The user lets the chat use their tabs. Lending only counts right after the
//     broker told the chat "not yours" (selecting its own tab twice lends nothing).
ok('right after "not yours", the chat is lent the user\'s tabs', (await adopt(two.port)) === 1);
const nowOk = await two.send('Page.navigate', { url: 'https://example.com/lent' }, userPage);
ok("...and may now use the user's tab", nowOk && !nowOk.error, JSON.stringify(nowOk && nowOk.error));
const closeIt = await two.send('Target.closeTarget', { targetId: 'user-tab' });
ok('...and close it', closeIt && !closeIt.error, JSON.stringify(closeIt && closeIt.error));
ok('...and the log says for the rest of the chat', /lent the user's tabs for the rest of the chat/.test(log()));

// 6. A new Chrome run (another port file): the old ids mean nothing.
two.b.kill(); two.ws.close();
await sleep(300);
portFile('/devtools/browser/run-2');
const three = await startBroker();
page = (await three.send('Target.attachToTarget', { targetId: t1, flatten: true })).result.sessionId;
nav = await three.send('Page.navigate', { url: 'https://example.com/' }, page);
ok('after Chrome restarts, nothing is carried over', nav && nav.error && /didn't open/.test(nav.error.message), JSON.stringify(nav));
three.ws.close();

console.log(results.join('\n'));
done(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
