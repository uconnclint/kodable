// Shared device-quality tier. Every optional visual effect in the game keys off
// this module so a 2018 iPad and a desktop can run the same bundle.
//
// ---------------------------------------------------------------------------
// PUBLIC API  (import this; you should never need to read the implementation)
// ---------------------------------------------------------------------------
//
//   import { tier, flags, caps, onQualityChange } from './quality.js';
//
//   tier()            -> 'low' | 'medium' | 'high'
//   flags()           -> frozen feature object for the current tier (see below)
//   caps()            -> frozen device capability report (see below)
//   setTier(t, why)   -> force a tier; notifies subscribers. `why` is a short
//                        string used only for the console note.
//   onQualityChange(fn) -> subscribe. fn(tier, flags) fires on every change.
//                        Returns an unsubscribe function. Never fires for the
//                        initial value — read flags() yourself at setup time.
//   noteFrame(dtMs)   -> feed the frame time to the watchdog. The renderer
//                        already calls this once per frame; nobody else should.
//   pixelRatioFor(w,h)-> device pixel ratio to hand WebGLRenderer.setPixelRatio
//                        for a CSS viewport of w x h. Capped by tier AND by a
//                        total-pixel budget, so a 3x iPad Pro does not render
//                        three times the pixels it can push.
//
// flags() fields — all tiers define all of them, so callers never branch on
// tier() directly. Prefer a flag; add a new flag rather than a tier check.
//
//   postFX        bool    run the EffectComposer at all (false => plain render)
//   bloom         bool    UnrealBloomPass on emissive highlights
//   ao            bool    screen-space ambient occlusion
//   msaaSamples   int     MSAA samples on the post-processing render target
//   shadows       bool    cast shadows at all
//   softShadows   bool    wide (true) vs narrow (false) shadow penumbra
//   shadowMapSize int     directional-light shadow map resolution
//   envMapSize    int     PMREM cube size for the procedural environment map
//   maxPixelRatio number  hard ceiling on devicePixelRatio
//   pixelBudget   number  ceiling on total rendered pixels (w*h*dpr*dpr)
//   detail        number  0..1.25 multiplier for optional scene decoration
//                         (cloud count, deco density, particle counts)
//   anisotropy    int     texture anisotropy for anything that samples a map
//
// caps() fields: gpu ('software'|'weak'|'normal'|'strong'|'unknown'),
//   renderer (raw UNMASKED_RENDERER string or ''), cores, deviceMemory,
//   maxTextureSize, devicePixelRatio, mobile, webgl2.
//
// Overrides, in priority order:
//   ?q=low|medium|high   URL query (used by the screenshot harness)
//   localStorage['blooptopia.quality']
//   auto-detection
//
// The watchdog only ever downgrades, and only once per step. Auto-upgrading
// would oscillate: the tier that caused the stall would be restored, stall
// again, and the player would watch the scene flicker between two looks.
// ---------------------------------------------------------------------------

const TIERS = ['low', 'medium', 'high'];

const FLAGS = {
  low: {
    postFX: false, bloom: false, ao: false, msaaSamples: 0,
    shadows: true, softShadows: false, shadowMapSize: 512,
    envMapSize: 64, maxPixelRatio: 1, pixelBudget: 1.5e6,
    detail: 0.5, anisotropy: 1,
  },
  medium: {
    postFX: true, bloom: true, ao: false, msaaSamples: 4,
    shadows: true, softShadows: true, shadowMapSize: 1024,
    envMapSize: 128, maxPixelRatio: 2, pixelBudget: 2.6e6,
    detail: 1, anisotropy: 4,
  },
  high: {
    postFX: true, bloom: true, ao: false, msaaSamples: 4,
    shadows: true, softShadows: true, shadowMapSize: 2048,
    envMapSize: 256, maxPixelRatio: 2, pixelBudget: 4.6e6,
    detail: 1.25, anisotropy: 8,
  },
};
for (const t of TIERS) Object.freeze(FLAGS[t]);

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

// Renderer strings that mean "there is no GPU here" (headless Chrome, VMs,
// blocklisted drivers). Software rasterisers manage a few fps at best with
// post-processing on, so they always land on the low tier.
const SOFTWARE = /swiftshader|llvmpipe|softwarerasterizer|basic render|microsoft basic/i;
// Old mobile parts and integrated chips that predate the device floor's
// comfortable range. Matching is deliberately loose: a false "weak" costs a
// little sharpness, a false "strong" costs playability.
const WEAK = /adreno \(tm\) [345]\d\d|mali-[tg]?[1-6]\d\b|powervr (sgx|rogue g6)|intel.*(hd|gma) graphics (3|4|5)\d\d\d?/i;
const STRONG = /nvidia|geforce|rtx|quadro|radeon|apple m\d|metal/i;

let _caps = null;

function probeCaps() {
  if (_caps) return _caps;
  let renderer = '';
  let maxTextureSize = 2048;
  let webgl2 = false;
  try {
    // A throwaway canvas: probing the real one would pin its context
    // attributes before WebGLRenderer gets to ask for antialiasing.
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      webgl2 = true;
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
      if (!renderer) renderer = String(gl.getParameter(gl.RENDERER) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* a locked-down browser: fall through to the conservative default */ }

  let gpu = 'unknown';
  if (renderer) {
    if (SOFTWARE.test(renderer)) gpu = 'software';
    else if (WEAK.test(renderer)) gpu = 'weak';
    else if (STRONG.test(renderer)) gpu = 'strong';
    else gpu = 'normal';
  }

  const mobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent)); // iPadOS desktop-mode UA

  _caps = Object.freeze({
    gpu, renderer, mobile, webgl2, maxTextureSize,
    cores: navigator.hardwareConcurrency || 4,
    deviceMemory: navigator.deviceMemory || 0,
    devicePixelRatio: globalThis.devicePixelRatio || 1,
  });
  return _caps;
}

function detectTier() {
  const c = probeCaps();
  if (!c.webgl2 || c.gpu === 'software') return 'low';
  if (c.gpu === 'weak') return 'low';
  // Small texture limits and very low core counts both point at the bottom of
  // the supported range (an A9/A10 iPad or a budget Chromebook).
  if (c.maxTextureSize < 8192 || c.cores <= 2) return 'low';
  if (c.deviceMemory && c.deviceMemory <= 2) return 'low';
  // Everything mobile defaults to medium. An iPad Pro is perfectly capable of
  // the high tier, but there is no reliable way to tell it from an iPad 6 --
  // Safari reports both as "Apple GPU" -- and guessing high on the weaker one
  // costs frames. The watchdog can still drop it; nothing pushes it up.
  if (c.mobile) return 'medium';
  if (c.gpu === 'strong' && c.cores >= 8) return 'high';
  return 'medium';
}

function readOverride() {
  let q = '';
  try {
    q = new URLSearchParams(location.search).get('q') || '';
    if (!q) q = localStorage.getItem('blooptopia.quality') || '';
  } catch { /* file:// or storage disabled */ }
  q = q.toLowerCase();
  return TIERS.indexOf(q) >= 0 ? q : null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const forced = readOverride();
let current = forced || detectTier();
const subscribers = new Set();

export function tier() { return current; }
export function flags() { return FLAGS[current]; }
export function caps() { return probeCaps(); }

export function setTier(next, why) {
  if (TIERS.indexOf(next) < 0 || next === current) return;
  if (forced) return; // an explicit override is a promise; do not second-guess it
  current = next;
  console.info(`[quality] tier -> ${next}${why ? ` (${why})` : ''}`);
  for (const fn of [...subscribers]) fn(current, FLAGS[current]);
}

export function onQualityChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function pixelRatioFor(width, height) {
  const f = FLAGS[current];
  const dpr = Math.min(globalThis.devicePixelRatio || 1, f.maxPixelRatio);
  const area = Math.max(width * height, 1);
  // Below the budget, use the display's own ratio; above it, back off until
  // the frame fits. A 2x 13" iPad Pro lands around 1.55 instead of 2.
  const budgeted = Math.sqrt(f.pixelBudget / area);
  return Math.max(1, Math.min(dpr, budgeted));
}

// ---------------------------------------------------------------------------
// Frame-time watchdog
// ---------------------------------------------------------------------------

const WINDOW_MS = 1500;   // length of one measurement window
const WARMUP_MS = 3000;   // shader compiles and the first level build are slow
const BUDGET_MS = 23;     // ~43fps; below this we are visibly missing frames
const STRIKES = 2;        // consecutive bad windows before we act

let started = 0;
let windowMs = 0;
let windowFrames = 0;
let strikes = 0;

export function noteFrame(dtMs) {
  if (forced) return;
  if (!started) started = performance.now();
  if (performance.now() - started < WARMUP_MS) return;
  // A frame longer than a quarter second is a tab switch, a GC pause or a
  // level rebuild, not a sustained framerate problem. Averaging it in would
  // downgrade players for something that happens once.
  if (dtMs > 250) return;
  windowMs += dtMs;
  windowFrames++;
  if (windowMs < WINDOW_MS) return;
  const avg = windowMs / windowFrames;
  windowMs = 0;
  windowFrames = 0;
  if (avg <= BUDGET_MS) { strikes = 0; return; }
  if (++strikes < STRIKES) return;
  strikes = 0;
  const idx = TIERS.indexOf(current);
  if (idx > 0) setTier(TIERS[idx - 1], `frame time ${avg.toFixed(1)}ms`);
}
