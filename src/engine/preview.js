// Draws a "dry run" of the player's program as a flowing ribbon over the board,
// so kids can check their logic before committing to a real run.
// Non-destructive: never moves the real bloop, never records stats.
//
// This is the feature that teaches prediction, so it is built to be read at a
// glance rather than merely to be visible:
//
//   * one continuous ribbon with rounded corners, not a line of dots -- a dot
//     path has to be traced by eye, a ribbon is taken in as a single shape;
//   * chevrons marching along it, so the *direction* of travel is explicit and
//     not something to be inferred from the shape of the maze;
//   * a crest sweeping start -> end on a loop, which says "this is the order
//     things happen in";
//   * a marker on every condition tile that fires, with a white core and the
//     tile's own colour as an outer glow, because "the pink tile turned me" is
//     the single hardest idea in the game -- and because a ring drawn in the
//     tile's colour on top of that tile is the one colour guaranteed to have
//     no contrast against it;
//   * a gold chevron pointing into the portal when the program reaches the
//     exit, amber and a closing beacon when it stops short. The ribbon stops a
//     tile short of the exit rather than painting over it: the glowing gold
//     donut is the cue a child has been taught to look for since level one, and
//     pressing Preview must not be the thing that takes it away.
import * as THREE from 'three';
import { onFrame, getScene, TILE_COLORS } from './renderer.js';
import { gridToWorld } from './world.js';
import { ringTexture } from './fx.js';

let current = null;
// One flat quad shared by every marker in every preview. Markers differ by
// material (colour, opacity, blending), never by geometry.
let markerGeo = null;
// One chevron outline, shared the same way. Points along +Z, unit scale.
let chevronGeo = null;

const PATH_Y = 0.06;      // clear of the tile tops, well under the collectables
const HALF_W = 0.16;      // half the ribbon width, in tiles
// Corner fillet radius. Must match animator.js: the preview's whole job is to
// promise the curve the real roll will take. It is also what keeps the ribbon
// from folding over itself through a turn -- the arc's radius of curvature is
// exactly CORNER_R everywhere, so as long as CORNER_R > HALF_W the inner edge
// of the offset ribbon still has room to be an arc rather than a crease.
const CORNER_R = 0.34;
const SEG = 14;           // centreline samples per tile
// Chevron pitch in *world units*, not per segment. Spacing them per segment is
// how the first pass ended up with 120/80/160px on one straight run and
// 180/200px on the next: a 2:1 density difference along one path, which reads
// as two different speeds.
const CHEVRON_PITCH = 0.72;
// Gold, matching the exit annulus and every coin and star in the game.
const GOLD = new THREE.Color(0xffc23d);

// Green reaches the exit, amber stops short. Each pairs a saturated body
// colour with a much darker rim: over a bright canyon floor or a lime meadow
// the body alone is not enough separation, and the rim is what keeps the
// ribbon's edge crisp instead of letting it bleed into the ground.
const WIN_COL = new THREE.Color(0x3fd873);
const WIN_DARK = new THREE.Color(0x12693a);
const SHORT_COL = new THREE.Color(0xffab21);
const SHORT_DARK = new THREE.Color(0x8f4708);

const RIBBON_VERT = `
attribute float au;
attribute float av;
varying float vU;
varying float vV;
void main() {
  vU = au;
  vV = av;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// The ribbon's value is *fixed*. Nothing here is allowed to be a function of
// what the ribbon happens to be crossing: the first pass let a bright sweeping
// crest push the fill to 70% white at 0.86 alpha, which over a saturated
// magenta condition tile came out near white -- so the same overlay read as
// clean saturated green on the teal tiles and as a colourless smear two tiles
// later. A path a child is meant to trace cannot change colour along its
// length. So the crest and the chevrons now only *modulate* a value that is
// otherwise constant, and a dark rim carries the separation instead.
const RIBBON_FRAG = `
uniform float uT;
uniform float uLen;
uniform vec3 uCol;
uniform vec3 uDark;
varying float vU;
varying float vV;

void main() {
  float a = abs(vV);

  // Chevrons, spaced on cumulative arc length so the pitch is identical on
  // every run of every path. Skewing the phase by |vV| tilts each band into a V
  // whose tip leads, so the ribbon states its direction without an arrowhead
  // model. No decay along the path: the destination end used to be the
  // faintest, which is precisely backwards.
  float f = fract(vU / ${CHEVRON_PITCH.toFixed(3)} - uT * 0.95 + a * 0.26);
  float arrow = smoothstep(0.34, 0.17, f) * smoothstep(0.0, 0.08, f);

  // One crest sweeping the whole path on a loop: the order of events.
  float cp = mod(uT * 0.5, 1.0) * (uLen + 1.6) - 0.8;
  float d = (vU - cp) * 1.1;
  float crest = exp(-d * d);

  // A dark rim right at the edge -- an outline, not a gradient. This is what
  // holds the ribbon's shape over a lime meadow and over a canyon floor alike.
  float rim = smoothstep(0.52, 0.92, a);
  float edge = 1.0 - smoothstep(0.90, 1.0, a);

  vec3 col = mix(uCol, uDark, rim);
  col = mix(col, vec3(1.0), min(1.0, arrow * 0.62 + crest * 0.22));
  float alpha = edge * (0.72 + arrow * 0.10 + crest * 0.06);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function clearPreviewPath() {
  if (current) { current.dispose(); current = null; }
}

// Position along the tile-centre polyline at arc length `s` (in tiles), with
// the corners rounded. Identical in spirit to the animator's path so the
// prediction and the run trace the same curve -- if the preview cut a corner
// the real roll did not, the feature would be teaching the wrong thing.
function pathPoint(P, dirs, corner, s, out) {
  const d = P.length - 1;
  const k = Math.min(Math.max(Math.floor(s), 0), d - 1);
  const j = Math.round(s);
  if (j >= 1 && j <= d - 1 && corner[j] && Math.abs(s - j) < CORNER_R) {
    // A circular arc tangent to both legs -- the same fillet animator.js uses.
    // The old smootherstep blend passed through the corner vertex itself, so
    // the "rounded" corner still had a curvature spike at its apex; offsetting
    // a 0.32-wide ribbon along that folded the inner edge back over itself and
    // double-composited into the bright diagonal seam visible at every turn.
    const th = ((s - j + CORNER_R) / (2 * CORNER_R)) * (Math.PI / 2);
    const c = Math.cos(th), sn = Math.sin(th);
    const d0 = dirs[j - 1], d1 = dirs[j];
    return out.set(
      P[j].x + CORNER_R * (-d0.x + d1.x + sn * d0.x - c * d1.x),
      P[j].y,
      P[j].z + CORNER_R * (-d0.z + d1.z + sn * d0.z - c * d1.z),
    );
  }
  return out.copy(P[k]).addScaledVector(dirs[k], s - k);
}

// level: parsed level, result: runProgram() output.
export function showPreviewPath(level, result) {
  clearPreviewPath();
  const scene = getScene();
  if (!scene) return;
  if (!markerGeo) markerGeo = new THREE.PlaneGeometry(1, 1);
  if (!chevronGeo) {
    // A solid arrowhead band, apex on +Y, one unit across. Shared by every
    // preview for the life of the page, like markerGeo.
    const s = new THREE.Shape();
    s.moveTo(-0.50, -0.05);
    s.lineTo(0, 0.45);
    s.lineTo(0.50, -0.05);
    s.lineTo(0.50, -0.35);
    s.lineTo(0, 0.15);
    s.lineTo(-0.50, -0.35);
    s.closePath();
    chevronGeo = new THREE.ShapeGeometry(s);
  }
  const ringTex = ringTexture();

  const group = new THREE.Group();
  const stops = [];
  const owned = [];   // everything this preview must dispose

  // Ordered tile path: start, then every tile the bloop rolls onto.
  const grid = [{ x: level.start.x, y: level.start.y }];
  const turns = [];
  for (const s of result.steps) {
    if (s.type === 'move') grid.push({ x: s.to.x, y: s.to.y });
    else if (s.type === 'turn') turns.push(s);
  }

  const win = result.win;
  const col = win ? WIN_COL : SHORT_COL;
  const dark = win ? WIN_DARK : SHORT_DARK;

  const P = grid.map((p) => {
    const w = gridToWorld(p.x, p.y, level);
    return new THREE.Vector3(w.x, PATH_Y, w.z);
  });
  const d = P.length - 1;

  // --- the ribbon ------------------------------------------------------------
  const dirs = [];
  const corner = [];
  const cur = new THREE.Vector3();
  // How far along the tile polyline the ribbon actually stops. A winning path
  // hands the last tile back to the exit portal: the ribbon ends a tile short
  // and a gold chevron carries the eye the rest of the way in.
  let sEnd = d;
  if (d >= 1) {
    for (let k = 0; k < d; k++) {
      dirs.push(new THREE.Vector3(
        Math.sign(P[k + 1].x - P[k].x), 0, Math.sign(P[k + 1].z - P[k].z),
      ));
    }
    for (let k = 0; k <= d; k++) {
      corner.push(k > 0 && k < d && dirs[k - 1].distanceToSquared(dirs[k]) > 1e-6);
    }
    if (win) sEnd = Math.max(d * 0.45, d - 0.92);

    // Sample the centreline, then reparameterise it by *cumulative arc length*.
    // Everything downstream -- chevron pitch, the sweeping crest, the end taper
    // -- is then measured in world units and is identical on every run of every
    // path, instead of being measured in polyline parameter, which compresses
    // through every fillet and gave one straight run twice the chevron density
    // of the next.
    const n = Math.max(2, Math.round(sEnd * SEG) + 1);
    const h = sEnd / (n - 1);
    const pts = [];
    const len = [0];
    for (let i = 0; i < n; i++) {
      pathPoint(P, dirs, corner, i * h, cur);
      pts.push(cur.clone());
      if (i > 0) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
    }
    const total = len[n - 1];

    const pos = new Float32Array(n * 2 * 3);
    const au = new Float32Array(n * 2);
    const av = new Float32Array(n * 2);
    const idx = [];
    const tan = new THREE.Vector3();
    const side = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const p = pts[i];
      // Central difference on the sampled points: a genuine tangent to the
      // curve that was built, not a re-evaluation that can disagree with it.
      tan.subVectors(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]);
      if (tan.lengthSq() < 1e-12) tan.copy(dirs[0]);
      // Perpendicular in the ground plane. Constant width: a ribbon that
      // narrows through a turn is exactly where a child needs it widest.
      side.set(-tan.z, 0, tan.x).normalize().multiplyScalar(HALF_W);
      // Pinch the two ends over a fixed 0.3 units so the ribbon eases in and
      // out instead of stopping on a cut-off rectangle edge.
      const fromEnd = Math.min(len[i], total - len[i]);
      const taper = Math.min(1, fromEnd / 0.3) * 0.55 + 0.45;
      const o = i * 6;
      pos[o] = p.x + side.x * taper; pos[o + 1] = p.y; pos[o + 2] = p.z + side.z * taper;
      pos[o + 3] = p.x - side.x * taper; pos[o + 4] = p.y; pos[o + 5] = p.z - side.z * taper;
      au[i * 2] = len[i]; au[i * 2 + 1] = len[i];
      av[i * 2] = 1; av[i * 2 + 1] = -1;
      if (i < n - 1) {
        const q = i * 2;
        idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('au', new THREE.BufferAttribute(au, 1));
    geo.setAttribute('av', new THREE.BufferAttribute(av, 1));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: 0 }, uLen: { value: total },
        uCol: { value: col.clone() }, uDark: { value: dark.clone() },
      },
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      // Stated rather than defaulted, because the whole point of the fragment
      // shader above is that this overlay's value does not depend on what is
      // underneath it.
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ribbon = new THREE.Mesh(geo, mat);
    ribbon.renderOrder = 6;
    group.add(ribbon);
    owned.push(geo, mat);
    stops.push(onFrame((dt, t) => { mat.uniforms.uT.value = t; }));
  }

  // --- markers ---------------------------------------------------------------
  // A flat ring quad. `pulse` is called every frame with the shared clock.
  function marker(at, colour, size, opacity, blending, order) {
    if (!ringTex) return new THREE.Object3D(); // renderer not up yet; ribbon only
    const mat = new THREE.MeshBasicMaterial({
      map: ringTex, color: colour, transparent: true, opacity,
      depthWrite: false, blending, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(markerGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(at.x, PATH_Y + 0.005, at.z);
    m.scale.setScalar(size);
    m.renderOrder = order;
    group.add(m);
    owned.push(mat);
    return m;
  }

  // A flat chevron lying on the board, pointing along `dir`. Real geometry
  // rather than a textured quad: at this size an arrowhead's whole job is its
  // edges, and a 128px alpha mask under a mip chain does not have them.
  function chevron(at, dir, colour, size, opacity, order) {
    const mat = new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity,
      depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(chevronGeo, mat);
    m.rotation.x = -Math.PI / 2;
    // chevronGeo points along +Y in its own plane, which lands on -Z once the
    // quad is laid flat; this spins it round the world Y to face `dir`.
    m.rotation.z = Math.atan2(-dir.x, -dir.z);
    m.position.set(at.x, PATH_Y + 0.01, at.z);
    m.scale.setScalar(size);
    m.renderOrder = order;
    group.add(m);
    owned.push(mat);
    return m;
  }

  // Start: a quiet white ring. It is the only marker that never animates --
  // "you begin here" is not news, and a pulsing one would compete with the end.
  marker(P[0], 0xffffff, 0.62, 0.4, THREE.NormalBlending, 7);

  // Condition tiles that actually fire. A white core with the tile's colour as
  // an outer glow, rather than a solid ring in the tile's own colour: a cyan
  // ring on the cyan tile and a magenta ring on the magenta tile is the one
  // pairing guaranteed to have the least contrast available, and this marker
  // carries the hardest idea in the game. The white band is what makes it
  // visible; the coloured halo just outside it is what says *which* tile.
  //
  // Both are annuli sized so their bright bands sit outside the ribbon's
  // half-width, leaving the tile's centre -- and the chevron marching through
  // it -- uncovered. Deduped: a loop can cross the same condition tile a dozen
  // times, and a dozen coincident rings would just be one very bright ring.
  const seenTurn = {};
  for (let i = 0; i < turns.length; i++) {
    const s = turns[i];
    const key = `${s.at.x},${s.at.y}`;
    if (seenTurn[key]) continue;
    seenTurn[key] = true;
    const w = gridToWorld(s.at.x, s.at.y, level);
    const tint = TILE_COLORS[s.color] || 0xffffff;
    const glow = marker(w, tint, 1.02, 0.7, THREE.AdditiveBlending, 8);
    const core = marker(w, 0xffffff, 0.86, 0.95, THREE.NormalBlending, 9);
    if (!core.material || !glow.material) continue;
    const ph = (i * 0.37) % 1;
    stops.push(onFrame((dt, t) => {
      const k = (t * 1.1 + ph) % 1;
      // The pair breathes together, so it always reads as one marker.
      core.scale.setScalar(0.80 + k * 0.20);
      glow.scale.setScalar(0.96 + k * 0.30);
      core.material.opacity = 0.95 * (0.45 + 0.55 * (1 - k) * (1 - k));
      glow.material.opacity = 0.7 * (1 - k) * (1 - k);
    }));
  }

  const end = P[d];
  if (win && d >= 1) {
    // The exit already *is* the destination marker: a glowing gold annulus the
    // child has been reading since level one. Repainting it green -- ring, fill
    // and beacon -- took that cue away at the exact moment the preview was
    // supposed to confirm it. So the portal is left completely alone, and the
    // arrival is stated by a gold chevron in the gap the ribbon left, pointing
    // in. Gold, because that is the colour of the thing it points at.
    const dirEnd = dirs.length ? dirs[dirs.length - 1] : new THREE.Vector3(1, 0, 0);
    const gap = new THREE.Vector3();
    pathPoint(P, dirs, corner, Math.min(d, (sEnd + d) / 2), gap);
    const chev = chevron(gap, dirEnd, GOLD, 0.62, 0.95, 10);
    if (chev.material) stops.push(onFrame((dt, t) => {
      // Slides towards the portal and fades as it arrives, on a loop: an
      // unmistakable "in there", with none of it landing on the portal itself.
      const k = (t * 1.15) % 1;
      chev.position.x = gap.x + dirEnd.x * (k * 0.34 - 0.1);
      chev.position.z = gap.z + dirEnd.z * (k * 0.34 - 0.1);
      chev.scale.setScalar(0.62 * (1 + k * 0.14));
      chev.material.opacity = 0.95 * Math.min(1, k * 5) * (1 - k) * (1 - k) * 1.9;
    }));
  } else if (!win) {
    // Stopping short lands on an ordinary tile, so there is no identity to
    // protect: a steady amber ring plus a beacon closing *inward*. The inward
    // motion is the point -- it is a different motion from the winning case,
    // so the outcome reads even to a child who cannot separate the two hues.
    const ring = marker(end, col, 0.9, 0.95, THREE.NormalBlending, 9);
    const beacon = marker(end, col, 1.2, 0.55, THREE.AdditiveBlending, 9);
    if (ring.material) stops.push(onFrame((dt, t) => {
      ring.scale.setScalar(0.86 + 0.10 * ease3(t * 0.8));
      const k = (t * 0.9) % 1;
      beacon.scale.setScalar(1.9 - k * 1.15);
      beacon.material.opacity = 0.6 * k * (1 - k) * 3.2;
    }));
  }

  scene.add(group);
  current = {
    dispose() {
      for (const s of stops) s();
      scene.remove(group);
      for (const o of owned) o.dispose();
    },
  };
}

// A gentle 0..1 breathe without reaching for a raw sine on the caller's side.
function ease3(t) {
  const k = (t % 1);
  const u = k < 0.5 ? k * 2 : (1 - k) * 2;
  return u * u * (3 - 2 * u);
}
