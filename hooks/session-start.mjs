#!/usr/bin/env node
// Tether: what every Claude Code session should know about this computer's
// browser, given to it at the start. Claude Code runs this SessionStart hook
// for a new chat, a fork, a resumed chat, after /clear and after compaction,
// and adds what it prints to the chat's context.
//
// Without it a new chat reaches for the Claude in Chrome extension (switched
// off on purpose here), asks you to reconnect it, opens tabs in a signed-out
// context, or doesn't know which Chrome profile it works in.
//
// Installed by scripts/session-start.sh (macOS) or scripts\session-start.ps1.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeProfiles } from '../scripts/lib/chrome-profiles.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.TETHER_BROKER_PORT || 9333;
const WINDOWS = process.platform === 'win32';

async function brokerSays() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(800) });
    return (await r.json()).chrome || null;
  } catch { return null; }
}

export function guide({ chrome, profiles, note, windows = WINDOWS, repo = REPO }) {
  const status = windows
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.win32.join(repo, 'scripts', 'broker-setup.ps1')}" -Status`
    : `${path.posix.join(repo, 'scripts', 'broker-setup.sh')} --status`;
  const lines = [
    'Browser on this computer (Tether):',
    "- For the user's Chrome, use the chrome-devtools MCP tools (list_pages, new_page, navigate_page, take_snapshot, click, fill, ...). "
      + "They drive the user's real Chrome, with its logins, through the Tether broker on 127.0.0.1, with no Allow prompt per chat.",
    '- The Claude in Chrome extension (the mcp__claude-in-chrome__* tools) is switched off here on purpose. Never call those tools, '
      + 'and never ask the user to reconnect, sign in to or open the extension. Use the built-in browser pane only for local pages or when the user asks for it.',
    `- If the chrome-devtools tools can't connect, run ${status} and tell the user what it says. Don't work around the broker.`
      + (chrome ? ` (At the start of this chat the broker said: Chrome ${chrome}.)` : ' (At the start of this chat the broker was not answering.)'),
    "- Start with new_page, never with isolatedContext (that opens a separate context with none of the user's sign-ins). "
      + "Work in your own tabs: the broker refuses navigating, typing into or closing the user's tabs (\"not yours\"). "
      + 'If the user told you to use their tabs or their open Chrome, select_page that tab again after "not yours", and their tabs are yours for the rest of this chat. '
      + 'Keep your tab open while you still need it; close it when the work is done.',
  ];
  if (profiles.length) {
    lines.push('- Chrome profiles:');
    for (const p of profiles) {
      lines.push(`  - "${p.name}"${p.email ? ` (${p.email})` : ''}${p.tether ? ': has the Tether extension' : ''}`);
    }
    const homes = profiles.filter((p) => p.tether);
    if (homes.length === 1) {
      lines.push(`  Your new tabs open in "${homes[0].name}", the profile with the Tether extension. If a site isn't signed in there, tell the user instead of using another profile.`);
    } else if (homes.length > 1) {
      lines.push(`  Your new tabs open in a profile with the Tether extension: the one where it was last active, normally the one used most recently, "${homes[0].name}". `
        + "If a site isn't signed in there, tell the user instead of using another profile.");
    } else {
      lines.push("  None has the Tether extension, so new tabs open in Chrome's default profile, which may not be signed in. If that happens, "
        + 'ask the user to load the extension (chrome://extensions > Developer mode > Load unpacked > the Tether "extension" folder) in the profile they use.');
    }
  } else if (note) {
    lines.push(`- Chrome profiles: not known, ${note}. Your new tabs open in the Chrome profile with the Tether extension.`);
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let text;
  try {
    const { profiles, note } = chromeProfiles();
    text = guide({ chrome: await brokerSays(), profiles, note });
  } catch (e) {
    text = guide({ chrome: null, profiles: [], note: `the profile list failed (${e.message})` });
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
}
