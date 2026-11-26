#!/usr/bin/env node
// Tether tab guard: Claude works in its own tabs, not in the one you're using.
//
// When a Claude Code session connects, chrome-devtools-mcp starts out "on"
// whatever tab happens to come first, which is often the one you're working
// in. Without this guard, Claude's first navigate_page or click lands there.
//
// Claude Code runs this before (PreToolUse) and after (PostToolUse) every
// chrome-devtools tool call, with the call as JSON on stdin.
//
// With the Tether broker running, the broker keeps the user's tabs safe: it
// knows each chat's own tabs by Chrome's tab id and refuses navigating, typing
// into or closing any other ("not yours"). This guard then only passes on the
// user's permission: the same tab chosen again with select_page right after
// that refusal means the user asked Claude to use their tabs, and the broker
// lends this chat all of them for the rest of the chat. And it warns once
// about new_page with isolatedContext (no sign-ins, an extra window).
//
// Without the broker, per session it remembers which tabs Claude opened
// itself (new_page). Then:
//   - acting on a tab (navigate, click, type, ...) before opening or choosing
//     one is refused: "open your own tab first";
//   - choosing or closing a tab Claude didn't open is refused once, with the
//     reason. If the user really asked for that tab, Claude repeats the call
//     within two minutes and it goes through.
// Looking (list_pages, take_snapshot, take_screenshot, ...) is never refused.
//
// State: %USERPROFILE%\.tether\tab-guard\<session>.json, removed after 2 days.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.TETHER_TAB_GUARD_DIR || path.join(os.homedir(), '.tether', 'tab-guard');
const CONFIRM_MS = 2 * 60 * 1000;
// Tools that act on the currently selected tab.
const ACTS = new Set(['navigate_page', 'click', 'fill', 'fill_form', 'type_text', 'press_key', 'hover', 'drag',
  'upload_file', 'handle_dialog']);

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function statePath(session) {
  return path.join(DIR, `${String(session).replace(/[^\w-]/g, '_').slice(0, 80) || 'unknown'}.json`);
}

function load(session) {
  try { return JSON.parse(fs.readFileSync(statePath(session), 'utf8')); } catch { return { own: [], ready: false, pending: null }; }
}

function save(session, state) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(statePath(session), JSON.stringify(state));
}

function tidy() {
  try {
    const old = Date.now() - 2 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      if (fs.statSync(p).mtimeMs < old) fs.unlinkSync(p);
    }
  } catch { /* nothing to tidy */ }
}

// All the text in a tool result, however it's nested.
function textOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => textOf(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => textOf(v, out));
  return out.join('\n');
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Tether tab guard: ${reason}` },
  }));
  process.exit(0);
}

const input = readStdin();
const tool = String(input.tool_name || '').split('__').pop(); // mcp__chrome-devtools__navigate_page -> navigate_page
const session = input.session_id || 'unknown';
const state = load(session);
const pageId = input.tool_input && Number.isInteger(input.tool_input.pageId) ? input.tool_input.pageId : null;

const BROKER = `http://127.0.0.1:${process.env.TETHER_BROKER_PORT || 9333}`;

// Is the Tether broker running? It knows each chat's own tabs by Chrome's tab
// id (kept across reconnects and broker restarts) and refuses navigating,
// typing into or closing any other tab, so this guard leaves that to it.
async function brokerUp() {
  try { return (await fetch(`${BROKER}/status`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; }
}

// The user asked Claude to use their tabs: the broker lends this chat all of
// them for the rest of the chat (only right after it told the chat "not
// yours"). Matched by Claude Code session id or claude pid.
async function lend() {
  try {
    await fetch(`${BROKER}/adopt`, {
      method: 'POST', body: JSON.stringify({ session, pid: process.ppid, chat: true }), signal: AbortSignal.timeout(2000),
    });
  } catch { /* no broker: nothing to tell */ }
}

if (input.hook_event_name === 'PostToolUse') {
  const text = textOf(input.tool_response);
  const selected = /^(\d+): .*\[selected\]\s*$/m.exec(text);
  if (tool === 'new_page') {
    if (selected && !state.own.includes(Number(selected[1]))) state.own.push(Number(selected[1]));
    state.ready = true;
  } else if (selected) {
    // The answer shows which tab is selected now. When Claude's own tab closed,
    // chrome-devtools-mcp falls back to the first tab, usually the user's: stop there.
    state.ready = state.own.includes(Number(selected[1]));
  } else if (/previously selected page was closed|is now selected/i.test(text)) {
    state.ready = false;
  }
  if (tool === 'close_page' && pageId !== null) state.own = state.own.filter((id) => id !== pageId);
  save(session, state);
  process.exit(0);
}

// ---- PreToolUse
tidy();
const repeated = (what) => {
  const p = state.pending;
  return Boolean(p && p.tool === what && p.pageId === pageId && Date.now() - p.at < CONFIRM_MS);
};

if (tool === 'new_page') {
  // A separate context has none of the user's sign-ins and leaves another window behind.
  if (input.tool_input && input.tool_input.isolatedContext && !repeated('new_page-isolated')) {
    state.pending = { tool: 'new_page-isolated', pageId, at: Date.now() };
    save(session, state);
    deny("isolatedContext opens the tab in a separate context with none of the user's sign-ins, and leaves another window behind. "
      + "Call new_page without it: Tether opens the tab in the user's own signed-in Chrome profile. "
      + 'Only if the user asked for a separate, signed-out context, call new_page with isolatedContext again.');
  }
  if (state.pending && state.pending.tool === 'new_page-isolated') { state.pending = null; save(session, state); }
  process.exit(0);
}

if (await brokerUp()) {
  // The broker decides, by Chrome's own tab ids: choosing a tab changes nothing,
  // and closing one is refused there unless it's the chat's (so a chat can close
  // its tabs after a reconnect, or after a new_page that timed out). The same tab
  // chosen again within two minutes, after the broker said "not yours", is the
  // confirmation that the user asked Claude to use their tabs.
  if (tool === 'select_page' && pageId !== null) {
    if (repeated('select_page')) {
      state.pending = null;
      save(session, state);
      await lend();
    } else {
      state.pending = { tool, pageId, at: Date.now() };
      save(session, state);
    }
  }
  process.exit(0);
}

// Without the broker: this guard keeps the user's tabs safe by itself.
if (tool === 'select_page' || tool === 'close_page') {
  if (pageId === null || state.own.includes(pageId)) {
    if (tool === 'select_page') { state.ready = true; save(session, state); }
    process.exit(0);
  }
  const p = state.pending;
  if (p && p.tool === tool && p.pageId === pageId && Date.now() - p.at < CONFIRM_MS) {
    // repeated on purpose: the user asked for this tab
    state.pending = null;
    if (tool === 'select_page') { state.own.push(pageId); state.ready = true; }
    save(session, state);
    await lend();
    process.exit(0);
  }
  state.pending = { tool, pageId, at: Date.now() };
  save(session, state);
  deny(tool === 'select_page'
    ? `page ${pageId} is a tab you didn't open, and the user may be working in it. Open your own tab with new_page instead. Only if the user asked you to use their tabs or their open Chrome (this tab, or in general), call select_page with pageId ${pageId} again.`
    : `page ${pageId} is a tab you didn't open. Close only your own tabs. Only if the user asked you to close this one, call close_page with pageId ${pageId} again.`);
}

if (ACTS.has(tool) && !state.ready) {
  deny("open your own tab first with new_page. Right now you're on a tab you didn't open, probably the one the user is working in. (If the user asked you to use a specific open tab, select it with select_page.)");
}

process.exit(0);
