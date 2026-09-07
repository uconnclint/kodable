// Runtime-generated texture maps. Blooptopia ships zero image assets, so every
// surface detail in the game is painted here into a canvas at boot and uploaded
// as an ordinary texture.
//
// The maps are deliberately *achromatic*. Tile and rock colour lives in vertex
// colours (see world.js) so the whole board can share one material and one draw
// call; these maps only multiply a little value and roughness variation on top.
// That split is what lets a pink condition tile and a green path tile be the
// same material without either of them losing its hue.
//
// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------
//   getMaps(themeKey, topKind)  -> { top: {map, roughnessMap},
//                                    rock: {map, roughnessMap, normalMap|null} }
//   softDiscTexture()           -> shared radial alpha disc (contact shadows)
//   glowDiscTexture()           -> shared radial glow disc (portal floor, motes)
//   portalCoreTexture()         -> the exit portal's opaque swirling interior
//   retireStaleMaps()           -> free maps orphaned by a quality-tier change
//   disposeTextures()           -> free everything (page teardown / tests)
//
// `topKind` is one of 'organic' | 'crystalline' | 'strata' | 'panel' | 'slate'.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { flags, tier, onQualityChange } from './quality.js';

// Albedo detail is the expensive one (it is the map you actually read on a
// close tile); roughness and the rock normal carry far less information and are
// generated at half that. A 2018 iPad spends about 12ms on a whole medium-tier
// theme, once, on the first level of a world.
const ALBEDO_RES = { low: 128, medium: 256, high: 512 };

// ---------------------------------------------------------------------------
// Tileable value noise
// ---------------------------------------------------------------------------

function mulberry(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t) => t * t * (3 - 2 * t);

// One octave of value noise on a `g x g` lattice, sampled into a `res x res`
// field. Lattice lookups wrap, which is the whole point: the board's UVs run in
// board space and repeat every two world units, so a seam in the noise would
// show up as a straight line ruled across the island.
function octave(out, res, g, seed, amp) {
  const rnd = mulberry(seed);
  const lat = new Float32Array(g * g);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const step = g / res;
  for (let y = 0; y < res; y++) {
    const fy = y * step;
    const y0 = Math.floor(fy) % g;
    const y1 = (y0 + 1) % g;
    const ty = smooth(fy - Math.floor(fy));
    for (let x = 0; x < res; x++) {
      const fx = x * step;
      const x0 = Math.floor(fx) % g;
      const x1 = (x0 + 1) % g;
      const tx = smooth(fx - Math.floor(fx));
      const a = lat[y0 * g + x0] + (lat[y0 * g + x1] - lat[y0 * g + x0]) * tx;
      const b = lat[y1 * g + x0] + (lat[y1 * g + x1] - lat[y1 * g + x0]) * tx;
      out[y * res + x] += (a + (b - a) * ty) * amp;
    }
  }
}

// Fractal sum, normalised to 0..1. `base` is the lattice size of the first
// octave; each further octave doubles it and halves its contribution.
function fbm(res, seed, base, octaves) {
  const out = new Float32Array(res * res);
  let amp = 1, total = 0, g = base;
  for (let o = 0; o < octaves; o++) {
    octave(out, res, g, seed + o * 7919, amp);
    total += amp;
    amp *= 0.5;
    g *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function makeCanvas(res) {
  const c = document.createElement('canvas');
  c.width = res; c.height = res;
  return c;
}

// Writes a greyscale field (already in 0..1) into a canvas as an RGB texture.
function fieldToCanvas(field, res) {
  const canvas = makeCanvas(res);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(res, res);
  const d = img.data;
  for (let i = 0; i < field.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(field[i] * 255)));
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function texFromCanvas(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = flags().anisotropy;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Surface recipes
// ---------------------------------------------------------------------------
//
// Every recipe returns a *height* field in 0..1. Albedo, roughness and the
// normal map are all derived from that one field, which is what keeps a
// surface's shading, its colour mottle and its bumpiness telling the same
// story instead of three unrelated noises fighting.

function heightField(kind, res, seed) {
  const h = fbm(res, seed, 4, kind === 'panel' ? 3 : 4);
  const fine = fbm(res, seed + 4241, 16, 2);

  if (kind === 'organic') {
    // Meadow grass: broad soft patches plus a fine blade-scale grain, and a
    // scatter of slightly darker clover clumps so the field is not uniform.
    for (let i = 0; i < h.length; i++) {
      let v = h[i] * 0.72 + fine[i] * 0.28;
      const clump = h[i] > 0.62 ? (h[i] - 0.62) * 1.6 : 0;
      h[i] = Math.min(1, Math.max(0, v - clump * 0.35));
    }
  } else if (kind === 'crystalline') {
    // Cavern floor: the same mottle, but banded into terraces so it reads as
    // fractured mineral rather than soil, with a sparse sparkle on the peaks.
    const rnd = mulberry(seed + 99);
    for (let i = 0; i < h.length; i++) {
      const v = h[i] * 0.65 + fine[i] * 0.35;
      const terraced = Math.floor(v * 6) / 6 + (v * 6 % 1) * 0.14;
      h[i] = Math.min(1, terraced + (rnd() > 0.9975 ? 0.7 : 0));
    }
  } else if (kind === 'strata') {
    // Canyon: sediment bands, warped by the noise so they wobble like real
    // bedding planes instead of ruling straight across the board.
    //
    // One band at five cycles was three or four soft stripes per tile face,
    // running dead flat along one axis at half the map's whole amplitude: at
    // any size that is not rock, it is a horizontally-smeared image, and it
    // read as a compression artefact. Two things fix it. A second, much finer
    // course at seventeen cycles gives the surface a *grain* -- roughly eight
    // bands per tile, which is small enough to read as texture rather than as
    // stripes -- and both scales now wander with x as well as y, which halves
    // how far a single value runs in a straight line. The coarse band also
    // gives up a third of its amplitude to make room, so the strata sit under
    // the surface instead of being the surface.
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const warp = (h[i] - 0.5) * 2.2;
        const v = (y / res) * Math.PI * 2;
        const u = (x / res) * Math.PI * 2;
        const band = Math.sin(v * 5 + warp * 1.8 + Math.sin(u) * 0.42) * 0.5 + 0.5;
        const grain = Math.sin(v * 17 + warp * 3.4 + Math.sin(u * 2) * 0.75) * 0.5 + 0.5;
        h[i] = Math.min(1, band * 0.34 + grain * 0.16 + h[i] * 0.30 + fine[i] * 0.20);
      }
    }
  } else if (kind === 'panel') {
    // Tech: flat plate with recessed seams on a one-world-unit pitch, a wash of
    // very low-amplitude noise so it is not dead flat, and a few brighter
    // service plates picked out by the low-frequency layer.
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const u = (x / res + 0.25) % 0.5;
        const v = (y / res + 0.25) % 0.5;
        const edge = Math.min(u, 0.5 - u, v, 0.5 - v);
        // A recessed seam with a lit shoulder on one side of it: the shoulder
        // is what stops the panel grid reading as a drawn line and starts it
        // reading as a moulded joint.
        const seam = edge < 0.010 ? 0.42 : (edge < 0.022 ? 1.12 : 1);
        const plate = h[i] > 0.68 ? 1.10 : 1;
        h[i] = Math.min(1, (0.78 + fine[i] * 0.22) * seam * plate);
      }
    }
  } else { // 'slate'
    // Storm: wet, high-contrast stone with a directional scour across it.
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const streak = Math.sin(((x + y * 0.6) / res) * Math.PI * 2 * 3 + h[i] * 7) * 0.5 + 0.5;
        // A second, much tighter scour across the same diagonal: one at three
        // cycles is a slow shading wobble, and what wet stone actually has is a
        // grain fine enough to see the water sitting in it.
        const grain = Math.sin(((x * 1.4 - y * 0.5) / res) * Math.PI * 2 * 11 + h[i] * 13) * 0.5 + 0.5;
        h[i] = Math.min(1, Math.max(0, h[i] * 0.60 + streak * 0.10 + grain * 0.10 + fine[i] * 0.20));
      }
    }
  }
  return h;
}

// The island's flanks and underside. Coarser than any tile top and always
// stratified: a sheer face with visible bedding is what makes the underside
// read as broken rock instead of as a brown box.
//
// The bedding used to be a single sine at 34% amplitude, which on a cliff a
// hundred pixels tall was a gradient, not strata. It is now two bands at
// different pitches -- a coarse one that reads as the bedding planes and a
// tighter one that breaks each plane into courses -- and the coarse one is
// squared off so a band has an edge rather than a slope. That is the whole
// difference between "layered rock" and "brown with a wobble in it".
function rockField(res, seed) {
  const h = fbm(res, seed + 313, 3, 4);
  const fine = fbm(res, seed + 777, 12, 2);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      const warp = (h[i] - 0.5) * 3.0;
      const v = (y / res) * Math.PI * 2;
      const coarse = Math.sin(v * 5 + warp) * 0.5 + 0.5;
      // Biased towards its own extremes: the midtones collapse and the band
      // gains a lip, without the aliasing a hard step would give at 128px.
      const bedded = coarse * coarse * (3 - 2 * coarse);
      const course = Math.sin(v * 13 + warp * 1.7) * 0.5 + 0.5;
      h[i] = Math.min(1, Math.max(0, h[i] * 0.30 + bedded * 0.44 + course * 0.11 + fine[i] * 0.15));
    }
  }
  return h;
}

// ---------------------------------------------------------------------------
// Map builders
// ---------------------------------------------------------------------------

// Albedo: a narrow multiplier band around white. Anything wider and the mottle
// starts competing with the tile colours, which is the one thing the brief
// says must never happen.
function albedoTexture(h, res, lo, hi) {
  const f = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) f[i] = lo + h[i] * (hi - lo);
  return texFromCanvas(fieldToCanvas(f, res), true);
}

// Roughness: inverted, so the raised parts of the surface are the polished
// ones. That is how worn stone and trodden grass actually behave, and it gives
// the key light something to catch that is not a flat sheet of specular.
function roughnessTexture(h, res, lo, hi) {
  const f = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) f[i] = hi - h[i] * (hi - lo);
  return texFromCanvas(fieldToCanvas(f, res), false);
}

// Sobel the height field into a tangent-space normal map. Only worth it on the
// rock, where the camera sees the surface almost edge-on and a flat normal
// reads as painted-on cardboard.
function normalTexture(h, res, strength) {
  const data = new Uint8Array(res * res * 4);
  const at = (x, y) => h[((y + res) % res) * res + ((x + res) % res)];
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Normalise (-dx, -dy, 1) by hand: a Vector3 per texel would allocate
      // a quarter of a million objects for one map.
      const len = Math.hypot(dx, dy, 1);
      const i = (y * res + x) * 4;
      data[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = flags().anisotropy;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Shared single-purpose textures
// ---------------------------------------------------------------------------

let softDisc = null;
let glowDisc = null;

// A soft alpha disc, used as the fake contact shadow under every floating
// collectable and every prop. It keeps a solid core out to 45% of the radius
// and only feathers after that: a pure falloff from the centre reads as a
// smudge of fog on the grass rather than as something's shadow, which is
// exactly the failure the real shadow map was making.
export function softDiscTexture() {
  if (softDisc) return softDisc;
  const res = 96;
  const canvas = makeCanvas(res);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(res, res);
  const d = img.data;
  const c = (res - 1) / 2;
  const CORE = 0.45;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const r = Math.hypot(x - c, y - c) / c;
      const a = Math.max(0, Math.min(1, (1 - r) / (1 - CORE)));
      const i = (y * res + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.round(a * a * (3 - 2 * a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  softDisc = new THREE.CanvasTexture(canvas);
  softDisc.colorSpace = THREE.SRGBColorSpace;
  return softDisc;
}

// A bright core fading to nothing, for the portal floor and the ambient motes.
// White throughout so callers can tint it with the material colour.
export function glowDiscTexture() {
  if (glowDisc) return glowDisc;
  const res = 128;
  const canvas = makeCanvas(res);
  const ctx = canvas.getContext('2d');
  const c = res / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.32, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.16)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, res, res);
  glowDisc = new THREE.CanvasTexture(canvas);
  glowDisc.colorSpace = THREE.SRGBColorSpace;
  return glowDisc;
}

// The exit portal's interior.
//
// The portal used to be a hole. A gold ring with three additive layers stacked
// inside it and nothing underneath them clipped to pure white -- 424 of 1520
// sampled pixels at exactly (255,255,255) -- on *every* quality tier, so it was
// not bloom, it was paper. A ring has to frame something.
//
// So the ring now frames a mouth: a deep indigo rim, a teal vortex turning
// inside it, and a core that is bright but deliberately capped well short of
// white so the additive pool and shaft on top of it have somewhere to go. The
// swirl is generated per texel rather than stroked, because canvas2d's `filter`
// (the only cheap way to soften strokes) is not on the device floor.
let portalCore = null;

export function portalCoreTexture() {
  if (portalCore) return portalCore;
  const res = 192;
  const canvas = makeCanvas(res);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(res, res);
  const d = img.data;
  const c = (res - 1) / 2;
  // Rim -> mid -> core. Nothing here exceeds 0.86 on any channel: the headroom
  // is the whole point of the object.
  const RIM = [0x14, 0x17, 0x3a];
  const MID = [0x1c, 0x55, 0x7e];
  const CORE = [0x4e, 0xcd, 0xbe];
  const mix = (a, b, t) => a + (b - a) * t;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      const i = (y * res + x) * 4;
      if (r > 1) { d[i + 3] = 0; continue; }
      const a = Math.atan2(dy, dx);
      // Three arms, dragged round by radius so the vortex reads as turning
      // inwards rather than as a pinwheel decal.
      const arm = Math.sin(a * 3 + (1 - r) * 7.5) * 0.5 + 0.5;
      // Value: bright at the middle, dark at the lip. The lip is what stops the
      // disc reading as a sticker on the tile.
      let v = Math.pow(Math.max(0, 1 - r), 1.35);
      v = Math.min(1, v * (0.72 + arm * 0.46));
      const col = v < 0.5
        ? [mix(RIM[0], MID[0], v * 2), mix(RIM[1], MID[1], v * 2), mix(RIM[2], MID[2], v * 2)]
        : [mix(MID[0], CORE[0], v * 2 - 1), mix(MID[1], CORE[1], v * 2 - 1), mix(MID[2], CORE[2], v * 2 - 1)];
      d[i] = col[0] | 0; d[i + 1] = col[1] | 0; d[i + 2] = col[2] | 0;
      // Feathered only in the outermost 6%, so the disc has a clean edge under
      // the ring without a jagged one when the camera drifts.
      d[i + 3] = Math.round(Math.max(0, Math.min(1, (1 - r) / 0.06)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  portalCore = new THREE.CanvasTexture(canvas);
  portalCore.colorSpace = THREE.SRGBColorSpace;
  return portalCore;
}

// ---------------------------------------------------------------------------
// Theme cache
// ---------------------------------------------------------------------------

// Three themes' worth of maps is roughly 6MB at the high tier. Keeping every
// theme resident would be fine on a desktop and would not be on an iPad 6, and
// a player only ever sees one world at a time, so the least-recently-used entry
// is evicted instead.
const CACHE_LIMIT = 3;
const cache = new Map(); // `${themeKey}:${kind}:${tier}` -> entry
const retired = [];      // entries orphaned by a tier change, freed on next build

function disposeEntry(entry) {
  for (const group of [entry.top, entry.rock]) {
    for (const key of Object.keys(group)) group[key]?.dispose();
  }
}

function buildEntry(themeKey, kind) {
  const res = ALBEDO_RES[tier()];
  const half = Math.max(64, res >> 1);
  const seed = 1013 + themeKey * 6151;

  const topH = heightField(kind, res, seed);
  const topHalf = heightField(kind, half, seed);
  const rockH = rockField(res, seed);
  const rockHalf = rockField(half, seed);

  // Tech panels want almost no albedo mottle (a moulded plastic plate is
  // uniform); grass and stone want a fair amount or they read as vinyl. Wet
  // slate wants more than either: it is the one surface in the game with no
  // hue to carry it and no props scattered over it, so with a 24% band it read
  // as a flat plastic tile whatever colour it was painted.
  const topLo = kind === 'panel' ? 0.78 : (kind === 'slate' ? 0.66 : 0.76);

  return {
    top: {
      map: albedoTexture(topH, res, topLo, 1.0),
      roughnessMap: roughnessTexture(topHalf, half, kind === 'panel' ? 0.35 : 0.62, 0.98),
    },
    rock: {
      // A wider band than the tile tops get. The cliff is the one surface in
      // the game the camera sees almost edge-on, so its detail map is doing the
      // work a silhouette would otherwise have to do alone -- and at 0.60 the
      // strata were inside the noise floor of the shading.
      map: albedoTexture(rockH, res, 0.50, 1.0),
      roughnessMap: roughnessTexture(rockHalf, half, 0.66, 1.0),
      // Present on every tier now. It used to be cut on low on the grounds that
      // it "buys nothing at a 128px albedo budget", but the thing it buys is
      // the only relief on the island's flanks, and a 64px RGBA map is 16KB and
      // one texture fetch on a material covering maybe a tenth of the frame.
      // Softened there, because a strong normal on a coarse map shimmers.
      normalMap: normalTexture(rockHalf, half, flags().anisotropy > 1 ? 2.6 : 1.9),
    },
  };
}

export function getMaps(themeKey, kind) {
  const key = `${themeKey}:${kind}:${tier()}`;
  const hit = cache.get(key);
  if (hit) {
    // Re-inserting keeps the Map's insertion order acting as an LRU list.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const entry = buildEntry(themeKey, kind);
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    disposeEntry(cache.get(oldest));
    cache.delete(oldest);
  }
  return entry;
}

// A tier change invalidates every resolution in the cache, but the materials
// still on screen are sampling those textures right now -- freeing them here
// would render the current level untextured until the next build. So they are
// parked and freed by the next buildLevel, which disposes those materials
// first. See world.js.
onQualityChange(() => {
  for (const entry of cache.values()) retired.push(entry);
  cache.clear();
});

export function retireStaleMaps() {
  while (retired.length) disposeEntry(retired.pop());
}

export function disposeTextures() {
  retireStaleMaps();
  for (const entry of cache.values()) disposeEntry(entry);
  cache.clear();
  softDisc?.dispose(); softDisc = null;
  glowDisc?.dispose(); glowDisc = null;
  portalCore?.dispose(); portalCore = null;
}
