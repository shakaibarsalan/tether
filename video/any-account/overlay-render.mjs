// Renders overlay.html frame by frame (transparent PNGs) to build/overlay/, timed by timeline.json.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frames = path.join(here, 'build', 'overlay');
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const t = JSON.parse(readFileSync(path.join(here, 'timeline.json'), 'utf8'));
const cuts = [0, ...t.lines.slice(1).map((l) => l.start)];
const FPS = 30;
const total = Math.ceil(t.total * FPS);

const work = mkdtempSync(path.join(tmpdir(), 'tether-overlay-'));
const PORT = 9336;
const chrome = spawn(process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(work, 'p')}`, '--no-first-run',
  '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let url;
for (let i = 0; i < 60 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} await sleep(200); }
const ws = new WebSocket(url); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: pathToFileURL(path.join(here, 'overlay.html')).href });
  for (let i = 0; i < 100 && (await ev('document.readyState')) !== 'complete'; i++) await sleep(100);
  const vars = cuts.map((c, i) => `--c${i}:${c}s`).join(';') + `;--total:${t.total}s`;
  await ev(`document.documentElement.setAttribute('style', '${vars}'); document.fonts.load('800 76px Inter'); document.fonts.load('600 26px Inter'); document.fonts.load('600 30px "JetBrains Mono"'); document.fonts.ready.then(() => new Promise(r => setTimeout(r, 500)))`);
  await ev(`window.__seek = (s) => new Promise((done) => { document.getAnimations().forEach((a) => { a.pause(); a.currentTime = s * 1000; }); requestAnimationFrame(() => requestAnimationFrame(done)); })`);
  for (let f = 0; f < total; f++) {
    await ev(`__seek(${f / FPS})`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
    writeFileSync(path.join(frames, `f${String(f).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
    if (f % 150 === 0) console.log(`overlay frame ${f} / ${total}`);
  }
} finally {
  ws.close(); chrome.kill(); await sleep(800);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
