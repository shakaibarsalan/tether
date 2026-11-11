// Builds the Chrome Web Store images for the Tether extension:
//   store/screenshot-1-working.png, -2-typing.png, -3-done.png  (1280x800)
//   store/promo-small.png                                        (440x280)
// The extension runs for real in a throwaway Chrome on a demo page; each shot is
// then framed under a drawn tab strip that shows the orange "Claude" group.
//
//   npm install --no-save puppeteer-core@24     (repo root)
//   node store/make-assets.mjs
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'store');
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HOOK = fs.readFileSync(path.join(repo, 'hooks', 'claude-tab-marker.js'), 'utf8');
const LOGO = fs.readFileSync(path.join(repo, 'assets', 'logo.svg'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.error(new Date().toISOString().slice(11, 23), m);

// ---------------------------------------------------------------- demo site
const fav = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#4f46e5"/><path d="M4 11V5l4 4 4-4v6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>';
const rows = [
  ['#10482', 'Ayesha Khan', 'Pro plan', 'Paid', '$49.00'],
  ['#10481', 'Daniel Brooks', 'Starter', 'Paid', '$19.00'],
  ['#10480', 'Mei Lin', 'Pro plan', 'Refunded', '$49.00'],
  ['#10479', 'Omar Siddiqui', 'Team', 'Paid', '$199.00'],
  ['#10478', 'Sofia Rossi', 'Starter', 'Pending', '$19.00'],
];
const demo = `<!doctype html><html><head><meta charset="utf-8"><title>Orders · Northwind</title>
<link rel="icon" href="/fav.svg" type="image/svg+xml">
<style>
*{box-sizing:border-box} body{margin:0;font:14px/1.45 "Segoe UI",system-ui,sans-serif;color:#1f2430;background:#f6f7fb;display:flex;height:100vh}
aside{width:220px;background:#fff;border-right:1px solid #e6e8ef;padding:22px 16px}
.brand{font-weight:700;font-size:16px;display:flex;gap:9px;align-items:center;margin-bottom:26px}
.brand i{width:26px;height:26px;border-radius:7px;background:#4f46e5;display:inline-block}
nav a{display:block;padding:9px 12px;border-radius:8px;color:#5b6274;text-decoration:none;margin-bottom:2px}
nav a.on{background:#eef0ff;color:#3730a3;font-weight:600}
main{flex:1;padding:28px 36px;overflow:hidden}
h1{font-size:22px;margin:0 0 4px} .sub{color:#7a8194;margin:0 0 22px}
.grid{display:grid;grid-template-columns:1.6fr 1fr;gap:20px}
.card{background:#fff;border:1px solid #e6e8ef;border-radius:14px;padding:20px 22px}
table{width:100%;border-collapse:collapse} th{color:#8a90a2;font-weight:600;font-size:12px;text-align:left;padding:8px 6px;border-bottom:1px solid #eef0f4}
td{padding:11px 6px;border-bottom:1px solid #f1f2f6} .pill{font-size:12px;padding:2px 9px;border-radius:99px;background:#e9f8ef;color:#1d7a46}
.pill.r{background:#fdecec;color:#b42318}.pill.p{background:#fff5e0;color:#a15c00}
label{display:block;color:#5b6274;font-size:13px;margin:0 0 6px} input{width:100%;font:inherit;padding:10px 12px;border:1px solid #d5d9e3;border-radius:9px;margin-bottom:14px}
button{font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:9px;background:#1f2430;color:#fff}
</style></head><body>
<aside><div class="brand"><i></i>Northwind</div><nav><a>Overview</a><a class="on">Orders</a><a>Customers</a><a>Refunds</a><a>Settings</a></nav></aside>
<main><h1>Orders</h1><p class="sub">Last 7 days · 1,284 orders</p>
<div class="grid"><div class="card"><table><tr><th>Order</th><th>Customer</th><th>Plan</th><th>Status</th><th>Total</th></tr>
${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td><span class="pill ${r[3] === 'Refunded' ? 'r' : r[3] === 'Pending' ? 'p' : ''}">${r[3]}</span></td><td>${r[4]}</td></tr>`).join('')}
</table></div>
<div class="card"><h3 style="margin:0 0 14px;font-size:15px">Refund order #10480</h3>
<label>Customer name</label><input id="name" placeholder="Name on the order">
<label>Reason</label><input id="reason" value="Duplicate purchase">
<button id="go">Issue refund</button></div></div></main></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/fav.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(fav); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(demo);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/admin/orders`;

// --------------------------------------------------------------- the frame
step('launch');
const browser = await puppeteer.launch({
  executablePath: chromePath, headless: true, pipe: true, enableExtensions: [path.join(repo, 'extension')],
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
step('first tab');
const tab = (await browser.pages())[0] || await browser.newPage();
await tab.bringToFront();

function frame(shotB64, faviconUrl) {
  const t = (title, icon, opts = {}) => `<div class="tab ${opts.active ? 'active' : ''} ${opts.group ? 'grouped' : ''}"><img src="${icon}"><span>${title}</span><b>×</b></div>`;
  const dot = (c) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${c}"/></svg>`);
  return `<!doctype html><html><head><style>
  body{margin:0;width:1280px;height:800px;background:#dfe3e8;font:13px "Segoe UI",system-ui,sans-serif;overflow:hidden}
  .strip{height:44px;display:flex;align-items:flex-end;padding:0 10px;gap:2px;background:#dfe3e8}
  .group{align-self:center;margin:6px 4px 0 6px;background:#FA903E;color:#fff;font-weight:600;font-size:12px;padding:3px 9px;border-radius:7px}
  .tab{position:relative;height:36px;width:230px;display:flex;align-items:center;gap:9px;padding:0 12px;color:#3c4043;border-radius:9px 9px 0 0}
  .tab img{width:16px;height:16px} .tab span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .tab b{font-weight:400;color:#80868b}
  .tab.active{background:#fff;color:#202124}
  .tab.grouped::after{content:"";position:absolute;left:8px;right:8px;bottom:0;height:3px;border-radius:2px;background:#FA903E}
  .bar{height:36px;background:#fff;display:flex;align-items:center;padding:0 14px;gap:12px;border-bottom:1px solid #e3e3e3}
  .omni{flex:1;height:26px;border-radius:13px;background:#f1f3f4;display:flex;align-items:center;padding:0 14px;color:#5f6368}
  .nav{color:#5f6368;font-size:16px;letter-spacing:10px}
  img.page{display:block;width:1280px;height:720px}
  </style></head><body>
  <div class="strip"><div class="group">Claude</div>${t('Orders · Northwind', faviconUrl, { active: true, group: true })}${t('Inbox', dot('#d93025'))}${t('Team docs', dot('#1a73e8'))}</div>
  <div class="bar"><span class="nav">‹ › ⟳</span><div class="omni">northwind.example/admin/orders</div></div>
  <img class="page" src="data:image/png;base64,${shotB64}">
  </body></html>`;
}

step('sheet page');
const sheet = await browser.newPage();
await sheet.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await tab.bringToFront(); // a page in the background gets no animation frames, and clicks wait for them
async function save(name, shot, faviconUrl) {
  step('save ' + name);
  await sheet.setContent(frame(Buffer.from(shot).toString('base64'), faviconUrl), { waitUntil: 'load' });
  await sheet.screenshot({ path: path.join(out, name) });
  await tab.bringToFront();
}
const favicon = () => tab.evaluate(() => document.querySelector('link[data-tether]')?.href || '');

step('shot 1');
// 1. Claude clicks "Issue refund"
await tab.goto(base, { waitUntil: 'load' });
await tab.evaluate(`(${HOOK})()`);
await sleep(1200);
await tab.click('#go');
await tab.evaluate(`(${HOOK})()`);
await sleep(700);
await save('screenshot-1-working.png', await tab.screenshot(), await favicon());

step('shot 2');
// 2. Claude types the customer's name
await sleep(1500);
await tab.click('#name');
await tab.type('#name', 'Mei Lin', { delay: 25 });
await tab.evaluate(`(${HOOK})()`);
await sleep(900);
await save('screenshot-2-typing.png', await tab.screenshot(), await favicon());

step('shot 3');
// 3. done: no Claude action for 20 s
await sleep(21000);
await save('screenshot-3-done.png', await tab.screenshot(), await favicon());

step('promo');
// small promo tile
await sheet.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
await sheet.setContent(`<!doctype html><html><head><style>
  body{margin:0;width:440px;height:280px;background:#1f1e1d;font-family:"Segoe UI",system-ui,sans-serif;overflow:hidden;position:relative}
  .glow{position:absolute;inset:0;box-shadow:inset 0 0 14px rgba(217,119,87,.7),inset 0 0 30px rgba(217,119,87,.4),inset 0 0 60px rgba(217,119,87,.16)}
  .wrap{position:absolute;inset:0;display:flex;align-items:center;gap:22px;padding:0 34px}
  .logo svg{width:112px;height:112px;display:block}
  h1{margin:0;color:#f5f0e8;font-size:44px;letter-spacing:-.5px} p{margin:6px 0 0;color:#d9d2c7;font-size:17px;line-height:1.3}
  .tag{display:inline-block;margin-top:12px;background:#D97757;color:#fff;font-size:13px;font-weight:600;padding:3px 9px;border-radius:6px}
  </style></head><body><div class="glow"></div><div class="wrap"><div class="logo">${LOGO}</div>
  <div><h1>Tether</h1><p>See which tabs<br>Claude Code is using</p><span class="tag">Display only</span></div></div></body></html>`);
await sheet.screenshot({ path: path.join(out, 'promo-small.png') });

await browser.close();
server.close();
console.log('written to', out);
