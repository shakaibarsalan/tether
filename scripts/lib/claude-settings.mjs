#!/usr/bin/env node
// Adds or removes Tether's hooks in Claude Code's ~/.claude/settings.json, for
// the macOS scripts (the Windows .ps1 scripts do the same in PowerShell).
//
//   node claude-settings.mjs tab-marker [--undo] [--server chrome-devtools]
//   node claude-settings.mjs tab-guard  [--undo] [--server chrome-devtools] [--node /path/to/node]
//   node claude-settings.mjs guard      [--undo] [--python /path/to/python3] [--guard /path/to/chrome_browser_guard.py]
//   node claude-settings.mjs check-hook [--undo] [--script /path/to/check.sh]
//
//   --claude-dir DIR   instead of ~/.claude (the tests use a temp folder)
//
// Each one backs settings.json up first, replaces only its own entries (so
// running it twice is safe), keeps everything else as it was, and refuses to
// write anything that isn't valid JSON.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEVTOOLS_ACTIONS = 'navigate_page|new_page|select_page|click|fill|fill_form|type_text|press_key|hover|drag|upload_file|handle_dialog';

function parseArgs(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) out[k] = v;
    else if (list[i + 1] !== undefined && !list[i + 1].startsWith('--')) out[k] = list[++i];
    else out[k] = true;
  }
  return out;
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Every hook entry is { matcher, hooks: [ ... ] }. "mine" says whether an entry
// was written by this tool, so only those are replaced.
function update(settingsPath, what, wanted, mine, undo) {
  let settings = {};
  let backup = null;
  if (fs.existsSync(settingsPath)) {
    const text = fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '');
    backup = `${settingsPath}.before-${what}-${stamp()}`;
    fs.copyFileSync(settingsPath, backup);
    if (text.trim()) {
      try { settings = JSON.parse(text); } catch (e) {
        throw new Error(`Couldn't read ${settingsPath} (is it valid JSON?). Nothing was changed. Details: ${e.message}`);
      }
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${settingsPath} isn't a JSON object. Nothing was changed.`);
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [event, entry] of Object.entries(wanted)) {
    let list = Array.isArray(hooks[event]) ? hooks[event].filter((e) => e != null && !mine(e)) : [];
    if (!undo) list = [...list, entry];
    if (list.length) hooks[event] = list; else delete hooks[event];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  const json = `${JSON.stringify(settings, null, 2)}\n`;
  JSON.parse(json); // refuse to write anything unreadable
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, json);
  return backup;
}

const hookText = (h) => `${h && h.command ? h.command : ''} ${h && Array.isArray(h.args) ? h.args.join(' ') : ''}`;
const anyHook = (entry, test) => Array.isArray(entry.hooks) && entry.hooks.some((h) => h && test(h));

export function tabMarker({ claudeDir, server = 'chrome-devtools', undo = false }) {
  const marker = fs.readFileSync(path.join(REPO, 'hooks', 'claude-tab-marker.js'), 'utf8').trim();
  const entry = {
    matcher: `mcp__${server}__(${DEVTOOLS_ACTIONS})`,
    hooks: [{ type: 'mcp_tool', server, tool: 'evaluate_script', input: { function: marker }, timeout: 15, statusMessage: "Marking Claude's tab" }],
  };
  const mine = (e) => anyHook(e, (h) => h.type === 'mcp_tool' && h.tool === 'evaluate_script' && /__claudeTabMarker/.test(String(h.input && h.input.function)));
  return update(path.join(claudeDir, 'settings.json'), 'tab-marker', { PostToolUse: entry }, mine, undo);
}

export function tabGuard({ claudeDir, server = 'chrome-devtools', node = process.execPath, undo = false }) {
  const hook = { type: 'command', command: node, args: [path.join(REPO, 'hooks', 'tab-guard.mjs')], timeout: 10 };
  const mine = (e) => anyHook(e, (h) => /tab-guard\.mjs/.test(hookText(h)));
  return update(path.join(claudeDir, 'settings.json'), 'tab-guard', {
    PreToolUse: { matcher: `mcp__${server}__.*`, hooks: [hook] },
    PostToolUse: { matcher: `mcp__${server}__new_page`, hooks: [hook] },
  }, mine, undo);
}

export function guard({ claudeDir, python = 'python3', guardPath, undo = false }) {
  const file = guardPath || path.join(claudeDir, 'hooks', 'chrome_browser_guard.py');
  const entry = (matcher, status, block) => {
    const h = { type: 'command', command: python, args: [file], timeout: 20, statusMessage: status };
    if (block) h.onFailure = 'block';
    return { matcher, hooks: [h] };
  };
  const mine = (e) => anyHook(e, (h) => /chrome_browser_guard/.test(hookText(h)));
  return update(path.join(claudeDir, 'settings.json'), undo ? 'tether-guard-removal' : 'tether-guard', {
    PreToolUse: entry('mcp__claude-in-chrome__.*', 'Checking Chrome browser lock', true),
    PostToolUse: entry('mcp__claude-in-chrome__(select_browser|list_connected_browsers)', 'Confirming Chrome browser', false),
  }, mine, undo);
}

export function checkHook({ claudeDir, script = path.join(REPO, 'scripts', 'check.sh'), undo = false }) {
  const entry = { hooks: [{ type: 'command', command: '/bin/bash', args: [script, '--hook'], timeout: 120 }] };
  const mine = (e) => anyHook(e, (h) => /scripts[\\/]check\.(sh|mjs|ps1)/.test(hookText(h)));
  return update(path.join(claudeDir, 'settings.json'), 'tether-check', { SessionStart: entry }, mine, undo);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const what = args._[0];
  const claudeDir = args['claude-dir'] || path.join(os.homedir(), '.claude');
  const undo = Boolean(args.undo);
  const jobs = {
    'tab-marker': () => tabMarker({ claudeDir, server: args.server, undo }),
    'tab-guard': () => tabGuard({ claudeDir, server: args.server, node: args.node || process.execPath, undo }),
    guard: () => guard({ claudeDir, python: args.python, guardPath: args.guard, undo }),
    'check-hook': () => checkHook({ claudeDir, script: args.script, undo }),
  };
  if (!jobs[what]) {
    console.error(`usage: claude-settings.mjs ${Object.keys(jobs).join('|')} [--undo] [--claude-dir DIR]`);
    process.exit(2);
  }
  try {
    const backup = jobs[what]();
    if (backup) console.log(`Settings backup: ${backup}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
