#!/usr/bin/env node
// Headless screenshot harness for visual review of the 3D scene.
//
// Dependency-free: it drives a headless Chrome over the DevTools protocol using
// Node's built-in fetch + WebSocket, so nothing has to be added to
// package.json. Every invocation gets its own debugging port and profile
// directory, which is what lets several review agents shoot at once.
//
//   node tools/shot.mjs --scene w1l1 --out /tmp/a.png
//   node tools/shot.mjs --scene w3l4:run --out /tmp/b.png --w 1600 --h 1000
//
// Scenes: menu | worldmap | levels | characters | w<world>l<index>
//         append ":run" to play the level's stored solution first,
//         ":preview" to draw the predicted-path overlay, ":play" to build the
//         solution by clicking the real command palette and pressing RUN (the
//         only mode that exercises the HUD's win path and results modal), or
//         ":fail" to run a deliberately wrong program so the failure animation
//         and its "out-of-commands" beat can be reviewed.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const scene = args.scene || 'menu';
const out = args.out || join(tmpdir(), `blooptopia-${scene.replace(/[^\w]/g, '_')}.png`);
const width = Number(args.w || 1600);
const height = Number(args.h || 1000);
const dpr = Number(args.dpr || 2);
const settle = Number(args.settle || 2600);
const url = args.url || 'http://localhost:5199/';
const port = Number(args.port || 9000 + Math.floor(Math.random() * 40000));

// ---- CDP plumbing -----------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(p, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* chrome not listening yet */ }
    await sleep(120);
  }
  throw new Error(`Chrome never opened a debugging port on ${p}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        const message = { id: ++id, method, params };
        if (sessionId) message.sessionId = sessionId;
        return new Promise((res, rej) => {
          pending.set(message.id, { resolve: res, reject: rej });
          ws.send(JSON.stringify(message));
        });
      },
      on(fn) { listeners.push(fn); },
      close() { ws.close(); },
    }));
  });
}

// ---- scene scripts ----------------------------------------------------------

// Runs inside the page. Returns once the requested screen is on-stage; the
// caller then waits `settle` ms for camera tweens and idle animation.
function sceneScript(name) {
  const [screen, mode] = name.split(':');
  const match = /^w(\d+)l(\d+)$/.exec(screen);
  if (!match) {
    return `(() => { window.__blooptopia.show(${JSON.stringify(screen)}); return ${JSON.stringify(screen)}; })()`;
  }
  const [, world, index] = match;
  return `(() => {
    const api = window.__blooptopia;
    const lvl = api.levelAt(${world}, ${index});
    if (!lvl) throw new Error('no such level');
    api.startLevel(lvl);
    const mode = ${JSON.stringify(mode || '')};
    if (mode === 'run' || mode === 'preview') {
      const program = lvl.solution;
      const s = api.getSession();
      if (mode === 'preview') s.preview(program);
      else s.run(program, { onCommand() {}, onDone() {} });
    } else if (mode === 'fail') {
      // A single command in the direction the solution does *not* start with.
      // It either stops short or runs out of commands, and either way the
      // interpreter emits a fail step -- which is the beat being reviewed.
      const first = ((lvl.solution && lvl.solution.main) || []).find((t) => t.t === 'dir');
      const away = { U: 'D', D: 'U', L: 'R', R: 'L' }[first ? first.d : 'R'] || 'L';
      api.getSession().run(
        { main: [{ t: 'dir', d: away }], functions: [], conditions: [] },
        { onCommand() {}, onDone() {} },
      );
    } else if (mode === 'play') {
      // Drive the actual UI: tap each palette button, then press RUN. This is
      // the only path that produces the results modal, because the HUD owns
      // the program state and the win callback -- session.run() bypasses both.
      const NAME = { U: 'Up', D: 'Down', L: 'Left', R: 'Right' };
      const tokens = (lvl.solution && lvl.solution.main) || [];
      if (!tokens.every((t) => t.t === 'dir')) {
        throw new Error('":play" only supports levels solved with plain direction commands');
      }
      for (const t of tokens) {
        const btn = document.querySelector('button[aria-label="Add ' + NAME[t.d] + ' command"]');
        if (!btn) throw new Error('no palette button for ' + t.d);
        btn.click();
      }
      const run = document.querySelector('button.btn.big.green');
      if (!run) throw new Error('no RUN button');
      run.click();
    }
    return lvl.name || lvl.id;
  })()`;
}

// ---- main -------------------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'blooptopia-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  // Software GL is the reliable path for headless WebGL2 on macOS; the scene
  // is a handful of thousand triangles, so stills render fine without a GPU.
  // --gpu swaps in the real Metal-backed driver, which matters because
  // SwiftShader is detected as a software GPU and therefore always selects the
  // `low` quality tier -- the medium/high tiers can only be exercised on
  // hardware, or by forcing the tier with ?q=.
  ...(args.gpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d; });

let client;
try {
  client = await connect(await waitForEndpoint(port));
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p = {}) => client.send(m, p, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: false,
  });

  const consoleErrors = [];
  client.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description
        || msg.params.exceptionDetails.text);
    }
  });

  const loaded = new Promise((resolve) => {
    client.on((msg) => {
      if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') resolve();
    });
  });
  await call('Page.navigate', { url });
  await loaded;

  // Wait for the bundle to finish booting before poking at its globals.
  let booted = false;
  for (let i = 0; i < 400; i++) {
    const r = await call('Runtime.evaluate', { expression: '!!window.__blooptopia', returnByValue: true });
    if (r.result.value) { booted = true; break; }
    await sleep(100);
  }
  // Without this, a boot-time throw surfaces only as "cannot read levelAt" from
  // the scene script below, which points at the harness rather than at the game.
  if (!booted) {
    const why = consoleErrors.length ? consoleErrors.join('\n') : '(no exception was reported)';
    throw new Error(`the game never finished booting; window.__blooptopia is undefined.\n${why}`);
  }

  const res = await call('Runtime.evaluate', {
    expression: sceneScript(scene),
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`scene "${scene}" failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  }

  await sleep(settle);

  const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));

  const summary = { out, scene, label: res.result.value, width, height, dpr };
  if (consoleErrors.length) summary.pageErrors = consoleErrors;
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(`shot failed: ${err.message}`);
  if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-8).join('\n'));
  process.exitCode = 1;
} finally {
  client?.close();
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
