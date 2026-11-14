// End-to-end check of the Tether extension in a throwaway Chrome: a temporary
// profile, no debugging port, nothing shared with your own Chrome.
//
//   npm install --no-save puppeteer-core@24
//   node tests/extension-e2e.mjs [folder-for-screenshots]
//
// Set CHROME_PATH if Chrome isn't in the default Windows or macOS location. It acts the
// way Claude Code does (a click, typing, a navigation, then nothing for 20 s)
// and checks the tab group, the tab icon, the hook's fallback and page errors.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'tether-e2e-'));
const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const HOOK = fs.readFileSync(path.join(repo, 'hooks', 'claude-tab-marker.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const fav = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#3b82f6"/></svg>';
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="icon" href="/fav.svg" type="image/svg+xml">
<style>body{margin:0;font:16px system-ui;background:#f7f5f2;color:#222}
header{background:#fff;padding:18px 32px;border-bottom:1px solid #e7e2da;font-weight:700}
main{padding:32px;max-width:760px} .card{background:#fff;border:1px solid #e7e2da;border-radius:12px;padding:22px;margin:0 0 18px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#2b2a28;color:#fff}
input{font:inherit;padding:10px 12px;border:1px solid #cfc8bd;border-radius:8px;width:280px}</style></head>
<body><header>Acme Admin</header><main>${body}</main></body></html>`;
// a page that stays busy for a few seconds after load, like a big web app starting up
const busyPage = `<!doctype html><title>Busy</title><p>busy</p><script>
const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms); };
let n = 0; const tick = () => { busy(400); if (++n < 6) setTimeout(tick, 0); };
addEventListener('load', () => setTimeout(tick, 0));
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/fav.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(fav); }
  if (req.url === '/busy') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(busyPage); }
  const html = req.url.startsWith('/b') ? page('Reports', '<div class="card"><h2>Reports</h2><p>Monthly numbers.</p></div>'.repeat(3))
    : page('Dashboard', '<div class="card"><h2>Alerts</h2><p>Turn alerts on for a trader.</p><button id="go">Save changes</button></div><div class="card"><label>Name<br><input id="name"></label></div><div class="card"><p>More content</p></div>');
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true, pipe: true, enableExtensions: [path.join(repo, 'extension')],
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 760 },
});
const errors = [];
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
const sw = await swTarget.worker();
const tab = (await browser.pages())[0] || await browser.newPage();
tab.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
tab.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const hook = () => tab.evaluate(`(${HOOK})()`);
const favicon = () => tab.evaluate(() => [...document.querySelectorAll('link[rel~="icon" i]')].map((l) => (l.hasAttribute('data-tether') ? 'tether:' : 'site:') + l.getAttribute('href').slice(0, 40)));
const groups = () => sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => `${g.title}/${g.color}`));

await tab.bringToFront();
await tab.goto(`${base}/a`, { waitUntil: 'load' });
ok('page has its own favicon before Claude', JSON.stringify(await favicon()) === '["site:/fav.svg"]', JSON.stringify(await favicon()));
const r1 = await hook();
ok('hook sees the extension', r1 === 'tether extension', r1);
await sleep(900);
await tab.screenshot({ path: path.join(out, '1-working.png') });
const f1 = await favicon();
ok('hourglass replaces the site icon', f1.length === 1 && f1[0].startsWith('tether:data:image/svg'), JSON.stringify(f1));
ok('title untouched', (await tab.title()) === 'Dashboard', await tab.title());
await sleep(300);
ok('tab is in an orange "Claude" group', JSON.stringify(await groups()) === '["Claude/orange"]', JSON.stringify(await groups()));

// collect the favicon animation frames
const frames = new Set();
for (let i = 0; i < 40; i++) { frames.add(await tab.evaluate(() => document.querySelector("link[data-tether]")?.href)); await sleep(60); }
ok("favicon animates", frames.size >= 5, `${frames.size} frames`);

await tab.click('#go');
ok('hook after click', (await hook()) === 'tether extension');
await sleep(520);
await tab.screenshot({ path: path.join(out, '2-click.png') });
await sleep(700);

await tab.type('#name', 'Ayesha Khan', { delay: 20 });
await hook();
await sleep(900);
await tab.screenshot({ path: path.join(out, '3-typing.png') });

// Claude navigates: the new page picks up the working look before any hook runs
await tab.goto(`${base}/b`, { waitUntil: 'load' });
await sleep(700);
await tab.screenshot({ path: path.join(out, '4-navigated.png') });
const f4 = await favicon();
ok('working look continues after navigation', f4.length === 1 && f4[0].startsWith('tether:'), JSON.stringify(f4));
await hook();

console.log('waiting 21 s for "done" ...');
await sleep(21000);
await tab.screenshot({ path: path.join(out, '5-done.png') });
const doneHref = await tab.evaluate(() => document.querySelector('link[data-tether]')?.href || '');
ok('green check when Claude stops', decodeURIComponent(doneHref).includes('#2EA36A'));
// you're looking at another tab: the check waits for you
const elsewhere = await browser.newPage();
await elsewhere.bringToFront();
await sleep(6500);
const stillDone = await tab.evaluate(() => document.querySelector('link[data-tether]')?.href || '');
ok('green check waits while you look elsewhere', decodeURIComponent(stillDone).includes('#2EA36A'));
await elsewhere.close();
await tab.bringToFront();
await sleep(6000);
const f6 = await favicon();
ok('site icon restored after the tab was seen', JSON.stringify(f6) === '["site:/fav.svg"]', JSON.stringify(f6));
await tab.screenshot({ path: path.join(out, '6-idle.png') });

// favicon frames, big and at tab size
const imgs = [...frames, doneHref].filter(Boolean).map((h) => `<div style="text-align:center"><img src="${h}" width="64"><br><img src="${h}" width="16"></div>`).join('');
const sheet = await browser.newPage();
await sheet.setViewport({ width: 760, height: 120 });
await sheet.setContent(`<body style="margin:12px;background:#fff;display:flex;gap:14px">${imgs}</body>`);
await sheet.screenshot({ path: path.join(out, '7-favicons.png') });
await sheet.setContent('<body style="margin:12px;background:#202124;display:flex;gap:14px">' + imgs + '</body>');
await sheet.screenshot({ path: path.join(out, '8-favicons-dark.png') });

// without the extension the hook falls back to its in-page marker (about:blank gets no content script)
const plain = await browser.newPage();
await plain.setContent('<title>Plain</title><p>no content script here</p>');
const t2 = Date.now();
const r2 = await plain.evaluate(`(${HOOK})()`);
const ms2 = Date.now() - t2;
ok('fallback marker without the extension', r2 === 'marked', r2);
ok('the fallback decides quickly', ms2 < 1000, `${ms2} ms`);

// A page still busy after load: Chrome can run a timer before a message that
// was sent earlier, so a hook that waited 300 ms for the extension's answer
// often gave up and drew the old marker on top of the extension's look.
const busyTab = await browser.newPage();
const busyResults = [];
for (let i = 0; i < 4; i++) {
  await busyTab.goto(`${base}/busy`, { waitUntil: 'load' });
  busyResults.push(await busyTab.evaluate(`(${HOOK})()`));
}
ok('hook sees the extension on a busy page', busyResults.every((r) => r === 'tether extension'), JSON.stringify(busyResults));
ok('no old marker on the busy page', (await busyTab.$$('[data-claude-tab-marker]')).length === 0);
await busyTab.close(); // its long tasks would slow the tabs below, which may share its process

// A page the hook once marked itself (the extension came later, or an older
// hook gave up too soon): the next action takes that marker off again.
const left = await browser.newPage();
await left.goto(`${base}/a`, { waitUntil: 'load' });
const NO_EXTENSION = HOOK.split("'claude-active'").join("'nobody-listens'"); // as if no extension answered
const marks = () => left.evaluate(() => ({ n: document.querySelectorAll('[data-claude-tab-marker]').length, title: document.title }));
const r3 = await left.evaluate(`(${NO_EXTENSION})()`);
const m3 = await marks();
ok('setup: page marked as if the extension were missing', r3 === 'marked' && m3.n === 2 && m3.title === '🤖 Dashboard', `${r3} ${JSON.stringify(m3)}`);
const r4 = await left.evaluate(`(${HOOK})()`);
await left.evaluate(() => { document.title = 'Dashboard 2'; });
await sleep(100);
const m4 = await marks();
ok('the extension\'s answer removes the old marker and title prefix', r4 === 'tether extension' && m4.n === 0 && m4.title === 'Dashboard 2', `${r4} ${JSON.stringify(m4)}`);
// a page marked by a hook from before this change (no way to stop its title keeper)
await left.evaluate(() => {
  window.__claudeTabMarker = true;
  const d = document.createElement('div');
  d.setAttribute('data-claude-tab-marker', 'badge');
  document.body.append(d);
});
const r5 = await left.evaluate(`(${HOOK})()`);
ok('frame and badge from an older hook are removed too', r5 === 'tether extension' && (await marks()).n === 0, r5);

// One group per Claude session, named after the chat. The broker fills in
// { id, title }; here the test posts what the hook would post.
const signal = (page, session) => page.evaluate((s) => window.postMessage({ tether: 'claude-active', id: 't', session: s }, '*'), session);
const jobs = { id: 'c111', title: 'Daytime job apply run' };
const kyc = { id: 'c222', title: 'Custom KYC hosting' };
const j1 = await browser.newPage(); await j1.goto(`${base}/a`, { waitUntil: 'load' });
const j2 = await browser.newPage(); await j2.goto(`${base}/b`, { waitUntil: 'load' });
const k1 = await browser.newPage(); await k1.goto(`${base}/a`, { waitUntil: 'load' });
// both tabs of one session at the same moment: still one group
await Promise.all([signal(j1, jobs), signal(j2, jobs)]);
await signal(k1, kyc);
// title -> tabs in it; "1+1" would mean two groups with the same name
const groupsWithTabs = () => sw.evaluate(async () => {
  const out = {};
  for (const g of await chrome.tabGroups.query({})) {
    const n = (await chrome.tabs.query({ groupId: g.id })).length;
    out[g.title] = out[g.title] === undefined ? n : `${out[g.title]}+${n}`;
  }
  return out;
});
// a slow test machine may take a moment: look again until it's right, for up to 5 s
const groupsUntil = async (cond) => {
  const end = Date.now() + 5000;
  let g = await groupsWithTabs();
  while (!cond(g) && Date.now() < end) { await sleep(150); g = await groupsWithTabs(); }
  return g;
};
let g2 = await groupsUntil((g) => g['Daytime job apply run'] === 2 && g['Custom KYC hosting'] === 1);
ok('each session gets its own group, named after the chat',
  g2['Daytime job apply run'] === 2 && g2['Custom KYC hosting'] === 1, JSON.stringify(g2));
await signal(k1, { id: 'c222', title: '' });   // title not known this time
await sleep(500);
g2 = await groupsWithTabs();
ok('a missing title never renames a group back to "Claude"', g2['Custom KYC hosting'] === 1, JSON.stringify(g2));
await signal(k1, { id: 'c222', title: 'KYC hosting on Hetzner' });
g2 = await groupsUntil((g) => g['KYC hosting on Hetzner'] === 1);
ok('a new chat title renames its group', g2['KYC hosting on Hetzner'] === 1, JSON.stringify(g2));

ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
