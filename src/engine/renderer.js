// Three.js scene, camera, lights, sky, clouds, particles, render loop.
import * as THREE from 'three';
import { flags, tier, caps, onQualityChange, pixelRatioFor, noteFrame } from './quality.js';
import { createSky, createEnvironment } from './sky.js';
import { createRig } from './lighting.js';
import { createComposer } from './postfx.js';

// Each theme now carries a full lighting description, not just two flat
// colours. `sky`/`fog`/`grass`/`dirt`/`deco` are unchanged and still consumed
// by world.js; everything after them drives the dome, the environment map and
// the three-point rig.
//
//   zenith/horizon/ground  the visible sky gradient. `ground` is what fills the
//                          frame below the horizon -- the camera looks *down*,
//                          so this is most of the screen, and it has to read as
//                          deep atmosphere, not as a floor.
//   bounce                 the below-horizon colour the environment map is
//                          baked with instead of `ground`: the light bouncing
//                          up off a meadow really is green, but a green screen
//                          is not.
//   sun / sunDir / sunGlow the visible sun wash and the key light's direction.
//   key / fill / rim       colour temperature of the three lights.
//   exposure               per-theme tone-mapping exposure. Dark worlds need
//                          more of it or the tone curve crushes them.
//   envIntensity           how much of the sky's ambient reaches materials.
export const WORLD_THEMES = {
  // Menu / world-select: a warm dusk that flatters every character colour.
  0: {
    sky: 0x8f7bff, fog: 0xb69cff, grass: 0x7ecb5f, dirt: 0x8a5a3c, deco: 'meadow',
    zenith: 0x5535ad, horizon: 0xd3b6ff, ground: 0x9877e0, bounce: 0x5a4090,
    cloud: 0xffe6f7, clouds: true,
    sun: 0xffd9c0, sunDir: [0.5, 0.9, 0.5], sunGlow: 0.45, skyFalloff: 0.75,
    key: 0xfff0e2, keyIntensity: 1.95, fill: 0xa88cff, fillIntensity: 0.40,
    rim: 0xffb0e8, rimIntensity: 0.95, exposure: 1.0, envIntensity: 0.7,
  },
  // Meadow: bright, high-key daylight.
  1: {
    sky: 0x9adfff, fog: 0xcdefff, grass: 0x7ecb5f, dirt: 0x8a5a3c, deco: 'meadow',
    zenith: 0x3ea7f5, horizon: 0xd9f3ff, ground: 0x8ed2f5, bounce: 0x74ad5a,
    cloud: 0xffffff, clouds: true,
    sun: 0xfff2d2, sunDir: [0.42, 1.0, 0.46], sunGlow: 0.45, skyFalloff: 0.7,
    key: 0xfff4dc, keyIntensity: 2.0, fill: 0xbfe4ff, fillIntensity: 0.38,
    rim: 0xffe6b4, rimIntensity: 0.8, exposure: 1.0, envIntensity: 0.65,
  },
  // Crystal cavern: no sky at all, so the "sun" is a cold shaft from above and
  // the ambient is a violet glow off the cavern walls.
  2: {
    sky: 0x2e2b52, fog: 0x4a3f86, grass: 0x6fc7c7, dirt: 0x4a4270, deco: 'crystal',
    zenith: 0x140f2e, horizon: 0x6350bb, ground: 0x241b52, bounce: 0x4a3d92,
    cloud: 0x8f7fd8, clouds: false,
    sun: 0xa9d6ff, sunDir: [0.3, 1.05, 0.4], sunGlow: 0.3, skyFalloff: 0.5,
    key: 0xd6e6ff, keyIntensity: 2.15, fill: 0x8a6cff, fillIntensity: 0.40,
    rim: 0x63f2e0, rimIntensity: 1.3, exposure: 1.15, envIntensity: 1.05,
  },
  // Canyon: warm high sun, dusty peach horizon.
  3: {
    // Deeper rock than the original sandy 0xe8a25c: gold stars sitting on a
    // pale orange tile were nearly the same value, and tone mapping narrowed
    // the gap further. Dropping the tile a stop made the collectables read --
    // and dropped it straight into the backdrop, which was a pale orange of
    // almost exactly the same luminance.
    //
    // Two rounds of fixing that in the sky produced the opposite failure. With
    // `zenith 0xef7a2e`, `horizon 0xf2b177`, `ground 0x6d3524` and the tile at
    // 0xdb8843, the whole frame sat inside a thirty-degree hue arc: 78% of the
    // image was one orange-brown family with no tonal structure at all, and the
    // board *still* only measured 2.1:1 against the air behind it.
    //
    // So the sky is given a run instead of a wash: warm at the horizon, cool
    // violet in the depth the camera is looking down into. That is what canyon
    // shadow does under a warm sun, and it buys hue contrast and value contrast
    // in the same move -- the board now reads better than 3:1 against the air
    // behind it and sits on a complementary hue instead of inside its own.
    //
    // `horizon` is the load-bearing value here and it is deliberately *not* the
    // obvious pale cream. The dome mixes horizon into ground in linear light,
    // and a near-white horizon is 1.0 in linear red: at the 12% the mix gives it
    // in the middle of the frame it still contributed five times the ground's
    // own red and washed the entire lower sky back to brown, however cool the
    // ground colour was. A burnt orange carries the same warmth at a quarter of
    // the linear magnitude, so the shadow underneath it survives.
    //
    // `bounce` stays warm, so the light coming back up onto the island does not
    // go cold with the sky and the rock still belongs to its world.
    sky: 0xffc98a, fog: 0xffe0bb, grass: 0xdb8843, dirt: 0xa1522a, deco: 'canyon',
    zenith: 0xc2582a, horizon: 0xb3603a, ground: 0x33203f, bounce: 0xb0663a,
    cloud: 0xfff0dc, clouds: true,
    sun: 0xfff0cf, sunDir: [0.55, 0.9, 0.45], sunGlow: 0.6, skyFalloff: 0.85,
    key: 0xffe7bd, keyIntensity: 1.95, fill: 0xffd2a6, fillIntensity: 0.36,
    rim: 0xfff3cc, rimIntensity: 0.95, exposure: 0.95, envIntensity: 0.6,
  },
  // Tech: clean, cool, slightly clinical daylight.
  4: {
    // World 3's board-against-sky problem, in a world that never got the fix:
    // `grass 0x6fa8ff` (111,168,255) was being played against `ground 0x74a8e4`
    // (116,168,228). Measured, the tile tops came out at 1.18:1 against the air
    // directly behind them at a colour difference of dE 22 -- a blue board on a
    // blue sky, with only the tile groove telling a child where the floor ends.
    //
    // The board goes up and the air goes down, and the air also goes green:
    // matching the tile's value from directly below it was only half the
    // problem, the other half was that both were the same cornflower. A deep
    // sea-teal below the horizon is still unmistakably a cool clinical daylight
    // world, and it gives the plates something to sit *on*. `horizon` loses the
    // near-white milkiness that was pulling the top of the frame towards paper.
    // `bounce` is untouched, so the cool ambient coming back up onto the plates
    // is exactly as it was.
    sky: 0xa8ccff, fog: 0xd2e8ff, grass: 0x7ab4ff, dirt: 0x3e5a8a, deco: 'tech',
    zenith: 0x2560c8, horizon: 0xa8cdf0, ground: 0x22465d, bounce: 0x5b81b8,
    cloud: 0xf2faff, clouds: true,
    sun: 0xffffff, sunDir: [0.38, 1.0, 0.46], sunGlow: 0.4, skyFalloff: 0.65,
    key: 0xffffff, keyIntensity: 1.95, fill: 0xc2ddff, fillIntensity: 0.40,
    rim: 0x9ef0ff, rimIntensity: 1.0, exposure: 1.0, envIntensity: 0.72,
  },
  // Storm: overcast, low contrast, one warm break in the cloud for the rim.
  5: {
    // `grass` was 0x9aa7b8 -- a desaturated blue-grey, which is to say grey.
    // Under a violet sky that reads as untextured plastic rather than as wet
    // slate, and it left the storm world the only board in the game with no
    // hue of its own. Pushed off neutral towards the sky it lives under, it is
    // still unmistakably stone and it now belongs to the world around it.
    sky: 0x3a2f4a, fog: 0x5f5177, grass: 0x9dadd6, dirt: 0x5a6270, deco: 'storm',
    zenith: 0x1d1729, horizon: 0x7f6b95, ground: 0x342b42, bounce: 0x4e4459,
    cloud: 0x9b90ad, clouds: true,
    sun: 0xffd7c0, sunDir: [0.5, 0.85, 0.42], sunGlow: 0.35, skyFalloff: 0.6,
    key: 0xe6e9ff, keyIntensity: 2.0, fill: 0x9a8cc0, fillIntensity: 0.40,
    // The most saturated and most intense rim in the game, on the coolest and
    // least contrasty board in the game: at 0xff9a70 / 1.45 it drew a salmon
    // hairline along every tile chamfer, which at any zoom fought the groove
    // the grid depends on and read as light coming from nowhere. Softened to a
    // pale warm and dropped below every other world's rim, it does the one job
    // a rim has here -- lifting the island's edge off the sky -- and stops
    // drawing an outline round each tile.
    rim: 0xffb79a, rimIntensity: 0.95, exposure: 1.1, envIntensity: 0.8,
  },
};

export const TILE_COLORS = { p: 0xff6fae, b: 0x4db3ff, g: 0x58cc6d, o: 0xffa53d };

// Vertical field of view *of the visible canvas*, in degrees. Tighter than the
// old 42 deg: less perspective spread across a board that is mostly flat, which
// reads more like a physical toy and keeps distant tiles the same size as near
// ones. The camera's own `fov` is derived from this and is usually larger,
// because the projection is offset (see updateProjection).
const BASE_FOV = 34;
// The camera sits on this fixed direction from the board centre. Slightly
// lower than the old rig so tile sides and the island underside are visible,
// which is where all the new lighting shows up.
const VIEW_DIR = new THREE.Vector3(0, 0.80, 0.60).normalize();
// Fraction of the usable band the board is allowed to occupy.
const FIT_MARGIN = 0.94;
// How far the lens may be shifted, as a fraction of the canvas. A shift is free
// (see updateProjection) but a big one makes the virtual frame tall enough that
// the derived fov starts to spread the perspective, so it is bounded.
const MAX_SHIFT = 0.40;
// Default vertical extent worth framing, in world units either side of the
// board plane: the tile tops, Bloop and the floating stars, plus a little of
// the island underside. Callers that know their own island (how deep its keel
// hangs, how high its stars float) override these through frameView's opts;
// these are the fallback for anyone who does not.
const DEFAULT_Y_LO = -0.9;
const DEFAULT_Y_HI = 0.78;
// Where the board's projected bounds sit horizontally, as a fraction of the
// canvas, per screen. The play screen centres it. The menu family parks it in
// the right third, because those screens stack their buttons down the middle of
// the canvas: with the island centred underneath, PLAY covered its centre,
// Bloop hid behind "Bloops" and the exit portal behind the subtitle, so the
// board read as a texture the panel was printed on rather than as a place the
// panel is floating in front of.
//
// 0.7 with a 1.8 zoom was not far enough: the two moves fought each other, and
// the overscaled island simply grew back under the right half of the stack, so
// PLAY, Badges and the last three letters of the wordmark all landed on green
// tiles and Bloop went behind the Bloops/Awards row. The island is pushed
// further right and no longer overscaled past the point where it reaches back
// under the buttons. The menu column is separately gaining padding on its
// right, so the two changes open the same gap from opposite sides -- which is
// why this stops at 0.82 rather than pushing the island off the edge.
const ALIGN_X = { play: 0.5, backdrop: 0.82, hero: 0.5 };
// Extra scale, for the other half of the same problem: fitted to the band, the
// menu island was a chip in the middle of an otherwise empty purple frame.
// Overscaling it -- and letting the frame crop it, as a backdrop should be
// cropped -- is what turns it from an object on the screen into somewhere the
// screen is looking. 1.45 is as far as that goes before the island's left edge
// reaches back under the button stack.
const ZOOM = { play: 1, backdrop: 1.45, hero: 1 };
// The smallest a world unit is allowed to be on screen, in CSS pixels at a
// 1000px-tall canvas, and the camera distance that produces it.
//
// `solveFraming` fits the board to the usable band, which sounds right and is
// wrong across a course: the band is about 2.5:1 while every board except the
// 6x1 tutorials is roughly square, so almost all of them are height-limited and
// tile size falls as 1/rows. Measured, one tile was 231 CSS px across in W1-01
// and 61 in W5-08 -- a 3.8x swing in the size of the single most important
// object in the game, which is why a child moving between levels has to re-read
// the board every time. Swift Playgrounds never changes its world scale.
//
// So the fit is allowed to pull the camera *back* and never to push it in: tall
// boards are untouched (they are already further away than this), and short
// ones stop being blown up to fill a frame they do not have the content for.
// Deriving the distance from the fov rather than hard-coding it keeps the two
// in step: half the canvas height subtends tan(BASE_FOV/2) at distance 1.
const MIN_TILE_PX = 100;
const REF_DIST = 1000 / (2 * MIN_TILE_PX * Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2));

let renderer, scene, camera, sky, env, rig, post;
let theme = WORLD_THEMES[1];
let themeKey = 1;
const updaters = new Set();
let clouds = [];
let cloudMat = null;
let cloudGroup = null;
let lastFrameTime = performance.now();
let elapsedTime = 0;

// Framing state. `camEye`/`camLook` are the settled camera; the frame loop adds
// the idle drift on top so a running tween and the drift never fight.
const framing = {
  center: new THREE.Vector3(), spanX: 6, spanZ: 6,
  yLo: DEFAULT_Y_LO, yHi: DEFAULT_Y_HI,
};
// The current framing solution. `dist` is the camera distance that fits the
// board; `cx`/`cy` are where the board's projected bounds ended up in NDC,
// relative to the point the camera is aimed at, and are what the lens shift
// cancels out. Kept as state because measuring and shifting are two different
// steps that run at different times (a HUD resize re-shifts without re-solving).
const solved = { dist: 12, cx: 0, cy: 0 };
const camEye = new THREE.Vector3(0, 12, 11);
const camLook = new THREE.Vector3(0, 0, 0);
let bandTop = 0, bandBottom = 0;
let bandPoll = 0;
let framedMode = '';

export function initRenderer() {
  const canvas = document.getElementById('gl');

  // three.js needs WebGL2, which only arrived in iPadOS 15. Left unhandled the
  // constructor throws deep inside three and the page is simply blank, so
  // surface it as the friendly boot-failure screen instead. The probe uses a
  // throwaway canvas: calling getContext on the real one would pin the default
  // attributes and silently drop `antialias` below.
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) {
    const fail = globalThis.__blooptopiaFail;
    if (fail) fail('This device’s graphics support is too old to run Blooptopia.', 'update');
    throw new Error('WebGL2 is not available on this device.');
  }
  probe.getExtension('WEBGL_lose_context')?.loseContext();

  const f = flags();
  // Default-framebuffer MSAA only matters on the low tier, where there is no
  // post-processing chain to do it in a render target instead.
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !f.postFX, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = f.shadows;
  // PCFShadowMap, not PCFSoftShadowMap: three r185 deprecated the latter and
  // silently rewrites it to PCF anyway. The current PCF kernel is a jittered
  // five-tap Vogel disk driven by `light.shadow.radius`, so softness is a
  // per-light setting now (see lighting.js) rather than a global mode.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Neutral rather than ACESFilmic. ACES is built for camera-referred footage:
  // it rolls saturated primaries towards grey, which is precisely what this
  // palette cannot afford -- the pink and blue condition tiles have to stay
  // instantly distinguishable to a six-year-old. Neutral (Khronos PBR neutral)
  // keeps hue and saturation until it has to compress, so highlights stop
  // clipping without the candy colours going chalky.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = theme.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 400);
  camera.position.copy(camEye);
  camera.lookAt(camLook);
  updateProjection(); // seeds the usable band before anything asks to be fitted

  sky = createSky(scene);
  env = createEnvironment(renderer);
  rig = createRig(scene);
  makeClouds();
  applyTheme(1);

  onQualityChange(onTierChange);

  window.addEventListener('resize', resize);
  // Sized, then composed, then sized again -- deliberately, and in that order.
  // The composer reads the renderer's drawing-buffer size and pixel ratio in
  // its constructor, so it has to be built after the first resize or it is born
  // at the canvas's 300x150 default. But it also has to *see* a resize, or it
  // never gets the sizing pass every other consumer gets and stays whatever its
  // constructor guessed. Building it after one resize and before another is the
  // only ordering where both are true, and it costs one extra framing solve at
  // boot. `post` stays null if the target could not be allocated (see postfx),
  // and tick() then draws straight to the canvas.
  resize();
  if (flags().postFX) post = createComposer(renderer, scene, camera);
  resize();
  renderer.setAnimationLoop(tick);
  console.info(`[render] tier=${tier()} gpu=${caps().gpu} dpr=${renderer.getPixelRatio().toFixed(2)}`);
  return { scene, camera, renderer };
}

function onTierChange() {
  const f = flags();
  renderer.shadowMap.enabled = f.shadows;
  rig.applyShadowQuality();
  rig.fit(framing.center, framing.spanX, framing.spanZ);
  if (post) { post.dispose(); post = null; }
  if (f.postFX) post = createComposer(renderer, scene, camera); // may return null
  applyTheme(themeKey);
  resize();
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(pixelRatioFor(w, h));
  renderer.setSize(w, h);
  updateProjection();
  refit();
  if (post) post.setSize(w, h);
}

// ---- framing ---------------------------------------------------------------

// Which of the three framing treatments the screen on stage wants. Screens are
// added and removed by the router rather than hidden, so their presence in the
// document is the whole test.
function screenMode() {
  if (document.getElementById('screen-play')) return 'play';
  if (document.getElementById('screen-menu')
    || document.getElementById('screen-worldmap')
    || document.getElementById('screen-levels')) return 'backdrop';
  return 'hero';
}

// The usable band is the part of the canvas the HUD is not sitting on. The old
// frameView centred the board in the *whole* viewport, so on the play screen it
// floated in the empty top third while its bottom edge slid under the program
// trays. Measured rather than hard-coded, because the trays grow as the player
// adds command tokens.
function measureBand() {
  const h = innerHeight;
  const play = document.getElementById('screen-play');
  // Menu and world-map screens put their buttons straight over the middle of
  // the canvas, so their backdrop board is deliberately framed loose: it is
  // scenery behind the UI, not the thing being read. It is also pushed sideways
  // and overscaled -- see ALIGN_X / ZOOM.
  if (!play) return { top: h * 0.22, bottom: h * 0.83 };

  // On the play screen the board *is* the subject, so it gets everything the
  // HUD is not using. Deliberately class-name agnostic: the HUD markup belongs
  // to another module. Anything parked in the top half raises the ceiling,
  // anything in the bottom half lowers the floor, and anything spanning the
  // middle (the flex spacer, a results modal) is ignored -- the board should
  // not jump when a dialog opens.
  let top = h * 0.08;
  let bottom = h * 0.94;
  for (const el of play.children) {
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.width < 4) continue;
    if (r.bottom <= h * 0.5) top = Math.max(top, r.bottom);
    else if (r.top >= h * 0.5) bottom = Math.min(bottom, r.top);
  }
  top += h * 0.015;
  bottom -= h * 0.01;
  if (bottom - top < h * 0.25) { // pathological layout: fall back to the middle
    const mid = (top + bottom) / 2;
    top = mid - h * 0.125; bottom = mid + h * 0.125;
  }
  return { top, bottom };
}

// Re-measures the usable band and re-aims the lens at the current framing
// solution. Splitting the two matters: a HUD tray growing a row changes the
// band four times a second, and re-shifting the lens for that is free, whereas
// re-solving the distance is not.
function updateProjection() {
  const band = measureBand();
  bandTop = band.top; bandBottom = band.bottom;
  applyProjection();
}

// Offsets the projection so the board's projected *bounds* land where the
// screen wants them -- vertically in the middle of the usable band, and
// horizontally wherever ALIGN_X says -- while the scene still fills the whole
// canvas. Doing it in the projection (a lens shift) rather than by tilting or
// dollying the camera keeps the island's verticals parallel, which is what
// makes the shift invisible.
//
// It aims at the bounds centre rather than at the board's own origin, and that
// is the whole fix for the board sliding under the program tray: seen from 53
// degrees above, a board's mass projects well below the point the camera is
// aimed at, so "origin in the middle of the band" left the near rank of tiles,
// and on a descending board the exit portal with them, under the panel.
function applyProjection() {
  const w = innerWidth, h = innerHeight;
  const mode = screenMode();
  const targetY = (bandTop + bandBottom) / 2;
  const targetX = w * ALIGN_X[mode];
  const clamp = THREE.MathUtils.clamp;
  // NDC y is up, screen y is down, hence the sign flip on cy.
  const shiftY = clamp(targetY - h / 2 + solved.cy * (h / 2), -h * MAX_SHIFT, h * MAX_SHIFT);
  const shiftX = clamp(targetX - w / 2 - solved.cx * (w / 2), -w * MAX_SHIFT, w * MAX_SHIFT);

  // The shift is expressed as a window onto a larger virtual frame. Widening
  // the frame by twice the shift and parking the window at one end puts the
  // projection axis exactly `shift` off centre; deriving the fov from the
  // virtual height keeps the *visible* canvas subtending BASE_FOV whatever the
  // shift is, so moving the board around the frame never changes its size.
  const fullH = h + 2 * Math.abs(shiftY);
  const fullW = w + 2 * Math.abs(shiftX);
  camera.aspect = fullW / fullH;
  camera.fov = THREE.MathUtils.radToDeg(
    2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2) * fullH / h),
  );
  camera.setViewOffset(
    fullW, fullH, Math.abs(shiftX) - shiftX, Math.abs(shiftY) - shiftY, w, h,
  );
  camera.updateProjectionMatrix();
}

const _probe = new THREE.PerspectiveCamera();
const _corner = new THREE.Vector3();

// Solves for the camera distance that makes the board fill the usable band, and
// records where the board's projected bounds ended up so applyProjection can
// shift the lens onto them.
//
// The measurement is a true NDC bounding box -- min and max tracked separately
// on both axes -- not the old max-absolute-deviation from the board's centre.
// That distinction is what fixes the board's on-screen size wandering between
// levels: on any board whose mass is off-axis (every diagonal staircase) one
// side deviates much further than the other, and fitting to the larger side
// alone shrank the board to half the frame and pushed it off centre with it.
//
// The probe is a clean, symmetric camera at BASE_FOV rather than a copy of the
// real one. A lens shift only translates the image, so measuring without one
// and solving for it afterwards stops the two steps chasing each other.
// Projected size is very nearly proportional to 1/distance, so scaling the
// distance by the current overshoot converges in two or three passes; the loop
// is capped anyway.
function solveFraming() {
  const { center, spanX, spanZ, yLo, yHi } = framing;
  const hx = spanX / 2 + 0.18;
  const hz = spanZ / 2 + 0.18;
  const zoom = ZOOM[screenMode()];
  const availX = FIT_MARGIN;
  const availY = ((bandBottom - bandTop) / innerHeight) * FIT_MARGIN;

  _probe.fov = BASE_FOV;
  _probe.aspect = innerWidth / innerHeight;
  _probe.near = camera.near;
  _probe.far = camera.far;
  _probe.clearViewOffset();
  _probe.updateProjectionMatrix();

  // Projects the eight corners of the framed box from `dist` and returns how
  // far over the available band the result is. Shared by the solver loop and by
  // the final re-measure, so `solved.cx`/`cy` always describe the distance the
  // camera actually ends up at.
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  const measure = (dist) => {
    _probe.position.copy(center).addScaledVector(VIEW_DIR, dist);
    _probe.lookAt(center);
    _probe.updateMatrixWorld(true);
    minX = minY = Infinity; maxX = maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      _corner.set(
        center.x + (i & 1 ? hx : -hx),
        center.y + (i & 2 ? yHi : yLo),
        center.z + (i & 4 ? hz : -hz),
      ).project(_probe);
      if (_corner.x < minX) minX = _corner.x;
      if (_corner.x > maxX) maxX = _corner.x;
      if (_corner.y < minY) minY = _corner.y;
      if (_corner.y > maxY) maxY = _corner.y;
    }
    return Math.max((maxX - minX) / 2 / availX, (maxY - minY) / 2 / availY) / zoom;
  };

  let dist = Math.max(spanX, spanZ, 4) + 6;
  for (let pass = 0; pass < 6; pass++) {
    const over = measure(dist);
    dist = THREE.MathUtils.clamp(dist * over, 5, 160);
    if (Math.abs(over - 1) < 0.004) break;
  }

  // Upward only, and only where the board is the subject. The menu backdrop is
  // deliberately overscaled and cropped, so a floor on its tile size would undo
  // the thing that turns it from an object into a place. Re-measured after the
  // clamp: the bounds centre moves with the distance, and applyProjection aims
  // the lens shift at that centre, so a stale one puts the board off-frame.
  if (screenMode() === 'play') {
    const floored = Math.max(dist, REF_DIST * 0.92);
    if (floored !== dist) { dist = floored; measure(dist); }
  }

  solved.dist = dist;
  solved.cx = (minX + maxX) / 2;
  solved.cy = (minY + maxY) / 2;
}

// Recomputes eye/look/shadow/fog for the current framing request. Cheap enough
// to call on resize, on a HUD layout change and at the start of a tween.
function refit(instant) {
  framedMode = screenMode();
  solveFraming();
  applyProjection();
  const dist = solved.dist;
  const eye = new THREE.Vector3().copy(framing.center).addScaledVector(VIEW_DIR, dist);
  if (instant) { camEye.copy(eye); camLook.copy(framing.center); }
  rig.fit(framing.center, framing.spanX, framing.spanZ);
  // Fog starts just past the board and closes well before the dome, so islands
  // dissolve into the horizon instead of ending on a hard edge.
  if (scene.fog) { scene.fog.near = dist * 1.15; scene.fog.far = dist * 3.4; }
  return eye;
}

// Smoothly move the camera to frame a box of `spanX` by `spanZ` world units at
// `center`. Options:
//
//   instant  cut instead of tweening.
//   yLo      how far *below* center.y the framed box reaches, in world units.
//   yHi      how far above it. Both optional: a caller that knows its own
//            island -- how deep the keel hangs, how high the stars float, where
//            the exit portal's arch tops out -- passes the real numbers, and
//            anything that does not gets DEFAULT_Y_LO / DEFAULT_Y_HI. They are
//            the difference between "the tile tops are in frame" and "the whole
//            object is in frame", which on a descending board is the difference
//            between seeing the exit and seeing half of it behind the tray.
let camTween = null;
export function frameView(center, spanX, spanZ, opts = {}) {
  framing.center.set(center.x, 0, center.z);
  framing.spanX = spanX;
  framing.spanZ = spanZ;
  framing.yLo = Number.isFinite(opts.yLo) ? opts.yLo : DEFAULT_Y_LO;
  framing.yHi = Number.isFinite(opts.yHi) ? opts.yHi : DEFAULT_Y_HI;
  const eye = refit(!!opts.instant);
  if (opts.instant) return;

  const from = camEye.clone();
  const lookFrom = camLook.clone();
  let t = 0;
  if (camTween) camTween();
  camTween = onFrame((dt) => {
    t = Math.min(1, t + dt * 1.6);
    const e = 1 - Math.pow(1 - t, 3);
    camEye.lerpVectors(from, eye, e);
    camLook.lerpVectors(lookFrom, framing.center, e);
    if (t >= 1) { camTween(); camTween = null; }
  });
}

// Slow, low-amplitude parallax. Three incommensurate periods so it never
// visibly loops, and an amplitude around 2% of the view distance -- enough for
// the scene to feel alive, far too little to move a tile off its neighbour.
const _drift = new THREE.Vector3();
const _look = new THREE.Vector3();
function updateCamera(t) {
  const amp = camEye.distanceTo(camLook) * 0.022;
  _drift.set(
    (Math.sin(t * 0.21) * 0.7 + Math.sin(t * 0.077) * 0.45) * amp,
    Math.sin(t * 0.13) * 0.4 * amp,
    Math.cos(t * 0.104) * 0.6 * amp,
  );
  camera.position.copy(camEye).add(_drift);
  _look.copy(camLook).addScaledVector(_drift, 0.25);
  camera.lookAt(_look);
}

function tick() {
  const now = performance.now();
  const dtMs = now - lastFrameTime;
  const dt = Math.min(dtMs / 1000, 0.2);
  lastFrameTime = now;
  elapsedTime += dt;
  const t = elapsedTime;
  noteFrame(dtMs);

  for (const fn of [...updaters]) fn(dt, t);

  // The HUD changes height as the player adds command tokens, so the usable
  // band has to be re-measured -- but four getBoundingClientRect calls every
  // frame is a layout read the browser does not need. Four times a second is
  // imperceptible and free.
  bandPoll += dt;
  if (bandPoll > 0.25) {
    bandPoll = 0;
    const beforeH = bandBottom - bandTop;
    const beforeTop = bandTop;
    updateProjection();
    // The router builds its backdrop before it builds the screen, so the very
    // first frameView of a menu runs while the DOM still says "no screen" and
    // gets the play framing. Watching the mode here is what lets the menu's
    // offset and overscale land at all -- and it costs one string compare.
    const mode = screenMode();
    const modeChanged = mode !== framedMode;
    framedMode = mode;
    if (modeChanged
      || Math.abs((bandBottom - bandTop) - beforeH) > 2 || Math.abs(bandTop - beforeTop) > 2) {
      // Re-frame through the normal tween so the board eases into its new
      // position instead of snapping when a tray grows a row of tokens. The
      // caller's vertical extent is carried through: this is a re-fit of the
      // same request, not a new one.
      frameView(framing.center, framing.spanX, framing.spanZ,
        { yLo: framing.yLo, yHi: framing.yHi });
    }
  }

  for (const c of clouds) {
    c.position.x += c.userData.speed * dt;
    if (c.position.x > 34) c.position.x = -34;
  }
  updateParticles(dt);
  updateCamera(t);
  sky.follow(camera);

  if (post) post.render(dt);
  else renderer.render(scene, camera);
}

// The part of the canvas the HUD is not sitting on, as NDC y (+1 top, -1
// bottom). scenery.js uses it to keep its decorative islands from running down
// behind the program tray and out the other side of it, which reads as a
// rendering fault rather than as land.
export function usableBandNDC() {
  const h = innerHeight || 1;
  return { top: 1 - 2 * bandTop / h, bottom: 1 - 2 * bandBottom / h };
}

export function onFrame(fn) { updaters.add(fn); return () => updaters.delete(fn); }
export function getScene() { return scene; }
export function getCamera() { return camera; }
export function getRenderer() { return renderer; }

export function applyTheme(world) {
  const th = WORLD_THEMES[world] || WORLD_THEMES[0];
  theme = th;
  themeKey = WORLD_THEMES[world] ? world : 0;

  // No flat background colour any more: the dome *is* the background, and it
  // is the same gradient the environment map is baked from.
  scene.background = null;
  scene.environment = env.get(themeKey, th);
  scene.environmentIntensity = th.envIntensity;
  // Mutated, never replaced: three keys a material's compiled program on the
  // fog *instance*, so handing the scene a fresh Fog on every level build would
  // recompile every shared material (sky, clouds, Bloop, particles) each time.
  if (!scene.fog) scene.fog = new THREE.Fog(th.horizon, 22, 60);
  else scene.fog.color.setHex(th.horizon);

  sky.apply(th);
  rig.apply(th);
  renderer.toneMappingExposure = th.exposure;

  if (cloudMat) cloudMat.color.setHex(th.cloud);
  if (cloudGroup) cloudGroup.visible = th.clouds !== false;

  refit(false);
  return th;
}

// ---- clouds ----
function makeClouds() {
  const detail = flags().detail;
  cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1 });
  cloudGroup = new THREE.Group();
  scene.add(cloudGroup);
  const count = Math.max(4, Math.round(10 * detail));
  for (let i = 0; i < count; i++) {
    const cloud = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let j = 0; j < n; j++) {
      const s = 0.9 + Math.random() * 1.4;
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), cloudMat);
      m.position.set(j * 1.2 - n * 0.55, Math.random() * 0.5, Math.random() * 0.9);
      m.scale.y = 0.55;
      cloud.add(m);
    }
    cloud.position.set(Math.random() * 68 - 34, 5 + Math.random() * 9, -20 - Math.random() * 22);
    cloud.userData.speed = 0.2 + Math.random() * 0.4;
    cloudGroup.add(cloud);
    clouds.push(cloud);
  }
}

// ---- particles ----
const particles = [];
const particleGeo = new THREE.TetrahedronGeometry(0.09);
// Burst materials are cached by colour. The old code allocated (and never
// freed) a MeshBasicMaterial per burst, which on a long play session meant
// hundreds of leaked GPU programs' worth of material state.
const burstMats = new Map();

function burstMaterial(color) {
  let m = burstMats.get(color);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); burstMats.set(color, m); }
  return m;
}

export function burst(pos, color, count = 14, speed = 3, life = 0.7) {
  const mat = burstMaterial(color);
  const n = Math.max(3, Math.round(count * flags().detail));
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(particleGeo, mat);
    m.position.copy(pos);
    const a = Math.random() * Math.PI * 2;
    const b = Math.random() * Math.PI;
    const s = speed * (0.4 + Math.random() * 0.6);
    m.userData = {
      vel: new THREE.Vector3(Math.sin(b) * Math.cos(a) * s, Math.cos(b) * s * 0.9 + 1.5, Math.sin(b) * Math.sin(a) * s),
      life: life * (0.6 + Math.random() * 0.4),
      t: 0,
    };
    scene.add(m);
    particles.push(m);
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.userData.t += dt;
    if (p.userData.t >= p.userData.life) {
      scene.remove(p);
      particles.splice(i, 1);
      continue;
    }
    p.userData.vel.y -= 9 * dt;
    p.position.addScaledVector(p.userData.vel, dt);
    const k = 1 - p.userData.t / p.userData.life;
    p.scale.setScalar(Math.max(k, 0.01));
    p.rotation.x += dt * 7; p.rotation.z += dt * 5;
  }
}
