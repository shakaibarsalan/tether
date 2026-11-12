// End-to-end check of the Tether extension in a throwaway Chrome: a temporary
// profile, no debugging port, nothing shared with your own Chrome.
//
//   npm install --no-save puppeteer-core@24
//   node tests/extension-e2e.mjs [folder-for-screenshots]
//
// Set CHROME_PATH if Chrome isn't in the default Windows location. It acts the
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
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
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
const server = http.createServer((req, res) => {
  if (req.url === '/fav.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(fav); }
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
const r2 = await plain.evaluate(`(${HOOK})()`);
ok('fallback marker without the extension', r2 === 'marked', r2);

// One group per Claude session, named after the chat. The broker fills in
// { id, title }; here the test posts what the hook would post.
const signal = (page, session) => page.evaluate((s) => window.postMessage({ tether: 'claude-active', id: 't', session: s }, '*'), session);
const jobs = { id: 'c111', title: 'Daytime job apply run' };
const kyc = { id: 'c222', title: 'Custom KYC hosting' };
const j1 = await browser.newPage(); await j1.goto(`${base}/a`, { waitUntil: 'load' }); await signal(j1, jobs);
const j2 = await browser.newPage(); await j2.goto(`${base}/b`, { waitUntil: 'load' }); await signal(j2, jobs);
const k1 = await browser.newPage(); await k1.goto(`${base}/a`, { waitUntil: 'load' }); await signal(k1, kyc);
await sleep(800);
const groupsWithTabs = () => sw.evaluate(async () => {
  const out = {};
  for (const g of await chrome.tabGroups.query({})) out[g.title] = (await chrome.tabs.query({ groupId: g.id })).length;
  return out;
});
let g2 = await groupsWithTabs();
ok('each session gets its own group, named after the chat',
  g2['Claude · Daytime job apply run'] === 2 && g2['Claude · Custom KYC hosting'] === 1, JSON.stringify(g2));
await signal(k1, { id: 'c222', title: '' });   // title not known this time
await sleep(500);
g2 = await groupsWithTabs();
ok('a missing title never renames a group back to "Claude"', g2['Claude · Custom KYC hosting'] === 1, JSON.stringify(g2));
await signal(k1, { id: 'c222', title: 'KYC hosting on Hetzner' });
await sleep(500);
g2 = await groupsWithTabs();
ok('a new chat title renames its group', g2['Claude · KYC hosting on Hetzner'] === 1, JSON.stringify(g2));

ok('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
