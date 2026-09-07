// Builds the 3D floating-island maze for a parsed level.
//
// ---------------------------------------------------------------------------
// How the board is put together, and why
// ---------------------------------------------------------------------------
//
// The board used to be two THREE.Box meshes per tile. That gave 0.02-wide gaps
// you could see the sky through (so a five-tile path read as five islands), a
// flat untextured top, and 160+ draw calls on a nine-by-nine level. It is now
// one procedurally welded mesh per *material*, generated here into plain
// arrays:
//
//   * Tiles butt together exactly. Tile identity comes from a 3mm chamfer round
//     each top face -- a shading groove, not a hole -- so the path still reads
//     as a grid of steps but as ONE island.
//   * Colour lives in vertex colours, not in the material, so every plain path
//     tile in the level shares a single material and a single draw call. The
//     four condition colours and the exit keep their own materials because they
//     also carry emissive, which cannot be a per-vertex value.
//   * Ambient occlusion is baked into those same vertex colours. Screen-space
//     AO was evaluated and rejected for this scene (see postfx.js): it finds
//     nothing but the tile seams and draws exactly the outlines that break the
//     path apart. Baking lets us put the darkening only where it grounds
//     things -- under the grass lip, down the cliff face, under every prop --
//     and nowhere near the interior seams.
//   * The island underside is a real shape: every grid *corner* carries a
//     depth and an inward inset, shared by all four tiles that touch it, so
//     the cliffs slope and the underside crumples without ever cracking open.
//
// Surface detail (albedo mottle, roughness, a normal map for the rock) is
// generated at runtime in textures.js and shared by every tile.
import * as THREE from 'three';
import { TILE_COLORS, applyTheme, onFrame, getScene, frameView } from './renderer.js';
import { flags } from './quality.js';
import { getMaps, retireStaleMaps, softDiscTexture, glowDiscTexture, portalCoreTexture } from './textures.js';
import { createScenery } from './scenery.js';

let current = null; // { group, itemMeshes: Map"x,y"->mesh, portal, dispose() }

// ---------------------------------------------------------------------------
// Board metrics. Everything vertical is measured down from the walking surface
// at y = 0, which is where bloop.js and animator.js expect to find the floor.
// ---------------------------------------------------------------------------
const LIP_Y = -0.20;       // bottom of the grass slab / top of the rock
// Vertex rows across one tile top, with the height and the shade multiplier
// that go with each. Read outwards from the middle:
//
//   +-0.34  the last row of full-value surface
//   +-0.415 the shoulder the groove gradient starts from
//   +-0.462 the bevel's inner lip -- a small drop, most of the darkening
//   +-0.5   the tile boundary itself -- the darkest value on the board
//
// This is deliberately a much stronger and wider groove than it used to be.
// The old one was a 3.5%-wide band at 0.84 of the tile colour, which is a 16%
// step, and in the low-contrast themes the chamfer's own highlight swallowed
// it: two coplanar neighbouring tiles met at a *lighter* hairline, so a child
// planning "right, right, down" had to count squares that had no edges. A
// puzzle grid has to read as a grid; the risk on the other side (a groove so
// heavy the path stops reading as one island) is what the two-step falloff and
// the untouched 68% of the tile interior are protecting against.
const TOP_ROWS = [
  { u: -0.5, y: -0.034, k: 'seam' },
  { u: -0.462, y: -0.011, k: 'groove' },
  { u: -0.415, y: 0, k: 'shoulder' },
  { u: -0.34, y: 0, k: 'full' },
  { u: 0.34, y: 0, k: 'full' },
  { u: 0.415, y: 0, k: 'shoulder' },
  { u: 0.462, y: -0.011, k: 'groove' },
  { u: 0.5, y: -0.034, k: 'seam' },
];
// Darkest of the two rows a vertex sits on wins, so the groove wraps the corner
// instead of brightening back up in it.
const SHADE_RANK = { full: 0, shoulder: 1, groove: 2, seam: 3 };
const CHAMFER_Y = TOP_ROWS[0].y; // where the grass lip starts, below the bevel

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Which procedural top surface each world gets. This is most of what makes the
// five worlds feel like different places rather than one place recoloured.
const TOP_KIND = {
  0: 'organic', 1: 'organic', 2: 'crystalline', 3: 'strata', 4: 'panel', 5: 'slate',
};

// Per-world surface response. A meadow is matte; a tech plate is a moulded
// polymer with a slight sheen; wet slate is the shiniest thing in the game.
const SURFACE = {
  0: { roughness: 0.90, metalness: 0.0 },
  1: { roughness: 0.92, metalness: 0.0 },
  2: { roughness: 0.62, metalness: 0.05 },
  3: { roughness: 0.95, metalness: 0.0 },
  4: { roughness: 0.42, metalness: 0.18 },
  5: { roughness: 0.48, metalness: 0.06 },
};

// ---------------------------------------------------------------------------
// Small helpers
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

// Colours arrive from the theme table as sRGB hex and are converted to the
// linear working space on construction, so all the arithmetic below (scaling
// for shade, lerping towards the bounce colour) happens in light, not in
// gamma -- which is the difference between a shadow that looks tinted and one
// that looks like a grey wash.
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// The albedo detail map averages about 0.9, so every base colour is lifted to
// meet it. Without this every surface in the game would quietly lose a tenth
// of its value the moment it got a texture.
const MAP_GAIN = 1.1;

function tint(hex, gain = MAP_GAIN) {
  return new THREE.Color(hex).multiplyScalar(gain);
}

// ---------------------------------------------------------------------------
// Condition-tile colour: one source of truth for the board and the HUD
// ---------------------------------------------------------------------------
//
// The HUD draws a coloured dot for each condition and the board draws a tile in
// "the same" colour, and that pairing *is* the teaching mechanic of World 2 --
// a child learns "pink means turn left" by matching a dot to a tile. It stopped
// being the same colour the moment the board started applying MAP_GAIN on top
// of TILE_COLORS to meet the albedo map: the two drifted by a few per cent of
// value and, worse, could drift further any time the gain moved.
//
// So the gain is applied exactly once, here, and both consumers read the
// result. `TILE_UI_COLORS` is the post-tint albedo as an ordinary sRGB hex; the
// HUD imports it, and falls back to the raw TILE_COLORS if it is ever absent.
const TILE_ALBEDO = {};
for (const k of Object.keys(TILE_COLORS)) TILE_ALBEDO[k] = tint(TILE_COLORS[k]);

export const TILE_UI_COLORS = {};
for (const k of Object.keys(TILE_ALBEDO)) {
  TILE_UI_COLORS[k] = TILE_ALBEDO[k].getHex(THREE.SRGBColorSpace);
}

// World 2's dirt is so dark that, lit only by a cavern's ambient, it rendered
// as a hole punched in the scene rather than as the rock the island is made
// of. Rather than special-casing one theme, any dirt below a linear luminance
// floor is scaled up to meet it, then given a little of the world's own bounce
// colour so it still belongs to its sky.
function rockBase(theme) {
  const c = new THREE.Color(theme.dirt);
  const l = lum(c);
  const FLOOR = 0.135;
  if (l > 0.0001 && l < FLOOR) c.multiplyScalar(Math.min(FLOOR / l, 2.4));
  // Only a trace of the bounce colour now, and none of it in the albedo above
  // the waist. Multiplying a warm brown dirt (0x8a5a3c) by a *green* bounce is
  // how World 1's cliffs came out at hue 68 degrees -- olive drab, reading as
  // mould, and the muddiest colour in the game. A per-channel multiply cannot
  // add hue, it can only cancel one, and brown x green cancels the red.
  // The bounce belongs at the keel, where light really does come up off the
  // world below; it does not belong in the base albedo of the whole flank.
  c.lerp(new THREE.Color(theme.bounce), 0.03);
  return c.multiplyScalar(MAP_GAIN);
}

// How far the island's flank is lifted so it separates from the sky behind it.
//
// Fixing the tile-top-versus-side inversion by darkening the rock moved the
// silhouette problem rather than solving it. Measured off a still, with the
// cliff isolated and compared against the sky *at the same pixels*, the flank
// came out at 1.9x the sky's luminance in World 2, 1.5x in World 3 and 1.3x in
// World 5. At those numbers the island has no outline at all: it stops being a
// thing floating in air and becomes a shape cut out of the backdrop, and a
// child cannot tell where the land ends.
//
// The three worlds it fails in are the three with a dark sky, which is also why
// brightening is the only available move -- there is no room left underneath
// them. Worlds 0, 1 and 4 have bright skies and separate the other way (their
// cliffs read between 2.6x and 7.5x *darker* than the air), so they are left
// exactly as they were.
//
// World 4 is the one entry below 1. Its sky was darkened to get its blue board
// off its blue backdrop, and the flank followed the sky down instead of holding
// still, so it ended up level with the air again. There the fix is the opposite
// one -- the sky is still the brighter of the two, so the cliff separates by
// going *further* down and reading as a proper silhouette, which is also what
// widens the tile-top-to-tile-side step rather than narrowing it.
//
// These are measured constants, not derived ones, and deliberately so: what the
// eye judges is the rendered pixel, and the flank renders at anywhere between
// 18% and 57% of its albedo depending on how much of the key light reaches it.
// Any formula in albedo space gets the answer wrong by half. Re-measure with
// the review harness if a sky colour moves.
const CLIFF_LIFT = { 2: 1.22, 3: 1.15, 4: 0.56, 5: 1.72 };

// ---------------------------------------------------------------------------
// Geometry accumulation
// ---------------------------------------------------------------------------

function newBuf() { return { pos: [], nor: [], uv: [], col: [] }; }

const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _fn = new THREE.Vector3();

// Pushes one flat-shaded triangle with per-vertex colours. UVs are derived
// from the triangle's dominant axis in *world* space, not per tile: that is
// what makes the surface texture run continuously across the whole island
// instead of restarting at every tile and re-drawing the grid we just spent
// the chamfer trying to soften.
const UV_SCALE = 0.5;
function tri(buf, a, b, c, ca, cb, cc) {
  _ab.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  _ac.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  _fn.crossVectors(_ab, _ac);
  if (_fn.lengthSq() < 1e-12) return; // degenerate: a zero-height cliff segment
  _fn.normalize();
  const ax = Math.abs(_fn.x), ay = Math.abs(_fn.y), az = Math.abs(_fn.z);
  let ui = 0, vi = 2;                       // top/bottom faces: x,z
  if (ay < ax || ay < az) {
    if (ax >= az) { ui = 2; vi = 1; }       // faces looking along x: z,y
    else { ui = 0; vi = 1; }                // faces looking along z: x,y
  }
  vert(buf, a, ui, vi, ca);
  vert(buf, b, ui, vi, cb);
  vert(buf, c, ui, vi, cc);
}

function vert(buf, p, ui, vi, col) {
  buf.pos.push(p[0], p[1], p[2]);
  buf.nor.push(_fn.x, _fn.y, _fn.z);
  buf.uv.push(p[ui] * UV_SCALE, p[vi] * UV_SCALE);
  buf.col.push(col.r, col.g, col.b);
}

function quad(buf, a, b, c, d, ca, cb, cc, cd) {
  tri(buf, a, b, c, ca, cb, cc);
  tri(buf, a, c, d, ca, cc, cd);
}

function toGeometry(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.computeBoundingSphere();
  return g;
}

export function gridToWorld(x, y, level) {
  return new THREE.Vector3(x - (level.cols - 1) / 2, 0, y - (level.rows - 1) / 2);
}

// ---------------------------------------------------------------------------
// Tile tops
// ---------------------------------------------------------------------------

const shaded = (base, k) => base.clone().multiplyScalar(k);

// The colours one tile-top material ever needs, resolved once per material
// rather than once per tile: a nine-by-nine board would otherwise allocate
// three thousand THREE.Color objects it throws away immediately.
//
// `seam` is a fixed fraction of the tile colour rather than an absolute dark
// value, so it darkens by the same *ratio* in every theme -- the storm world's
// grey-blue board and the meadow's green one get the same 40% step, which is
// what the old absolute-ish 0.84 could not promise.
function tilePalette(color) {
  return {
    full: shaded(color, 1.0),
    shoulder: shaded(color, 0.93),
    groove: shaded(color, 0.78),
    seam: shaded(color, 0.60),
    lipTop: shaded(color, 0.72),
    lipBot: shaded(color, 0.50),
  };
}

function addTileTop(buf, cx, cz, pal) {
  const n = TOP_ROWS.length;
  const cols = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = TOP_ROWS[i].k, b = TOP_ROWS[j].k;
      cols.push(pal[SHADE_RANK[a] >= SHADE_RANK[b] ? a : b]);
    }
  }
  const pt = (i, j) => [cx + TOP_ROWS[i].u, Math.min(TOP_ROWS[i].y, TOP_ROWS[j].y), cz + TOP_ROWS[j].u];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      // Wound anti-clockwise seen from above, so the face normal is +Y.
      quad(buf,
        pt(i, j), pt(i, j + 1), pt(i + 1, j + 1), pt(i + 1, j),
        cols[j * n + i], cols[(j + 1) * n + i], cols[(j + 1) * n + i + 1], cols[j * n + i + 1]);
    }
  }
}

// The vertical band of grass on an exposed tile edge, from the bottom of the
// bevel down to where the rock starts. Darkens as it goes: this is the first
// half of the contact shade that stops the island floating free of its own
// underside.
function addGrassLip(buf, cx, cz, dx, dz, pal) {
  const top = pal.lipTop;
  const bot = pal.lipBot;
  // Two corners of the exposed edge, walked so the face points outward.
  const px = dx * 0.5, pz = dz * 0.5;
  const tx = dz * 0.5, tz = -dx * 0.5;
  const a = [cx + px + tx, CHAMFER_Y, cz + pz + tz];
  const b = [cx + px - tx, CHAMFER_Y, cz + pz - tz];
  quad(buf,
    a, b, [b[0], LIP_Y, b[2]], [a[0], LIP_Y, a[2]],
    top, top, bot, bot);
}

// ---------------------------------------------------------------------------
// Island rock
// ---------------------------------------------------------------------------

// Per-corner description of the island's underside. Corners are shared by up
// to four tiles, so putting the randomness *here* rather than per tile is what
// makes the cliffs and the crumpled underside continuous: two neighbouring
// tiles cannot disagree about a point they both use.
function buildCorners(level, rng) {
  const { cols, rows, tiles } = level;
  const w = cols + 1, h = rows + 1;
  const solid = new Int8Array(w * h);
  const dist = new Int16Array(w * h).fill(9999);
  const dirX = new Float32Array(w * h);
  const dirZ = new Float32Array(w * h);

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const ci = cy * w + cx;
      let n = 0, sx = 0, sz = 0;
      for (let oy = -1; oy <= 0; oy++) {
        for (let ox = -1; ox <= 0; ox++) {
          const tx = cx + ox, ty = cy + oy;
          if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
          if (!tiles[ty][tx]) continue;
          n++; sx += ox + 0.5; sz += oy + 0.5;
        }
      }
      solid[ci] = n;
      const len = Math.hypot(sx, sz);
      if (len > 1e-4) { dirX[ci] = sx / len; dirZ[ci] = sz / len; }
    }
  }

  // Distance (in corners) from the island's rim, so the underside can hang
  // deepest where it is furthest from an edge -- a keel, not a slab.
  const queue = [];
  for (let i = 0; i < solid.length; i++) if (solid[i] > 0 && solid[i] < 4) { dist[i] = 0; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const cx = i % w, cy = (i / w) | 0;
    for (const [ox, oy] of NEIGHBOURS) {
      const nx = cx + ox, ny = cy + oy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (solid[ni] === 0 || dist[ni] <= dist[i] + 1) continue;
      dist[ni] = dist[i] + 1;
      queue.push(ni);
    }
  }

  const baseX = -(cols - 1) / 2 - 0.5;
  const baseZ = -(rows - 1) / 2 - 0.5;
  const pts = new Array(w * h);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const ci = cy * w + cx;
      const x = baseX + cx, z = baseZ + cy;
      const rim = solid[ci] < 4;
      const inset = rim ? 0.09 + rng() * 0.10 : 0;
      const depth = 0.56 + Math.min(dist[ci], 4) * 0.34 + rng() * 0.40;
      // Mid ring: pulled in less than the base and jittered outward, so the
      // cliff breaks over a ledge instead of tapering like a lampshade.
      const midIn = inset * (0.30 + rng() * 0.35);
      pts[ci] = {
        x, z, solid: solid[ci], depth,
        mx: x + dirX[ci] * midIn, my: LIP_Y - depth * (0.34 + rng() * 0.16), mz: z + dirZ[ci] * midIn,
        bx: x + dirX[ci] * inset, by: LIP_Y - depth, bz: z + dirZ[ci] * inset,
      };
    }
  }
  return { pts, w };
}

function addRock(buf, corners, tileX, tileY, exposed, pal) {
  const { pts, w } = corners;
  const c00 = pts[tileY * w + tileX];
  const c10 = pts[tileY * w + tileX + 1];
  const c11 = pts[(tileY + 1) * w + tileX + 1];
  const c01 = pts[(tileY + 1) * w + tileX];

  const top = (c) => [c.x, LIP_Y, c.z];
  // A narrow band just under the grass, at 16% of the way down to the waist.
  // The contact shade used to be spread over the whole upper half of the cliff,
  // which meant the flank got *brighter* as it went down -- the reverse of how
  // a lit face behaves, and it flattened the only value range the rock had.
  // Confining the darkening to a band this thin turns it into the hairline of
  // occlusion it is meant to be, and lets the face below it be the brightest
  // rock on the island instead of the darkest.
  const near = (c) => [
    c.x + (c.mx - c.x) * 0.16, LIP_Y + (c.my - LIP_Y) * 0.16, c.z + (c.mz - c.z) * 0.16,
  ];
  const mid = (c) => [c.mx, c.my, c.mz];
  const bot = (c) => [c.bx, c.by, c.bz];

  // Exposed cliff faces, walked outward. `exposed` is indexed the same way as
  // NEIGHBOURS: +x, -x, +z, -z.
  const faces = [
    [c10, c11], // +x
    [c01, c00], // -x
    [c11, c01], // +z
    [c00, c10], // -z
  ];
  for (let i = 0; i < 4; i++) {
    if (!exposed[i]) continue;
    const [a, b] = faces[i];
    quad(buf, top(a), top(b), near(b), near(a), pal.shade, pal.shade, pal.face, pal.face);
    quad(buf, near(a), near(b), mid(b), mid(a), pal.face, pal.face, pal.mid, pal.mid);
    quad(buf, mid(a), mid(b), bot(b), bot(a), pal.mid, pal.mid, pal.deep, pal.deep);
  }
  // The underside itself. Always emitted: neighbouring tiles share these four
  // points, so it welds into one continuous crumpled sheet, and without it the
  // island is hollow the moment the camera catches it from below.
  quad(buf, bot(c00), bot(c10), bot(c11), bot(c01), pal.deep, pal.deep, pal.deep, pal.deep);
}

// Hanging stalactites. The old build dropped one five-sided cone under every
// fourth tile, which read as a row of identical spikes; these come in clusters
// of one to three at mixed sizes, weighted heavily towards the rim where they
// are the only thing making the island's silhouette.
function addSpikes(buf, corners, tileX, tileY, exposed, rng, pal) {
  const { pts, w } = corners;
  const isRim = exposed[0] || exposed[1] || exposed[2] || exposed[3];
  // Spikes drift towards whichever edges of the tile are open. A spike hung
  // under the middle of a rim tile is hidden behind that tile's own cliff from
  // every angle the camera can be at, so it costs triangles and buys nothing.
  const bias = [
    (exposed[0] ? 1 : 0) - (exposed[1] ? 1 : 0),
    (exposed[2] ? 1 : 0) - (exposed[3] ? 1 : 0),
  ];
  const c = [
    pts[tileY * w + tileX], pts[tileY * w + tileX + 1],
    pts[(tileY + 1) * w + tileX + 1], pts[(tileY + 1) * w + tileX],
  ];
  const cxm = (c[0].bx + c[1].bx + c[2].bx + c[3].bx) / 4;
  const czm = (c[0].bz + c[1].bz + c[2].bz + c[3].bz) / 4;
  const cym = (c[0].by + c[1].by + c[2].by + c[3].by) / 4;

  const want = isRim ? 0.8 : 0.28;
  if (rng() > want) return;
  const n = 1 + (rng() < (isRim ? 0.55 : 0.25) ? 1 : 0) + (rng() < 0.2 ? 1 : 0);
  for (let s = 0; s < n; s++) {
    // Minimum cross-section, in three ways at once. The old spikes could come
    // out as a literal one-pixel sliver: four sides was two faces from most
    // camera angles, the base radius could fall to 0.067, and -- the real
    // culprit -- each face picked its two corner radii *independently*, so
    // face i and face i+1 disagreed about the corner they share. That left
    // cracks down the middle of the cone and, when two corners happened to
    // land small, a polygon seen edge-on that read as a stray dark line rather
    // than as rock. Corner radii are now computed once, per corner.
    const r = 0.13 + rng() * 0.13;
    const len = (0.26 + rng() * 0.75) * (isRim ? 1.25 : 0.8);
    const ox = cxm + (rng() - 0.5) * 0.42 + bias[0] * 0.22;
    const oz = czm + (rng() - 0.5) * 0.42 + bias[1] * 0.22;
    const oy = cym + 0.04;
    const sides = 5 + ((rng() * 2) | 0);
    // A lean, not a plumb line. Every keel used to point straight down with
    // the same taper, which is what made a rim of them read as a comb.
    const lean = 0.14 + rng() * 0.30;
    const leanA = rng() * Math.PI * 2;
    const tip = [ox + Math.cos(leanA) * len * lean, oy - len, oz + Math.sin(leanA) * len * lean];
    const phase = rng() * Math.PI * 2;
    const rad = [];
    for (let i = 0; i < sides; i++) rad.push(r * (0.82 + rng() * 0.40));
    const pt = (i) => {
      const a = phase + (i / sides) * Math.PI * 2;
      return [ox + Math.cos(a) * rad[i], oy, oz + Math.sin(a) * rad[i]];
    };
    for (let i = 0; i < sides; i++) {
      tri(buf, pt(i), pt((i + 1) % sides), tip, pal.deep, pal.deep, pal.tip);
    }
  }
}

// ---------------------------------------------------------------------------
// Board assembly
// ---------------------------------------------------------------------------

function buildBoard(level, theme, themeKey, owned) {
  const maps = getMaps(themeKey, TOP_KIND[themeKey] || 'organic');
  const surf = SURFACE[themeKey] || SURFACE[1];
  const rng = mulberry(level.cols * 73856093 ^ level.rows * 19349663);

  // One buffer per material. `path` collects every plain tile in the level,
  // which is the overwhelming majority of them, into a single draw call.
  const bufs = new Map();
  const buf = (key) => {
    let b = bufs.get(key);
    if (!b) { b = newBuf(); bufs.set(key, b); }
    return b;
  };

  const grassPal = tilePalette(tint(theme.grass));
  // Was a near-white 0xe8dcff, which put the exit tile at 88% value before the
  // portal drew a single pixel on it -- so the portal's own glow had nowhere to
  // go but straight through white. A deeper violet gives the gold ring, the
  // amber spill and the portal's core something to read against, and it is a
  // stronger "this tile is different" signal than pale lavender ever was.
  const exitPal = tilePalette(tint(0xa88fe0));
  const colorPal = {};
  for (const k of Object.keys(TILE_ALBEDO)) colorPal[k] = tilePalette(TILE_ALBEDO[k]);

  const base = rockBase(theme).multiplyScalar(CLIFF_LIFT[themeKey] || 1);
  const bounce = new THREE.Color(theme.bounce);
  const pal = {
    // A hairline of occlusion right under the grass lip, and then the flank
    // *brightens*. The gradient used to run the other way -- dark at the top,
    // lightest at the very bottom -- which is how neither rock nor anything
    // else behaves under a sun that is above it.
    shade: base.clone().multiplyScalar(0.52),
    face: base.clone().multiplyScalar(1.16),
    mid: base.clone().multiplyScalar(0.86),
    // Towards the bottom the rock picks up the light bouncing off whatever the
    // island is floating over -- but as a *tint on a darker value*, not as a
    // brightening. Baking it in is still what stops the underside reading as a
    // hole; taking it up past the lit face is what made it read as mould.
    deep: base.clone().lerp(bounce, 0.16).multiplyScalar(0.58),
    tip: base.clone().lerp(bounce, 0.26).multiplyScalar(0.74),
  };

  const rockBuf = buf('rock');
  const corners = buildCorners(level, rng);

  for (let y = 0; y < level.rows; y++) {
    for (let x = 0; x < level.cols; x++) {
      const t = level.tiles[y][x];
      if (!t) continue;
      const p = gridToWorld(x, y, level);

      let key = 'path', pal2 = grassPal;
      if (t.kind === 'color') { key = `c${t.color}`; pal2 = colorPal[t.color]; }
      else if (t.kind === 'exit') { key = 'exit'; pal2 = exitPal; }
      const topBuf = buf(key);
      addTileTop(topBuf, p.x, p.z, pal2);

      const exposed = NEIGHBOURS.map(([ox, oy]) => {
        const nx = x + ox, ny = y + oy;
        return nx < 0 || ny < 0 || nx >= level.cols || ny >= level.rows || !level.tiles[ny][nx];
      });
      for (let i = 0; i < 4; i++) {
        if (exposed[i]) addGrassLip(topBuf, p.x, p.z, NEIGHBOURS[i][0], NEIGHBOURS[i][1], pal2);
      }
      addRock(rockBuf, corners, x, y, exposed, pal);
      addSpikes(rockBuf, corners, x, y, exposed, rng, pal);
    }
  }

  const meshes = [];
  for (const [key, b] of bufs) {
    if (!b.pos.length) continue;
    const geo = toGeometry(b);
    const isRock = key === 'rock';
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: isRock ? maps.rock.map : maps.top.map,
      roughnessMap: isRock ? maps.rock.roughnessMap : maps.top.roughnessMap,
      normalMap: isRock ? maps.rock.normalMap : null,
      roughness: isRock ? 1.0 : surf.roughness,
      metalness: isRock ? 0.0 : surf.metalness,
    });
    if (isRock && maps.rock.normalMap) mat.normalScale.set(0.95, 0.95);
    if (isRock) {
      // The cliff and the underside receive almost no key light, so before this
      // they were lit *entirely* by the environment map -- and the environment
      // map's lower hemisphere is baked from `bounce`, which in the meadow is
      // green. Green ambient times brown albedo is olive, and no amount of
      // retinting the albedo fixes it while the ambient is doing all the work.
      // So the rock drinks less than half the env light every other surface
      // gets, and the difference comes back as a self-lit term.
      mat.envMapIntensity = 0.42;
      // That term is the rock's own colour with a little of the bounce in it,
      // not the bounce colour itself, and it is modulated by the albedo map so
      // the strata survive it instead of being flooded flat. Well under the
      // bloom threshold: it lifts the darks, it never glows.
      mat.emissive = base.clone().lerp(bounce, 0.22).multiplyScalar(0.34);
      mat.emissiveMap = maps.rock.map;
    }
    if (key.startsWith('c')) {
      mat.emissive = new THREE.Color(TILE_COLORS[key.slice(1)]);
      mat.emissiveIntensity = 0.22;
    } else if (key === 'exit') {
      mat.emissive = new THREE.Color(0x8c66ff);
      mat.emissiveIntensity = 0.34;
    }
    const mesh = new THREE.Mesh(geo, mat);
    // Named so a still can be taken apart: the review harness isolates the tile
    // tops from the rock to measure each against the sky behind it, and doing
    // that by guessing at pixels is how the last two rounds got the numbers
    // wrong. Costs a string per draw call.
    mesh.name = isRock ? 'island.rock' : `island.top.${key}`;
    mesh.receiveShadow = true;
    mesh.castShadow = isRock;
    meshes.push(mesh);
    owned.push(geo, mat);
  }
  // How far the island actually hangs. The framing solver used to assume a
  // constant -0.9, which is roughly a third of the truth on a wide board, so
  // the keel ran off the bottom of the frame and -- because the fit is solved
  // against the *usable* band -- the board drifted down under the program
  // trays to compensate. Measured from the corners the underside was built
  // from, so it cannot go stale.
  let keelY = LIP_Y;
  for (const p of corners.pts) if (p.solid > 0 && p.by < keelY) keelY = p.by;
  return { meshes, keelY };
}

// ---------------------------------------------------------------------------
// Collectables
// ---------------------------------------------------------------------------

// A genuinely three-dimensional star: two five-sided pyramids sharing a rim,
// so there is no angle at which it collapses to a flat sliver. The old star was
// an extruded 2D shape spinning on Y, which spent half of every rotation
// presenting edge-on as a yellow stick.
//
// The two halves are shaded differently in vertex colour -- warm gold on the
// faces that tilt up, a deep amber on the ones that tilt down. That built-in
// value break is also what rescues the collectables in World 3, where a flat
// gold star sat within a hair of the orange rock's value and vanished.
function starGeometry() {
  const buf = newBuf();
  const R = 0.30, r = 0.135, D = 0.115;
  const rim = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    rim.push([Math.cos(a) * rad, Math.sin(a) * rad, 0]);
  }
  const front = [0, 0, D];
  const back = [0, 0, -D];
  const hi = new THREE.Color(0xffeaa0);
  const mid = new THREE.Color(0xffbe25);
  const lo = new THREE.Color(0x6b3204);
  const rimCol = (p) => (p[1] > 0.02 ? mid : (p[1] < -0.02 ? lo : mid.clone().lerp(lo, 0.5)));
  for (let i = 0; i < 10; i++) {
    const a = rim[i], b = rim[(i + 1) % 10];
    tri(buf, front, a, b, hi, rimCol(a), rimCol(b));
    tri(buf, back, b, a, hi, rimCol(b), rimCol(a));
  }
  return toGeometry(buf);
}

// A chunky two-step disc rather than a bare cylinder, so the rim catches the
// key light and the coin reads as struck metal at the size it is actually
// drawn (about forty pixels).
function coinGeometry() {
  const buf = newBuf();
  const R = 0.20, R2 = 0.165, H = 0.030, H2 = 0.048;
  const face = new THREE.Color(0xffe17a);
  const edge = new THREE.Color(0xc8871a);
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    for (const sign of [1, -1]) {
      const y1 = H * sign, y2 = H2 * sign;
      // The -Y half is the +Y half mirrored, and mirroring reverses winding,
      // so each face is emitted with its vertex order swapped for one sign.
      const w = (a, b, c, d, ca, cb, cc, cd) => (sign > 0
        ? quad(buf, a, d, c, b, ca, cd, cc, cb)
        : quad(buf, a, b, c, d, ca, cb, cc, cd));
      // outer rim wall
      w([c0 * R, 0, s0 * R], [c1 * R, 0, s1 * R], [c1 * R, y1, s1 * R], [c0 * R, y1, s0 * R],
        edge, edge, edge, edge);
      // shoulder in to the raised face
      w([c0 * R, y1, s0 * R], [c1 * R, y1, s1 * R], [c1 * R2, y2, s1 * R2], [c0 * R2, y2, s0 * R2],
        edge, edge, face, face);
      if (sign > 0) tri(buf, [0, y2, 0], [c1 * R2, y2, s1 * R2], [c0 * R2, y2, s0 * R2], face, face, face);
      else tri(buf, [0, y2, 0], [c0 * R2, y2, s0 * R2], [c1 * R2, y2, s1 * R2], face, face, face);
    }
  }
  return toGeometry(buf);
}

// ---------------------------------------------------------------------------
// Contact shadows
// ---------------------------------------------------------------------------
//
// Nothing small casts a real shadow any more. A star floating half a tile up
// threw a shadow map blob the size of the tile, offset from the star by the
// sun's angle, which read as a smudge on the grass rather than as the star's
// shadow -- and it cost a shadow-map render of every collectable in the level.
// A tinted soft disc pinned under the object is both cheaper and a far better
// read: it says "this thing is here, and it is floating".
function shadowMaterial(theme, owned) {
  // Tinted towards the sky's ground bounce rather than black. A pure black
  // contact shadow on a saturated tile reads as a hole.
  const col = new THREE.Color(theme.bounce).multiplyScalar(0.35);
  const mat = new THREE.MeshBasicMaterial({
    color: col, map: softDiscTexture(), transparent: true, opacity: 0.40,
    depthWrite: false, blending: THREE.NormalBlending, fog: false,
  });
  owned.push(mat);
  return mat;
}

// ...but a disc pinned *directly beneath* its owner disagrees with the island's
// own shadow-map shadows, which are offset by the sun angle. On a board with
// both in frame you saw offset tile shadows and zero-offset prop shadows side
// by side, which is the one thing a cheat like this cannot survive: it has to
// agree with the real system it is standing in for.
//
// So each disc is displaced by the ground-plane projection of the sun ray. One
// vector add at build time; nothing at all at runtime.
function sunOffset(theme) {
  const [sx, sy, sz] = theme.sunDir || [0.4, 1, 0.45];
  const y = Math.max(0.25, sy); // a sun on the horizon would project to infinity
  return { x: -sx / y, z: -sz / y };
}

// ---------------------------------------------------------------------------
// Exit portal
// ---------------------------------------------------------------------------

// The goal of every level in the game. It reads as a destination from anywhere
// on the board: an indigo mouth sunk into the tile with a vortex turning in it,
// a warm spill of light on the tile round it, a hovering gold ring, four
// orbiting shards and (above the low tier) a short column of light with motes
// rising through it. Deliberately identical in every world, because it is the
// one object a child has to recognise instantly on a screen they have never
// seen before.
//
// ---------------------------------------------------------------------------
// Why the layer order and the numbers below are what they are
// ---------------------------------------------------------------------------
// This object used to blow out to paper white -- 424 of 1520 sampled pixels at
// exactly (255,255,255), with no internal structure at all -- and it did so on
// the *low* tier too, where there is no bloom, so it was never a post-process
// problem. Three additive layers were stacking on a near-white tile with
// nothing opaque underneath them:
//
//   1. the pool, a near-white 0xfff0c0 at up to 0.85 opacity over a texture
//      whose centre stop is rgba(255,255,255,1);
//   2. the shaft, set to DoubleSide, so its near *and* far walls each
//      contributed their 0.45 vertex alpha to the same pixels;
//   3. ten additive motes on top of that.
//
// The fixes, in the order they matter: the ring now frames an opaque core
// instead of a hole; every additive layer is retinted from near-white to a
// saturated amber, so what saturates is gold rather than white; the pool peaks
// at 0.45; and the shaft is BackSide, so the column is drawn once.
function buildPortal(pos, stops, owned) {
  const g = new THREE.Group();
  g.position.copy(pos);
  const detail = flags().detail;

  // Light spilling out onto the tile the portal sits on. Wide, weak, and drawn
  // first: without it the portal was a bright object with no relationship to
  // the surface under it, which is most of why it read as a hole punched in
  // the screen rather than as something standing on the board.
  const spillGeo = new THREE.PlaneGeometry(1.9, 1.9);
  const spillMat = new THREE.MeshBasicMaterial({
    color: 0xffa832, map: glowDiscTexture(), transparent: true, opacity: 0.20,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const spill = new THREE.Mesh(spillGeo, spillMat);
  spill.rotation.x = -Math.PI / 2;
  spill.position.y = 0.008;
  spill.renderOrder = 1;
  g.add(spill);
  owned.push(spillGeo, spillMat);

  // The interior. Opaque (bar a six-per-cent feather on its rim), and the whole
  // reason the additive layers above it are now allowed to be bright: they are
  // adding to a deep indigo, not to a white tile.
  const coreGeo = new THREE.CircleGeometry(0.325, 40);
  const coreMat = new THREE.MeshBasicMaterial({
    map: portalCoreTexture(), transparent: true, depthWrite: false, fog: false,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.rotation.x = -Math.PI / 2;
  core.position.y = 0.012;
  core.renderOrder = 2;
  g.add(core);
  owned.push(coreGeo, coreMat);

  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffb43c, map: glowDiscTexture(), transparent: true, opacity: 0.45,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  const glowGeo = new THREE.PlaneGeometry(1.02, 1.02);
  const pool = new THREE.Mesh(glowGeo, glowMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.016;
  pool.renderOrder = 3;
  g.add(pool);
  owned.push(glowGeo, glowMat);

  const ringGeo = new THREE.TorusGeometry(0.36, 0.055, 10, 30);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xffc93d, emissive: 0xffae1f, emissiveIntensity: 0.9,
    roughness: 0.35, metalness: 0.25, flatShading: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.24;
  g.add(ring);
  owned.push(ringGeo, ringMat);

  // Four small faceted pebbles orbiting the ring.
  //
  // These were tiny copies of the collectable star at 0.28 scale, and a
  // five-point star solid a few pixels across does not read as a star -- it
  // collapses to a lozenge. Zoomed in they were hard-edged pale-yellow
  // diamonds at wildly different sizes (`0.8 + (i % 2) * 0.35` is a 44% swing
  // between neighbours), one of them intersecting the torus, and at emissive
  // 0.7 they took almost no directional light. They read as UI cursor arrows.
  //
  // An icosahedron has no axis it can present edge-on, so it survives being
  // twelve pixels wide, and at emissive 0.35 the key light gets to model it.
  const shardGeo = new THREE.IcosahedronGeometry(0.105, 0);
  const shardMat = new THREE.MeshStandardMaterial({
    color: 0xffd98a, emissive: 0xffb43c, emissiveIntensity: 0.35,
    roughness: 0.34, metalness: 0.2, flatShading: true,
  });
  const shards = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(shardGeo, shardMat);
    m.userData.phase = i * 1.63;
    // Barely varied at all now: enough that they are not stamped copies, far
    // too little to read as four different objects.
    m.scale.setScalar(0.94 + (i % 2) * 0.12);
    g.add(m);
    shards.push(m);
  }
  owned.push(shardGeo, shardMat);

  let shaft = null;
  let motes = null;
  if (detail >= 0.9) {
    // A short column of light. Kept under a tile in height on purpose: taller
    // and it runs up into the HUD, which the camera framing does not budget
    // for. Alpha is a vertex attribute so the column dissolves at the top
    // without needing a second texture.
    const h = 0.85;
    const sg = new THREE.CylinderGeometry(0.30, 0.20, h, 16, 1, true);
    const p = sg.attributes.position;
    const cols = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      // 1 at the base, 0 at the top -- and the clamp is load-bearing, not
      // defensive tidying. `p.getY()` round-trips through float32, so the top
      // ring comes back as 0.42500001 rather than 0.425 and this expression
      // lands on -1.4e-8. `Math.pow(negative, 1.6)` is NaN, so seventeen of the
      // shaft's thirty-four vertices were being handed a NaN vertex alpha.
      // On the low tier that is a few dead pixels behind the portal ring; on
      // every tier with post-processing the bloom pass's separable blur smears
      // those NaNs across the whole mip chain, the composite adds them back
      // over the scene, and OutputPass writes NaN to the canvas as transparent
      // black -- which is why 43-78% of the frame was bare page background.
      const k = Math.min(1, Math.max(0, 1 - (p.getY(i) + h / 2) / h));
      // Amber, not the old near-white (1, 0.94, 0.76). An additive layer's
      // colour is what the pixel saturates *towards*, so a near-white one has
      // only one place it can end up.
      cols[i * 4] = 1; cols[i * 4 + 1] = 0.70; cols[i * 4 + 2] = 0.26;
      cols[i * 4 + 3] = Math.pow(k, 1.6) * 0.45;
    }
    sg.setAttribute('color', new THREE.BufferAttribute(cols, 4));
    const sm = new THREE.MeshBasicMaterial({
      // BackSide, not DoubleSide. An additive open cylinder drawn double-sided
      // lays its near wall over its far wall, so every pixel of the column was
      // paying its 0.45 alpha twice and the base of the shaft was the single
      // brightest thing in the game. Back faces only: the column is drawn once,
      // and being the far wall it is the one the viewer would see through the
      // near opening anyway.
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false,
    });
    shaft = new THREE.Mesh(sg, sm);
    shaft.position.y = h / 2 + 0.02;
    shaft.renderOrder = 4;
    g.add(shaft);
    owned.push(sg, sm);

    const n = 10;
    const mp = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    const rnd = mulberry(0x5eed);
    for (let i = 0; i < n; i++) { seeds[i] = rnd(); mp[i * 3 + 1] = seeds[i]; }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    const mm = new THREE.PointsMaterial({
      color: 0xffc457, map: glowDiscTexture(), size: 0.13, sizeAttenuation: true,
      transparent: true, opacity: 0.62, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    motes = new THREE.Points(mg, mm);
    motes.renderOrder = 5;
    g.add(motes);
    owned.push(mg, mm);
    motes.userData = { mp, seeds, n, rnd };
  }

  stops.push(onFrame((dt, t) => {
    ring.rotation.z += dt * 0.75;
    ring.position.y = 0.24 + Math.sin(t * 1.9) * 0.045;
    // Peaks at 0.45, not 0.85. The breathe is now carried mostly by the pool's
    // scale and by the core turning underneath it, which is a change you read
    // as movement rather than as a lamp being switched on and off.
    const pulse = 0.33 + Math.sin(t * 2.6) * 0.12;
    glowMat.opacity = pulse;
    spillMat.opacity = 0.15 + Math.sin(t * 2.6) * 0.05;
    pool.scale.setScalar(0.94 + Math.sin(t * 2.6) * 0.06);
    // The vortex turns, slowly and against the ring, so the interior is alive
    // without adding a single triangle.
    core.rotation.z -= dt * 0.22;
    for (const s of shards) {
      const a = t * 0.9 + s.userData.phase;
      s.position.set(Math.cos(a) * 0.46, 0.24 + Math.sin(a * 1.7) * 0.14, Math.sin(a) * 0.46);
      s.rotation.y += dt * 1.6;
      s.rotation.x += dt * 1.1;
    }
    if (motes) {
      const { mp, seeds, n } = motes.userData;
      for (let i = 0; i < n; i++) {
        const k = (seeds[i] + t * 0.35) % 1;
        const a = seeds[i] * 40 + t * 0.8;
        mp[i * 3] = Math.cos(a) * 0.20 * (1 - k * 0.4);
        mp[i * 3 + 1] = 0.04 + k * 0.82;
        mp[i * 3 + 2] = Math.sin(a) * 0.20 * (1 - k * 0.4);
      }
      motes.geometry.attributes.position.needsUpdate = true;
    }
  }));

  return g;
}

// ---------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------

// Shared primitives, built once for the life of the page. Every prop below is
// a handful of these baked into one merged, vertex-coloured geometry, which is
// then drawn as a single InstancedMesh however many copies the board wants.
const PRIM = {};
function prim(key, make) { return PRIM[key] || (PRIM[key] = make()); }

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _nm = new THREE.Matrix3();

function part(out, geo, color, o) {
  _e.set(o.rx || 0, o.ry || 0, o.rz || 0);
  _q.setFromEuler(_e);
  _v.set(o.x || 0, o.y || 0, o.z || 0);
  _s.set(o.sx ?? o.s ?? 1, o.sy ?? o.s ?? 1, o.sz ?? o.s ?? 1);
  _m4.compose(_v, _q, _s);
  _nm.getNormalMatrix(_m4);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const idx = geo.index;
  const p = new THREE.Vector3();
  const push = (i) => {
    p.fromBufferAttribute(pos, i).applyMatrix4(_m4);
    out.pos.push(p.x, p.y, p.z);
    p.fromBufferAttribute(nor, i).applyMatrix3(_nm).normalize();
    out.nor.push(p.x, p.y, p.z);
    out.uv.push(0, 0);
    out.col.push(color.r, color.g, color.b);
  };
  if (idx) for (let i = 0; i < idx.count; i++) push(idx.getX(i));
  else for (let i = 0; i < pos.count; i++) push(i);
}

// The collectable star's gold, and the exclusion zone round it.
//
// A decorative prop that shares the stars' hue, size and hover height is not
// decoration, it is a false objective: a six-year-old told to "collect 3 stars"
// will go and chase it, fail, and have no way of knowing why. Two worlds were
// doing exactly that. So no prop is allowed inside 25 degrees of the star hue
// while it is also bright and saturated enough to read as gold -- and rather
// than trusting the tables below to stay clean, every prop colour goes through
// the guard, which rotates an offender out of the zone rather than letting it
// ship. The tables are hand-tuned so it should never actually fire.
const _hsl = {};
const STAR_GOLD_HUE = new THREE.Color(0xffc93d).getHSL(_hsl, THREE.SRGBColorSpace).h;
const STAR_HUE_GUARD = 25 / 360;
// Chroma, not HSL saturation: by the HSL formula a cream at (255,243,220) is
// "fully saturated", and a cream flower centre is nobody's idea of a
// collectable. What makes a prop read as star gold is that it is *colourful*
// and gold, so the test is max-minus-min.
const STAR_CHROMA = 0.28;

function propColor(hex, theme, blend) {
  const c = new THREE.Color(hex);
  // Props inherit some of the board's own hue and sit below its value. Applied
  // only to the manufactured worlds: the tech plates and storm rubble were
  // near-white desaturated greys, which on a saturated blue or violet board
  // read as the brightest thing in frame after the stars and the portal, and
  // pulled the eye straight off the path.
  if (blend > 0) c.lerp(new THREE.Color(theme.grass), blend).multiplyScalar(1 - blend * 0.55);
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  const s = c.clone().convertLinearToSRGB();
  const chroma = Math.max(s.r, s.g, s.b) - Math.min(s.r, s.g, s.b);
  let d = _hsl.h - STAR_GOLD_HUE;
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
  if (Math.abs(d) < STAR_HUE_GUARD && chroma > STAR_CHROMA && _hsl.l > 0.42) {
    const h = STAR_GOLD_HUE + (d < 0 ? -STAR_HUE_GUARD : STAR_HUE_GUARD);
    c.setHSL((h + 1) % 1, _hsl.s, _hsl.l, THREE.SRGBColorSpace);
  }
  return c;
}

// Returns an array of { geo, glow, weight } prop variants for a theme.
function propVariants(kind, theme) {
  const cone = () => prim('cone5', () => new THREE.ConeGeometry(1, 1, 5));
  const cone4 = () => prim('cone4', () => new THREE.ConeGeometry(1, 1, 4));
  const ico = () => prim('ico', () => new THREE.IcosahedronGeometry(1, 0));
  const cyl = () => prim('cyl6', () => new THREE.CylinderGeometry(1, 1, 1, 6));
  const box = () => prim('box', () => new THREE.BoxGeometry(1, 1, 1));
  const sph = () => prim('sph', () => new THREE.IcosahedronGeometry(1, 1));
  const out = [];
  const blend = kind === 'tech' ? 0.45 : (kind === 'storm' ? 0.34 : 0);
  const C = (h) => propColor(h, theme, blend);

  const add = (glow, weight, build) => {
    const buf = newBuf();
    build(buf);
    out.push({ geo: toGeometry(buf), glow, weight });
  };

  if (kind === 'meadow') {
    // Apricot rather than the old buttercup yellow, and a cream centre rather
    // than a golden one: both were within a couple of degrees of the star's
    // hue, and a golden five-lobed thing at ankle height on a green tile is a
    // collectable as far as a six-year-old is concerned.
    for (const petal of [0xff7ab8, 0xff8a5a, 0xfff4f0]) {
      add(false, 1, (b) => {
        part(b, cyl(), C(0x4f9c46), { y: 0.16, sx: 0.022, sy: 0.32, sz: 0.022 });
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          part(b, ico(), C(petal), {
            x: Math.cos(a) * 0.058, y: 0.34, z: Math.sin(a) * 0.058, s: 0.052,
          });
        }
        part(b, ico(), C(0xfff3dc), { y: 0.365, s: 0.036 });
      });
    }
    add(false, 2.4, (b) => { // grass tuft
      for (let i = 0; i < 4; i++) {
        const a = i * 1.9;
        part(b, cone(), C(i % 2 ? 0x63bf58 : 0x4d9b45), {
          x: Math.cos(a) * 0.06, y: 0.13 + (i % 2) * 0.05, z: Math.sin(a) * 0.06,
          sx: 0.055, sy: 0.28 + (i % 2) * 0.12, sz: 0.055, rz: (i - 1.5) * 0.16,
        });
      }
    });
    add(false, 1.1, (b) => { // toadstool
      part(b, cyl(), C(0xfbf1e0), { y: 0.09, sx: 0.032, sy: 0.18, sz: 0.032 });
      part(b, sph(), C(0xe8574f), { y: 0.17, sx: 0.105, sy: 0.075, sz: 0.105 });
    });
    add(false, 1.2, (b) => { // field stone
      part(b, ico(), C(0x9a8f7d), { y: 0.06, sx: 0.13, sy: 0.09, sz: 0.11, ry: 0.6 });
    });
  } else if (kind === 'crystal') {
    for (const [tallest, hue] of [[0.46, 0x6b4fd6], [0.32, 0x2f9fd8], [0.38, 0x9350d8]]) {
      add(true, 1, (b) => {
        for (let i = 0; i < 3; i++) {
          const a = i * 2.1;
          part(b, cone4(), C(hue), {
            x: Math.cos(a) * 0.07, y: (tallest * (0.55 + i * 0.22)) / 2,
            z: Math.sin(a) * 0.07,
            sx: 0.055 - i * 0.008, sy: tallest * (0.55 + i * 0.22),
            sz: 0.055 - i * 0.008, rz: (i - 1) * 0.22, ry: a,
          });
        }
      });
    }
    add(false, 1.3, (b) => { // dark cavern stone the crystals grow out of
      part(b, ico(), C(0x5a5183), { y: 0.05, sx: 0.15, sy: 0.08, sz: 0.13, ry: 1.1 });
      part(b, ico(), C(0x6a5f94), { x: 0.09, y: 0.04, z: 0.05, s: 0.07 });
    });
    add(true, 0.8, (b) => { // glow shroom
      part(b, cyl(), C(0x7d74ad), { y: 0.09, sx: 0.028, sy: 0.18, sz: 0.028 });
      part(b, sph(), C(0x2fbfa4), { y: 0.18, sx: 0.09, sy: 0.062, sz: 0.09 });
    });
  } else if (kind === 'canyon') {
    add(false, 1.4, (b) => { // saguaro
      part(b, cyl(), C(0x4f8f4a), { y: 0.22, sx: 0.062, sy: 0.44, sz: 0.062 });
      part(b, sph(), C(0x4f8f4a), { y: 0.44, s: 0.062 });
      part(b, cyl(), C(0x477f43), { x: 0.10, y: 0.26, sx: 0.038, sy: 0.16, sz: 0.038, rz: -1.1 });
      part(b, cyl(), C(0x477f43), { x: 0.13, y: 0.32, sx: 0.038, sy: 0.14, sz: 0.038 });
    });
    add(false, 1.6, (b) => { // cairn
      part(b, ico(), C(0x8d5230), { y: 0.055, sx: 0.135, sy: 0.055, sz: 0.12, ry: 0.4 });
      part(b, ico(), C(0xa9673d), { y: 0.145, sx: 0.10, sy: 0.05, sz: 0.095, ry: 1.4 });
      part(b, ico(), C(0xc98a52), { y: 0.215, sx: 0.065, sy: 0.04, sz: 0.062, ry: 2.5 });
    });
    add(false, 1.5, (b) => { // dry scrub
      for (let i = 0; i < 5; i++) {
        const a = i * 1.3;
        part(b, cone(), C(i % 2 ? 0x8d7b44 : 0x6f6335), {
          x: Math.cos(a) * 0.08, y: 0.10, z: Math.sin(a) * 0.08,
          sx: 0.05, sy: 0.22, sz: 0.05, rz: (i - 2) * 0.26,
        });
      }
    });
    add(false, 1.0, (b) => { // weathered spire
      part(b, cone(), C(0xb06a3a), { y: 0.19, sx: 0.09, sy: 0.38, sz: 0.09, ry: 0.5 });
    });
  } else if (kind === 'tech') {
    // The old hex bolt was a flat-topped six-sided *disc* the size of a coin,
    // sitting where a collectable sits. Nothing in the set dressing is allowed
    // to be a disc or a torus any more, for the same reason nothing is allowed
    // to be star gold: those are the collectables' shapes, and a shape a child
    // has been taught to chase must not appear on a tile as scenery. It is now
    // an anchor bracket -- clearly a bolted-down bit of the world.
    add(false, 1.5, (b) => { // anchor bracket
      part(b, box(), C(0x8ea6c6), { y: 0.035, sx: 0.19, sy: 0.07, sz: 0.13, ry: 0.5 });
      part(b, box(), C(0x6d84a6), { x: -0.04, y: 0.13, sx: 0.08, sy: 0.19, sz: 0.11, ry: 0.5, rz: -0.22 });
    });
    add(true, 1.2, (b) => { // beacon
      part(b, cyl(), C(0x8195b5), { y: 0.13, sx: 0.028, sy: 0.26, sz: 0.028 });
      part(b, sph(), C(0x8ef2ff), { y: 0.29, s: 0.055 });
    });
    add(false, 1.4, (b) => { // conduit run
      part(b, box(), C(0x7d92b4), { y: 0.045, sx: 0.42, sy: 0.09, sz: 0.10 });
      part(b, box(), C(0x5f7396), { y: 0.095, sx: 0.36, sy: 0.02, sz: 0.05 });
    });
    add(false, 1.0, (b) => { // vent plate
      // Raised into a real kerbed block rather than a 4cm-thick decal. Flat on
      // the tile it had no lit top and no visible sides, so it read as a white
      // parallelogram drawn *on* the grass at a perspective that did not match
      // the grass -- which is exactly what an unlit decal is.
      part(b, box(), C(0x8ea6c6), { y: 0.045, sx: 0.28, sy: 0.09, sz: 0.28, ry: 0.4 });
      for (let i = 0; i < 3; i++) {
        part(b, box(), C(0x5c718f), { x: (i - 1) * 0.075, y: 0.10, sx: 0.038, sy: 0.03, sz: 0.20, ry: 0.4 });
      }
    });
  } else { // storm
    add(false, 1.5, (b) => { // broken pillar
      part(b, box(), C(0x99a4b6), { y: 0.16, sx: 0.11, sy: 0.32, sz: 0.11, rz: 0.16, ry: 0.5 });
      part(b, ico(), C(0x7d8899), { x: 0.10, y: 0.05, s: 0.075, ry: 1.2 });
    });
    add(true, 1.0, (b) => { // charged shard
      part(b, ico(), C(0x8c97a8), { y: 0.06, sx: 0.12, sy: 0.07, sz: 0.11 });
      part(b, cone4(), C(0xff7b6b), { y: 0.24, sx: 0.055, sy: 0.34, sz: 0.055, rz: 0.2 });
    });
    add(false, 1.8, (b) => { // rubble
      part(b, ico(), C(0x8b95a5), { y: 0.055, sx: 0.13, sy: 0.075, sz: 0.11, ry: 0.9 });
      part(b, ico(), C(0xa0abbc), { x: 0.11, y: 0.035, z: 0.06, s: 0.058, ry: 2.1 });
    });
    add(false, 1.1, (b) => { // toppled marker stone
      // A thin leaning mast was the first idea here and it rendered as a
      // one-pixel black hair on the tile -- an artefact, not a prop. Nothing
      // in the set dressing is allowed to be thinner than about 6cm.
      part(b, box(), C(0x8a95a6), { y: 0.13, sx: 0.085, sy: 0.26, sz: 0.085, rz: 0.34, ry: 0.7 });
      part(b, box(), C(0xa2adbe), { x: 0.11, y: 0.035, sx: 0.13, sy: 0.06, sz: 0.10, ry: 1.9 });
    });
  }
  return out;
}

// Placement. Two rules do all the work:
//   1. A prop only ever goes on a tile with an exposed edge, and only ever on
//      that edge. Bloop rolls down the middle of the board, so nothing the
//      player has to see is ever behind a decoration.
//   2. Density comes from a smooth seeded field rather than a flat coin flip,
//      so props gather into thickets and leave clearings. A uniform 22% scatter
//      is the single most recognisable signature of generated set dressing.
function placeProps(level, rng) {
  const spots = [];
  const field = (x, y) => {
    const a = Math.sin(x * 1.7 + y * 0.9) + Math.sin(x * 0.6 - y * 1.9) + Math.sin((x + y) * 1.1);
    return (a / 3 + 1) / 2;
  };
  for (let y = 0; y < level.rows; y++) {
    for (let x = 0; x < level.cols; x++) {
      const t = level.tiles[y][x];
      if (!t || t.kind !== 'path') continue;
      if (x === level.start.x && y === level.start.y) continue;
      const edges = [];
      for (const [ox, oy] of NEIGHBOURS) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= level.cols || ny >= level.rows || !level.tiles[ny][nx]) {
          edges.push([ox, oy]);
        }
      }
      if (!edges.length) continue;
      const density = 0.16 + field(x, y) * 0.68;
      const n = rng() < density ? 1 : 0;
      if (!n) continue;
      const [ox, oy] = edges[(rng() * edges.length) | 0];
      const p = gridToWorld(x, y, level);
      // Pushed out to the rim, then jittered along it. 0.33 from centre keeps
      // the prop clear of both the walking line and the tile's own bevel.
      const along = (rng() - 0.5) * 0.5;
      spots.push({
        x: p.x + ox * 0.33 + oy * along,
        z: p.z + oy * 0.33 + ox * along,
        scale: 0.88 + rng() * 0.62,
        rot: rng() * Math.PI * 2,
        pick: rng(),
        shade: 0.86 + rng() * 0.28,
      });
    }
  }
  return spots;
}

function buildProps(level, theme, rng, shadowMat, owned) {
  const detail = flags().detail;
  const variants = propVariants(theme.deco, theme);
  const sun = sunOffset(theme);
  const spots = placeProps(level, rng).filter(() => rng() < Math.min(1, 0.55 + detail * 0.45));
  const meshes = [];
  if (!spots.length) {
    for (const v of variants) v.geo.dispose();
    return meshes;
  }

  const totalWeight = variants.reduce((s, v) => s + v.weight, 0);
  const buckets = variants.map(() => []);
  for (const s of spots) {
    let pick = s.pick * totalWeight;
    let i = 0;
    while (i < variants.length - 1 && pick > variants[i].weight) { pick -= variants[i].weight; i++; }
    buckets[i].push(s);
  }

  const dull = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0.05,
  });
  const glow = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.35, metalness: 0.0,
    emissive: new THREE.Color(theme.rim), emissiveIntensity: 0.42,
  });
  owned.push(dull, glow);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const s3 = new THREE.Vector3();
  const col = new THREE.Color();

  variants.forEach((variant, i) => {
    const list = buckets[i];
    if (!list.length) { variant.geo.dispose(); return; }
    const inst = new THREE.InstancedMesh(variant.geo, variant.glow ? glow : dull, list.length);
    inst.castShadow = false;
    inst.receiveShadow = true;
    list.forEach((sp, k) => {
      e.set(0, sp.rot, 0);
      q.setFromEuler(e);
      v.set(sp.x, 0, sp.z);
      s3.setScalar(sp.scale);
      m.compose(v, q, s3);
      inst.setMatrixAt(k, m);
      // Per-instance value jitter on top of the baked vertex colours. Two
      // identical flowers side by side is the other giveaway of generated
      // dressing, and this costs one float per instance.
      col.setScalar(sp.shade);
      inst.setColorAt(k, col);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    meshes.push(inst);
    owned.push(variant.geo, inst);
  });

  // One instanced disc under the lot, so every prop is attached to the ground
  // rather than hovering a millimetre above it.
  const discGeo = new THREE.PlaneGeometry(0.34, 0.34);
  const discs = new THREE.InstancedMesh(discGeo, shadowMat, spots.length);
  discs.renderOrder = 2;
  // Props stand *on* the tile, so unlike the floating collectables their disc
  // cannot simply be moved down-sun -- that would detach it from the thing
  // casting it. It is leaned instead: displaced by the sun ray applied to half
  // the prop's height, which keeps the disc overlapping the base while pointing
  // the same way as every real shadow in the frame.
  const lean = 0.5 * 0.22;
  spots.forEach((sp, k) => {
    e.set(-Math.PI / 2, 0, sp.rot);
    q.setFromEuler(e);
    v.set(sp.x + sun.x * lean * sp.scale, 0.012, sp.z + sun.z * lean * sp.scale);
    s3.setScalar(sp.scale * 0.9);
    m.compose(v, q, s3);
    discs.setMatrixAt(k, m);
  });
  discs.instanceMatrix.needsUpdate = true;
  meshes.push(discs);
  owned.push(discGeo, discs);

  return meshes;
}

// ---------------------------------------------------------------------------
// Level build
// ---------------------------------------------------------------------------

export function buildLevel(level, worldNum) {
  disposeLevel();
  // Safe here and nowhere else: the materials that were sampling these maps
  // were disposed by disposeLevel() one line ago.
  retireStaleMaps();

  const theme = applyTheme(worldNum);
  const themeKey = TOP_KIND[worldNum] === undefined ? 0 : worldNum;
  const scene = getScene();
  const group = new THREE.Group();
  const itemMeshes = new Map();
  const stops = [];
  const owned = [];
  const rng = mulberry(level.rows * 31 + level.cols * 7 + worldNum * 101);

  const board = buildBoard(level, theme, themeKey, owned);
  for (const mesh of board.meshes) group.add(mesh);

  const shadowMat = shadowMaterial(theme, owned);
  const sun = sunOffset(theme);
  const discGeo = new THREE.PlaneGeometry(1, 1);
  owned.push(discGeo);

  // Start pad: an inlaid ring rather than the old opaque white disc, which
  // covered the tile bloop is standing on and fought with bloop's own belly.
  {
    const p = gridToWorld(level.start.x, level.start.y, level);
    // A flat annulus, not a torus: bloop's rolling radius is 0.38, so any ring
    // with thickness sat *inside* bloop and read as a collar round its neck.
    const ringGeo = new THREE.RingGeometry(0.40, 0.465, 34);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false, fog: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, 0.016, p.z);
    ring.renderOrder = 2;
    group.add(ring);
    const halo = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff, map: glowDiscTexture(), transparent: true, opacity: 0.16,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(p.x, 0.014, p.z);
    halo.scale.setScalar(0.9);
    group.add(halo);
    owned.push(ringGeo, ringMat, halo.material);
  }

  const portalPos = gridToWorld(level.exit.x, level.exit.y, level);
  const portal = buildPortal(portalPos, stops, owned);
  group.add(portal);

  // ---- collectables --------------------------------------------------------
  const starGeo = starGeometry();
  const starMat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.28, metalness: 0.15,
    emissive: 0xffb02e, emissiveIntensity: 0.30,
  });
  const coinGeo = coinGeometry();
  const coinMat = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.24, metalness: 0.55,
    emissive: 0xb97c10, emissiveIntensity: 0.18,
  });
  owned.push(starGeo, starMat, coinGeo, coinMat);

  const addItem = (gx, gy, geo, mat, baseY, kind) => {
    const p = gridToWorld(gx, gy, level);
    const pivot = new THREE.Group();
    pivot.position.set(p.x, baseY, p.z);
    const m = new THREE.Mesh(geo, mat);
    // The camera looks down at 53 degrees, so a star standing bolt upright is
    // always seen edge-on-ish from above. Leaning it back inside the pivot
    // turns its face towards the player without changing how it swings.
    if (kind === 'star') m.rotation.x = -0.46;
    pivot.add(m);
    // No cast shadow: see the note above shadowMaterial(). Displaced down-sun
    // by the object's hover height, so a star's disc lands where a star's real
    // shadow would -- the island's tiles beside it are casting shadow-map
    // shadows with exactly that offset, and the two systems have to agree.
    const disc = new THREE.Mesh(discGeo, shadowMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(p.x + sun.x * baseY, 0.013, p.z + sun.z * baseY);
    disc.renderOrder = 2;
    group.add(pivot, disc);
    pivot.userData = { baseY, disc, kind, phase: rng() * Math.PI * 2 };
    itemMeshes.set(`${gx},${gy}`, pivot);
  };

  for (const s of level.stars) addItem(s.x, s.y, starGeo, starMat, 0.50, 'star');
  for (const c of level.coins) addItem(c.x, c.y, coinGeo, coinMat, 0.46, 'coin');

  stops.push(onFrame((dt, t) => {
    for (const m of itemMeshes.values()) {
      const d = m.userData;
      const bob = Math.sin(t * 2.2 + d.phase) * 0.075;
      m.position.y = d.baseY + bob;
      if (d.kind === 'star') {
        // A bounded sway, not a spin. The star is a real solid now and reads
        // from any angle, but keeping its face turned towards the player is
        // still the difference between "a star" and "a shape" for a
        // six-year-old glancing at a tablet.
        m.rotation.y = Math.sin(t * 1.05 + d.phase) * 0.45;
        m.rotation.z = Math.sin(t * 0.83 + d.phase * 1.7) * 0.11;
      } else {
        m.rotation.y += dt * 2.0;
      }
      // The contact shadow grows and fades as its owner rises, which is what
      // sells the float. Scale, not opacity alone: a disc that only fades
      // looks like a light going out.
      const k = 1 - (bob + 0.075) / 0.30;
      d.disc.scale.setScalar((d.kind === 'star' ? 0.44 : 0.34) * (0.86 + k * 0.22));
    }
  }));

  for (const mesh of buildProps(level, theme, rng, shadowMat, owned)) group.add(mesh);

  scene.add(group);

  const boardRadius = Math.hypot(level.cols, level.rows) / 2;
  const scenery = createScenery(scene, themeKey, theme, boardRadius);

  // The vertical extent the camera has to fit, measured from what was actually
  // built rather than assumed.
  //
  //   yHi  the top of a star at the peak of its bob (0.50 + 0.075 + its own
  //        0.30 half-height), which is the highest thing on the board a player
  //        has to see; the portal's column of light reaches about the same.
  //   yLo  the real bottom of the island's keel. The hanging spikes go lower
  //        still and are deliberately *not* included -- they are silhouette,
  //        not information, and budgeting for them would push the whole board
  //        up into the top of the frame to make room for decoration.
  //
  // Both are relative to the board's own surface at y = 0. Passing them is
  // what stops a deep-keeled board sliding down under the program trays.
  frameView(new THREE.Vector3(0, 0, 0), level.cols, level.rows, {
    instant: false, yLo: board.keelY, yHi: 0.95,
  });

  current = {
    group, itemMeshes, portal, level,
    dispose() {
      stops.forEach((s) => s());
      scenery.dispose();
      scene.remove(group);
      // Textures are shared and cached by theme, so they are deliberately not
      // in `owned`; everything else allocated for this level is, and the level
      // is rebuilt on every reset.
      for (const o of owned) o.dispose?.();
    },
  };
  return current;
}

export function getCurrentWorldModel() { return current; }

export function disposeLevel() {
  if (current) { current.dispose(); current = null; }
}

export function removeItemAt(x, y) {
  if (!current) return null;
  const key = `${x},${y}`;
  const m = current.itemMeshes.get(key);
  if (m) {
    current.group.remove(m);
    if (m.userData.disc) current.group.remove(m.userData.disc);
    current.itemMeshes.delete(key);
  }
  return m;
}
