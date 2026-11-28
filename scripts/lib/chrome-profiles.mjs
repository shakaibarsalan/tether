// Your Chrome profiles: folder, name, the Google account it's signed in to, and
// whether the Tether extension is in it (that's where Claude's tabs open).
//
// On a Mac, Chrome keeps its data folder private, so this reads the list that
// tether-chrome-profiles (mac/chrome-profiles.c, set up by port-mirror-setup.sh)
// keeps in ~/.tether/chrome/profiles.json. Elsewhere it reads Chrome's own
// "Local State" and each profile's preferences.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TETHER_HOME = process.env.TETHER_HOME || path.join(os.homedir(), '.tether');

// Chrome names an unpacked extension after its folder: SHA-256 of the path
// (UTF-16 on Windows, UTF-8 elsewhere), the first 32 hex digits written as the
// letters a-p.
export function unpackedExtensionId(dir, platform = process.platform) {
  const bytes = Buffer.from(dir, platform === 'win32' ? 'utf16le' : 'utf8');
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

// Tether's extension IDs: the extension folder of this copy (and its real
// path), plus any in ~/.tether/config.json "extensionIds" (another folder, the store).
export function tetherExtensionIds({ tetherHome = TETHER_HOME, repo = REPO, platform = process.platform } = {}) {
  const dir = path.resolve(repo, 'extension');
  const dirs = new Set([dir]);
  try { dirs.add(fs.realpathSync(dir)); } catch { /* no folder */ }
  const ids = new Set([...dirs].map((d) => unpackedExtensionId(d, platform)));
  try {
    for (const id of JSON.parse(fs.readFileSync(path.join(tetherHome, 'config.json'), 'utf8')).extensionIds || []) {
      if (/^[a-p]{32}$/.test(id)) ids.add(id);
    }
  } catch { /* no config */ }
  return ids;
}

export function defaultChromeDir(platform = process.platform) {
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// { profiles: [{ dir, name, email, tether }], note } with the Tether profiles first.
// note says why the list is empty or incomplete.
export function chromeProfiles({ platform = process.platform, tetherHome = TETHER_HOME, chromeDir = process.env.TETHER_CHROME_DIR || null, ids = null } = {}) {
  let cache = null;
  let withTether = null;
  let note = '';
  if (platform === 'darwin' && !chromeDir) {
    const mirrored = readJson(path.join(tetherHome, 'chrome', 'profiles.json'));
    if (mirrored) {
      cache = mirrored.info_cache || {};
      withTether = new Set(mirrored.tether || []);
    } else {
      note = "the list of Chrome profiles isn't available (scripts/port-mirror-setup.sh sets up tether-chrome-profiles, which needs Full Disk Access)";
    }
  } else {
    const dir = chromeDir || defaultChromeDir(platform);
    const local = readJson(path.join(dir, 'Local State'));
    if (local) {
      cache = (local.profile && local.profile.info_cache) || {};
      const wanted = [...(ids || tetherExtensionIds({ tetherHome, platform }))].map((id) => `"${id}"`);
      withTether = new Set(Object.keys(cache).filter((p) => ['Secure Preferences', 'Preferences'].some((f) => {
        try { const text = fs.readFileSync(path.join(dir, p, f), 'utf8'); return wanted.some((w) => text.includes(w)); } catch { return false; }
      })));
    } else {
      note = `Chrome's profile list couldn't be read (${path.join(dir, 'Local State')})`;
    }
  }
  // Chrome notes when each profile was last used (active_time, in seconds): the
  // most recent first, so of several profiles with the extension the first is
  // normally the one the broker opens tabs in (where the extension was last active).
  const profiles = Object.entries(cache || {}).map(([dir, p]) => ({
    dir,
    name: String((p && p.name) || dir),
    email: String((p && p.user_name) || ''),
    tether: withTether.has(dir),
    usedAt: Number(p && p.active_time) || 0,
  })).sort((a, b) => Number(b.tether) - Number(a.tether) || b.usedAt - a.usedAt || a.name.localeCompare(b.name));
  return { profiles, note };
}
