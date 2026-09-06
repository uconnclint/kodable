// Motion easing + the game's particle / shockwave / trail effect system.
//
// Everything here is procedural (no image files), pooled (no allocation once
// the pools are warm) and scaled by `flags().detail`, because the reward
// moments fire dozens of times a minute on a tablet that also has to keep the
// board at 60fps.
//
// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------
//   ease                      easing curves (see the table below)
//   spring(k, damp)           tiny critically-ish damped spring, for settles
//
//   emit(opts)                low-level particle burst  (see EMIT OPTIONS)
//   ring(opts)                expanding ground shockwave
//   absorb(mesh, opts)        fly a collected item up and out of existence
//   createTrail(color)        -> { update(pos, dt), dispose() }
//
//   collect(pos, item, mesh)  coin / star pickup       (reward tier 1 / 2)
//   turnPulse(pos, color)     condition tile fires
//   land(pos, power)          a roll comes to rest away from a wall
//   bump(pos, dir, power)     the roll is blocked by the edge of the island
//   celebrate(pos, mag, col)  escalating reward: 3 = win, 4 = perfect clear,
//                             5 = world complete
//   fizzle(pos)               the program ran out / looped forever
//   screenFlash(col, a, life) one soft full-frame wash (tier 4+ only)
//   ringTexture()             the shared soft-annulus texture (preview.js)
//
//   clearFx()                 kill every live effect (run cancelled / reset)
//   disposeFx()               release every GPU resource this module owns
//
// The reward ladder is deliberately built out of *different kinds* of event,
// not out of bigger numbers of the same one. Bigger numbers of the same thing
// do not escalate: 45% more of an effect you already saw reads as noise, and
// the whole point of the ladder is that a child can *see* that this clear was
// better than the last one.
//   coin   9 sparks
//   star   + a shockwave, + the star bursts into a dozen shards, + twinkles
//   win    + three timed waves, + confetti, + Bloop jumps and spins
//   perfect  + a full-frame gold wash, + an amber second ring instead of the
//            character's colour, + a second confetti volley, + Bloop hangs at
//            the top of a higher hop and hops again on landing
//   world    + a cream ring and a wide fountain 0.8s later
//
// ---------------------------------------------------------------------------
// EMIT OPTIONS  (all optional except pos)
// ---------------------------------------------------------------------------
//   pos      THREE.Vector3   emitter origin
//   count    number          particles *before* the detail multiplier
//   shape    'sphere' | 'dome' | 'ring' | 'cone' | 'fountain'
//   dir      THREE.Vector3   axis for 'cone'
//   spread   number          cone half-angle, radians
//   speed    [min, max]      units/sec
//   size     [birth, death]  world-space sprite diameter
//   life     [min, max]      seconds
//   colors   [THREE.Color]   picked per particle (non-uniform on purpose)
//   fadeTo   THREE.Color     colour at end of life (defaults to the birth one)
//   gravity  number          units/sec^2, positive = falls
//   drag     number          per-second velocity damping
//   spin     [min, max]      sprite rotation, rad/sec
//   sprite   'blob' | 'star' | 'ring'
//   alpha    number          peak opacity
//   soft     boolean         true = additive (glow), false = normal (confetti)
//   radius   number          spawn jitter radius around pos
//   swirl    number          tangential velocity added around the Y axis
//   floor    number          minimum count after the tier multiplier
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { onFrame, getScene, getCamera, getRenderer } from './renderer.js';
import { flags } from './quality.js';

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------
// Deliberately *not* sines. A sine has the same acceleration entering and
// leaving, which is exactly the "floaty, weightless" read this game had. Real
// character motion is asymmetric: it leaves fast and arrives slowly.
const c1 = 1.70158;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOutQuint: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),
  // Overshoots past 1 and comes back: the "arrives with weight" curve.
  outBack: (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  inBack: (t) => c3 * t * t * t - c1 * t * t,
  // Rings once and settles. Used sparingly -- on a six-year-old's screen more
  // than one visible oscillation reads as a glitch, not as bounce.
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1
    : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
  outBounce: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
    if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
    t -= 2.625 / d; return n * t * t + 0.984375;
  },
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
};

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// A one-dimensional damped spring. Kicks compose additively, which is the
// whole point: a landing squash that arrives while a bump is still ringing
// blends instead of snapping the scale back to a keyframe.
export function spring(stiffness, damping) {
  return {
    v: 0,
    x: 0,
    kick(impulse) { this.v += impulse; },
    set(x) { this.x = x; this.v = 0; },
    step(dt) {
      // Sub-stepped so a dropped frame cannot make the spring explode.
      const n = dt > 0.02 ? Math.ceil(dt / 0.02) : 1;
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        this.v += (-stiffness * this.x - damping * this.v) * h;
        this.x += this.v * h;
      }
      return this.x;
    },
  };
}

// ---------------------------------------------------------------------------
// Procedural sprite atlas
// ---------------------------------------------------------------------------
// One RGB texture holding three masks, selected per particle in the shader by
// a dot product with a channel mask. One texture, one material, three looks.
//   R  soft blob  - bright core, wide halo. Glows, dust, confetti.
//   G  twinkle    - four-point star. Sparkles and the star pickup.
//   B  soft ring  - a thin annulus. Pops and impact flecks.
const SPRITE_SIZE = 128;

function makeSpriteAtlas() {
  const S = SPRITE_SIZE;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = ((x + 0.5) / S) * 2 - 1;
      const ny = ((y + 0.5) / S) * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);
      const fall = Math.max(0, 1 - r);

      // Two falloffs summed: a tight core so the particle has a readable
      // centre, and a wide skirt so it never shows a hard edge against the
      // sky. A single gaussian gives one or the other, not both.
      const blob = Math.min(1, Math.pow(fall, 1.6) * 0.55 + Math.pow(fall, 6) * 0.75);

      const ax = Math.abs(nx), ay = Math.abs(ny);
      const cross = Math.pow(fall, 2.0) / (1 + Math.min(ax, ay) * 30);
      const core = Math.pow(Math.max(0, 1 - r * 3.4), 2);
      const star = Math.min(1, cross * 1.15 + core);

      const rd = (r - 0.66) / 0.15;
      const ring = r > 1 ? 0 : Math.exp(-rd * rd) * Math.min(1, fall * 6);

      const i = (y * S + x) * 4;
      data[i] = Math.round(blob * 255);
      data[i + 1] = Math.round(star * 255);
      data[i + 2] = Math.round(ring * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; // particles get small fast; without this they crawl
  tex.needsUpdate = true;
  return tex;
}

// White RGB with the shockwave profile in alpha, so a MeshBasicMaterial can
// tint it per ring without a second shader.
function makeRingTexture() {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = ((x + 0.5) / S) * 2 - 1;
      const ny = ((y + 0.5) / S) * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);
      const a = (r - 0.70) / 0.115;
      const b = (r - 0.70) / 0.30;
      // Sharp bright rim over a soft inner wash: the wash is what stops the
      // ring reading as a wireframe circle at small scales.
      const v = r > 1 ? 0 : (Math.exp(-a * a) * 0.92 + Math.exp(-b * b) * 0.20)
        * Math.min(1, (1 - r) * 7);
      const i = (y * S + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, v) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Particle pool
// ---------------------------------------------------------------------------

const VERT = `
attribute vec3 pcolor;
attribute vec3 pcolor2;
attribute float psize;
attribute float psize2;
attribute float palpha;
attribute float pspin;
attribute float pshape;
attribute float pcurve;
attribute float page;   // 0..1 normalised lifetime, updated on the CPU
uniform float uPix;
varying vec3 vColor;
varying float vAlpha;
varying float vRot;
varying vec3 vMask;

void main() {
  float u = page;
  vColor = mix(pcolor, pcolor2, u);
  vMask = vec3(step(pshape, 0.5),
               step(0.5, pshape) * step(pshape, 1.5),
               step(1.5, pshape));
  vRot = pspin;

  // Two alpha curves. 0 = ease-out fade (dust, confetti: present, then gone).
  // 1 = pop (snaps on, holds, drops away) which is what makes a sparkle read
  // as a flash rather than as a shrinking dot.
  float fade = pow(1.0 - u, 1.7);
  float pop = smoothstep(0.0, 0.10, u) * pow(1.0 - u, 2.6);
  vAlpha = palpha * mix(fade, pop, step(0.5, pcurve));

  // Size follows its own curve so a spark can flare before it dies instead of
  // shrinking linearly the way every default particle system does.
  float grow = mix(u, 1.0 - pow(1.0 - u, 2.4), step(0.5, pcurve));
  float sz = mix(psize, psize2, grow);

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(sz * projectionMatrix[1][1] * uPix / max(-mv.z, 0.05), 320.0);
}`;

const FRAG = `
uniform sampler2D uMap;
varying vec3 vColor;
varying float vAlpha;
varying float vRot;
varying vec3 vMask;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
  float a = dot(texture2D(uMap, uv).rgb, vMask) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SHAPE_ID = { blob: 0, star: 1, ring: 2 };

function makePool(capacity, additive, atlas) {
  const geo = new THREE.BufferGeometry();
  const f32 = (n) => new Float32Array(capacity * n);
  const pos = f32(3), col = f32(3), col2 = f32(3);
  const size = f32(1), size2 = f32(1), alpha = f32(1);
  const spin = f32(1), shape = f32(1), curve = f32(1), age = f32(1);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('pcolor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('pcolor2', new THREE.BufferAttribute(col2, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('psize2', new THREE.BufferAttribute(size2, 1));
  geo.setAttribute('palpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('pspin', new THREE.BufferAttribute(spin, 1));
  geo.setAttribute('pshape', new THREE.BufferAttribute(shape, 1));
  geo.setAttribute('pcurve', new THREE.BufferAttribute(curve, 1));
  geo.setAttribute('page', new THREE.BufferAttribute(age, 1));
  geo.setDrawRange(0, 0);
  // The pool never moves, so an infinite sphere keeps three from culling it
  // when the emitter happens to sit outside a stale bounding volume.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: atlas }, uPix: { value: 500 } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = additive ? 12 : 11;

  return {
    points, geo, mat, capacity, n: 0,
    // Per-particle simulation state the shader never sees.
    vx: f32(1), vy: f32(1), vz: f32(1),
    t: f32(1), life: f32(1), grav: f32(1), drag: f32(1), spinRate: f32(1),
    pos, col, col2, size, size2, alpha, spin, shape, curve, age,
  };
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let root = null;          // scene group holding every effect
let atlas = null, ringTex = null;
let glowPool = null, solidPool = null;
let rings = [];           // pooled shockwave meshes
let ringGeo = null;
let absorbing = [];       // collected item meshes flying out
let timers = [];          // delayed sub-bursts (the celebration waves)
let flashMesh = null;     // the full-frame wash, built on first use
let flashGeo = null;
let flash = null;         // { t, life, peak, color } while one is playing
let stopFrame = null;
let started = false;
const _size = new THREE.Vector2();

function ensure() {
  if (started) return true;
  const scene = getScene();
  if (!scene) return false;
  started = true;

  const detail = flags().detail;
  atlas = makeSpriteAtlas();
  ringTex = makeRingTexture();

  root = new THREE.Group();
  root.name = 'fx';
  scene.add(root);

  // Glow (additive) carries most of the load; the solid pool only ever holds
  // confetti and dust, which are far fewer.
  glowPool = makePool(Math.round(300 * detail), true, atlas);
  solidPool = makePool(Math.round(150 * detail), false, atlas);
  root.add(glowPool.points, solidPool.points);

  ringGeo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < 8; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: ringTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(ringGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    m.renderOrder = 10;
    m.userData = { busy: false };
    root.add(m);
    rings.push(m);
  }

  stopFrame = onFrame(update);
  return true;
}

const scaled = (n) => Math.max(2, Math.round(n * flags().detail));

// The soft-annulus texture, shared with preview.js so the two systems draw the
// same kind of ring and there is only ever one copy of it on the GPU. Returns
// null before the renderer exists.
export function ringTexture() {
  return ensure() ? ringTex : null;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(0xffffff);
// Golden angle. Stratifying the azimuth this way gives even coverage without
// the clumps and gaps of Math.random(), which is what makes a default particle
// system read as "computer noise" rather than as a designed spray.
const GOLDEN = 2.39996323;

export function emit(opts) {
  if (!ensure()) return;
  const soft = opts.soft !== false;
  const pool = soft ? glowPool : solidPool;
  // `floor` is a per-burst minimum that the tier multiplier cannot cut below.
  // Only the celebration uses it: halving the decoration on a cheap tablet is
  // the right trade, but halving the one moment the whole level was building
  // towards is not -- the payoff has to land on an iPad 6 too.
  const want = Math.max(scaled(opts.count || 12), opts.floor || 0);
  const n = Math.min(want, pool.capacity - pool.n);
  if (n <= 0) return;

  const p = opts.pos;
  const shape = opts.shape || 'sphere';
  const spd = opts.speed || [1.5, 3];
  const sz = opts.size || [0.16, 0.02];
  const lf = opts.life || [0.4, 0.8];
  const cols = opts.colors || [WHITE];
  const fadeTo = opts.fadeTo || null;
  const spin = opts.spin || [-4, 4];
  const shapeId = SHAPE_ID[opts.sprite || 'blob'];
  const curve = opts.curve === 'pop' ? 1 : 0;
  const grav = opts.gravity === undefined ? 7 : opts.gravity;
  const drag = opts.drag === undefined ? 1.4 : opts.drag;
  const alpha = opts.alpha === undefined ? 1 : opts.alpha;
  const radius = opts.radius || 0;
  const swirl = opts.swirl || 0;
  const spread = opts.spread === undefined ? 0.5 : opts.spread;
  const dir = opts.dir;
  const phase = Math.random() * Math.PI * 2;
  if (shape === 'cone' && dir) _q.setFromUnitVectors(UP, dir);

  for (let k = 0; k < n; k++) {
    const i = pool.n++;
    // Stratified within the burst, jittered between bursts: two identical
    // bursts never lay down the same pattern, but neither ever clumps.
    const a = phase + k * GOLDEN;
    const q = (k + 0.5) / n;

    let dx = 0, dy = 0, dz = 0;
    if (shape === 'ring') {
      dx = Math.cos(a); dz = Math.sin(a);
      dy = 0.18 + Math.random() * 0.32;
    } else if (shape === 'dome') {
      const el = Math.acos(1 - q * 0.85);          // even over the hemisphere
      dx = Math.sin(el) * Math.cos(a); dz = Math.sin(el) * Math.sin(a);
      dy = Math.cos(el);
    } else if (shape === 'fountain') {
      const el = spread * Math.sqrt(q);
      dx = Math.sin(el) * Math.cos(a); dz = Math.sin(el) * Math.sin(a);
      dy = Math.cos(el);
    } else if (shape === 'cone' && dir) {
      const el = spread * Math.sqrt(q);
      // A +Y-aligned cone rotated onto `dir` (the quaternion is built once,
      // outside the loop -- this runs per particle).
      _v.set(Math.sin(el) * Math.cos(a), Math.cos(el), Math.sin(el) * Math.sin(a)).applyQuaternion(_q);
      dx = _v.x; dy = _v.y; dz = _v.z;
    } else {
      const el = Math.acos(1 - 2 * q);
      dx = Math.sin(el) * Math.cos(a); dz = Math.sin(el) * Math.sin(a);
      dy = Math.cos(el);
    }

    // Speed weighted towards the low end: a spray with a few fast outliers
    // reads as energy, a spray with uniform speed reads as an explosion decal.
    const w = Math.pow(Math.random(), 1.6);
    const s = spd[0] + (spd[1] - spd[0]) * w;

    pool.pos[i * 3] = p.x + dx * radius * Math.random();
    pool.pos[i * 3 + 1] = p.y + dy * radius * Math.random() * 0.6;
    pool.pos[i * 3 + 2] = p.z + dz * radius * Math.random();
    pool.vx[i] = dx * s - dz * swirl;
    pool.vy[i] = dy * s;
    pool.vz[i] = dz * s + dx * swirl;

    _c.copy(cols[(Math.random() * cols.length) | 0]);
    pool.col[i * 3] = _c.r; pool.col[i * 3 + 1] = _c.g; pool.col[i * 3 + 2] = _c.b;
    if (fadeTo) {
      pool.col2[i * 3] = fadeTo.r; pool.col2[i * 3 + 1] = fadeTo.g; pool.col2[i * 3 + 2] = fadeTo.b;
    } else {
      pool.col2[i * 3] = _c.r; pool.col2[i * 3 + 1] = _c.g; pool.col2[i * 3 + 2] = _c.b;
    }

    // Size jitter is multiplicative so the spread stays proportional whatever
    // the caller asked for.
    const sj = 0.6 + Math.random() * 0.75;
    pool.size[i] = sz[0] * sj;
    pool.size2[i] = sz[1] * sj;
    pool.alpha[i] = alpha * (0.72 + Math.random() * 0.28);
    pool.spin[i] = Math.random() * Math.PI * 2;
    pool.spinRate[i] = spin[0] + Math.random() * (spin[1] - spin[0]);
    pool.shape[i] = shapeId;
    pool.curve[i] = curve;
    pool.age[i] = 0;
    pool.t[i] = 0;
    pool.life[i] = lf[0] + Math.random() * (lf[1] - lf[0]);
    pool.grav[i] = grav;
    pool.drag[i] = drag;
  }
}

// ---------------------------------------------------------------------------
// Shockwave rings
// ---------------------------------------------------------------------------

export function ring(opts) {
  if (!ensure()) return;
  let m = null;
  for (let i = 0; i < rings.length; i++) if (!rings[i].userData.busy) { m = rings[i]; break; }
  if (!m) return; // eight simultaneous shockwaves is already more than legible
  m.userData.busy = true;
  m.visible = true;
  m.position.copy(opts.pos);
  m.material.color.copy(opts.color || WHITE);
  m.material.blending = opts.soft === false ? THREE.NormalBlending : THREE.AdditiveBlending;
  m.userData.t = 0;
  m.userData.life = opts.life || 0.5;
  m.userData.r0 = opts.from === undefined ? 0.25 : opts.from;
  m.userData.r1 = opts.to === undefined ? 1.5 : opts.to;
  m.userData.a = opts.alpha === undefined ? 0.9 : opts.alpha;
  m.userData.tilt = !!opts.upright;
  m.rotation.set(opts.upright ? 0 : -Math.PI / 2, 0, 0);
}

// ---------------------------------------------------------------------------
// Full-frame wash
// ---------------------------------------------------------------------------
// One quad held in front of the camera. This is the *only* effect in the game
// that touches the whole frame, which is exactly why it is reserved for the
// perfect clear: a thing that has never happened before cannot be mistaken for
// more of a thing that happens every level.
//
// It is a single soft wash, not a strobe -- one event, a fast attack and a
// ~0.4s decay, peaking well under opaque. Repeated hard flashes are a
// photosensitivity hazard and this game's audience is six.
const _fwd = new THREE.Vector3();

export function screenFlash(color, peak, life) {
  if (!ensure()) return;
  if (!flashMesh) {
    flashGeo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 0,
    });
    flashMesh = new THREE.Mesh(flashGeo, mat);
    flashMesh.frustumCulled = false;
    // Above every particle pool and every shockwave: the wash is the frame,
    // not another thing standing in it.
    flashMesh.renderOrder = 40;
    root.add(flashMesh);
  }
  flashMesh.material.color.copy(color || WHITE);
  flashMesh.visible = true;
  flash = { t: 0, life: life || 0.42, peak: peak === undefined ? 0.3 : peak };
}

// ---------------------------------------------------------------------------
// Collected item fly-out
// ---------------------------------------------------------------------------

// Takes the *live* item mesh handed back by world.removeItemAt and gives it an
// exit rather than deleting it mid-frame. Geometry and materials are shared
// and owned by world.js, so this only ever re-parents and never disposes.
//
// `shards` breaks the pickup apart instead of floating it away whole. The whole
// mesh rising and flaring to 1.45x was the single worst-reading effect in the
// game: at this camera distance one gold chunk the size of Bloop's head, with
// hard polygon edges, hanging over his shoulder reads as litter, not as a
// reward. The shards are Meshes sharing the pickup's own geometry and material
// -- no GPU allocation, and world.js still owns both -- so the star visibly
// *shatters* into its own colour and the pieces spill past the tile.
export function absorb(mesh, opts) {
  if (!mesh || !ensure()) return;
  const o = opts || {};
  // Floor of 7 so the shatter still reads on a cheap tablet; every piece is an
  // extra draw call, so the tier multiplier is allowed to take the rest.
  const n = o.shards ? Math.max(7, scaled(o.shards)) : 0;
  root.add(mesh);
  absorbing.push({
    mesh,
    t: 0,
    life: n ? 0.20 : (o.life || 0.42),
    y0: mesh.position.y,
    rise: n ? 0.22 : (o.rise || 0.85),
    s0: mesh.scale.x,
    spin: o.spin || 14,
    burst: n > 0,
  });
  if (!n) return;

  const scale = o.shardScale || 0.25;
  const phase = Math.random() * Math.PI * 2;
  for (let k = 0; k < n; k++) {
    // Same golden-angle stratification the particle pool uses, so the pieces
    // ring the pickup evenly instead of clumping on one side of it.
    const a = phase + k * GOLDEN;
    const el = 0.30 + Math.random() * 0.62;   // mostly outward, a little up
    const s = 1.9 + Math.random() * 1.8;
    const piece = new THREE.Mesh(mesh.geometry, mesh.material);
    piece.position.copy(mesh.position);
    piece.rotation.set(Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283);
    piece.scale.setScalar(mesh.scale.x * scale * (0.7 + Math.random() * 0.6));
    piece.castShadow = false;
    root.add(piece);
    absorbing.push({
      mesh: piece, t: 0, life: 0.38 + Math.random() * 0.24, shard: true,
      s0: piece.scale.x,
      vx: Math.cos(a) * Math.cos(el) * s,
      vy: Math.sin(el) * s * 1.25 + 0.8,
      vz: Math.sin(a) * Math.cos(el) * s,
      rx: (Math.random() - 0.5) * 22,
      ry: (Math.random() - 0.5) * 22,
      rz: (Math.random() - 0.5) * 22,
    });
  }
}

// ---------------------------------------------------------------------------
// Character trail
// ---------------------------------------------------------------------------

const TRAIL_PTS = 26;
const TRAIL_LIFE = 0.42;   // seconds -- about three tiles at cruise
// Peak half-width and opacity of the ribbon. The previous pass was 0.075/0.30
// on top of a shaping factor that peaks at 0.73, which came to a four-
// centimetre-wide additive smear at 0.16 alpha: it did not appear in a single
// frame of a twenty-five shot review, mid-roll ones included. An effect nobody
// can see is not restraint, it is a bug.
const TRAIL_W = 0.22;
const TRAIL_A = 0.75;
// The ribbon is pinned to the ground plane rather than billboarded to the
// camera. Billboarding a strip this wide swings it up through Bloop's face and
// out into empty sky past the edge of the island, because a camera-facing quad
// at ball height has nothing to sit on. On the ground it is a skid mark: it is
// occluded by the platform, it can never hang in the air, and from this
// top-down camera it reads as speed rather than as a floating banner.
const TRAIL_Y = 0.05;

const TRAIL_VERT = `
attribute float alpha;
attribute float across;
varying float vA;
varying float vV;
void main() {
  vA = alpha;
  vV = across;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const TRAIL_FRAG = `
uniform vec3 uColor;
varying float vA;
varying float vV;
void main() {
  if (vA < 0.004) discard;
  // Soft across the width and hot down the middle. A flat-filled strip reads
  // as a painted stripe; the falloff is what makes it read as motion blur.
  float core = 1.0 - smoothstep(0.0, 0.45, abs(vV));
  float shape = pow(max(0.0, 1.0 - vV * vV), 1.6);
  vec3 col = mix(uColor, vec3(1.0), core * 0.6);
  gl_FragColor = vec4(col, vA * shape);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// A ground-hugging ribbon whipped out behind the bloop. Deliberately short: a
// long trail turns into a second path drawn over the board and competes with
// the preview overlay for the child's attention.
export function createTrail(color) {
  if (!ensure()) return { update() {}, dispose() {} };
  const pts = [];
  const positions = new Float32Array(TRAIL_PTS * 2 * 3);
  const alphas = new Float32Array(TRAIL_PTS * 2);
  const across = new Float32Array(TRAIL_PTS * 2);
  for (let i = 0; i < TRAIL_PTS; i++) { across[i * 2] = 1; across[i * 2 + 1] = -1; }
  const index = [];
  for (let i = 0; i < TRAIL_PTS - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
  geo.setAttribute('across', new THREE.BufferAttribute(across, 1));
  geo.setIndex(index);
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color || 0xffffff) } },
    vertexShader: TRAIL_VERT,
    fragmentShader: TRAIL_FRAG,
    transparent: true,
    // Normal, not additive. Additive made the ribbon's colour a function of
    // whatever it happened to cross -- invisible over bright tiles, white over
    // saturated ones. A fixed value is what lets it be tuned once and stay
    // legible over every world's palette.
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;
  root.add(mesh);

  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();

  return {
    update(pos, dt) {
      for (let i = pts.length - 1; i >= 0; i--) {
        pts[i].age += dt;
        if (pts[i].age > TRAIL_LIFE) pts.splice(i, 1);
      }
      const head = pts[pts.length - 1];
      if (!head || head.p.distanceToSquared(pos) > 0.0016) {
        pts.push({ p: pos.clone(), age: 0 });
        if (pts.length > TRAIL_PTS) pts.shift();
      } else {
        head.p.copy(pos);
      }
      if (pts.length < 2) { geo.setDrawRange(0, 0); return; }

      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const cur = pts[i].p;
        const nxt = pts[Math.min(i + 1, n - 1)].p;
        const prv = pts[Math.max(i - 1, 0)].p;
        dir.subVectors(nxt, prv);
        dir.y = 0;
        if (dir.lengthSq() < 1e-9) dir.set(1, 0, 0);
        // Perpendicular to travel *in the ground plane*, so the strip always
        // lies flat on the tiles however the camera is pointed.
        side.set(-dir.z, 0, dir.x).normalize();
        // Widest just *behind* the head, pinched to nothing at both ends: the
        // ribbon appears to stream out of the ball rather than to wrap it, and
        // the tail dissolves instead of ending on a cut edge.
        const along = i / (n - 1);              // 0 = oldest, 1 = newest
        const decay = 1 - pts[i].age / TRAIL_LIFE;
        const lens = Math.pow(along, 0.55) * (1 - Math.pow(along, 6));
        const w = TRAIL_W * lens * decay;
        const a = TRAIL_A * lens * decay * decay;
        const o = i * 6;
        positions[o] = cur.x + side.x * w;
        positions[o + 1] = TRAIL_Y;
        positions[o + 2] = cur.z + side.z * w;
        positions[o + 3] = cur.x - side.x * w;
        positions[o + 4] = TRAIL_Y;
        positions[o + 5] = cur.z - side.z * w;
        alphas[i * 2] = a;
        alphas[i * 2 + 1] = a;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.alpha.needsUpdate = true;
      geo.setDrawRange(0, (n - 1) * 6);
    },
    dispose() {
      root.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Frame update
// ---------------------------------------------------------------------------

function stepPool(pool, dt) {
  let i = 0;
  while (i < pool.n) {
    pool.t[i] += dt;
    const u = pool.t[i] / pool.life[i];
    if (u >= 1) {
      // Swap-with-last removal: O(1) and keeps the live particles packed at
      // the front so setDrawRange draws exactly what is alive.
      const last = --pool.n;
      if (last !== i) {
        pool.pos[i * 3] = pool.pos[last * 3];
        pool.pos[i * 3 + 1] = pool.pos[last * 3 + 1];
        pool.pos[i * 3 + 2] = pool.pos[last * 3 + 2];
        pool.col[i * 3] = pool.col[last * 3];
        pool.col[i * 3 + 1] = pool.col[last * 3 + 1];
        pool.col[i * 3 + 2] = pool.col[last * 3 + 2];
        pool.col2[i * 3] = pool.col2[last * 3];
        pool.col2[i * 3 + 1] = pool.col2[last * 3 + 1];
        pool.col2[i * 3 + 2] = pool.col2[last * 3 + 2];
        pool.vx[i] = pool.vx[last]; pool.vy[i] = pool.vy[last]; pool.vz[i] = pool.vz[last];
        pool.t[i] = pool.t[last]; pool.life[i] = pool.life[last];
        pool.grav[i] = pool.grav[last]; pool.drag[i] = pool.drag[last];
        pool.size[i] = pool.size[last]; pool.size2[i] = pool.size2[last];
        pool.alpha[i] = pool.alpha[last]; pool.spin[i] = pool.spin[last];
        pool.spinRate[i] = pool.spinRate[last];
        pool.shape[i] = pool.shape[last]; pool.curve[i] = pool.curve[last];
        pool.age[i] = pool.age[last];
      }
      continue;
    }
    const d = Math.max(0, 1 - pool.drag[i] * dt);
    pool.vy[i] -= pool.grav[i] * dt;
    pool.vx[i] *= d; pool.vy[i] *= d; pool.vz[i] *= d;
    pool.pos[i * 3] += pool.vx[i] * dt;
    pool.pos[i * 3 + 1] += pool.vy[i] * dt;
    pool.pos[i * 3 + 2] += pool.vz[i] * dt;
    pool.spin[i] += pool.spinRate[i] * dt;
    pool.age[i] = u;
    i++;
  }
  pool.geo.setDrawRange(0, pool.n);
  if (pool.n > 0) {
    pool.geo.attributes.position.needsUpdate = true;
    pool.geo.attributes.pcolor.needsUpdate = true;
    pool.geo.attributes.pcolor2.needsUpdate = true;
    pool.geo.attributes.psize.needsUpdate = true;
    pool.geo.attributes.psize2.needsUpdate = true;
    pool.geo.attributes.palpha.needsUpdate = true;
    pool.geo.attributes.pspin.needsUpdate = true;
    pool.geo.attributes.pshape.needsUpdate = true;
    pool.geo.attributes.pcurve.needsUpdate = true;
    pool.geo.attributes.page.needsUpdate = true;
  }
}

function update(dt) {
  // gl_PointSize is in device pixels, so the sprite size has to be told how
  // tall the drawing buffer currently is or particles change size with the
  // window. Reading it costs nothing; the renderer keeps it as a number.
  const px = getRenderer().getDrawingBufferSize(_size).y * 0.5;
  glowPool.mat.uniforms.uPix.value = px;
  solidPool.mat.uniforms.uPix.value = px;

  stepPool(glowPool, dt);
  stepPool(solidPool, dt);

  for (let i = 0; i < rings.length; i++) {
    const m = rings[i];
    if (!m.userData.busy) continue;
    const d = m.userData;
    d.t += dt;
    const u = d.t / d.life;
    if (u >= 1) { d.busy = false; m.visible = false; continue; }
    // Radius eases out hard (the wave leaves fast, then coasts); opacity has a
    // fast attack so the ring never fades *in* on top of the impact frame.
    const r = d.r0 + (d.r1 - d.r0) * ease.outQuart(u);
    m.scale.set(r * 2, r * 2, r * 2);
    m.material.opacity = d.a * Math.min(1, u * 9) * Math.pow(1 - u, 1.6);
  }

  for (let i = absorbing.length - 1; i >= 0; i--) {
    const a = absorbing[i];
    a.t += dt;
    const u = a.t / a.life;
    if (u >= 1) { root.remove(a.mesh); absorbing.splice(i, 1); continue; }
    if (a.shard) {
      // Ballistic, tumbling, shrinking to nothing. Gravity and drag are the
      // same numbers the particle pool uses, so the shards and the sparks that
      // fly with them share one physics and read as one event.
      const d = Math.max(0, 1 - 2.2 * dt);
      a.vy -= 9.0 * dt;
      a.vx *= d; a.vy *= d; a.vz *= d;
      a.mesh.position.x += a.vx * dt;
      a.mesh.position.y += a.vy * dt;
      a.mesh.position.z += a.vz * dt;
      a.mesh.rotation.x += a.rx * dt;
      a.mesh.rotation.y += a.ry * dt;
      a.mesh.rotation.z += a.rz * dt;
      a.mesh.scale.setScalar(a.s0 * Math.pow(1 - u, 0.8));
      continue;
    }
    a.mesh.position.y = a.y0 + a.rise * ease.outCubic(u);
    a.mesh.rotation.y += a.spin * dt;
    // A pickup that shatters snaps shut on itself; one that floats away whole
    // flares first, because a shape that only shrinks reads as a bug.
    const s = a.burst
      ? Math.pow(1 - u, 1.3)
      : (u < 0.22 ? 1 + ease.outBack(u / 0.22) * 0.45 : 1.45 * Math.pow(1 - (u - 0.22) / 0.78, 1.5));
    a.mesh.scale.setScalar(a.s0 * s);
  }

  if (flash) {
    flash.t += dt;
    const u = flash.t / flash.life;
    if (u >= 1) { flash = null; flashMesh.visible = false; }
    else {
      const cam = getCamera();
      // Parked just past the near plane and sized to overfill the frustum, so
      // the lens shift renderer.js applies with setViewOffset cannot uncover a
      // corner of it.
      const dist = cam.near * 4 + 0.05;
      const h = 2 * Math.tan((cam.fov * Math.PI) / 360) * dist;
      flashMesh.scale.set(h * cam.aspect * 2.2, h * 2.2, 1);
      flashMesh.quaternion.copy(cam.quaternion);
      flashMesh.position.copy(cam.position)
        .add(_fwd.set(0, 0, -dist).applyQuaternion(cam.quaternion));
      // Hard attack, long decay: the wash has to land on the impact frame, not
      // arrive after it.
      flashMesh.material.opacity = flash.peak
        * (u < 0.10 ? u / 0.10 : Math.pow(1 - (u - 0.10) / 0.90, 2.2));
    }
  }

  for (let i = timers.length - 1; i >= 0; i--) {
    timers[i].t -= dt;
    if (timers[i].t <= 0) { const fn = timers[i].fn; timers.splice(i, 1); fn(); }
  }
}

function later(delay, fn) {
  if (!ensure()) return;
  timers.push({ t: delay, fn });
}

// ---------------------------------------------------------------------------
// Designed effects -- the escalating reward ladder
// ---------------------------------------------------------------------------

const GOLD = new THREE.Color(0xffc93d);
const GOLD_HOT = new THREE.Color(0xfff3c0);
const AMBER = new THREE.Color(0xffa53d);
const CREAM = new THREE.Color(0xfff6e0);
const DUST = new THREE.Color(0xfff2dd);

// Tier 1 (coin) and tier 2 (star). The star gets a ring, a shape change and
// roughly triple the count, so the difference is felt and not just counted.
export function collect(pos, item, mesh) {
  if (item === 'star') {
    // The star shatters into a dozen of itself rather than sailing off whole.
    absorb(mesh, { shards: 12, shardScale: 0.26 });
    // Gold, and normal-blended so it stays gold. Additive over a bright lawn
    // took GOLD_HOT straight to white, which cost the pickup the one colour
    // that ties it to the coins, the exit and the score.
    ring({
      pos: new THREE.Vector3(pos.x, 0.06, pos.z), color: GOLD,
      from: 0.15, to: 0.68, life: 0.42, alpha: 0.6, soft: false,
    });
    emit({
      pos, count: 18, shape: 'dome', sprite: 'star', curve: 'pop',
      speed: [1.4, 3.6], size: [0.10, 0.30], life: [0.38, 0.72],
      colors: [GOLD, GOLD_HOT, CREAM], fadeTo: GOLD, spin: [-9, 9],
      gravity: 3.4, drag: 2.6, alpha: 1, radius: 0.16,
    });
    emit({
      pos, count: 10, shape: 'ring', sprite: 'blob',
      speed: [1.8, 3.2], size: [0.13, 0.01], life: [0.3, 0.5],
      colors: [GOLD, AMBER], gravity: 5, drag: 3, alpha: 0.9, swirl: 1.2,
    });
  } else {
    absorb(mesh, { rise: 0.55, life: 0.32, spin: 20 });
    emit({
      pos, count: 9, shape: 'dome', sprite: 'blob', curve: 'pop',
      speed: [1.2, 2.6], size: [0.09, 0.20], life: [0.26, 0.46],
      colors: [GOLD, GOLD_HOT], fadeTo: AMBER, gravity: 4.5, drag: 3,
      alpha: 0.95, radius: 0.1,
    });
  }
}

// A condition tile fired. This is the single most important thing on the board
// to *notice*, so it gets a ring in the tile's own colour: the child should be
// able to say "the pink tile turned me" without being told.
export function turnPulse(pos, color) {
  const c = new THREE.Color(color);
  ring({ pos: new THREE.Vector3(pos.x, 0.055, pos.z), color: c, from: 0.2, to: 0.82, life: 0.36, alpha: 0.85 });
  emit({
    pos: new THREE.Vector3(pos.x, 0.18, pos.z), count: 9, shape: 'ring', sprite: 'blob',
    speed: [1.1, 2.2], size: [0.11, 0.02], life: [0.26, 0.44],
    colors: [c, c.clone().lerp(WHITE, 0.55)], gravity: 1.5, drag: 3.4,
    alpha: 0.85, swirl: 1.6,
  });
}

// Contact. `power` is 0..1 of cruise speed, so a one-tile nudge kicks up a
// puff and a long run lands with a proper thump.
// This is the most frequently fired effect in the game -- once per roll, many
// times a minute -- so it is deliberately the quietest. Anything loud enough to
// notice on its own would be exhausting by the third level, and it would be
// competing with Bloop for the brightest thing on the board.
export function land(pos, power) {
  if (power < 0.12) return;
  ring({
    pos: new THREE.Vector3(pos.x, 0.045, pos.z), color: DUST,
    from: 0.16, to: 0.32 + power * 0.5, life: 0.3, alpha: 0.20 * power, soft: false,
  });
  emit({
    pos: new THREE.Vector3(pos.x, 0.06, pos.z), count: Math.round(3 + power * 4),
    shape: 'ring', sprite: 'blob', soft: false,
    speed: [0.5 + power, 1.1 + power * 1.6], size: [0.08, 0.18],
    life: [0.22, 0.42], colors: [DUST], gravity: 1.2, drag: 4.2, alpha: 0.18 * power,
  });
}

// Blocked by the edge of the island -- which, because a roll only ever ends by
// running out of path, is how nearly every roll in the game finishes. It is
// therefore the *only* stop effect: `land` used to fire on the same frame and
// the two stacked into a white blob at Bloop's feet that outshone the
// character. `power` is 0..1 of cruise speed.
export function bump(pos, dir, power) {
  const p = power === undefined ? 1 : power;
  const back = new THREE.Vector3(-dir.x, 0.6, -dir.z).normalize();
  emit({
    pos: new THREE.Vector3(pos.x + dir.x * 0.32, pos.y + 0.08, pos.z + dir.z * 0.32),
    count: Math.round(5 + p * 7), shape: 'cone', dir: back, spread: 0.9,
    sprite: 'blob', soft: false,
    speed: [1.0 + p, 1.8 + p * 1.8], size: [0.08, 0.02], life: [0.24, 0.46],
    colors: [DUST, CREAM], gravity: 8, drag: 1.6, alpha: 0.3 + p * 0.2,
  });
  // A scuff on the ground under the character, not a hoop in the air: the
  // contact happens at Bloop's feet and the ring has to agree with that.
  ring({
    pos: new THREE.Vector3(pos.x, 0.045, pos.z), color: DUST,
    from: 0.18, to: 0.42 + p * 0.4, life: 0.3, alpha: 0.16 + p * 0.12, soft: false,
  });
}

// The program stopped without reaching the exit. Reads as a deflating fizzle,
// never as a buzzer: this is a puzzle game for children and a wrong answer is
// a normal, safe thing to have happen.
export function fizzle(pos) {
  const grey = new THREE.Color(0xbfc6d6);
  const pale = new THREE.Color(0xe4e9f2);
  // The air going out, not smoke going up. The first pass drifted fourteen
  // grey blobs *upward*, which is the shape of a fire, not of a deflation --
  // and it played over a character that is simultaneously sinking, so the two
  // halves of the beat pulled against each other.
  //
  // So: a wide low puff escaping sideways at Bloop's base, a soft grey scuff
  // spreading on the ground under him, and a second smaller sigh a fifth of a
  // second later, timed against the animator's recoil shudder so the character
  // and the effect settle together.
  emit({
    pos: new THREE.Vector3(pos.x, pos.y + 0.14, pos.z), count: 16, shape: 'ring',
    sprite: 'blob', soft: false, speed: [1.1, 2.3], size: [0.16, 0.34],
    life: [0.5, 0.9], colors: [grey, pale],
    gravity: 1.1, drag: 3.6, alpha: 0.4, radius: 0.18, swirl: 0.7,
  });
  ring({
    pos: new THREE.Vector3(pos.x, 0.05, pos.z), color: grey,
    from: 0.18, to: 0.85, life: 0.55, alpha: 0.22, soft: false,
  });
  later(0.22, () => {
    emit({
      pos: new THREE.Vector3(pos.x, pos.y + 0.10, pos.z), count: 9, shape: 'ring',
      sprite: 'blob', soft: false, speed: [0.6, 1.4], size: [0.13, 0.26],
      life: [0.45, 0.8], colors: [pale], gravity: 0.9, drag: 4.0,
      alpha: 0.3, radius: 0.14,
    });
  });
}

// Confetti palette. Gold leads because gold is the game's reward colour --
// every coin, every star, every exit annulus is gold -- and the one moment the
// whole level was building towards is the last place to abandon it.
const CONFETTI_PINK = new THREE.Color(0xff6fae);
const CONFETTI_CYAN = new THREE.Color(0x6fd8ff);

// Tier 3+ : the level is complete. Built as timed waves rather than one dump of
// particles -- escalation over ~0.6s is what makes a celebration feel bigger
// than a pickup, not raw count.
//
// Everything is centred on `pos`, which the animator hands in as Bloop's own
// world position rather than the exit tile's centre, and every burst shape is
// radially symmetric. A tight upward `fountain` on a tile centre is what made
// the first pass read as a texture cut off at the tile's edge instead of as a
// burst coming out of the character.
//
// The rings are normal-blended and deliberately small. The first pass fired a
// 1.6-unit additive GOLD_HOT ring and a 2.4-unit additive one in the character
// colour: both saturated to the same white against a pale sky, they spanned
// more than the whole island, and between them they *were* the celebration.
export function celebrate(pos, magnitude, color) {
  if (!ensure()) return;
  const mag = Math.max(3, Math.min(5, magnitude || 3));
  const chr = new THREE.Color(color || 0xffffff);
  const boost = 1 + (mag - 3) * 0.45;              // 1.0 / 1.45 / 1.9
  const ground = new THREE.Vector3(pos.x, 0.06, pos.z);
  const mid = new THREE.Vector3(pos.x, pos.y + 0.42, pos.z);
  // The second ring changes *colour* with the tier rather than only size, so a
  // still frame of a perfect clear can never be mistaken for a plain one.
  const second = mag >= 4 ? AMBER : chr;

  // Tier 4+ opens with one soft gold wash over the whole frame. Nothing else
  // in the game touches the frame, so it cannot be read as more of something
  // the child has already seen.
  if (mag >= 4) screenFlash(GOLD, mag >= 5 ? 0.36 : 0.28, 0.45);

  // Wave 0 -- the hit. A gold ground shockwave and a full radial dome of
  // twinkles that leaves frame fast, pulling the eye up off the board.
  ring({ pos: ground, color: GOLD, from: 0.2, to: 0.9 * boost, life: 0.55, alpha: 0.7, soft: false });
  emit({
    pos: mid, count: Math.round(30 * boost), floor: Math.round(22 * boost),
    shape: 'dome',
    sprite: 'star', curve: 'pop', speed: [3.6, 6.8 * boost],
    size: [0.14, 0.36], life: [0.6, 1.0], colors: [GOLD, GOLD_HOT, CREAM, chr],
    fadeTo: GOLD, gravity: 8.5, drag: 0.8, alpha: 1, spin: [-8, 8], radius: 0.18,
  });
  // A low skirt thrown outward along the ground, so the burst visibly spills
  // past the edges of the tile Bloop is standing on.
  emit({
    pos: ground, count: Math.round(16 * boost), floor: 12,
    shape: 'ring', sprite: 'blob', speed: [3.0, 5.2 * boost],
    size: [0.16, 0.03], life: [0.45, 0.8], colors: [GOLD, GOLD_HOT],
    gravity: 3.2, drag: 1.3, alpha: 0.85, swirl: 1.4,
  });

  // Wave 1 -- confetti. Solid, not additive: it has to read as *stuff* falling
  // through the frame, and additive confetti just makes a bright smear. Sized
  // to be seen from this camera -- the previous 0.13-unit pieces came to about
  // four screen pixels and read as dust.
  later(0.13, () => {
    emit({
      pos: mid, count: Math.round(40 * boost), floor: Math.round(28 * boost),
      shape: 'dome', sprite: 'blob', soft: false,
      speed: [2.6, 5.4 * boost], size: [0.30, 0.22], life: [0.9, 1.5],
      colors: [GOLD, GOLD_HOT, chr, CREAM, CONFETTI_PINK, CONFETTI_CYAN],
      gravity: 6.5, drag: 0.9, alpha: 0.95, spin: [-12, 12], radius: 0.24,
    });
    ring({ pos: ground, color: second, from: 0.3, to: 1.4 * boost, life: 0.62, alpha: 0.5, soft: false });
  });

  // Wave 2 -- the shimmer that lingers after the bang, so the moment has a
  // tail instead of ending on a hard cut.
  later(0.32, () => {
    emit({
      pos: mid, count: Math.round(20 * boost), floor: Math.round(15 * boost),
      shape: 'sphere', sprite: 'star', curve: 'pop',
      speed: [0.9, 2.6], size: [0.10, 0.30], life: [1.0, 1.7],
      colors: [GOLD_HOT, CREAM, chr], fadeTo: GOLD,
      gravity: -0.9, drag: 1.4, alpha: 0.95, spin: [-5, 5], radius: 0.5, swirl: 1.1,
    });
  });

  // A perfect clear comes *back*. The second volley is the escalation: the
  // celebration appearing to be over and then starting again is a different
  // event, where a 45%-bigger version of the same ring is only a bigger number.
  if (mag >= 4) {
    later(0.62, () => {
      ring({ pos: ground, color: GOLD, from: 0.35, to: 1.15 * boost, life: 0.8, alpha: 0.55, soft: false });
      emit({
        pos: mid, count: Math.round(26 * boost), floor: 20,
        shape: 'dome', sprite: 'blob', soft: false,
        speed: [2.2, 4.6 * boost], size: [0.28, 0.20], life: [0.9, 1.5],
        colors: [GOLD, GOLD_HOT, CREAM, CONFETTI_PINK],
        gravity: 6.0, drag: 0.9, alpha: 0.95, spin: [-12, 12], radius: 0.3,
      });
    });
  }
  if (mag >= 5) {
    later(0.9, () => {
      ring({ pos: ground, color: CREAM, from: 0.6, to: 2.0, life: 1.0, alpha: 0.5, soft: false });
      emit({
        pos: mid, count: 30, shape: 'dome', sprite: 'star', curve: 'pop',
        speed: [3.4, 6.8], size: [0.14, 0.42], life: [1.0, 1.6],
        colors: [GOLD, GOLD_HOT, CREAM], gravity: 6, drag: 0.7, alpha: 1, spin: [-7, 7],
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Called when a run is cancelled or the board is rebuilt: leaving a half-played
// celebration on screen while the level resets looks broken.
export function clearFx() {
  if (!started) return;
  glowPool.n = 0; glowPool.geo.setDrawRange(0, 0);
  solidPool.n = 0; solidPool.geo.setDrawRange(0, 0);
  for (let i = 0; i < rings.length; i++) { rings[i].userData.busy = false; rings[i].visible = false; }
  for (let i = 0; i < absorbing.length; i++) root.remove(absorbing[i].mesh);
  absorbing.length = 0;
  timers.length = 0;
  flash = null;
  if (flashMesh) { flashMesh.visible = false; flashMesh.material.opacity = 0; }
}

export function disposeFx() {
  if (!started) return;
  clearFx();
  if (stopFrame) { stopFrame(); stopFrame = null; }
  glowPool.geo.dispose(); glowPool.mat.dispose();
  solidPool.geo.dispose(); solidPool.mat.dispose();
  for (let i = 0; i < rings.length; i++) rings[i].material.dispose();
  ringGeo.dispose();
  if (flashMesh) { flashMesh.material.dispose(); flashGeo.dispose(); }
  flashMesh = null; flashGeo = null;
  atlas.dispose();
  ringTex.dispose();
  const scene = getScene();
  if (scene) scene.remove(root);
  rings = [];
  root = null;
  started = false;
}
