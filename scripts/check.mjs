#!/usr/bin/env node
// Check that Tether's protection still holds (macOS; scripts/check.ps1 on Windows).
//
//   1. /etc/hosts still blocks bridge.claudeusercontent.com.
//   2. Chrome was restarted after the block. Otherwise the extension may still
//      hold a bridge connection it opened before.
//   3. Every installed Claude in Chrome extension version only contains remote
//      hosts we have already looked at. A new host after an extension update
//      could be a new bridge that the block doesn't cover.
//   4. Chrome's remote debugging, if it's on, listens on loopback only, and
//      who is connected to it.
//   5. Remote Control is disabled in Claude Code's settings (reported, not required).
//
// Exit code 0 when everything holds, 1 when something needs attention. Extension
// versions that were already scanned are cached, so repeat runs are fast.
//
//   node check.mjs [--hook] [--skip-live] [--hosts-file F] [--chrome-user-data D]
//                  [--claude-settings F] [--cache-file F]
//
// --hook: output for a Claude Code SessionStart hook: nothing when all is well,
// a JSON systemMessage when something needs attention. Always exits 0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const BRIDGE = 'bridge.claudeusercontent.com';
const SINKHOLES = new Set(['0.0.0.0', '::', '127.0.0.1', '::1']);
// Remote hosts seen in extension 1.0.102-1.0.105. Only the bridge carries browser
// commands (see docs/how-it-works.md); the rest are the API, staging and a dev server.
const KNOWN_HOSTS = new Set(['bridge.claudeusercontent.com', 'bridge-staging.claudeusercontent.com', 'api.anthropic.com', 'localhost']);

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

export function hostsBlocked(text) {
  for (const raw of String(text).split('\n')) {
    const parts = raw.split('#', 1)[0].trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && SINKHOLES.has(parts[0]) && parts.slice(1).some((h) => h.toLowerCase() === BRIDGE)) return true;
  }
  return false;
}

function jsFiles(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
  } catch { return []; }
}

// The earliest start time of Chrome's main program, or 0 when it isn't running.
function chromeStart() {
  const r = spawnSync('/bin/ps', ['-axww', '-o', 'lstart=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  let first = 0;
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d\d:\d\d:\d\d \d{4})\s+(.*\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome)\s*$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (t && (!first || t < first)) first = t;
  }
  return first;
}

export async function check(opts) {
  const lines = [];
  const problems = [];
  const ok = (m) => lines.push(`OK    ${m}`);
  const noteLine = (m) => lines.push(`NOTE  ${m}`);
  const problem = (m) => { lines.push(`WARN  ${m}`); problems.push(m); };

  // 1. hosts block
  let hostsText = '';
  try { hostsText = fs.readFileSync(opts.hostsFile, 'utf8'); } catch { /* none */ }
  const blocked = hostsBlocked(hostsText);
  if (blocked) ok(`hosts file blocks ${BRIDGE}`);
  else problem(`hosts file does NOT block ${BRIDGE}. Run Block-Remote.command (or scripts/bridge-block.sh).`);

  // 2. Chrome restarted after the block
  if (!opts.skipLive && blocked) {
    const started = chromeStart();
    // Chrome's start time has whole seconds, the file's change time doesn't.
    const changed = Math.floor(fs.statSync(opts.hostsFile).mtimeMs / 1000) * 1000;
    if (!started) ok('Chrome is not running (the block applies when it starts)');
    else if (started >= changed) ok('Chrome was restarted after the block');
    else problem('Chrome has been running since before the block. Quit Chrome completely (Cmd+Q) and open it again.');
  }

  // 3. remote hosts in every installed extension version
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(opts.cacheFile, 'utf8')) || {}; } catch { /* none yet */ }
  const versionDirs = [];
  let profiles = [];
  try { profiles = fs.readdirSync(opts.chromeUserData, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* no Chrome */ }
  for (const p of profiles) {
    const ext = path.join(opts.chromeUserData, p.name, 'Extensions', EXTENSION_ID);
    try { for (const v of fs.readdirSync(ext, { withFileTypes: true })) if (v.isDirectory()) versionDirs.push(path.join(ext, v.name)); } catch { /* not in this profile */ }
  }
  const seen = new Set();
  const newHosts = new Map();
  for (const dir of versionDirs) {
    const version = path.basename(dir);
    if (!Array.isArray(cache[version])) {
      const found = new Set();
      for (const f of jsFiles(dir)) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        for (const m of text.matchAll(/wss?:\/\/([A-Za-z0-9.-]+)/g)) found.add(m[1].toLowerCase());
      }
      cache[version] = [...found].sort();
    }
    seen.add(version);
    for (const h of cache[version]) if (!KNOWN_HOSTS.has(h)) newHosts.set(h, version);
  }
  if (!versionDirs.length) noteLine('Claude in Chrome extension not found in any Chrome profile');
  else if (!newHosts.size) ok(`extension versions ${[...seen].sort().join(', ')}: no unknown remote hosts`);
  else {
    for (const [h, v] of newHosts) {
      problem(`extension ${v} talks to a new remote host: ${h}. It may be a new bridge that the block doesn't cover. Open an issue at github.com/shakaibarsalan/tether.`);
    }
  }
  try {
    fs.mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
    fs.writeFileSync(opts.cacheFile, JSON.stringify(cache));
  } catch { /* cache is optional */ }

  // 4. remote debugging on loopback only, and who is connected
  if (!opts.skipLive) {
    const w = await import('./connect-watch.mjs');
    const port = w.debugPort(opts.chromeUserData);
    const listeners = port ? w.listenersOn(port) : [];
    if (!listeners.length) ok('Chrome remote debugging is not listening');
    else if (listeners.every((l) => l.addr === '127.0.0.1' || l.addr === '::1')) ok(`Chrome remote debugging is on loopback only (port ${port})`);
    else problem(`Chrome remote debugging listens beyond loopback on port ${port}. Check how Chrome was started.`);

    if (port && listeners.length) {
      const clients = w.clientsOf(port);
      if (!clients.length) ok('nothing is connected to Chrome remote debugging right now');
      const table = w.processTable();
      const brokerScript = path.join(here, '..', 'broker', 'tether-broker.mjs');
      const done = new Set();
      for (const c of clients) {
        if (done.has(c.pid)) continue;
        done.add(c.pid);
        const p = table.get(c.pid);
        const chain = w.ancestry(table, c.pid).slice(1, 5).map((x) => x.name);
        const by = chain.join(' <- ') || 'unknown';
        const isBroker = p && path.basename(p.exe) === 'node' && p.args.includes(path.resolve(brokerScript));
        const isMcp = p && /chrome-devtools-mcp/.test(p.args);
        if (isBroker) ok(`connected to Chrome: the Tether broker (pid ${c.pid}); it lets in only signed Claude desktop sessions`);
        else if (isMcp && chain.includes('claude')) ok(`connected to Chrome: chrome-devtools-mcp (pid ${c.pid}), started by ${by}`);
        else {
          const what = isMcp ? 'chrome-devtools-mcp' : p ? p.name : `pid ${c.pid}`;
          problem(`an unknown program is connected to Chrome remote debugging: ${what} (pid ${c.pid}), started by ${by}. If you didn't start it, quit Chrome or turn off chrome://inspect/#remote-debugging.`);
        }
      }
      const outside = w.connectionsOn(port).filter((c) => c.localPort === port && !['127.0.0.1', '::1'].includes(c.remoteAddr));
      if (outside.length) problem(`Chrome remote debugging has ${outside.length} connection(s) from outside this computer.`);
    }
  }

  // 5. Remote Control
  let rcOff = false;
  try { rcOff = Boolean(JSON.parse(fs.readFileSync(opts.claudeSettings, 'utf8').replace(/^\uFEFF/, '')).disableRemoteControl); } catch { /* not set */ }
  if (rcOff) ok('Remote Control is disabled in Claude Code settings');
  else noteLine('Remote Control is not disabled. On a shared account, set "disableRemoteControl": true in ~/.claude/settings.json.');

  return { lines, problems };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  const opts = {
    hook: Boolean(a.hook),
    skipLive: Boolean(a['skip-live']) || process.platform !== 'darwin',
    hostsFile: a['hosts-file'] || '/etc/hosts',
    chromeUserData: a['chrome-user-data'] || path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome'),
    claudeSettings: a['claude-settings'] || path.join(HOME, '.claude', 'settings.json'),
    cacheFile: a['cache-file'] || path.join(process.env.TETHER_HOME || path.join(HOME, '.tether'), 'check-cache.json'),
  };
  const { lines, problems } = await check(opts);
  if (opts.hook) {
    if (problems.length) {
      const msg = `Tether: ${problems.join(' | ')}`;
      process.stdout.write(JSON.stringify({
        systemMessage: msg,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${msg} Tell the user before doing any browser work.` },
      }));
    }
    process.exit(0);
  }
  for (const l of lines) console.log(l);
  console.log('');
  if (problems.length) { console.log(`${problems.length} thing(s) need attention.`); process.exit(1); }
  console.log('Tether is holding.');
  process.exit(0);
}
