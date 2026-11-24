#!/usr/bin/env node
// Tether broker: one DevTools connection to your Chrome, shared by your Claude
// Code sessions.
//
// Chrome asks "Allow?" for every program that connects to its debugging port.
// The broker connects once, so you click Allow once per Chrome start. Claude
// Code sessions then connect to the broker at
//     ws://127.0.0.1:9333/devtools/browser/tether
// and get in without a prompt, but only after the broker checks who they are
// (scripts/connect-watch.ps1 on Windows, scripts/connect-watch.mjs on macOS):
//   - the program is chrome-devtools-mcp,
//   - started by Claude Code (claude.exe / claude) signed by Anthropic, PBC,
//   - which the Claude desktop app (also signed by Anthropic) started.
// Windows checks Authenticode signatures, macOS the Developer ID (codesign).
// Anything else gets "403 Forbidden", and the connect watch shows who it was.
//
// Each client gets its own browser session inside the one connection
// (Target.attachToBrowserTarget). Its commands, events and tabs it attaches to
// stay its own, and a client that goes away is detached without touching the
// others. Browser.close and a few other dangerous commands are refused.
//
// Per chat (one Claude session, across reconnects) the broker also keeps:
//   - the tabs the chat opened (and popups those tabs opened). Navigating,
//     clicking, typing into or closing any other tab, i.e. yours, is refused,
//     unless you asked Claude to use it (the tab guard then calls /adopt);
//   - the Chrome profile its first tab opened in, so its later tabs open there
//     too instead of wherever Chrome's default is;
//   - a short pause before each click, so the extension's cursor can get there
//     first and the click doesn't happen before you see where it goes.
//
//   node tether-broker.mjs [--port 9333] [--chrome-user-data <dir>] [--lazy] [--log <file>] [--no-notify]
//
// --lazy waits for the first Claude session before connecting to Chrome. By
// default the broker connects as soon as Chrome is running, so the Allow prompt
// comes up right when you open Chrome, not in the middle of a task.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const HOST = '127.0.0.1';
const PORT = Number(args.port || 9333);
const PATHNAME = '/devtools/browser/tether';
const IS_MAC = process.platform === 'darwin';
const CHROME_DATA = args['chrome-user-data'] || (IS_MAC
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  : path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'));
const LAZY = Boolean(args.lazy);
// Only for tests with a throwaway Chrome: skips the check of who connects.
const ALLOW_ANY = Boolean(args['insecure-allow-any-client']);
const NOTIFY = !args['no-notify'];
const LOG = args.log || path.join(os.homedir(), '.tether', 'broker.log');
const VERIFY = path.join(here, '..', 'scripts', IS_MAC ? 'connect-watch.mjs' : 'connect-watch.ps1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const MAX_PAYLOAD = 512 * 1024 * 1024;
// What changes a tab: refused in tabs the chat didn't open.
const GUARDED = new Set([
  'Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry', 'Page.close',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchTouchEvent',
  'Input.dispatchDragEvent', 'Input.imeSetComposition', 'DOM.setFileInputFiles',
]);
const NOT_YOURS = "Tether: this is a tab Claude didn't open, so it's the user's. Open your own tab with new_page and work there. "
  + 'Only if the user asked you to use this tab: select_page it a second time to confirm.';
const CLICK_LEAD_MS = 220;   // a click waits this long after the mouse moved, for the cursor
const BLOCKED = new Set([
  'Browser.close',                  // would close your whole Chrome
  'Browser.crash',
  'Browser.crashGpuProcess',
  'Target.exposeDevToolsProtocol',  // would hand a web page the DevTools protocol
]);

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) out[k] = v;
    else if (list[i + 1] && !list[i + 1].startsWith('--')) out[k] = list[++i];
    else out[k] = true;
  }
  return out;
}

function log(message) {
  const d = new Date();
  const stamp = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 19); // local time
  const line = `${stamp}  ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, `${LOG}.old`);
    fs.appendFileSync(LOG, line);
  } catch { /* logging must never stop the broker */ }
  if (process.stdout.isTTY || args.verbose) process.stdout.write(line);
}

// ------------------------------------------------------------- Chrome side

let up = null;            // { ws, open, ready, stamp }
let nextId = 1;
const pending = new Map();   // upstream id -> { client, origId, strip, method } or { resolve, reject }
const owners = new Map();    // DevTools session id -> client
const clients = new Set();
const sessionTargets = new Map();   // DevTools session id -> the tab (target id) it's attached to

// Per chat, keyed like the tab-marker session (c<claude.exe pid>), kept across
// reconnects: the tabs it opened, the profile (browser context) of its first
// tab, until when the user lent it their tabs, and its Claude Code session id.
const chats = new Map();
function chatOf(client) {
  const k = client.session.id;
  if (!chats.has(k)) chats.set(k, { targets: new Set(), context: null, adoptUntil: 0, cliId: '' });
  return chats.get(k);
}

// Newer Chrome on macOS keeps its data folder private to itself (EPERM for everyone
// else). scripts/port-mirror-setup.sh then keeps a copy of the port file here.
const PORT_MIRROR = path.join(process.env.TETHER_HOME || path.join(os.homedir(), '.tether'), 'chrome', 'DevToolsActivePort');
let mirrorHinted = false;
function readPortFile() {
  try { return fs.readFileSync(path.join(CHROME_DATA, 'DevToolsActivePort'), 'utf8'); } catch (e) {
    if (!IS_MAC || !['EPERM', 'EACCES'].includes(e.code)) throw e;
    try { return fs.readFileSync(PORT_MIRROR, 'utf8'); } catch (e2) {
      if (!mirrorHinted && e2.code === 'ENOENT') {
        mirrorHinted = true;
        log(`macOS keeps Chrome's data folder private and there is no copy at ${PORT_MIRROR}: run scripts/port-mirror-setup.sh`);
      }
      throw e2;
    }
  }
}

function activePort() {
  const text = readPortFile();
  const [port, wsPath] = text.split(/\r?\n/);
  if (!/^\d+$/.test(port || '') || !(wsPath || '').startsWith('/devtools/browser/')) throw new Error('DevToolsActivePort is incomplete');
  return { port: Number(port), wsPath, stamp: `${port}${wsPath}` };
}

function connectChrome() {
  if (up) return up.ready;
  let info;
  try { info = activePort(); } catch {
    return Promise.reject(new Error('Chrome remote debugging is off or Chrome is not running (no DevToolsActivePort)'));
  }
  log(`connecting to Chrome on 127.0.0.1:${info.port}; Chrome asks "Allow?" once`);
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}${info.wsPath}`, {
    perMessageDeflate: false, maxPayload: MAX_PAYLOAD, handshakeTimeout: 10 * 60 * 1000,
  });
  const entry = { ws, open: false, stamp: info.stamp };
  entry.ready = new Promise((resolve, reject) => {
    ws.once('open', () => { entry.open = true; log('connected to Chrome'); resolve(); });
    ws.once('error', (e) => reject(e));
    ws.once('close', () => { if (!entry.open) reject(new Error('Chrome closed the connection (Allow declined or timed out?)')); });
  });
  ws.on('message', onChromeMessage);
  ws.on('error', (e) => log(`Chrome connection error: ${e.message}`));
  ws.on('close', (code) => {
    if (entry.open) log(`Chrome connection closed (${code})`);
    if (up === entry) up = null;
    for (const p of pending.values()) if (p.reject) p.reject(new Error('Chrome connection closed'));
    pending.clear();
    owners.clear();
    sessionTargets.clear();
    for (const c of chats.values()) { c.targets.clear(); c.context = null; } // a new Chrome run, new ids
    for (const c of clients) c.ws.close(1011, 'Chrome connection closed');
  });
  up = entry;
  entry.ready.catch((e) => { log(`could not connect to Chrome: ${e.message}`); if (up === entry) up = null; });
  return entry.ready;
}

function callChrome(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    if (!up || !up.open) { reject(new Error('not connected to Chrome')); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    up.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

function own(sessionId, client) {
  owners.set(sessionId, client);
  client.sessions.add(sessionId);
}

function disown(sessionId) {
  const c = owners.get(sessionId);
  owners.delete(sessionId);
  if (c) c.sessions.delete(sessionId);
}

function onChromeMessage(data) {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (!p.client) {
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (p.method === 'Target.attachToTarget' && msg.result && msg.result.sessionId) {
      own(msg.result.sessionId, p.client);
      if (p.params && p.params.targetId) sessionTargets.set(msg.result.sessionId, p.params.targetId);
    }
    if (p.method === 'Target.createTarget') {
      const chat = chatOf(p.client);
      if (msg.result && msg.result.targetId) {
        chat.targets.add(msg.result.targetId);
        if (!chat.context) {
          callChrome('Target.getTargetInfo', { targetId: msg.result.targetId })
            .then((r) => { if (!chat.context && r && r.targetInfo) chat.context = r.targetInfo.browserContextId || null; })
            .catch(() => {});
        }
      } else if (msg.error && p.pinned) {
        // the profile this chat used is gone (its windows were closed): open the tab Chrome's default way
        chat.context = null;
        const id = nextId++;
        pending.set(id, { ...p, pinned: false });
        up.ws.send(JSON.stringify({ id, method: p.method, params: p.unpinned, sessionId: p.upSession }));
        return;
      }
    }
    const out = { ...msg, id: p.origId };
    if (p.strip) delete out.sessionId;
    send(p.client, out);
    return;
  }
  const owner = msg.sessionId && owners.get(msg.sessionId);
  if (!owner) return;
  const info = msg.params && msg.params.targetInfo;
  if (msg.method === 'Target.attachedToTarget' && msg.params && msg.params.sessionId) {
    own(msg.params.sessionId, owner);
    if (info) sessionTargets.set(msg.params.sessionId, info.targetId);
  }
  if (msg.method === 'Target.detachedFromTarget' && msg.params && msg.params.sessionId) {
    disown(msg.params.sessionId);
    sessionTargets.delete(msg.params.sessionId);
  }
  // a popup or new tab opened from one of the chat's own tabs is the chat's too
  if (info && info.openerId && /^Target\.(targetCreated|targetInfoChanged|attachedToTarget)$/.test(msg.method)) {
    const chat = chatOf(owner);
    if (chat.targets.has(info.openerId)) chat.targets.add(info.targetId);
  }
  send(owner, msg.sessionId === owner.browserSession ? { method: msg.method, params: msg.params } : msg);
}

// ------------------------------------------------------------- client side

function send(client, msg) {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
}

function refuse(client, msg, code, message) {
  const out = { id: msg.id, error: { code, message } };
  if (msg.sessionId) out.sessionId = msg.sessionId;
  send(client, out);
}

// Log a kept-out attempt once per chat and tab, not for every keystroke.
const keptOut = new Map();
function logKeptOut(client, target, method) {
  const k = `${client.session.id}|${target}`;
  if (Date.now() - (keptOut.get(k) || 0) < 60000) return;
  keptOut.set(k, Date.now());
  log(`${client.who.label}: kept out of a tab it didn't open (${method})`);
}

function forward(client, data) {
  let text = data.toString();
  const marker = text.includes(SESSION_MARK);   // the tab-marker hook
  if (marker) text = text.split(SESSION_MARK).join(sessionToken(client));
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
  if (BLOCKED.has(msg.method)) { refuse(client, msg, -32000, `${msg.method} is blocked by Tether`); return; }
  if (!up || !up.open) { refuse(client, msg, -32000, 'Tether is not connected to Chrome'); return; }
  let sessionId = client.browserSession;
  let strip = true;
  if (msg.sessionId !== undefined) {
    if (msg.sessionId === client.browserSession || !client.sessions.has(msg.sessionId)) {
      refuse(client, msg, -32001, 'Session with given id not found.');
      return;
    }
    sessionId = msg.sessionId;
    strip = false;
  }
  const chat = chatOf(client);
  const lent = Date.now() < chat.adoptUntil;
  // Your tabs: no navigating, clicking, typing or closing, and no Claude look, unless you lent them.
  if (!lent && !strip) {
    const target = sessionTargets.get(sessionId);
    if (target && !chat.targets.has(target) && (GUARDED.has(msg.method) || marker)) {
      logKeptOut(client, target, msg.method);
      refuse(client, msg, -32000, NOT_YOURS);
      return;
    }
  }
  if (!lent && msg.method === 'Target.closeTarget' && msg.params && !chat.targets.has(msg.params.targetId)) {
    logKeptOut(client, msg.params.targetId, msg.method);
    refuse(client, msg, -32000, NOT_YOURS);
    return;
  }
  // A new tab opens in the profile of the chat's first tab.
  let params = msg.params || {};
  let pinned = false;
  const unpinned = params;
  if (msg.method === 'Target.createTarget' && !params.browserContextId && chat.context) {
    params = { ...params, browserContextId: chat.context };
    pinned = true;
  }
  const id = nextId++;
  pending.set(id, { client, origId: msg.id, strip, method: msg.method, params, pinned, unpinned, upSession: sessionId });
  const out = JSON.stringify({ id, method: msg.method, params, sessionId });
  // A click waits a moment after the mouse moved there, so the cursor arrives first.
  let wait = 0;
  if (msg.method === 'Input.dispatchMouseEvent') {
    if (params.type === 'mouseMoved') client.movedAt = Date.now();
    else if (params.type === 'mousePressed' && Date.now() - (client.movedAt || 0) < 1000) wait = CLICK_LEAD_MS;
  }
  const said = !strip ? claudeInput(client, msg.method, params) : null;
  // in order: what comes after a held click waits for it
  client.out = client.out
    .then(() => (wait ? new Promise((r) => setTimeout(r, wait)) : null))
    .then(() => {
      if (!up || !up.open) return;
      if (said) callChrome('Runtime.evaluate', { expression: `window.postMessage(${JSON.stringify(said)}, '*')` }, sessionId).catch(() => {});
      up.ws.send(out);
    });
}

// What the extension needs to know about Claude's own mouse and keys, so its
// cursor follows Claude and never your mouse: posted into the page just before
// the input itself. (Inside the page a real mouse move can look exactly like
// one sent through DevTools, so the page can't tell them apart on its own.)
function claudeInput(client, method, params) {
  if (method === 'Input.dispatchMouseEvent' && (params.type === 'mouseMoved' || params.type === 'mousePressed')) {
    const x = Number(params.x), y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { tether: 'claude-pointer', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, press: params.type === 'mousePressed' };
  }
  if (method === 'Input.dispatchKeyEvent' || method === 'Input.insertText') {
    if (Date.now() - (client.typedAt || 0) < 400) return null;   // once per burst of keys is enough
    client.typedAt = Date.now();
    return { tether: 'claude-typing' };
  }
  return null;
}

// The tab guard says the user asked this chat to use one of their tabs: lend it
// the user's tabs for a while. Matched by Claude Code session id or claude pid.
function adopt({ session, pid, minutes }) {
  const until = Date.now() + Math.min(Math.max(Number(minutes) || 30, 1), 60) * 60000;
  let n = 0;
  for (const [key, chat] of chats) {
    if ((session && chat.cliId === session) || (pid && key === `c${pid}`)) { chat.adoptUntil = until; n++; }
  }
  if (n) log(`a chat was lent the user's tabs until ${new Date(until).toTimeString().slice(0, 5)} (the user asked for one)`);
  return n;
}

async function onClient(ws, who) {
  const client = { ws, who, browserSession: null, sessions: new Set(), queue: [], closed: false, session: sessionOf(who),
    out: Promise.resolve(), movedAt: 0 };
  clients.add(client);
  ws.on('message', (data) => { if (client.browserSession) forward(client, data); else client.queue.push(data); });
  ws.on('error', () => {});
  ws.on('close', () => dropClient(client));
  try {
    await connectChrome();
    const { sessionId } = await callChrome('Target.attachToBrowserTarget');
    if (client.closed) { callChrome('Target.detachFromTarget', { sessionId }).catch(() => {}); return; }
    client.browserSession = sessionId;
    own(sessionId, client);
    for (const data of client.queue.splice(0)) forward(client, data);
    withName(who).then(() => {
      if (who.info && who.info.Title && !client.session.title) client.session.title = who.info.Title;
      if (who.info && who.info.SessionId) chatOf(client).cliId = who.info.SessionId;
      log(`${who.label}: let in`);
      if (who.allowed) notify(who); // not for the tests' --insecure-allow-any-client
    });
  } catch (e) {
    log(`${who.label}: could not reach Chrome: ${e.message}`);
    ws.close(1011, String(e.message).slice(0, 120));
  }
}

function dropClient(client) {
  if (client.closed) return;
  client.closed = true;
  clients.delete(client);
  for (const [id, p] of pending) if (p.client === client) pending.delete(id);
  for (const s of [...client.sessions]) owners.delete(s);
  if (client.browserSession && up && up.open) {
    callChrome('Target.detachFromTarget', { sessionId: client.browserSession }).catch(() => {});
  }
  log(`${client.who.label}: left`);
}

// ------------------------------------------------------------- the checks

// One long-running PowerShell (connect-watch.ps1 -Serve) answers the checks line
// by line. Starting PowerShell costs seconds on a busy PC, or minutes when the
// disk is full; a check through the running worker takes about one second.
// On macOS the worker is "node connect-watch.mjs --serve": same requests, same answers.
class Worker {
  constructor() { this.proc = null; this.queue = []; this.busy = null; this.buf = ''; }

  start() {
    const proc = IS_MAC
      ? spawn(process.execPath, [VERIFY, '--serve', '--server-port', String(PORT)], { stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', VERIFY,
        '-Serve', '-ServerPort', String(PORT)], { windowsHide: true });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this.onData(d));
    proc.on('error', () => {});
    proc.on('exit', () => { if (this.proc === proc) { this.proc = null; this.fail(new Error('check worker stopped')); } });
    this.proc = proc;
    this.buf = '';
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line || !this.busy) continue;
      const job = this.busy;
      this.busy = null;
      clearTimeout(job.timer);
      try { job.resolve(JSON.parse(line)); } catch { job.reject(new Error('check failed')); }
      this.next();
    }
  }

  fail(err) {
    if (this.busy) { clearTimeout(this.busy.timer); this.busy.reject(err); this.busy = null; }
    this.next();
  }

  next() {
    if (this.busy || !this.queue.length) return;
    if (!this.proc) this.start();
    const job = this.queue.shift();
    this.busy = job;
    job.timer = setTimeout(() => {   // a stuck worker is replaced by a fresh one
      const p = this.proc;
      this.proc = null;
      try { p.kill(); } catch { /* gone */ }
      this.fail(new Error('check timed out'));
    }, job.timeoutMs);
    this.proc.stdin.write(job.line + '\n');
  }

  ask(line, timeoutMs = 90000) {
    return new Promise((resolve, reject) => { this.queue.push({ line, timeoutMs, resolve, reject }); this.next(); });
  }
}
// Two workers: "who is this?" has one to itself, so it never waits behind a slow
// signature check, a chat-name lookup or a notification.
const worker = new Worker();
const slowWorker = new Worker();

// claude.exe is a few hundred MB, so checking its signature takes seconds, or
// minutes when the PC is busy. Keep each yes for as long as the file has the
// same path, size and modified time, also on disk, so a broker restart doesn't
// start over. (Only a yes is kept; a program that can rewrite this file can
// already replace claude.exe itself.)
const SIG_FILE = path.join(os.homedir(), '.tether', 'signatures.json');
let signedOk = new Set();
try { signedOk = new Set(JSON.parse(fs.readFileSync(SIG_FILE, 'utf8'))); } catch { /* none yet */ }
const signatures = new Map();
function signedByAnthropic(file) {
  let st;
  // A macOS app is a folder; the seal of its signature changes whenever the app does.
  const stamped = IS_MAC && String(file).endsWith('.app') ? path.join(file, 'Contents', '_CodeSignature', 'CodeResources') : file;
  try { st = fs.statSync(stamped); } catch { return Promise.resolve(false); }
  const key = `${file.toLowerCase()}|${st.size}|${st.mtimeMs}`;
  if (signedOk.has(key)) return Promise.resolve(true);
  if (!signatures.has(key)) {
    const p = slowWorker.ask(`sig ${file}`, 10 * 60 * 1000).then((r) => r.Signed === true);
    p.then((ok) => {
      if (!ok) return;
      signedOk.add(key);
      try { fs.mkdirSync(path.dirname(SIG_FILE), { recursive: true }); fs.writeFileSync(SIG_FILE, JSON.stringify([...signedOk].slice(-50))); } catch { /* kept in memory */ }
    }, () => signatures.delete(key)); // a failed check is tried again next time
    signatures.set(key, p);
  }
  return signatures.get(key).catch(() => false);
}

// Which process owns the client end of this connection? netstat (lsof on macOS)
// answers in a fraction of a second, without PowerShell.
function pidOf(remotePort) {
  if (IS_MAC) {
    return new Promise((resolve) => {
      execFile('/usr/sbin/lsof', ['-nP', `-iTCP:${remotePort}`, '-sTCP:ESTABLISHED', '-Fpn'],
        { timeout: 15000, env: { ...process.env, LC_ALL: 'C' } }, (_err, stdout) => {
          let pid = 0;
          for (const line of String(stdout || '').split(/\r?\n/)) {
            if (line[0] === 'p') pid = Number(line.slice(1));
            else if (line.startsWith(`n127.0.0.1:${remotePort}->127.0.0.1:${PORT}`)) { resolve(pid); return; }
          }
          resolve(0);
        });
    });
  }
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) { resolve(0); return; }
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+127\.0\.0\.1:(\d+)\s+\S+\s+(\d+)\s*$/i.exec(line);
        if (m && Number(m[1]) === remotePort && Number(m[2]) === PORT) { resolve(Number(m[3])); return; }
      }
      resolve(0);
    });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// chrome-devtools-mcp processes already checked and let in. A session that
// reconnects gets straight back in; an entry goes when its process ends.
const approved = new Map();
setInterval(() => { for (const pid of approved.keys()) if (!alive(pid)) approved.delete(pid); }, 30000).unref();

// Who is on the other end of this TCP connection? The worker finds the process
// and its parents; the broker then checks the two signatures.
async function verifyClient(remotePort) {
  const pid = await pidOf(remotePort);
  if (pid && approved.has(pid) && alive(pid)) return { ...approved.get(pid), again: true };
  let v;
  // With the pid known, the worker skips finding it again and leaves the chat's
  // name for later (nameSession): both were slow on a busy PC, and checks timed out.
  const ask = pid ? `check ${remotePort} ${pid}` : `verify ${remotePort}`;
  try { v = await worker.ask(ask, 50000); } catch (e) { v = { Error: e.message }; }
  if (v.Error) return { allowed: false, label: `client :${remotePort}`, reason: v.Error, info: {} };
  const answer = { allowed: v.Allowed === true, label: v.Label || `client :${remotePort}`, reason: v.Reason || '', info: v };
  if (answer.allowed) {
    const [cli, app] = await Promise.all([signedByAnthropic(v.ClaudePath), signedByAnthropic(v.AppPath)]);
    if (!cli) Object.assign(answer, { allowed: false, reason: `Claude Code isn't signed by Anthropic (${v.ClaudePath})` });
    else if (!app) Object.assign(answer, { allowed: false, reason: `the Claude app isn't signed by Anthropic (${v.AppPath})` });
  }
  if (answer.allowed && v.ProcessId) approved.set(v.ProcessId, answer);
  return answer;
}

// Log what the broker decided through the connect watch (which only shows a
// notification when ~/.tether/config.json turns them on).
function notify(answer) {
  if (!NOTIFY || answer.again) return;
  const v = answer.info || {};
  const toast = answer.allowed
    ? { Kind: 'broker-allowed', Title: `Claude is using Chrome: ${v.Session || 'a Claude session'}`,
        Lines: ['Let in by Tether, no Allow needed', `Folder: ${v.Folder || 'unknown'}`], Hint: 'Nothing to do.' }
    : { Kind: 'broker-blocked', Title: `Tether blocked ${v.Program || 'a program'} from Chrome`,
        Lines: [answer.label, `Why: ${answer.reason}`], Hint: 'Refused. Nothing to do unless you expected it.' };
  toast.ProcessId = v.ProcessId || 0;
  slowWorker.ask(`toast ${JSON.stringify(toast)}`, 30000).catch(() => {});
}

// Check the running claude.exe programs now, so the first session doesn't wait.
function warmUp() {
  slowWorker.ask('paths', 60000)
    .then((r) => { for (const p of [].concat((r && r.Paths) || [])) signedByAnthropic(p); })
    .catch(() => {});
}

// ------------------------------------------------------------- session names

// The tab-marker hook carries the placeholder below. For each client the broker
// swaps it for that client's session, base64 JSON { id, title }, so the
// extension can give every Claude session its own tab group, named after the
// chat. Titles of new sessions appear later, so they're looked up again now
// and then.
const SESSION_MARK = '__TETHER_SESSION__';
let anonymous = 0;

function sessionOf(who) {
  const v = who.info || {};
  return { id: v.ClaudePid ? `c${v.ClaudePid}` : `x${++anonymous}`, title: v.Title || '', claudePid: v.ClaudePid || 0, checkedAt: Date.now() };
}

function sessionToken(client) {
  const s = client.session;
  if (s.claudePid && Date.now() - s.checkedAt > 30000) {
    s.checkedAt = Date.now();
    slowWorker.ask(`session ${s.claudePid}`, 30000).then((r) => {
      if (r && r.Title) s.title = r.Title;
      if (r && r.Id && chats.has(s.id)) chats.get(s.id).cliId = r.Id;
    }).catch(() => {});
  }
  return Buffer.from(JSON.stringify({ id: s.id, title: s.title }), 'utf8').toString('base64');
}

// The quick check leaves out the chat's name (finding it reads the desktop app's
// session files, slow on a busy PC). Look it up after the decision, for the log,
// the notification and the tab group. Resolves when known, or when it gave up.
function withName(who) {
  const v = who.info || {};
  if (v.Title || !v.ClaudePid || !String(v.Kind || '').startsWith('claude-')) return Promise.resolve(who);
  return slowWorker.ask(`session ${v.ClaudePid}`, 60000).then((r) => {
    if (r && r.Id) v.SessionId = r.Id;
    if (r && r.Title) {
      Object.assign(v, { Title: r.Title, Session: r.Title, Folder: r.Folder || v.Folder || '' }); // a reconnect starts with it
      who.label = `Claude session '${r.Title}' (${v.Program}, pid ${v.ProcessId})`;
    }
    return who;
  }, () => who);
}

// ------------------------------------------------------------- server

const hostOk = (req) => [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(String(req.headers.host || '').toLowerCase());

const server = http.createServer((req, res) => {
  const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!hostOk(req) || req.headers.origin) { reply(403, { error: 'forbidden' }); return; }
  if (req.url === '/json/version') {
    reply(200, { Browser: 'Tether broker', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://${HOST}:${PORT}${PATHNAME}` });
  } else if (req.method === 'POST' && req.url === '/adopt') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let n = 0;
      try { n = adopt(JSON.parse(body || '{}')); } catch { /* bad request */ }
      reply(200, { lent: n });
    });
  } else if (req.url === '/status') {
    reply(200, { chrome: up && up.open ? 'connected' : up ? 'waiting for Allow' : 'not connected', clients: [...clients].map((c) => c.who.label) });
  } else {
    reply(404, { error: 'not found' });
  }
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });

server.on('upgrade', async (req, socket, head) => {
  const deny = (status, why) => {
    if (why) log(`refused ${why}`);
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  // A web page can open a WebSocket to 127.0.0.1, but it always sends an Origin.
  if (!hostOk(req) || req.headers.origin) { deny('403 Forbidden', `a connection with Host ${req.headers.host} / Origin ${req.headers.origin}`); return; }
  if (new URL(req.url, 'http://x').pathname !== PATHNAME) { deny('404 Not Found', `a connection to ${req.url}`); return; }
  let who = { label: `client :${socket.remotePort}` };
  if (!ALLOW_ANY) {
    const v = await verifyClient(socket.remotePort);
    if (!v.allowed) {
      deny('403 Forbidden');   // at once; the log line waits for the chat's name
      withName(v).then(() => { log(`refused ${v.label}: ${v.reason}`); notify(v); });
      return;
    }
    who = v;
  }
  if (socket.destroyed) return;
  wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, who));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { log(`port ${PORT} is busy: is the broker already running?`); process.exit(0); }
  log(`server error: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`listening on ws://${HOST}:${PORT}${PATHNAME}${ALLOW_ANY ? ' (INSECURE: letting any client in, tests only)' : ''}`);
  if (!ALLOW_ANY) warmUp();
});

// Connect as soon as Chrome is running, and again after Chrome restarts, so the
// Allow prompt comes up when you open Chrome.
let lastStamp = null;
function watchChrome() {
  if (LAZY || up) return;
  let stamp = null;
  try { stamp = activePort().stamp; } catch { lastStamp = null; return; }
  if (stamp === lastStamp) return;   // this Chrome run was tried already; next try on demand
  lastStamp = stamp;
  connectChrome().catch(() => {});
}
setInterval(watchChrome, 5000).unref();
watchChrome();
