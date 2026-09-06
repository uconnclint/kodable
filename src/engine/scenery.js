// Ambient set dressing: the distant islands that give the sky a floor, and the
// slow drift of motes that gives the air something in it.
//
// Nothing here is ever interactive and nothing here is ever allowed near the
// board -- the whole job of this module is depth. A flat gradient dome behind a
// flat board puts every pixel on one plane; a handful of fog-tinted masses at
// three different distances turns the same dome into somewhere.
//
// All of it is procedural, all of it is one merged geometry per layer, and all
// of it scales with `flags().detail`, so the low tier draws two extra meshes
// and about nine hundred triangles.
import * as THREE from 'three';
import { flags } from './quality.js';
import { onFrame, getCamera } from './renderer.js';
import { glowDiscTexture } from './textures.js';

function mulberry(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Geometry baking
// ---------------------------------------------------------------------------

function finish(out) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
  g.setIndex(out.idx);
  return g;
}

// ---------------------------------------------------------------------------
// Distant islands
// ---------------------------------------------------------------------------

// Aerial perspective, done by hand and taken all the way. These are unlit --
// the material is MeshBasicMaterial, and every value below is the final pixel
// colour -- because the alternative is a lit distant island catching the key
// light and becoming the brightest object on the screen, which is exactly what
// a first pass at this did in the crystal cavern.
//
// Islands fade towards `theme.ground`, not `theme.horizon`: `ground` is the
// colour the sky dome actually paints *below* the horizon line, which is where
// these hang. Fading to the horizon colour instead leaves a bright band of
// island floating on a dark sky.
function hazed(base, air, amount, value) {
  return base.clone().lerp(air, amount).multiplyScalar(value);
}

// One irregular island: a jagged n-gon plateau, a short cliff, and a keel
// tapering to a point. Generated per island rather than instanced from a
// primitive, because a scaled icosahedron seen from a camera looking down
// presents its top face as a clean hexagon -- unmistakably a shape, never a
// place.
// `air` and `sink` give every vertex a second, per-vertex fade towards the air
// on top of the per-island one: the further *down* a vertex is, the deeper into
// the haze it goes. Three flat fills -- plateau, cliff, keel -- is what made
// these read as cut paper; a distant mass has a value gradient down it whether
// or not it has any lighting, because the air in front of the bottom of it is
// thicker than the air in front of the top. It costs nothing: the vertex
// colours already exist.
function island(out, cx, cy, cz, radius, depth, rnd, top, mid, deep, air, sink) {
  const n = 7 + ((rnd() * 3) | 0);
  const rim = [];
  const waist = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.18;
    const r = radius * (0.72 + rnd() * 0.45);
    rim.push([cx + Math.cos(a) * r, cy - rnd() * radius * 0.10, cz + Math.sin(a) * r]);
    const rw = r * (0.42 + rnd() * 0.20);
    waist.push([cx + Math.cos(a) * rw, cy - depth * (0.30 + rnd() * 0.12), cz + Math.sin(a) * rw]);
  }
  const centre = [cx, cy + radius * 0.06, cz];
  const tip = [cx + (rnd() - 0.5) * radius * 0.3, cy - depth, cz + (rnd() - 0.5) * radius * 0.3];
  const _c = new THREE.Color();
  const push = (a, b, c, ca, cb, cc) => {
    const base = out.pos.length / 3;
    for (const [p, col] of [[a, ca], [b, cb], [c, cc]]) {
      out.pos.push(p[0], p[1], p[2]);
      out.nor.push(0, 1, 0); // unlit material: normals are never sampled
      const k = Math.min(1, Math.max(0, (cy - p[1]) / depth));
      _c.copy(col).lerp(air, k * sink);
      out.col.push(_c.r, _c.g, _c.b);
    }
    out.idx.push(base, base + 1, base + 2);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(centre, rim[j], rim[i], top, top, top);       // plateau
    push(rim[i], rim[j], waist[j], mid, mid, mid);     // cliff
    push(rim[i], waist[j], waist[i], mid, mid, deep);
    push(waist[i], waist[j], tip, deep, deep, deep);   // keel
  }
}

// Islands are generated in *units of the camera's distance to the board*, and
// the mesh is then scaled by that distance every frame. The old code used fixed
// world offsets (x = side * (24 + rnd() * 20)) with no relation to how far away
// the camera had settled, so on a close-framed board -- which is most of World
// 1 and World 4 -- an island landed on or past the edge of the frame and got
// hard-cut by it. A flat two-tone polygon sliced off by the frame edge does not
// read as distant land; it reads as a bug.
//
// Because the camera sits at `dist * VIEW_DIR` and these sit at `dist * p`, the
// vector from one to the other also scales with `dist`: angular position and
// apparent size come out exactly invariant, on every board, at every zoom.
function buildIslands(theme, detail, seed) {
  const rnd = mulberry(seed);
  const out = { pos: [], nor: [], col: [], idx: [] };
  const count = Math.max(3, Math.round(6 * detail));

  const grass = new THREE.Color(theme.grass);
  const rock = new THREE.Color(theme.dirt);
  const air = new THREE.Color(theme.ground);

  for (let i = 0; i < count; i++) {
    // Placed explicitly out to the left and right rather than on a ring. The
    // camera looks down a fixed axis and never orbits, so a ring puts a
    // predictable share of the islands directly behind the board -- and the
    // first version of this hung one immediately behind the exit portal, which
    // is the last object in the game that should have to compete for the eye.
    const side = i % 2 ? 1 : -1;
    const x = side * (0.42 + rnd() * 0.22);
    const z = -(0.35 + rnd() * 0.50);
    // Well below the board, not merely behind it. The camera looks *down* at
    // 53 degrees, so anything level with the island sits above the top of the
    // frame; these have to be far enough under it to fall inside the view.
    const y = -(0.80 + rnd() * 0.55);
    const s = 0.055 + rnd() * 0.065;
    // Two things vary with distance: how far the colour has drifted into the
    // air, and how dark it has gone. Both, because either one alone leaves the
    // far islands reading as nearer, paler ones.
    //
    // The floor used to be 0.38 -- only 38% air on the nearest island, which
    // put it at the same luminance as the board's own grass. In World 4 that
    // meant a distant island at (82,138,208) against playable tiles at
    // (67,116,192): a child could read it as somewhere Bloop might go. Nothing
    // that is not standable is allowed anywhere near the board's value.
    const t = Math.min(1, Math.max(0, (Math.hypot(x, z) - 0.6) / 0.5));
    const haze = 0.62 + t * 0.24;
    const value = Math.min(0.70, 0.70 - t * 0.14);
    island(out, x, y, z, s, s * (1.3 + rnd() * 1.4), rnd,
      hazed(grass, air, haze, value),
      hazed(rock, air, haze + 0.05, value * 0.92),
      hazed(rock, air, haze + 0.12, value * 0.84),
      air, 0.30);
  }

  return out.idx.length ? finish(out) : null;
}

// ---------------------------------------------------------------------------
// Ambient motes
// ---------------------------------------------------------------------------

// Per-theme air. `rise` is metres per second (negative falls), `sway` the
// horizontal wander, `size` the point size in world units.
// `spread` is the per-particle size variation, +-40% of `size`.
//
// World 1's air used to be 0xfff4c4 at 0.46 opacity and 0.20 across, which
// against a bright blue midday sky rendered as small hard white dots: stars at
// noon. Pollen in daylight is a soft, warm, *dim* smudge you notice at the
// edge of the frame, so theme 1 is now bigger, warmer and half the opacity --
// the same total light spread over four times the area, which is the difference
// between a dot and a bit of air.
const AIR = {
  0: { tint: 0xffd7f2, rise: 0.30, sway: 0.30, size: 0.22, opacity: 0.44, spread: 0.4 },
  1: { tint: 0xffdb96, rise: 0.26, sway: 0.34, size: 0.38, opacity: 0.22, spread: 0.4 }, // pollen
  2: { tint: 0x8ef2e4, rise: 0.16, sway: 0.14, size: 0.17, opacity: 0.66, spread: 0.4 }, // mineral glints
  3: { tint: 0xffd9a8, rise: 0.10, sway: 0.62, size: 0.26, opacity: 0.30, spread: 0.4 }, // blown dust
  4: { tint: 0x9ef0ff, rise: 0.55, sway: 0.10, size: 0.15, opacity: 0.54, spread: 0.4 }, // data motes
  5: { tint: 0xd8cfe8, rise: -1.9, sway: 0.05, size: 0.13, opacity: 0.42, spread: 0.25 }, // driven rain
};

// Screen-space stratification.
//
// A uniform rnd() over the volume clumps -- that is what uniform randomness
// does, and at these counts you see it: four of the six visible motes in a
// World 1 shot sat in the top-right corner and one in the bottom-left, which
// reads as dirt on the sensor rather than as air. The volume is divided into a
// 4 x 3 grid across the two axes that map to screen x and y, one mote seeded
// per cell before any are seeded twice, and jittered inside its cell. Depth
// stays uniform: it is not a screen axis, so it cannot clump visibly.
const GRID_X = 4, GRID_Y = 3;

function buildMotes(themeKey, detail, boardRadius, seed) {
  const air = AIR[themeKey] || AIR[0];
  const count = Math.max(40, Math.round(220 * detail));
  const rnd = mulberry(seed + 4242);
  const pos = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);

  // The clear volume: motes are additive, so any that drift across a tile eat
  // contrast on the one surface the player has to read. They are spawned in a
  // ring outside the board, or high enough above it to be out of the way.
  const clear = boardRadius + 1.5;
  const X0 = -13, XW = 26 / GRID_X;
  const Y0 = -4, YH = 11 / GRID_Y;
  for (let i = 0; i < count; i++) {
    const cell = i % (GRID_X * GRID_Y);
    const cx = cell % GRID_X, cy = (cell / GRID_X) | 0;
    let x = 0, y = 0, z = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      x = X0 + (cx + rnd()) * XW;
      y = Y0 + (cy + rnd()) * YH;
      z = (rnd() - 0.5) * 22;
      if (Math.hypot(x, z) > clear || y > 3.2 || y < -1.2) break;
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    // Every mote used to be exactly the same size, which is the other half of
    // why they read as sensor dust rather than as things suspended at different
    // distances in a volume of air.
    sizes[i] = 1 - air.spread + rnd() * air.spread * 2;
    phase[i] = rnd() * Math.PI * 2;
    speed[i] = 0.6 + rnd() * 0.9;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.PointsMaterial({
    color: air.tint,
    map: glowDiscTexture(),
    size: air.size,
    sizeAttenuation: true,
    transparent: true,
    opacity: air.opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Points are unlit by definition; fogging them is what stops the far ones
    // from punching through the haze the islands are sitting in.
    fog: true,
  });
  // PointsMaterial has one size for the whole system, so the per-particle
  // multiplier is patched into its vertex shader. Three lines of GLSL and one
  // float attribute, versus a custom ShaderMaterial that would have to
  // reimplement fog, tone mapping and the map lookup by hand.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float aSize;\n${
      shader.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = size * aSize;')}`;
  };
  mat.customProgramCacheKey = () => 'motes-varysize';
  return { geo, mat, pos, phase, speed, count, air };
}

// ---------------------------------------------------------------------------

export function createScenery(scene, themeKey, theme, boardRadius) {
  const detail = flags().detail;
  const seed = 20260906 + themeKey * 977;
  const group = new THREE.Group();
  group.name = 'scenery';
  const owned = [];
  let stop = null;

  const islandGeo = buildIslands(theme, detail, seed);
  let islands = null;
  if (islandGeo) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    islands = new THREE.Mesh(islandGeo, mat);
    // Never culled and never a shadow caster: they are backdrop, and a shadow
    // frustum big enough to include them would waste the whole shadow map.
    islands.frustumCulled = false;
    // Built in units of camera distance (see buildIslands), so they start at
    // wherever the camera is now -- not at 1, which would be a tenth of a metre
    // across, and not at a constant, which would pop on the first frame.
    const cam = getCamera();
    islands.scale.setScalar(cam ? cam.position.length() : 20);
    group.add(islands);
    owned.push(islandGeo, mat);
  }

  const motes = buildMotes(themeKey, detail, boardRadius, seed);
  const points = new THREE.Points(motes.geo, motes.mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  group.add(points);
  owned.push(motes.geo, motes.mat);

  const { pos, phase, speed, count, air } = motes;
  const yLo = air.rise < 0 ? -3 : -3;
  const yHi = 10;
  // The scale the islands are held at, low-passed. The camera carries a slow
  // 2% idle drift and re-frames with a tween whenever a level loads or the HUD
  // grows a row, and feeding either straight into a scale would make the
  // backdrop breathe. Chasing it at 2.5/second is fast enough to keep up with
  // a framing tween and far too slow to see the drift in.
  let islandScale = islands ? islands.scale.x : 1;
  stop = onFrame((dt, t) => {
    if (islands) {
      const cam = getCamera();
      // The board is always built at the origin, and the camera always looks at
      // it, so its distance from the origin *is* the framing distance.
      const target = cam ? cam.position.length() : islandScale;
      islandScale += (target - islandScale) * Math.min(1, dt * 2.5);
      islands.scale.setScalar(islandScale);
    }
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      pos[j + 1] += air.rise * speed[i] * dt;
      pos[j] += Math.sin(t * 0.5 * speed[i] + phase[i]) * air.sway * dt;
      if (pos[j + 1] > yHi) pos[j + 1] = yLo;
      else if (pos[j + 1] < yLo) pos[j + 1] = yHi;
    }
    motes.geo.attributes.position.needsUpdate = true;
  });

  scene.add(group);
  return {
    group,
    dispose() {
      stop?.();
      scene.remove(group);
      for (const o of owned) o.dispose();
    },
  };
}
