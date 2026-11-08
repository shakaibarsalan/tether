// Renders tether-guide.html to an MP4, frame by frame, so every animation lands
// exactly where it should. Needs Chrome and ffmpeg; no npm packages.
//
//   node video/render.mjs [out.mp4]
//
// It starts a separate headless Chrome with its own temporary profile, pauses
// every CSS animation, seeks them to each frame's time, takes a screenshot, and
// hands the frames to ffmpeg.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'tether-guide.html');
const out = path.resolve(process.argv[2] || path.join(here, 'tether-guide.mp4'));
const FPS = 30;
const DURATION = 51; // seconds, matches the progress bar in the page
const SIZE = 1080;
const PORT = 9333; // not 9222, which your everyday Chrome may be using
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const work = mkdtempSync(path.join(tmpdir(), 'tether-video-'));
const frames = path.join(work, 'frames');
mkdirSync(frames);

const browser = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(work, 'profile')}`,
  `--window-size=${SIZE},${SIZE}`, '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageSocketUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const target = list.find((t) => t.type === 'page');
      if (target) return target.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  const waiter = msg.id && pending.get(msg.id);
  if (!waiter) return;
  pending.delete(msg.id);
  msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(page).href });
  for (let i = 0; i < 100 && (await evaluate('document.readyState')) !== 'complete'; i++) await sleep(100);
  await evaluate('document.fonts.ready.then(() => document.fonts.size)');
  await evaluate(`window.__seek = (t) => new Promise((done) => {
    document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t * 1000; });
    requestAnimationFrame(() => requestAnimationFrame(done));
  })`);

  const total = FPS * DURATION;
  for (let f = 0; f < total; f++) {
    await evaluate(`__seek(${f / FPS})`);
    const { data } = await send('Page.captureScreenshot', {
      format: 'jpeg', quality: 95, clip: { x: 0, y: 0, width: SIZE, height: SIZE, scale: 1 },
    });
    writeFileSync(path.join(frames, `f${String(f).padStart(5, '0')}.jpg`), Buffer.from(data, 'base64'));
    if (f % 300 === 0) console.log(`frame ${f} / ${total}`);
  }
} finally {
  ws.close();
  browser.kill();
  await new Promise((r) => (browser.exitCode !== null ? r() : browser.once('exit', r)));
}

execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%05d.jpg'),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
], { stdio: 'inherit' });

for (let i = 0; i < 5; i++) {
  try { rmSync(work, { recursive: true, force: true }); break; } catch { await sleep(500); }
}
console.log(`wrote ${out}`);
