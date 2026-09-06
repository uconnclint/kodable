#!/usr/bin/env node
// Blind A/B comparison sheet.
//
// Composites two screenshots side by side in a RANDOMISED order, labelled only
// "A" and "B", and writes the answer key to a separate JSON file. A reviewing
// agent is handed the sheet but not the key, so its preference can't be
// anchored by knowing which image is the new one — which is the whole point,
// since "the one I was told is the improvement" is not a judgement.
//
//   node tools/ab.mjs --left old.png --right new.png \
//     --out sheet.png --key key.json [--title "World 3"]
//
// Reveal the key afterwards with:  node tools/ab.mjs --reveal key.json
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--')) continue;
  const k = process.argv[i].slice(2);
  const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true';
  args[k] = v;
}

if (args.reveal) {
  console.log(readFileSync(args.reveal, 'utf8'));
  process.exit(0);
}

const left = resolve(args.left);
const right = resolve(args.right);
const out = resolve(args.out || join(tmpdir(), 'ab-sheet.png'));
const keyPath = resolve(args.key || out.replace(/\.png$/, '.key.json'));
const title = args.title || '';

// Coin flip decides which source image becomes panel A.
const swap = Math.random() < 0.5;
const panelA = swap ? right : left;
const panelB = swap ? left : right;

const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#15151c;font:600 22px/1.2 -apple-system,system-ui,sans-serif;color:#fff}
  .sheet{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:18px}
  figure{margin:0}
  figcaption{padding:10px 0 12px;font-size:34px;letter-spacing:.12em;text-align:center;color:#fff}
  img{width:100%;display:block;border-radius:10px}
  h1{font-size:24px;font-weight:600;margin:0;padding:16px 18px 0;color:#9aa0b5;letter-spacing:.02em}
</style>
${title ? `<h1>${title}</h1>` : ''}
<div class="sheet">
  <figure><figcaption>A</figcaption><img src="${dataUri(panelA)}"></figure>
  <figure><figcaption>B</figcaption><img src="${dataUri(panelB)}"></figure>
</div>`;

const profile = mkdtempSync(join(tmpdir(), 'blooptopia-ab-'));
const htmlFile = join(profile, 'sheet.html');
writeFileSync(htmlFile, html);
const port = 9000 + Math.floor(Math.random() * 40000);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

async function ws() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('Chrome never opened a debugging port');
}

let sock;
try {
  const url = await ws();
  sock = await new Promise((res, rej) => {
    const s = new WebSocket(url);
    s.addEventListener('error', rej);
    s.addEventListener('open', () => res(s));
  });
  let id = 0;
  const pending = new Map();
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, { res, rej });
    sock.send(JSON.stringify(msg));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p) => send(m, p, sessionId);
  await call('Page.enable');
  // A short viewport keeps `contentSize` equal to the sheet's own height, so
  // the capture below crops to the content instead of padding it with letterbox.
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 200, deviceScaleFactor: 2, mobile: false });
  await call('Page.navigate', { url: `file://${htmlFile}` });
  await sleep(1200);
  const { contentSize } = await call('Page.getLayoutMetrics');
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 },
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, JSON.stringify({ sheet: out, A: panelA, B: panelB, swapped: swap }, null, 2));
  console.log(JSON.stringify({ sheet: out, key: keyPath }, null, 2));
} catch (err) {
  console.error(`ab failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  sock?.close();
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
