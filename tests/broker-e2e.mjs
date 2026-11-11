// End-to-end check of the Tether broker against a throwaway Chrome (temporary
// profile, its own random port, nothing shared with your Chrome).
//
//   npm install --no-save puppeteer-core@24      (in the repo root)
//   npm install                                  (in broker/)
//   node tests/broker-e2e.mjs
//
// Set CHROME_PATH if Chrome isn't in the default Windows location. The part with
// chrome-devtools-mcp runs when it's installed globally (scripts/devtools-setup.ps1).
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repo, 'broker', 'package.json'));
const { WebSocket } = require('ws');
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const children = [];
const cleanup = () => { for (const c of children) { try { c.kill(); } catch { /* gone */ } } };
process.on('exit', cleanup);
let current = 'start';
const step = (s) => { current = s; console.error(`${new Date().toISOString().slice(11, 23)}  ${s}`); };
setTimeout(() => {
  console.log(results.join('\n'));
  console.log(`FAIL  stuck at: ${current}`);
  process.exit(2);
}, 150000).unref();

async function waitFor(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await check(); if (v) return v; } catch { /* not yet */ } await sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-broker-'));
const profile = path.join(tmp, 'profile');
children.push(spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' }));
await waitFor(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')) && fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').includes('/devtools/'), 20000, 'Chrome');

function startBroker(port, extra) {
  const b = spawn(process.execPath, [path.join(repo, 'broker', 'tether-broker.mjs'), '--port', String(port),
    '--chrome-user-data', profile, '--log', path.join(tmp, `broker-${port}.log`), ...extra], { stdio: 'ignore' });
  children.push(b);
  return waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 15000, `broker on ${port}`);
}
await startBroker(9334, ['--insecure-allow-any-client']);
const ep = 'ws://127.0.0.1:9334/devtools/browser/tether';
const titles = async (b) => Promise.all((await b.pages()).map((p) => p.title()));

step('A connects');
const A = await puppeteer.connect({ browserWSEndpoint: ep, defaultViewport: null });
step('A opens a tab');
const pa = await A.newPage();
await pa.goto('data:text/html,<title>Tab A</title><p>a</p>');
ok('client A opens and drives a tab', (await pa.title()) === 'Tab A');

step('B connects');
const B = await puppeteer.connect({ browserWSEndpoint: ep, defaultViewport: null });
ok('client B sees the tab A opened', (await titles(B)).includes('Tab A'), JSON.stringify(await titles(B)));
step('B opens a tab');
const pb = await B.newPage();
await pb.goto('data:text/html,<title>Tab B</title>');
ok('client B opens and drives its own tab', (await pb.evaluate(() => 6 * 7)) === 42);
step('B finds tab A');
let sharedA = null;
for (const p of await B.pages()) if ((await p.title()) === 'Tab A') sharedA = p;
ok('both clients can drive the same tab', sharedA && (await sharedA.evaluate(() => document.title)) === 'Tab A' && (await pa.evaluate(() => 1)) === 1);

step('A disconnects');
await A.disconnect();
await sleep(600);
step('B after A left');
ok('B keeps working after A leaves', (await pb.evaluate(() => 2 + 2)) === 4);
ok("A's tab stays open after A leaves", (await titles(B)).includes('Tab A'));

step('B tries Browser.close');
// puppeteer swallows errors from Browser.close, so ask on the raw protocol
const closeReply = await new Promise((resolve, reject) => {
  const ws = new WebSocket(ep);
  ws.on('open', () => ws.send(JSON.stringify({ id: 3, method: 'Browser.close', params: {} })));
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id === 3) { resolve(m); ws.close(); } });
  ws.on('error', reject);
});
await sleep(600);
step('C connects');
const C = await puppeteer.connect({ browserWSEndpoint: ep });
const closeError = (closeReply.error && closeReply.error.message) || '';
ok('Browser.close is refused and Chrome keeps running', /blocked by Tether/.test(closeError) && (await titles(C)).includes('Tab B'), closeError);

step('raw session check');
// raw protocol: a session id the client was never given is refused
const raw = await new Promise((resolve, reject) => {
  const ws = new WebSocket(ep);
  ws.on('open', () => ws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'not-yours' })));
  ws.on('message', (d) => { resolve(JSON.parse(d.toString())); ws.close(); });
  ws.on('error', reject);
});
ok("a session that isn't yours is refused", raw.id === 7 && /not found/i.test(raw.error && raw.error.message), JSON.stringify(raw).slice(0, 90));

const statusOf = (url, opts) => new Promise((resolve) => {
  const ws = new WebSocket(url, opts);
  ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
  ws.on('open', () => { resolve(101); ws.close(); });
  ws.on('error', () => resolve(0));
});
step('origin check');
ok('a web page (Origin header) is refused', (await statusOf(ep, { origin: 'https://evil.example' })) === 403);
ok('a wrong Host (DNS rebinding) is refused', (await statusOf(ep, { headers: { host: 'evil.example:9334' } })) === 403);

// With the real check on, this test process is not chrome-devtools-mcp started by
// the Claude desktop app, so it must be refused.
step('broker with check on');
await startBroker(9335, ['--lazy', '--no-notify']);
ok('with the check on, other programs get 403', (await statusOf('ws://127.0.0.1:9335/devtools/browser/tether')) === 403);

step('chrome-devtools-mcp');
// chrome-devtools-mcp, the real client, through the broker
let mcpEntry = process.env.CHROME_DEVTOOLS_MCP;
if (!mcpEntry) { try { mcpEntry = path.join(execSync('npm root -g').toString().trim(), 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js'); } catch { /* no npm */ } }
if (mcpEntry && fs.existsSync(mcpEntry)) {
  const mcp = spawn(process.execPath, [mcpEntry, `--wsEndpoint=${ep}`, '--no-usage-statistics', '--no-performance-crux'],
    { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1', CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' } });
  children.push(mcp);
  let buf = '';
  const replies = new Map();
  mcp.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id !== undefined) replies.set(m.id, m); } catch { /* log line */ }
    }
  });
  const rpc = (id, method, params) => { mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return waitFor(() => replies.get(id), 60000, method); };
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tether-test', version: '1' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await rpc(2, 'tools/call', { name: 'list_pages', arguments: {} });
  const text = JSON.stringify(listed.result || listed.error);
  ok('chrome-devtools-mcp works through the broker', text.includes('Tab A') && text.includes('Tab B'), text.slice(0, 90));
  mcp.kill();
} else {
  results.push('SKIP  chrome-devtools-mcp through the broker (not installed)');
}

await B.disconnect().catch(() => {});
await C.disconnect().catch(() => {});
cleanup();
await sleep(500);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
