#!/usr/bin/env node
// Tether connect watch for macOS (scripts/connect-watch.ps1 does this on Windows).
//
// With remote debugging on, Chrome asks "Allow?" every time a program connects,
// but it doesn't say which program. This watches Chrome's debugging port and,
// when something connects, logs who it is (and shows a notification if
// ~/.tether/config.json says { "notifications": true }):
//
//   Claude wants Chrome           chrome-devtools-mcp started by a Claude Code
//                                 session: the session's title and folder.
//   A script run by Claude ...    something a session ran from a shell, not the
//                                 normal tool. Allow only if you asked for it.
//   Unknown program ...           anything else. Click Block.
//
// It also answers the Tether broker (broker/tether-broker.mjs), which asks, for
// every program that connects to it, "may this one in?". Yes only for
// chrome-devtools-mcp started by Claude Code that the Claude desktop app
// started, with Claude Code and Claude.app both signed by Anthropic, PBC
// (Developer ID, checked with codesign).
//
//   node connect-watch.mjs                         watch (the LaunchAgent runs this)
//   node connect-watch.mjs --once [--notify]       what is connected right now
//   node connect-watch.mjs --explain-pid PID       what it would say about one process (JSON)
//   node connect-watch.mjs --verify-client-port PORT [--server-port 9333] [--skip-signatures]
//   node connect-watch.mjs --check-signature PATH  signed by Anthropic, PBC? (JSON)
//   node connect-watch.mjs --lookup-session ID [--session-roots DIR,DIR]
//   node connect-watch.mjs --session-for-pid PID   title and folder of a Claude Code process
//   node connect-watch.mjs --claude-paths          running Claude Code programs and Claude.app
//   node connect-watch.mjs --show-toast JSON       log (and maybe show) one broker decision
//   node connect-watch.mjs --serve [--server-port 9333]
//                                                  one request per line on stdin, one JSON
//                                                  answer per line: the broker's worker
//
// It only reads: open connections (lsof), the process list (ps), code
// signatures (codesign) and the session titles the Claude app keeps.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
export const TETHER_DIR = process.env.TETHER_HOME || path.join(HOME, '.tether');
export const CHROME_DATA_DEFAULT = path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome');
export const CLAUDE_DATA_DEFAULT = path.join(HOME, 'Library', 'Application Support', 'Claude');
const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// ps, lsof and codesign in the C locale, so dates and messages parse the same everywhere.
const C_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function run(cmd, args, timeout = 20000) {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', env: C_ENV, timeout, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return { status: -1, stdout: '', stderr: String(e.message) };
  }
}

// ------------------------------------------------------------------ logging

export function logLine(file, message) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.old`);
    const d = new Date();
    const stamp = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(file, `${stamp}  ${message}\n`);
  } catch { /* logging must never stop the watcher */ }
}

// ------------------------------------------------------------------ processes

// "ps -o lstart" in the C locale: "Thu Nov 13 01:23:45 2026" (day padded with a space).
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d\d:\d\d:\d\d \d{4})\s+(.*)$/;

export function parsePs(statText, argsText) {
  const table = new Map();
  for (const line of String(statText).split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const exe = m[4].trim();
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), start: Date.parse(m[3]) || 0, exe, name: path.basename(exe), args: '' });
  }
  for (const line of String(argsText).split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m && table.has(Number(m[1]))) table.get(Number(m[1])).args = m[2].trim();
  }
  return table;
}

export function processTable() {
  const stat = run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart=,comm=']);
  const args = run('/bin/ps', ['-axww', '-o', 'pid=,args=']);
  const table = parsePs(stat.stdout || '', args.stdout || '');
  // "comm" is the full path for nearly everything on macOS; ask lsof for the rest.
  for (const p of table.values()) p.exePath = p.exe.startsWith('/') ? p.exe : '';
  return table;
}

export function exePath(p) {
  if (!p) return '';
  if (p.exePath) return p.exePath;
  const r = run('/usr/sbin/lsof', ['-a', '-p', String(p.pid), '-d', 'txt', '-Fn']);
  const m = /^n(\/.+)$/m.exec(r.stdout || '');
  p.exePath = m ? m[1] : p.exe;
  return p.exePath;
}

// The process and its parents, nearest first. Stops where a parent id was reused
// by a process that started later than its "child".
export function ancestry(table, pid) {
  const list = [];
  let cur = table.get(pid);
  for (let i = 0; i < 12 && cur; i++) {
    list.push(cur);
    const parent = table.get(cur.ppid);
    if (!parent || parent.pid === cur.pid) break;
    if (parent.start && cur.start && parent.start > cur.start) break;
    cur = parent;
  }
  return list;
}

// The Claude desktop app: its main program or one of its helpers inside Claude.app.
export function appBundleOf(file) {
  const m = /^(.*\/Claude\.app)\/Contents\//.exec(String(file || ''));
  return m ? m[1] : '';
}

// A Claude Code process: the CLI the desktop app starts (claude-code/<version>/.../claude),
// the native CLI, or the npm CLI. Not the desktop app and not its helpers.
export function isClaudeCode(p) {
  const file = exePath(p);
  if (path.basename(file) === 'claude' && !/\.app\/Contents\//.test(file) && !/\s--type=/.test(p.args)) return true;
  if (path.basename(file) === 'node' && /@anthropic-ai\/claude-code/.test(p.args)) return true;
  return false;
}

// ------------------------------------------------------------------ sessions

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sessionFiles(root) {
  try {
    return fs.readdirSync(root, { recursive: true })
      .map(String)
      .filter((f) => /^local_.*\.json$/i.test(path.basename(f)))
      .map((f) => path.join(root, f));
  } catch { return []; }
}

const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const emptySession = (id = '') => ({ Id: id, Title: '', Folder: '', Account: '' });

// Title and folder the Claude desktop app keeps for a Claude Code session id.
// With fork the id is the session it was forked from, so take the newest fork.
export function findSession(id, fork, roots) {
  if (!id) return null;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const files = sessionFiles(root);
    let hit = null;
    if (fork) {
      hit = files.filter((f) => mtimeOf(f) > Date.now() - 2 * 86400000).map(readJson)
        .filter((j) => j && String(j.forkedFromSessionId) === `local_${id}`)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0] || null;
    }
    if (!hit) {
      let file = files.find((f) => path.basename(f).toLowerCase() === `local_${id}.json`.toLowerCase());
      if (!file) {
        const re = new RegExp(`"cliSessionId"\\s*:\\s*"${escapeRe(id)}"`);
        file = files.find((f) => { try { return re.test(fs.readFileSync(f, 'utf8')); } catch { return false; } });
      }
      if (file) hit = readJson(file);
    }
    if (hit) return { Id: id, Title: String(hit.title || ''), Folder: String(hit.cwd || ''), Account: '' };
  }
  return emptySession(id);
}

// A brand-new session has no id on its command line: take the session the app
// created just after this Claude Code process started.
export function findSessionByStart(start, roots) {
  let best = null;
  let bestGap = 61;
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const f of sessionFiles(root)) {
      if (mtimeOf(f) < start - 60000) continue;
      const j = readJson(f);
      if (!j || !j.createdAt) continue;
      const gap = (Number(j.createdAt) - start) / 1000;
      if (gap >= -5 && gap < bestGap) { best = j; bestGap = gap; }
    }
  }
  if (!best) return null;
  return { Id: String(best.cliSessionId || ''), Title: String(best.title || ''), Folder: String(best.cwd || ''), Account: '' };
}

export function sessionRootsFor(claudeFile, extra = []) {
  const roots = [...extra];
  let account = '';
  const m = /^(.*?)\/claude-code\//.exec(String(claudeFile || ''));
  if (m) {
    roots.push(path.posix.join(m[1], 'claude-code-sessions'));
    const leaf = path.basename(m[1]);
    if (leaf !== 'Claude' && !/^claude_[a-z0-9]+$/i.test(leaf)) account = leaf;
  }
  const def = path.join(CLAUDE_DATA_DEFAULT, 'claude-code-sessions');
  if (!roots.includes(def)) roots.push(def);
  return { roots, account };
}

const sessionCache = new Map();
export function claudeSession(p, extraRoots = [], useCache = true) {
  const key = `${p.pid}@${p.start}`;
  if (useCache && sessionCache.has(key)) return sessionCache.get(key);
  const idMatch = new RegExp(`--(?:resume|session-id)[= ]"?(${ID})`).exec(p.args);
  const id = idMatch ? idMatch[1] : '';
  const fork = /--fork-session/.test(p.args);
  const { roots, account } = sessionRootsFor(exePath(p), extraRoots);
  let s = findSession(id, fork, roots);
  if ((!s || !s.Title) && !id && p.start) s = findSessionByStart(p.start, roots) || s;
  s = { ...(s || emptySession()), Account: account };
  if (s.Title) sessionCache.set(key, s);
  return s;
}

const sessionLabel = (s) => (s && s.Title) || (s && s.Id ? `session ${s.Id.slice(0, 8)}` : 'a Claude Code session');

function shortCommand(p) {
  let cl = String(p.args || '').trim().replace(/^\S+\s*/, '');
  if (cl.length > 90) cl = `${cl.slice(0, 87)}...`;
  return cl;
}

// ------------------------------------------------------------------ who is it?

export function connectionInfo(pid, table = processTable(), extraRoots = []) {
  const chain = ancestry(table, pid);
  const self = chain[0] || null;
  const name = self ? self.name : `pid ${pid}`;
  const chainText = chain.slice(1, 5).map((p) => p.name).join(' <- ') || 'unknown';
  const claudeAt = chain.findIndex((p) => isClaudeCode(p));
  // The normal tool: chrome-devtools-mcp, and every process between it and
  // Claude is part of launching it (for example "npx chrome-devtools-mcp").
  const isTool = claudeAt > 0 && chain.slice(0, claudeAt).every((p) => /chrome-devtools-mcp/.test(p.args));
  const info = { Kind: '', ProcessId: pid, Program: name, Chain: chainText, Session: null, Title: '', Lines: [], Hint: '',
    ClaudePath: '', AppPath: '', ClaudePid: 0 };
  if (claudeAt >= 0) {
    info.ClaudePath = exePath(chain[claudeAt]);
    info.ClaudePid = chain[claudeAt].pid;
    const parent = chain[claudeAt + 1];
    if (parent) info.AppPath = appBundleOf(exePath(parent)) || exePath(parent);
  }
  if (self && /tether-broker\.mjs/.test(self.args)) {
    Object.assign(info, { Kind: 'tether-broker', Title: 'Tether wants Chrome',
      Lines: ['Allow once: your Claude sessions then get in without asking', `Until Chrome closes. node, pid ${pid}`],
      Hint: 'Allow. This is the Tether broker.' });
  } else if (claudeAt >= 0) {
    const s = claudeSession(chain[claudeAt], extraRoots);
    info.Session = s;
    let where = s.Folder || 'folder unknown';
    if (s.Account) where = `${where} (${s.Account})`;
    if (isTool) {
      Object.assign(info, { Kind: 'claude-tool', Title: `Claude wants Chrome: ${sessionLabel(s)}`,
        Lines: [`Folder: ${where}`, `chrome-devtools-mcp, pid ${pid}`], Hint: 'Allow if you just gave this session a browser task.' });
    } else {
      Object.assign(info, { Kind: 'claude-script', Title: 'A script run by Claude wants Chrome',
        Lines: [`Session: ${sessionLabel(s)} - ${where}`, `${name} (pid ${pid}): ${shortCommand(self)}`],
        Hint: "Not Claude's normal browser tool. Allow only if you asked for it." });
    }
  } else {
    Object.assign(info, { Kind: 'unknown', Title: `Unknown program wants Chrome: ${name}`,
      Lines: [`${self ? exePath(self) : 'path unknown'} (pid ${pid})`, `Started by: ${chainText}`],
      Hint: 'Click Block in Chrome unless you started this.' });
  }
  return info;
}

export function formatInfo(info) {
  let text = `${info.Kind.padEnd(13)} ${info.Title} | ${(info.Lines || []).join(' | ')}`;
  if (!['unknown', 'broker-blocked'].includes(info.Kind)) text += ` | started by ${info.Chain}`;
  return text;
}

// ------------------------------------------------------------------ signatures

// "codesign -dvv" output: the signing certificate is the first Authority line.
// Anthropic's Developer ID, chained to Apple's root, with a matching team id.
export function parseCodesign(text) {
  const authorities = [...String(text).matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  const team = (/^TeamIdentifier=(\S+)\s*$/m.exec(String(text)) || [])[1] || '';
  const leaf = /^Developer ID Application: Anthropic, PBC \(([A-Z0-9]{10})\)$/.exec(authorities[0] || '');
  return { authorities, team, anthropic: Boolean(leaf && leaf[1] === team && authorities.includes('Apple Root CA')) };
}

const sigCache = new Map();
export function signatureOf(file) {
  if (!file || !fs.existsSync(file)) return { Signed: false, Reason: 'not found' };
  let st;
  try { st = fs.statSync(file.endsWith('.app') ? path.join(file, 'Contents', '_CodeSignature', 'CodeResources') : file); } catch { st = fs.statSync(file); }
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (sigCache.has(key)) return sigCache.get(key);
  let answer;
  const verify = run('/usr/bin/codesign', ['--verify', '--strict', file], 10 * 60 * 1000);
  if (verify.status !== 0) {
    answer = { Signed: false, Reason: `codesign --verify failed: ${String(verify.stderr || '').trim().split('\n').pop()}` };
  } else {
    const d = run('/usr/bin/codesign', ['-dvv', file], 60000);
    const c = parseCodesign(`${d.stderr || ''}\n${d.stdout || ''}`);
    answer = { Signed: c.anthropic, Team: c.team, Signer: c.authorities[0] || '', Reason: c.anthropic ? '' : `signed by ${c.authorities[0] || 'nobody'}` };
  }
  sigCache.set(key, answer);
  return answer;
}

export const anthropicSigned = (file) => signatureOf(file).Signed === true;

// Yes only for chrome-devtools-mcp started by Claude Code, where Claude Code and
// the Claude desktop app that started it are both signed by Anthropic. A
// script Claude ran, a terminal session or anything else: no.
export function clientAllowed(info, signatures = true) {
  const no = (why) => ({ Allowed: false, Reason: why });
  if (info.Kind !== 'claude-tool') return no(`not Claude's chrome-devtools-mcp (${info.Kind})`);
  if (!/\/Claude\.app$/.test(info.AppPath)) return no(`not started by the Claude desktop app (${info.AppPath})`);
  if (signatures) {
    if (!anthropicSigned(info.ClaudePath)) return no(`Claude Code isn't signed by Anthropic (${info.ClaudePath})`);
    if (!anthropicSigned(info.AppPath)) return no(`the Claude app isn't signed by Anthropic (${info.AppPath})`);
  }
  return { Allowed: true, Reason: 'chrome-devtools-mcp from a signed Claude desktop session' };
}

// ------------------------------------------------------------------ connections

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// "lsof -F pn" output: p<pid> starts a process, n<local>-><remote> is one socket.
export function parseLsof(text) {
  const out = [];
  let pid = 0;
  const end = '(?:\\[([^\\]]+)\\]|([^:\\s\\[\\]]+)):(\\d+)';
  const re = new RegExp(`^n${end}->${end}`);
  for (const line of String(text).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') {
      const m = re.exec(line);
      if (m) out.push({ pid, localAddr: m[1] || m[2], localPort: Number(m[3]), remoteAddr: m[4] || m[5], remotePort: Number(m[6]) });
    }
  }
  return out;
}

export function connectionsOn(port) {
  return parseLsof(run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpn']).stdout || '');
}

// Programs on this computer connected to this port: the client ends.
export function clientsOf(port) {
  return connectionsOn(port).filter((c) => c.remotePort === port && LOOPBACK.has(c.remoteAddr));
}

export function pidOfClient(clientPort, serverPort) {
  const c = connectionsOn(clientPort).find((x) => x.localPort === clientPort && x.remotePort === serverPort && LOOPBACK.has(x.remoteAddr));
  return c ? c.pid : 0;
}

// Addresses Chrome's debugging port listens on ("127.0.0.1", "::1", "*", ...).
export function listenersOn(port) {
  const out = [];
  let pid = 0;
  for (const line of String(run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']).stdout || '').split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    const m = /^n(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(line);
    if (m) out.push({ pid, addr: m[1] || m[2], port: Number(m[3]) });
  }
  return out;
}

export function debugPort(chromeData = CHROME_DATA_DEFAULT) {
  try {
    const port = Number(fs.readFileSync(path.join(chromeData, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch { return 0; }
}

// ------------------------------------------------------------------ notifications

// Off unless ~/.tether/config.json says { "notifications": true }. The log
// always gets everything.
export function notificationsOn() {
  try { return Boolean(JSON.parse(fs.readFileSync(path.join(TETHER_DIR, 'config.json'), 'utf8')).notifications); } catch { return false; }
}

export function showToast(info, logFile) {
  if (!notificationsOn()) return false;
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const script = `display notification ${q((info.Lines || []).join('\n'))} with title ${q(info.Title)} subtitle ${q(`Tether: ${info.Hint}`)}`;
  const r = run('/usr/bin/osascript', ['-e', script], 15000);
  if (r.status !== 0 && logFile) logLine(logFile, `notification failed: ${String(r.stderr || '').trim()}`);
  return r.status === 0;
}

// ------------------------------------------------------------------ the broker's questions

export function verifyAnswer(clientPort, serverPort, signatures, extraRoots = []) {
  const answer = { Allowed: false, Reason: 'connection not found', Label: `client :${clientPort}`, Kind: '', Program: '', ProcessId: 0,
    Chain: '', Session: '', Folder: '', ClaudePath: '', AppPath: '', ClaudePid: 0, Title: '' };
  const pid = pidOfClient(clientPort, serverPort);
  if (!pid) return answer;
  const info = connectionInfo(pid, processTable(), extraRoots);
  const v = clientAllowed(info, signatures);
  Object.assign(answer, { Allowed: v.Allowed, Reason: v.Reason, Kind: info.Kind, Program: info.Program, ProcessId: info.ProcessId,
    Chain: info.Chain, ClaudePath: info.ClaudePath, AppPath: info.AppPath, ClaudePid: info.ClaudePid,
    Title: info.Session ? info.Session.Title : '' });
  if (info.Kind.startsWith('claude-')) {
    answer.Session = sessionLabel(info.Session);
    answer.Folder = (info.Session && info.Session.Folder) || '';
    answer.Label = `Claude session '${answer.Session}' (${info.Program}, pid ${info.ProcessId})`;
  } else {
    answer.Label = `${info.Program} (pid ${info.ProcessId})`;
  }
  return answer;
}

export function sessionAnswer(claudePid, extraRoots = []) {
  const p = processTable().get(claudePid);
  const s = p ? claudeSession(p, extraRoots, false) : emptySession();
  return { Title: s.Title, Folder: s.Folder, Id: s.Id };
}

// Claude Code programs running now, and the Claude.app bundles that started
// them (the broker checks their signatures ahead of time).
export function claudePaths() {
  const table = processTable();
  const paths = new Set();
  for (const p of table.values()) {
    if (!isClaudeCode(p)) continue;
    paths.add(exePath(p));
    const app = appBundleOf(exePath(table.get(p.ppid)));
    if (app) paths.add(app);
  }
  return [...paths].sort();
}

function toastFromJson(text) {
  const t = JSON.parse(text);
  return { Kind: String(t.Kind || ''), Title: String(t.Title || ''), Lines: [].concat(t.Lines || []).map(String), Hint: String(t.Hint || ''),
    ProcessId: Number(t.ProcessId) || 0, Chain: '' };
}

// ------------------------------------------------------------------ main

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) out[k] = v;
    else if (list[i + 1] !== undefined && !list[i + 1].startsWith('--')) out[k] = list[++i];
    else out[k] = true;
  }
  return out;
}

const print = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverPort = Number(args['server-port'] || 9333);
  const chromeData = args['chrome-user-data'] || CHROME_DATA_DEFAULT;
  const logFile = args['log-file'] || path.join(TETHER_DIR, 'connect-watch.log');
  const roots = args['session-roots'] ? String(args['session-roots']).split(',').filter(Boolean) : [];

  if (args['lookup-session']) { print(findSession(String(args['lookup-session']), false, roots)); return; }
  if (args['explain-pid']) {
    const info = connectionInfo(Number(args['explain-pid']), processTable(), roots);
    print({ ...info, BrokerVerdict: clientAllowed(info, !args['skip-signatures']) });
    return;
  }
  if (args['verify-client-port']) { print(verifyAnswer(Number(args['verify-client-port']), serverPort, !args['skip-signatures'], roots)); return; }
  if (args['check-signature']) { print({ Path: String(args['check-signature']), ...signatureOf(String(args['check-signature'])) }); return; }
  if (args['session-for-pid']) { print(sessionAnswer(Number(args['session-for-pid']), roots)); return; }
  if (args['claude-paths']) { print(claudePaths()); return; }
  if (args['show-toast']) {
    const info = toastFromJson(String(args['show-toast']));
    logLine(logFile, `broker: ${formatInfo(info)}`);
    showToast(info, logFile);
    return;
  }

  if (args.serve) {
    // For the broker: one long-running process that answers line by line.
    // Requests: "verify <clientPort>", "session <claudePid>", "sig <path>",
    // "paths", "toast <json>".
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      const at = line.indexOf(' ');
      const cmd = at < 0 ? line : line.slice(0, at);
      const arg = at < 0 ? '' : line.slice(at + 1);
      let out;
      try {
        if (cmd === 'verify') out = verifyAnswer(Number(arg), serverPort, false, roots);
        else if (cmd === 'session') out = sessionAnswer(Number(arg), roots);
        else if (cmd === 'sig') out = { Path: arg, ...signatureOf(arg) };
        else if (cmd === 'paths') out = { Paths: claudePaths() };
        else if (cmd === 'toast') {
          const info = toastFromJson(arg);
          logLine(logFile, `broker: ${formatInfo(info)}`);
          out = { Shown: showToast(info, logFile) };
        } else out = { Error: `unknown request: ${cmd}` };
      } catch (e) {
        out = { Error: String(e.message || e) };
      }
      print(out);
    }
    return;
  }

  if (args.once) {
    const port = debugPort(chromeData);
    if (!port) { console.log('Chrome remote debugging is not on (no DevToolsActivePort).'); return; }
    const clients = clientsOf(port);
    if (!clients.length) { console.log(`Nothing is connected to Chrome's debugging port (${port}).`); return; }
    const table = processTable();
    const done = new Set();
    for (const c of clients) {
      if (done.has(c.pid)) continue;
      done.add(c.pid);
      const info = connectionInfo(c.pid, table, roots);
      console.log(formatInfo(info));
      if (args.notify) showToast(info, logFile);
    }
    return;
  }

  await watch(chromeData, logFile, roots, Number(args['interval-ms'] || 1000));
}

// One watcher at a time (the LaunchAgent may start one while you run another).
function takeLock() {
  const file = path.join(TETHER_DIR, 'connect-watch.pid');
  try {
    const old = Number(fs.readFileSync(file, 'utf8'));
    if (old && old !== process.pid) { process.kill(old, 0); return false; }
  } catch { /* no live watcher */ }
  fs.mkdirSync(TETHER_DIR, { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  process.on('exit', () => { try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file); } catch { /* gone */ } });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  return true;
}

async function watch(chromeData, logFile, roots, intervalMs) {
  if (!takeLock()) return;
  logLine(logFile, `watching (pid ${process.pid})`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let port = 0;
  let seen = new Set();
  let baseline = true;
  let portReadAt = 0;
  const lastToast = new Map();
  for (;;) {
    try {
      if (Date.now() - portReadAt >= 5000) {
        const p = debugPort(chromeData);
        if (p !== port) {
          seen = new Set();
          baseline = true;
          if (p) logLine(logFile, `Chrome debugging port ${p}`);
        }
        port = p;
        portReadAt = Date.now();
      }
      if (port) {
        const clients = clientsOf(port);
        const now = new Set(clients.map((c) => c.localPort));
        const fresh = clients.filter((c) => !seen.has(c.localPort));
        if (fresh.length) {
          const table = processTable();
          for (const c of fresh) {
            seen.add(c.localPort);
            const info = connectionInfo(c.pid, table, roots);
            if (baseline) { logLine(logFile, `already connected (chrome): ${formatInfo(info)}`); continue; }
            logLine(logFile, `new connection (chrome): ${formatInfo(info)}`);
            // one program often opens more than one connection: one notification is enough
            if (lastToast.has(c.pid) && Date.now() - lastToast.get(c.pid) < 60000) continue;
            lastToast.set(c.pid, Date.now());
            showToast(info, logFile);
          }
        }
        for (const k of [...seen]) if (!now.has(k)) seen.delete(k);
        baseline = false;
      }
    } catch (e) {
      logLine(logFile, `error: ${e.message}`);
      await sleep(2000);
    }
    await sleep(intervalMs);
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  if (process.platform !== 'darwin' && !process.env.TETHER_ALLOW_ANY_PLATFORM) {
    console.error('connect-watch.mjs is the macOS version. On Windows use scripts\\connect-watch.ps1.');
    process.exit(2);
  }
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
