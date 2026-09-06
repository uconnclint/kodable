// The hero. One soft, lobed body that spins as it rolls, plus an upright face
// rig that carries the features and whatever the player has bought for it.
//
// Rig contract -- animator.js and main.js are written against this, do not
// change it without telling them:
//
//   root.userData = { body, face, char, shadow }
//   body   a Group that spins (rollBody, and the idle turn in animator.js)
//   face   a Group that never rotates, so the eyes and the hat stay upright
//   shadow the contact-shadow quad; see "Contact shadow" below. It drives
//          itself off root.position.y, so the animator can ignore it entirely
//   rollBody(root, dir, dist)   dist in tiles, dir a unit {x,z}
//
// Design notes, because they are not obvious from the code:
//
// * The body used to be an icosahedron studded with cones. At render scale
//   those cones were spikes and the protagonist of a game for six-year-olds
//   read as an angry sea urchin. The shape here is a single continuous mesh
//   whose radius wobbles gently towards the twelve icosahedral directions, so
//   the silhouette is one soft blob with a dozen shallow lobes -- enough for
//   the eye to see it rolling, never enough to be sharp.
//
// * Everything on the face hangs off a *tilted* sub-group. The camera looks
//   down the board at about 53 degrees; features pinned to +Z end up at the
//   bottom of the visible disc, which is exactly why the old face looked like
//   it was sliding off. Tilting the whole feature set up towards the camera
//   puts the eyes where a face has eyes.
//
// * The face is NOT a separate lighter object stuck on the front. It used to
//   be an ellipsoid that intersected the body, and the intersection curve was
//   a hard shading crease running from one eye down under the mouth -- a weld
//   line that read as a deformed jaw, and on the low tier as a pale disc with
//   a cut edge. The face is now a shell that shares the body's material and
//   the body's base colour, lifts into a gentle muzzle at the centre, and
//   tucks back *inside* the body at its rim so the rim can never be seen. The
//   lighter tint lives in the shell's vertex colours and fades radially to
//   exactly the body colour well before the two surfaces meet, so there is
//   nothing to see where they cross: same material, same colour, and only a
//   ~12-degree change of slope.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { tier } from './quality.js';

// ---------------------------------------------------------------------------
// Proportions. One place, so the accessories can be written against the body
// instead of against magic numbers that stop matching when it is retuned.
// ---------------------------------------------------------------------------
const R = 0.38;          // mean body radius, and the radius rollBody rolls on
const LOBE = 0.025;      // +/- fraction of R the lobes push the surface
const R_MAX = R * (1 + LOBE);
const R_MIN = R * (1 - LOBE);

// --- the face shell --------------------------------------------------------
// A surface of revolution about the head's +Z axis, described by its radius as
// a function of the polar angle from that axis:
//
//   theta = 0 .............. the centre of the face; SHELL + MUZZLE
//   theta -> BUMP_END ...... the muzzle has died away; SHELL, a hair proud of
//                            the tallest lobe so the spinning body can never
//                            poke through
//   theta -> DIVE_END ...... tucked to SHELL - DIVE, which is inside R_MIN, so
//                            the shell's open rim is buried at every angle
//
// The two surfaces therefore cross somewhere on the dive, where the shell is
// falling at only 12-16 degrees off the body's tangent. That shallow angle is
// the whole trick: a crease you cannot find is a crease that is not there.
const SHELL = R_MAX + 0.006;
const MUZZLE = 0.042;    // how far the centre of the face pushes out
const BUMP_END = 0.86;   // radians; muzzle fully gone by here
const DIVE_START = 0.88; // radians; the shell starts tucking under
const DIVE_END = 1.52;   // radians; last ring of the shell
// The rim ends 0.021 inside the deepest lobe valley, which is what guarantees
// it is buried whatever the body is doing underneath.
const DIVE = SHELL - R_MIN + 0.021;
// The lighter face tint, as an ellipse in the head's xy plane. Wider than it
// is tall, because a face is; the *geometry* stays radially symmetric so the
// bulge cannot carry a directional crease of its own.
const PATCH_RX = 0.285;
const PATCH_RY = 0.245;
const PATCH_IN = 0.50;   // full tint inside this fraction of the ellipse
// How far the feature group is tipped back towards the camera. Tuned against
// the fixed VIEW_DIR in renderer.js: at this angle the eyes sit just below the
// centre of the visible disc, which is where a round character's eyes belong.
const FACE_TILT = -0.66;

const smooth = (t) => THREE.MathUtils.smoothstep(t, 0, 1);

function shellRadius(theta) {
  const bump = 1 - smooth(theta / BUMP_END);
  const dive = smooth((theta - DIVE_START) / (DIVE_END - DIVE_START));
  return SHELL + MUZZLE * bump - DIVE * dive;
}

// The z of the face surface directly in front of (x, y), so a feature can be
// positioned by where it should *appear* and then sunk into the surface by
// however much of it should be buried. The shell's radius depends on the very
// angle we are solving for, so this is a fixed-point iteration -- it converges
// in two or three rounds because the radius barely moves, and it only ever
// runs at build time.
function faceZ(x, y, sink) {
  const rho = Math.hypot(x, y);
  let th = Math.asin(Math.min(rho / SHELL, 1));
  for (let i = 0; i < 5; i++) th = Math.asin(Math.min(rho / shellRadius(th), 1));
  return shellRadius(th) * Math.cos(th) - (sink || 0);
}

// ---------------------------------------------------------------------------
// Colour helpers
//
// All of these work in sRGB, not in the linear working space. An HSL lightness
// offset in linear space is wildly non-uniform -- +0.2 barely moves a light
// colour and blows out a dark one -- and these are art-direction numbers, so
// they need to behave the way a colour picker behaves.
// ---------------------------------------------------------------------------
const _hsl = { h: 0, s: 0, l: 0 };

function shift(color, dh, ds, dl) {
  const c = color.clone();
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  return c.setHSL(
    (_hsl.h + dh + 1) % 1,
    THREE.MathUtils.clamp(_hsl.s + ds, 0, 1),
    THREE.MathUtils.clamp(_hsl.l + dl, 0, 1),
    THREE.SRGBColorSpace,
  );
}

function lightness(color) {
  color.getHSL(_hsl, THREE.SRGBColorSpace);
  return _hsl.l;
}

// Squeezes a character colour into a band the renderer can actually shade.
// Above the top of the band a lit surface clears the bloom threshold and the
// character glows (Seraph's cream and Sunny's yellow both did); below the
// bottom there is no shading information left at all and the body reads as a
// hole (Shadowpaw's near-black did).
//
// The saturation floor is the character's half of "the hero must not go grey".
// World 3's warm key and World 2's teal fill both pull a weakly saturated
// albedo towards the light's own hue, and a bloop that has gone slate has lost
// the one thing that tells a six-year-old which bloop is theirs. Only Mossy,
// Seraph and Shadowpaw sit under the floor; everything else is already at or
// near full chroma. Colours with almost no chroma to begin with are left
// alone, so a deliberately neutral bloop could still exist.
const SAT_FLOOR = 0.55;

function bodySafe(color, lo = 0.34, hi = 0.70) {
  const c = color.clone();
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  const l = THREE.MathUtils.clamp(_hsl.l, lo, hi);
  const s = _hsl.s > 0.18 ? Math.max(_hsl.s, SAT_FLOOR) : _hsl.s;
  return c.setHSL(_hsl.h, s, l, THREE.SRGBColorSpace);
}

// The exact body colour the model is built from, as an sRGB hex string.
//
// The shop chip used to re-derive its swatch from `char.colors.body`, which is
// the *authored* colour, not the one on screen: Sunny's chip came out bright
// yellow next to a mustard model and Lumen's pale lilac next to a mid violet.
// Anything drawing a bloop that is not a bloop -- chips, cards, the coin
// burst's tint -- should call this instead of reading char.colors.body.
export function displayBodyColor(char) {
  return `#${bodySafe(new THREE.Color(char.colors.body)).getHexString(THREE.SRGBColorSpace)}`;
}

// Accessories are meant to be legible against the body they sit on, and a
// same-hue accent at +/- 0.20 lightness is not legible: Minty's headphones
// were dark teal on teal, Mossy's leaves dark green on green, and Shadowpaw --
// an 1100-coin unlock -- was a black mass with one white eye in it. So the
// value push is wide enough to survive tone mapping, the chroma is lifted, and
// the hue is rotated 45 degrees anticlockwise. The rotation is what stops two
// greens from reading as one shape in the two seconds a child looks at the
// card; it is small enough that the accessory still belongs to the character
// (Sunny gets a red cap, Bubbles violet antennae) and it always moves towards
// the warmer neighbour, which keeps the roster from drifting cold.
const ACCENT_PUSH = 0.34;
const ACCENT_HUE = -0.125;

function contrastAccent(accent, body) {
  const la = lightness(accent);
  const lb = lightness(body);
  const want = THREE.MathUtils.clamp(
    lb < 0.5 ? Math.max(la, lb + ACCENT_PUSH) : Math.min(la, lb - ACCENT_PUSH), 0.12, 0.88,
  );
  return shift(accent, ACCENT_HUE, 0.10, want - la);
}

// ---------------------------------------------------------------------------
// Shared geometry. buildBloop runs on every level start and on every card the
// player taps in the shop, so nothing here may be allocated per call.
// ---------------------------------------------------------------------------
const cache = new Map();
const get = (key, make) => {
  let g = cache.get(key);
  if (!g) { g = make(); cache.set(key, g); }
  return g;
};

const unitSphere = (w = 20, h = 14) => get(`sph${w}x${h}`, () => new THREE.SphereGeometry(1, w, h));
const unitCone = (seg = 10) => get(`cone${seg}`, () => new THREE.ConeGeometry(1, 1, seg));
const unitCyl = (seg = 12) => get(`cyl${seg}`, () => new THREE.CylinderGeometry(1, 1, 1, seg));
const unitBox = () => get('box', () => new THREE.BoxGeometry(1, 1, 1));
// Torus cannot be scaled uniformly without changing the tube ratio, so arcs
// are cached per shape instead.
const arc = (r, tube, sweep, seg = 20) =>
  get(`arc${r}|${tube}|${sweep}|${seg}`, () => new THREE.TorusGeometry(r, tube, 8, seg, sweep));

// The twelve icosahedron vertex directions -- the lobe centres.
const LOBE_DIRS = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  return [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => new THREE.Vector3(v[0], v[1], v[2]).normalize());
})();
// Dot product from a lobe centre to the point furthest from every lobe (an
// icosahedral face centre). Normalising by it makes the lobe field span 0..1
// no matter how the constants above are retuned.
const LOBE_FLOOR = 0.7947;

function bodyGeometry() {
  return get('body', () => {
    let g = new THREE.IcosahedronGeometry(1, 3);
    // The uv seam and the per-face normals both stop mergeVertices from
    // welding the duplicates, and an unwelded sphere shades with a visible
    // crack down one side. Nothing here samples a texture, so drop both and
    // let computeVertexNormals rebuild them after the displacement.
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g = mergeVertices(g, 1e-4);

    const pos = g.attributes.position;
    const shades = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      let d = -1;
      for (let k = 0; k < LOBE_DIRS.length; k++) d = Math.max(d, v.dot(LOBE_DIRS[k]));
      const t = THREE.MathUtils.clamp((d - LOBE_FLOOR) / (1 - LOBE_FLOOR), 0, 1);
      const s = t * t * (3 - 2 * t); // smoothstep: rounded lobes, no creases
      const r = R * (1 + LOBE * (s * 2 - 1));
      pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
      // Most of the lobe read is this, not the displacement: a 2.5% bulge is
      // almost invisible on its own, but tinting the crowns up and the valleys
      // down turns it into a surface you can watch turn over as it rolls.
      const shade = 1 + (s - 0.5) * 0.17;
      shades[i * 3] = shades[i * 3 + 1] = shades[i * 3 + 2] = shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(shades, 3));
    g.computeVertexNormals();
    return g;
  });
}

// The face shell's positions and normals, plus the radial tint weight for each
// vertex. Shared by every character: only the colour attribute differs, and
// that is built per palette in faceGeometry() below.
const FACE_RINGS = 20;
const FACE_SEG = 36;

function faceShell() {
  return get('faceShell', () => {
    const pos = [];
    const fade = [];
    const idx = [];
    // Apex first, then FACE_RINGS rings of FACE_SEG vertices.
    pos.push(0, 0, shellRadius(0));
    fade.push(0);
    for (let i = 1; i <= FACE_RINGS; i++) {
      const th = (i / FACE_RINGS) * DIVE_END;
      const r = shellRadius(th);
      const rho = r * Math.sin(th), z = r * Math.cos(th);
      for (let j = 0; j < FACE_SEG; j++) {
        const a = (j / FACE_SEG) * Math.PI * 2;
        const x = Math.cos(a) * rho, y = Math.sin(a) * rho;
        pos.push(x, y, z);
        // Elliptical falloff, evaluated on the vertex's own xy. It reaches the
        // body colour by the time the ellipse is full, which happens a good 15
        // degrees before the shell meets the body -- so the two surfaces cross
        // inside a region that is already exactly the body's colour.
        const e = Math.hypot(x / PATCH_RX, y / PATCH_RY);
        fade.push(smooth((e - PATCH_IN) / (1 - PATCH_IN)));
      }
    }
    for (let j = 0; j < FACE_SEG; j++) idx.push(0, 1 + j, 1 + (j + 1) % FACE_SEG);
    for (let i = 0; i < FACE_RINGS - 1; i++) {
      for (let j = 0; j < FACE_SEG; j++) {
        const a = 1 + i * FACE_SEG + j, b = 1 + i * FACE_SEG + (j + 1) % FACE_SEG;
        idx.push(a, b, a + FACE_SEG, b, b + FACE_SEG, a + FACE_SEG);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.userData.fade = fade;
    return g;
  });
}

// A per-character view of the shell. It borrows the shared position, normal
// and index buffers -- three uploads a BufferAttribute once however many
// geometries reference it -- and adds the only thing that differs, a colour
// attribute that carries the face tint as a multiplier on the body colour.
// Written this way the shell can use the *body's own material*, which is what
// guarantees it shades identically where the two meet.
function faceGeometry(char, body, lens) {
  return get(`face:${char.id}`, () => {
    const base = faceShell();
    const { fade } = base.userData;
    const col = new Float32Array(fade.length * 3);
    // Working-space ratio, so body * ratio lands exactly on the lens colour.
    // A channel that is black in the body cannot be tinted away from black, so
    // guard the divide rather than producing an infinity.
    const rr = body.r > 1e-4 ? lens.r / body.r : 1;
    const rg = body.g > 1e-4 ? lens.g / body.g : 1;
    const rb = body.b > 1e-4 ? lens.b / body.b : 1;
    for (let i = 0; i < fade.length; i++) {
      const f = fade[i];
      col[i * 3] = rr + (1 - rr) * f;
      col[i * 3 + 1] = rg + (1 - rg) * f;
      col[i * 3 + 2] = rb + (1 - rb) * f;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('normal', base.getAttribute('normal'));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(base.getIndex());
    return g;
  });
}

// A five-pointed star, extruded and bevelled, for the star eyes. Built from a
// Shape once: the old star eye was an octahedron squashed flat, which from the
// front is a diamond and from anywhere else is a lump.
function starGeometry() {
  return get('star', () => {
    const shape = new THREE.Shape();
    const outer = 1, inner = 0.45;
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const rad = i % 2 ? inner : outer;
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: 0.3, bevelEnabled: true, bevelSize: 0.14, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 1,
    });
    g.center();
    return g;
  });
}

// A rounded rectangle traced into an existing Path/Shape, centred on the
// origin. Used for the square spectacle rims.
function roundedRect(path, hw, hh, r) {
  path.moveTo(-hw + r, -hh);
  path.lineTo(hw - r, -hh);
  path.quadraticCurveTo(hw, -hh, hw, -hh + r);
  path.lineTo(hw, hh - r);
  path.quadraticCurveTo(hw, hh, hw - r, hh);
  path.lineTo(-hw + r, hh);
  path.quadraticCurveTo(-hw, hh, -hw, hh - r);
  path.lineTo(-hw, -hh + r);
  path.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
}

function squareRimGeometry() {
  return get('sqrim', () => {
    const shape = new THREE.Shape();
    roundedRect(shape, 0.128, 0.112, 0.034);
    const hole = new THREE.Path();
    roundedRect(hole, 0.106, 0.090, 0.026);
    shape.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: 0.020, bevelEnabled: false, curveSegments: 3,
    });
    g.center();
    return g;
  });
}

// A swept tube whose radius tapers along the curve. TubeGeometry cannot taper,
// and the taper is the entire difference between a horn and a length of pipe.
// Used for horns, antenna stalks and the quill crest.
function taperedTube(key, points, r0, r1, seg = 16, radial = 8) {
  return get(`tube${key}`, () => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    const frames = curve.computeFrenetFrames(seg, false);
    const pos = [];
    const idx = [];
    const p = new THREE.Vector3();
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      curve.getPointAt(t, p);
      const r = THREE.MathUtils.lerp(r0, r1, t * t * (3 - 2 * t));
      const N = frames.normals[i], B = frames.binormals[i];
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
        pos.push(p.x + N.x * cx + B.x * cy, p.y + N.y * cx + B.y * cy, p.z + N.z * cx + B.z * cy);
      }
    }
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * radial + j, b = i * radial + (j + 1) % radial;
        idx.push(a, b, a + radial, b, b + radial, a + radial);
      }
    }
    // Rounded tip: one apex vertex fanned to the last ring. Cheaper than a
    // hemisphere and it is only ever seen from a distance.
    curve.getPointAt(1, p);
    const T = frames.tangents[seg];
    const apex = pos.length / 3;
    pos.push(p.x + T.x * r1 * 0.9, p.y + T.y * r1 * 0.9, p.z + T.z * r1 * 0.9);
    for (let j = 0; j < radial; j++) idx.push(seg * radial + j, seg * radial + (j + 1) % radial, apex);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  });
}

// ---------------------------------------------------------------------------
// Contact shadow
//
// Bloop was the only object on the board without one: every star and mushroom
// dropped a soft disc on the grass and the hero floated over it, with the
// start ring's bright rim running behind him unbroken. A cast shadow from the
// key light cannot do this job -- at the tier's 512px map one character's worth
// of penumbra is about two texels -- so this is an explicit painted contact
// patch, which is what the reference art does anyway.
//
// One quad, one shared texture, one shared material.
// ---------------------------------------------------------------------------
const SHADOW_SIZE = 1.06;   // world units across at rest; the body is 0.78
const SHADOW_Y = 0.014;     // clear of the tile top, under everything else
const SHADOW_FADE = 0.95;   // lift, in tiles, at which the patch has fully gone
const SHADOW_ALPHA = 0.46;  // density on the ground at rest

function shadowTexture() {
  return get('shadowTex', () => {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    // Hand-placed stops rather than a linear ramp: a real contact patch has a
    // dense core right under the object and a long, weak skirt. A straight
    // gradient reads as an airbrushed blob.
    grad.addColorStop(0.00, 'rgba(255,255,255,1)');
    grad.addColorStop(0.34, 'rgba(255,255,255,0.92)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.60)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.25)');
    grad.addColorStop(0.90, 'rgba(255,255,255,0.06)');
    grad.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

function shadowMaterial() {
  return get('shadowMat', () => new THREE.MeshBasicMaterial({
    // Not black. A neutral black patch on grass reads as a hole punched in the
    // terrain; a deep cool violet sits in the same family as the sky's ambient
    // and looks like light being blocked rather than paint being applied.
    color: 0x241d3a,
    map: shadowTexture(),
    transparent: true,
    opacity: SHADOW_ALPHA,
    depthWrite: false,
  }));
}

function addContactShadow(root) {
  const mesh = new THREE.Mesh(
    get('shadowQuad', () => new THREE.PlaneGeometry(1, 1)),
    shadowMaterial(),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // The patch is parented to the bloop so it follows him around the board, but
  // it must not follow him *up*, and it must not inherit the squash the
  // animator puts on the group -- a squashed character does not get an oval
  // shadow, it gets a wider one. So both are undone here, once per draw.
  //
  // Driving it from root.position.y means the animator needs to know nothing
  // about it: any hop, any spring, any bob shrinks and lifts the patch for
  // free. If it ever wants explicit control it can set
  // `bloop.userData.shadow.userData.lift` to a height in tiles and that wins.
  mesh.onBeforeRender = () => {
    const ud = mesh.userData;
    const lift = typeof ud.lift === 'number' ? ud.lift : root.position.y;
    // Faded out rather than hidden: below the floor there is no floor, and the
    // shop preview hangs its bloop in open space where a disc would just be a
    // smudge in the backdrop. `visible = false` cannot be used for this -- an
    // object that is not drawn never gets another onBeforeRender, so it could
    // never come back.
    const t = THREE.MathUtils.clamp(Math.max(lift, 0) / SHADOW_FADE, 0, 1);
    const k = SHADOW_SIZE * (1 - 0.42 * t);
    mesh.position.y = (SHADOW_Y - root.position.y) / (root.scale.y || 1);
    mesh.scale.set(k / (root.scale.x || 1), k / (root.scale.z || 1), 1);
    mesh.material.opacity = lift < -0.05 ? 0 : SHADOW_ALPHA * (1 - 0.72 * t);
  };
  root.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Materials. Keyed by character id and kept forever: sixteen palettes is a
// bounded set, and the alternative -- rebuilding them on every level start and
// every shop card -- leaked a materials-worth of GPU state per level, because
// nothing outside this module ever disposed a bloop.
// ---------------------------------------------------------------------------
const palettes = new Map();

// Sheen is what makes the body read as a soft toy instead of a plastic ball:
// a wide, low-gloss lobe that lights the grazing edge and separates Bloop from
// whatever is behind him. It costs a heavier shader, so the bottom tier gets a
// plain standard material instead. The tier is read once, when the palette is
// built; a watchdog downgrade mid-session leaves already-built bloops alone
// rather than dropping a frame rebuilding shaders at the worst possible moment.
function bodyMaterial(color, sheenColor, sheenAmount) {
  const common = {
    color, vertexColors: true, roughness: 0.58, metalness: 0.0,
  };
  if (tier() === 'low') return new THREE.MeshStandardMaterial(common);
  return new THREE.MeshPhysicalMaterial({
    ...common,
    sheen: sheenAmount,
    sheenRoughness: 0.7,
    sheenColor,
  });
}

function paletteFor(char) {
  const hit = palettes.get(char.id);
  if (hit) return hit;

  const raw = new THREE.Color(char.colors.body);
  const body = bodySafe(raw);
  const bl = lightness(body);
  const accent = contrastAccent(new THREE.Color(char.colors.accent), body);
  // Which way the face tint moves depends on where the body already sits. On
  // a mid or dark bloop a lighter patch reads as a muzzle; on a cream or ice
  // one there is no headroom left -- lifting it further flattens the shading
  // and walks it towards the bloom threshold -- so it goes the other way.
  const lensColor = shift(body, 0, -0.10, bl <= 0.66 ? 0.11 : -0.09);

  // The rim is the character's half of "the hero must separate from the
  // background". A same-hue sheen brightens a blue bloop against a blue sky by
  // making it a slightly lighter blue, which is no separation at all; a rim in
  // the body's complement is a different colour at the edge and reads even
  // when the value behind it matches. Kept low in chroma so it is a light
  // wrap, not a neon outline. Dark bloops need it badly, pale ones less --
  // on a cream body a strong sheen just washes the shading out.
  const sheenColor = shift(body, 0.5, -0.55, 0.34);
  const sheenAmount = THREE.MathUtils.lerp(1.0, 0.55, THREE.MathUtils.clamp((bl - 0.3) / 0.45, 0, 1));
  const bodyMat = bodyMaterial(body, sheenColor, sheenAmount);

  const p = {
    body: bodyMat,
    bodyColor: body,
    lensColor,
    // The face shell shares the body's material outright. That is the point:
    // identical roughness, identical sheen, identical base colour, so the only
    // difference across the join is the vertex tint, and the vertex tint is
    // already back at 1.0 by the time the join happens.
    lens: bodyMat,
    // Eyelids come off the *body*, not the patch. On a pale bloop the patch is
    // the darker of the two, and a lid cut from it read as bruising rather
    // than as skin closing over the eye.
    lid: new THREE.MeshStandardMaterial({ color: shift(body, 0, -0.04, 0.035), roughness: 0.65 }),
    accent: new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5, flatShading: true }),
    accentSoft: new THREE.MeshStandardMaterial({ color: accent, roughness: 0.55 }),
    accentGlow: new THREE.MeshStandardMaterial({
      color: shift(accent, 0, 0, 0.18), emissive: shift(accent, 0, 0, 0.1), emissiveIntensity: 1.1, roughness: 0.4,
    }),
    // The cap's top button: lifted off the accent so it does not vanish into
    // the dome it sits on.
    button: new THREE.MeshStandardMaterial({ color: shift(accent, 0, -0.1, 0.16), roughness: 0.5 }),
  };
  palettes.set(char.id, p);
  return p;
}

// Colour-independent materials, shared by every character.
const shared = {};
function sharedMaterials() {
  if (shared.ink) return shared;
  // Eye white, deliberately not white: a true white facing the key light lands
  // over the bloom threshold and the eyes smear. This is the brightest value
  // on the character that still stays under it, and reading slightly cool
  // makes the pupil look wetter.
  // Deliberately not white, and deliberately barely lit by the environment.
  // A true white facing the key light clears the bloom threshold and the eyes
  // smear; and at full environment intensity the eye is the whitest thing on
  // the character, so it takes on whatever the sky is doing -- under the menu's
  // violet dusk a neutral white came out distinctly mauve, which reads as sore.
  // Matte, too: the wet look comes from the unlit catchlights, so the sclera
  // itself does not need a specular lobe to tint. The tint that is left leans
  // very slightly cool, which is what cancels the menu theme's pink rim.
  shared.sclera = new THREE.MeshStandardMaterial({
    color: 0xeaeff4, roughness: 0.82, envMapIntensity: 0.22,
  });
  shared.ink = new THREE.MeshStandardMaterial({ color: 0x1d2033, roughness: 0.42 });
  // Catchlights are unlit on purpose. A specular highlight has to sit in the
  // same place from every angle or the eye stops looking alive, and at this
  // size a real one is a single flickering pixel.
  shared.glint = new THREE.MeshBasicMaterial({ color: 0xdfe8ff });
  shared.gold = new THREE.MeshStandardMaterial({ color: 0xf2c33d, roughness: 0.28, metalness: 0.85 });
  // Cool platinum. Regalia is a gold bloop in a gold crown with gold eyes --
  // a monochrome wash at 1200 coins -- and one cool metal in the band is what
  // turns the crown back into an object sitting on a head.
  shared.metal = new THREE.MeshStandardMaterial({ color: 0xcfd4e2, roughness: 0.25, metalness: 0.9 });
  shared.goldGlow = new THREE.MeshStandardMaterial({
    color: 0xffe9a8, emissive: 0xffcf5e, emissiveIntensity: 1.35, roughness: 0.3,
  });
  shared.gem = new THREE.MeshStandardMaterial({ color: 0xff5f8d, roughness: 0.2, metalness: 0.1, flatShading: true });
  shared.cloth = new THREE.MeshStandardMaterial({ color: 0x2b2740, roughness: 0.85 });
  // Spectacle frames: a shade lighter than the ink of the pupils, and glossy,
  // so the rims read as a separate object in front of the eyes rather than
  // merging into them.
  shared.frame = new THREE.MeshStandardMaterial({ color: 0x39304f, roughness: 0.3, metalness: 0.35 });
  shared.ivory = new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.45 });
  // Mossy's flower is the one accessory whose colour cannot come from the
  // character: his accent is a dark green, and dark green petals with a dark
  // green leaf on a green body is a lump, not a flower. Real hair flowers are
  // pale and their leaves are much deeper than the stem they came off, so
  // these are fixed and chosen against the body they always sit on.
  shared.blossom = new THREE.MeshStandardMaterial({ color: 0xffa8c8, roughness: 0.5 });
  shared.leaf = new THREE.MeshStandardMaterial({ color: 0x2c7a45, roughness: 0.65 });
  // The halo's light cone. Additive and very faint: it exists to connect the
  // ring to the head, not to be noticed.
  shared.halolight = new THREE.MeshBasicMaterial({
    color: 0xffdf9a, transparent: true, opacity: 0.17, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  return shared;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// Local +Z: the axis every flat accessory is modelled facing along.
const FORWARD = new THREE.Vector3(0, 0, 1);

// `scale` is a number (uniform) or a [x, y, z] triple. Note that a caller that
// wants a non-uniform scale has to pass the triple: doing `put(..., 0.1)` and
// then `mesh.scale.set(1, 0.8, 0.6)` *replaces* the uniform scale rather than
// modulating it, which is how the closed and star eyes ended up as
// unit-radius spheres eight times the size of the character.
function put(parent, geo, mat, pos, scale, rot, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (typeof scale === 'number') m.scale.setScalar(scale);
  else if (scale) m.scale.set(scale[0], scale[1], scale[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  m.castShadow = shadow;
  parent.add(m);
  return m;
}

export function buildBloop(char) {
  const p = paletteFor(char);
  const s = sharedMaterials();

  const root = new THREE.Group();

  // Spinning body. Sits exactly one mean radius above the tile so it kisses
  // the ground; the lobes take it a hair either side of contact as it turns,
  // which is the point.
  const body = new THREE.Group();
  body.position.y = R;
  put(body, bodyGeometry(), p.body, null, null, null, true);
  root.add(body);

  // Upright rig. `face` is world-aligned and carries the hat; `head` is tipped
  // towards the camera and carries everything that is part of the face itself.
  const face = new THREE.Group();
  face.position.y = R;
  root.add(face);

  const head = new THREE.Group();
  head.rotation.x = FACE_TILT;
  face.add(head);

  // No cast shadow off the shell. It hovers six thousandths of a unit over the
  // body across most of its span, which is well inside one shadow texel, and a
  // caster that close to its receiver is an acne generator. The body sphere
  // already casts the character's outline.
  put(head, faceGeometry(char, p.bodyColor, p.lensColor), p.lens, null, null, null, false);

  addEyes(head, char.eyes, p, s);
  addMouth(head, char.eyes, s);
  // No cheek blush. Two attempts at one both ended as lumps: the patch curves
  // away in x as well as in y, so anything wide enough to read as a cheek has
  // its outer edge standing off the surface. On a face this small it is noise
  // that costs the silhouette, and the mouth already carries the warmth.

  addAccessory(face, char, p, s);

  const shadow = addContactShadow(root);

  root.userData = { body, face, char, shadow };
  return root;
}

// ---------------------------------------------------------------------------
// Eyes
//
// Every style is built from the same parts so they sit at the same place on
// the face and read as the same character pulling a different expression:
// a bulging sclera set into the face, a big pupil with two catchlights, and a
// body-coloured lid ridge above it that gives the face a brow.
// ---------------------------------------------------------------------------
// Big eyes, set close together. The first pass used 0.086 at 0.118 apart and
// at gameplay scale that reads as two beads on a ball; a toy character's eyes
// have to be most of its face.
const EYE_X = 0.112;
const EYE_Y = 0.042;
const EYE_R = 0.099;
// Sclera centre: buried far enough that a fat cap of it bulges out of the
// face, but no further. The old set-in put the ball's centre outside R_MAX,
// and at a grazing camera angle the outer edge of the left sclera crossed the
// body's own silhouette -- a white bite taken out of the blue.
const EYE_Z = faceZ(EYE_X, EYE_Y, 0.048);

// A soft ridge above an eye. This replaced a torus ring drawn round the eye:
// the ring's top arc sank *inside* the sclera and read as blue eyeliner, and
// its colour came off the body, which on a saturated bloop was far too loud.
// A low mound cut from the face tint models the socket instead of drawing
// a line on it.
function openEye(head, x, p, s, lidDrop) {
  const sign = Math.sign(x);
  put(head, unitSphere(20, 14), s.sclera, [x, EYE_Y, EYE_Z], EYE_R);
  // Pupils converge very slightly, which is the cheapest trick there is for
  // making a face look like it is looking at you rather than past you.
  const px = x - sign * 0.008;
  put(head, unitSphere(16, 12), s.ink, [px, EYE_Y - 0.005, EYE_Z + 0.062], 0.056, null, false);
  // The primary catchlight is mirrored about the centre line and sits *on the
  // pupil*. It used to be offset the same way on both eyes, as a real light
  // would be, and the consequence was that the left one landed on the sclera
  // outside the pupil and vanished: one eye alive, one eye a flat black hole.
  // It is also much bigger than it was -- at 0.021 it survived neither the
  // low tier's pixel ratio nor a 60px shop chip.
  put(head, unitSphere(12, 10), s.glint,
    [px - sign * 0.024, EYE_Y + 0.030, EYE_Z + 0.090], 0.030, null, false);
  // The second, smaller light is what turns a highlight into a wet eye. It is
  // the one that goes when the tier drops, because at half the pixel ratio it
  // is a flickering speck and the primary is not.
  if (tier() !== 'low') {
    put(head, unitSphere(8, 6), s.glint,
      [x + sign * 0.030, EYE_Y - 0.034, EYE_Z + 0.076], 0.013, null, false);
  }
  if (lidDrop) {
    // Sleepy, not shut. The lid used to be a body-tinted sphere at 78% of the
    // eye covering the whole of it, which on Grape read as two black craters
    // and on Lumen as two dark slits. It now clips the top four-tenths only,
    // so the pupil and its catchlight stay visible underneath and the eye
    // still reads as an eye.
    const r = EYE_R * 1.02;
    put(head, unitSphere(16, 10), p.lid, [x, EYE_Y + 0.072, EYE_Z + 0.004], [r, r * 0.42, r]);
    const lash = put(head, arc(EYE_R * 0.82, 0.015, Math.PI * 0.86), s.ink,
      [x, EYE_Y + 0.030, EYE_Z + 0.050], null, [0, 0, Math.PI], false);
    lash.scale.set(1, 0.45, 1);
  }
}

function closedEye(head, x, p, s) {
  // A closed eye is not a line: there is an eyelid mound under it. Without the
  // mound the arc floats in front of the face and the whole head goes flat,
  // which is exactly what the old happy and sleepy faces did.
  put(head, unitSphere(16, 12), p.lid, [x, EYE_Y, EYE_Z], [EYE_R, EYE_R * 0.80, EYE_R * 0.60]);
  const a = put(head, arc(0.062, 0.021, Math.PI * 0.86), s.ink,
    [x, EYE_Y - 0.014, EYE_Z + 0.058], null, null, false);
  a.scale.set(1, 0.80, 1);
}

function starEye(head, x, p, s) {
  const r = EYE_R * 0.98;
  // Ink behind the star, on every character, not the face tint. Seraph is a
  // pale bloop and a pale-gold star on a pale-gold backing left the 950-coin
  // flagship with no eyes at all -- just a small dark mouth on a blank ball.
  put(head, unitSphere(16, 12), s.ink, [x, EYE_Y, EYE_Z], [r, r * 0.92, r * 0.55]);
  put(head, starGeometry(), s.goldGlow, [x, EYE_Y, EYE_Z + 0.052], [0.086, 0.086, 0.05],
    [0, 0, x < 0 ? 0.12 : -0.12]);
}

function addEyes(head, kind, p, s) {
  if (kind === 'happy') {
    closedEye(head, -EYE_X, p, s); closedEye(head, EYE_X, p, s);
  } else if (kind === 'sleepy') {
    openEye(head, -EYE_X, p, s, 1); openEye(head, EYE_X, p, s, 1);
  } else if (kind === 'star') {
    starEye(head, -EYE_X, p, s); starEye(head, EYE_X, p, s);
  } else if (kind === 'wink') {
    openEye(head, -EYE_X, p, s); closedEye(head, EYE_X, p, s);
  } else if (kind === 'angry') {
    openEye(head, -EYE_X, p, s); openEye(head, EYE_X, p, s);
    // A determined scowl, not a threat: the brows are short, thick and only
    // slightly tilted. Steeper than this and a six-year-old's favourite bloop
    // looks like it hates them.
    for (const sgn of [-1, 1]) {
      const bx = sgn * (EYE_X + 0.014), by = EYE_Y + 0.112;
      put(head, unitBox(), s.ink, [bx, by, faceZ(bx, by, -0.010)],
        [0.118, 0.028, 0.030], [0, 0, sgn * 0.40], false);
    }
  } else {
    openEye(head, -EYE_X, p, s); openEye(head, EYE_X, p, s);
  }
}

function addMouth(head, kind, s) {
  const y = kind === 'angry' ? -0.112 : -0.104;
  const w = kind === 'angry' ? 0.054 : 0.077;
  // Sunk a little into the face so it reads as a line cut into it rather than
  // a wire hovering in front of it. The old mouth used a fixed z that was well
  // behind the surface, so on most characters it never appeared.
  const m = new THREE.Mesh(arc(w, 0.021, Math.PI * 0.92), s.ink);
  m.position.set(0, y, faceZ(0, y, 0.008));
  m.rotation.z = Math.PI;
  m.scale.set(1, kind === 'angry' ? 0.55 : 0.88, 0.9);
  m.castShadow = false;
  head.add(m);
}

// ---------------------------------------------------------------------------
// Accessories
//
// These are bought with coins the player earned, so every one has to feel like
// it was worth the coins. They hang off `face`, which is world-upright, so a
// crown stays level while the body rolls underneath it.
//
// Anything that wraps the head sits clear of R_MAX: the body's lobes turn
// under these, and a band pinned to the mean radius would be pierced by a lobe
// crown on one frame and floating over a valley on the next.
//
// Four accessory *types* are shared by two characters each, and shared type
// used to mean shared silhouette: Coral and Emberling were the same shape in
// two reds, 300 coins apart and 800 coins apart; so were Tangelo and Bubbles,
// Grape and Frostbyte, Lumen and Seraph. Half the roster was a repeat. Every
// shared type below therefore branches on the character id and changes the
// thing you can see in a black cutout -- length, sweep, count, corner shape --
// not the colour, which a thumbnail throws away first.
// ---------------------------------------------------------------------------
const TOP = R_MAX;         // crown of the head
const HUG = R_MAX + 0.018; // radius a band or a hat can wrap at without clipping

// Hats live in a frame tipped back off vertical, because on this character the
// top *front* of the ball is face, not forehead: the feature group is tilted
// up towards the camera, so the eyes reach nearly to the crown. A cap pinned
// to world-up pulls straight down over them -- which is exactly what the first
// version of this did, and Sunny came out as a yellow ball wearing a helmet.
const HAT_TILT = -0.46;

function hatFrame(face) {
  const g = new THREE.Group();
  g.rotation.x = HAT_TILT;
  face.add(g);
  return g;
}

// A band that follows the head exactly, cut out of a sphere shell at HUG
// between two polar angles. Cylinders and cones were the old approach and they
// cannot follow a sphere: whatever radius you pick, the head pokes through it
// at one end of the band and hovers away from it at the other.
function headBand(t0, t1, seg) {
  return get(`band${t0}|${t1}`, () => new THREE.SphereGeometry(
    HUG, seg || 24, 6, 0, Math.PI * 2, t0, t1 - t0,
  ));
}

// A pair of stalks, mirrored, growing out of the crown. Antennae and horns are
// the same construction with wildly different numbers.
function pair(face, at, stalk, p, tipMat, tip, tipR) {
  for (const sgn of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(sgn * at[0], at[1], at[2]);
    // Mirrored by a negative x scale, so one modelled curve serves both sides.
    g.scale.x = sgn;
    face.add(g);
    put(g, stalk, p.accentSoft);
    if (tipMat) put(g, unitSphere(12, 10), tipMat, tip, tipR, null, false);
  }
}

// The two halves of the halo: a ring, and a wisp of light joining it to the
// head. The ring used to hang a long way above the crown with nothing under
// it, which does not read as a halo -- it reads as a piece of UI that has come
// loose in the scene.
const UP = new THREE.Vector3(0, 1, 0);

function addHalo(face, s, rayed) {
  const ry = TOP + 0.078;
  const rr = 0.190;
  // One tilted frame holds the ring and its rays, so the rays cannot drift out
  // of the ring's plane the way hand-written Euler angles let them.
  const h = new THREE.Group();
  h.position.y = ry;
  h.rotation.x = -0.16;
  face.add(h);
  put(h, arc(rr, 0.024, Math.PI * 2, 26), s.goldGlow, null, null, [Math.PI / 2, 0, 0], false);
  if (rayed) {
    // Seraph's is a rayed halo -- same family as Lumen's, and unmistakably not
    // the same object at thumbnail size.
    const dir = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      dir.set(Math.cos(a), 0, Math.sin(a));
      const ray = put(h, unitCone(6), s.goldGlow,
        [dir.x * (rr + 0.048), 0, dir.z * (rr + 0.048)], [0.020, 0.072, 0.020], null, false);
      ray.quaternion.setFromUnitVectors(UP, dir);
    }
  }
  // The light cone, in the upright frame so it always falls straight down.
  // Wider at the bottom than the top and ending just inside the head, so it
  // terminates on the crown instead of stopping in mid air.
  const cone = get('halocone', () => new THREE.CylinderGeometry(0.175, 0.235, 0.160, 20, 1, true));
  put(face, cone, s.halolight, [0, ry - 0.086, 0], null, null, false);
}

function addAccessory(face, char, p, s) {
  // Blip ships as `accessory: 'none'`, which made the one bloop every child
  // sees first -- the level screenshot, the shop's top-left card, anything
  // that would ever be an app icon -- a plain ball among fifteen siblings in
  // caps, crowns and horns. A default character has to have a hook too, so
  // "none" builds one: a single off-centre sprout with a lit bead, asymmetric
  // on purpose, and still legible as a black cutout at 60 pixels.
  const kind = char.accessory === 'none' ? 'sprout' : char.accessory;

  if (kind === 'sprout') {
    const stalk = taperedTube('sprout',
      [[0, 0, 0], [0.020, 0.104, -0.030], [0.056, 0.200, -0.086]], 0.022, 0.011, 14, 8);
    const g = new THREE.Group();
    g.position.set(-0.030, TOP - 0.028, -0.020);
    face.add(g);
    put(g, stalk, p.accentSoft);
    put(g, unitSphere(16, 12), p.accentGlow, [0.058, 0.208, -0.089], 0.056);
  } else if (kind === 'antennae') {
    // Tangelo: short, upright, leaning forward over the brow, small beads.
    // Bubbles: half again as tall, splayed wide and swept back, fat beads.
    // Same parts, and no one would mistake one contour for the other.
    if (char.id === 'bubbles') {
      const stalk = taperedTube('antTall',
        [[0, 0, 0], [0.072, 0.152, -0.048], [0.172, 0.300, -0.108]], 0.022, 0.010, 18, 8);
      pair(face, [0.118, TOP - 0.088, -0.030], stalk, p,
        p.accentGlow, [0.176, 0.310, -0.111], 0.058);
    } else {
      const stalk = taperedTube('antShort',
        [[0, 0, 0], [0.038, 0.112, 0.012], [0.082, 0.206, 0.034]], 0.024, 0.013, 16, 8);
      pair(face, [0.100, TOP - 0.066, 0.000], stalk, p,
        p.accentGlow, [0.084, 0.214, 0.035], 0.048);
    }
  } else if (kind === 'crown') {
    // A band cut from the head's own sphere, five rounded points and a gem.
    // Rounded tips matter: this sits next to the spiky-quill crest in the shop
    // and the two have to read as different objects. Band in platinum, points
    // in gold: a gold crown on Regalia's gold body was one colour twice.
    const hat = hatFrame(face);
    const t0 = 0.50, t1 = 0.96;
    put(hat, headBand(t0, t1), s.metal);
    const ring = HUG * Math.sin(t0), lift = HUG * Math.cos(t0);
    put(hat, arc(ring, 0.019, Math.PI * 2, 22), s.metal, [0, lift, 0], null, [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const x = Math.sin(a) * ring, z = Math.cos(a) * ring;
      put(hat, unitCone(8), s.gold, [x, lift + 0.070, z], [0.044, 0.145, 0.044]);
      put(hat, unitSphere(10, 8), s.gold, [x, lift + 0.152, z], 0.030);
    }
    const gt = t1 - 0.09;
    put(hat, unitSphere(12, 10), s.gem,
      [0, HUG * Math.cos(gt), HUG * Math.sin(gt) + 0.014], [0.058, 0.058, 0.036]);
  } else if (kind === 'horns') {
    // Coral: a calf's -- short, thick, swept outward, barely past the crown.
    // Emberling: a ram's -- long, back-swept, nearly doubling the head's width
    // and reaching a third of a body above it.
    if (char.id === 'emberling') {
      const horn = taperedTube('hornLong',
        [[0, 0, 0], [0.062, 0.150, -0.062], [0.078, 0.302, -0.208]], 0.060, 0.014, 18, 9);
      pair(face, [0.150, TOP - 0.150, -0.030], horn, p,
        s.ivory, [0.080, 0.312, -0.216], 0.017);
    } else {
      const horn = taperedTube('hornShort',
        [[0, 0, 0], [0.064, 0.082, -0.006], [0.120, 0.132, -0.022]], 0.064, 0.022, 14, 9);
      pair(face, [0.146, TOP - 0.168, -0.008], horn, p,
        s.ivory, [0.124, 0.138, -0.023], 0.024);
    }
  } else if (kind === 'halo') {
    addHalo(face, s, char.id === 'seraph');
  } else if (kind === 'cap') {
    // Worn back on the head, which is the only way a cap fits a character
    // whose face reaches the crown -- and happens to be how a child wears one.
    // Dome, sagging brim, button.
    const hat = hatFrame(face);
    const dome = get('capdome', () => new THREE.SphereGeometry(HUG, 22, 12, 0, Math.PI * 2, 0, 0.94));
    put(hat, dome, p.accentSoft);
    const rim = get('caprim', () => new THREE.TorusGeometry(HUG * Math.sin(0.94), 0.017, 6, 24));
    put(hat, rim, p.accentSoft, [0, HUG * Math.cos(0.94), 0], null, [Math.PI / 2, 0, 0], false);
    const brim = get('capbrim', () => new THREE.SphereGeometry(1, 20, 8, 0, Math.PI, 0, Math.PI * 0.5));
    put(hat, brim, p.accentSoft,
      [0, HUG * Math.cos(0.94) + 0.008, HUG * Math.sin(0.94) - 0.01], [0.200, 0.046, 0.270], [0.22, 0, 0]);
    put(hat, unitSphere(12, 10), p.button, [0, HUG + 0.012, 0], 0.036);
  } else if (kind === 'bow') {
    // Two pinched loops, a knot and two ribbon tails, worn off to one side of
    // the crown. Doubled in size from the first pass, which read as a bead.
    const g = new THREE.Group();
    // Laid back so its face turns towards the camera. Worn flat on the crown
    // and yawed away, as the first version was, the two loops line up in depth
    // and the whole thing reads as a single lump.
    g.position.set(0.105, TOP - 0.030, 0.020);
    g.rotation.set(-0.86, 0.18, 0.26);
    face.add(g);
    for (const sgn of [-1, 1]) {
      put(g, unitSphere(16, 12), p.accentSoft, [sgn * 0.125, 0.015, 0],
        [0.125, 0.082, 0.055], [0, 0, sgn * 0.42]);
      put(g, unitCone(7), p.accentSoft, [sgn * 0.098, -0.100, -0.012],
        [0.040, 0.140, 0.026], [0, 0, sgn * 0.62 + Math.PI]);
    }
    put(g, unitSphere(14, 12), p.accent, [0, 0.015, 0.010], [0.054, 0.054, 0.046]);
  } else if (kind === 'spikes') {
    // A crest running front to back along the centre line -- a punk mohawk,
    // which is a thing you buy, instead of four cones stuck in the back of the
    // head, which is a thing that happened to you.
    const hat = hatFrame(face);
    const quill = taperedTube('quill',
      [[0, 0, 0], [0, 0.115, -0.050], [-0.012, 0.205, -0.135]], 0.058, 0.013, 14, 8);
    // t runs back to front. The span is deliberately short: with the hat frame
    // already tipped back, a crest that started at t = -0.5 put its first two
    // quills round the back of the head where nothing can see them, and the
    // crest read as one lonely horn.
    const heights = [0.66, 0.88, 1.0, 0.9, 0.72];
    for (let i = 0; i < heights.length; i++) {
      const t = -0.15 + i * 0.2125;
      // Splayed left and right as well as fore and aft. The camera sits in the
      // same vertical plane as the crest, so a crest that only ran front to
      // back projected all five quills onto one line and read as a single
      // unicorn horn.
      put(hat, quill, p.accentSoft,
        [0, HUG * Math.cos(t) - 0.055, HUG * Math.sin(t)],
        [1, heights[i], 1], [t * 0.8 - 0.1, 0, (i - 2) * 0.21]);
    }
  } else if (kind === 'glasses') {
    // Rims on the face plane with temple arms running back to the sides of the
    // head. The arms are what stopped these reading as two rings drawn on the
    // front of the ball. Grape's are round and Frostbyte's are square: they
    // were identical, 500 coins apart.
    const g = new THREE.Group();
    g.rotation.x = FACE_TILT;
    face.add(g);
    const square = char.id === 'frostbyte';
    const rim = square ? squareRimGeometry() : arc(0.112, 0.016, Math.PI * 2, 20);
    for (const sgn of [-1, 1]) {
      put(g, rim, s.frame, [sgn * EYE_X, EYE_Y, EYE_Z + 0.062], null, null, false);
      put(g, unitCyl(6), s.frame, [sgn * 0.222, EYE_Y + 0.030, EYE_Z - 0.085],
        [0.011, 0.215, 0.011], [Math.PI / 2 - 0.22, 0, sgn * 0.42], false);
    }
    put(g, unitCyl(6), s.frame, [0, EYE_Y + 0.016, EYE_Z + 0.062],
      [0.010, 0.052, 0.010], [0, 0, Math.PI / 2], false);
  } else if (kind === 'flower') {
    // Five rounded petals, a gold centre and a leaf, worn over one "ear" and
    // tilted outward. The old one was five tiny balls at the wrong scale, half
    // buried in the head; this one is the size of a real hair flower.
    const g = new THREE.Group();
    // Aimed straight out of the head rather than by guessed Euler angles: the
    // guess had it nearly edge-on to the camera, which is the worst possible
    // read for a flat five-petal shape.
    const at = new THREE.Vector3(0.235, 0.250, 0.075);
    g.position.copy(at);
    g.quaternion.setFromUnitVectors(FORWARD, at.clone().normalize());
    g.rotateZ(0.45);
    face.add(g);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      put(g, unitSphere(14, 10), s.blossom,
        [Math.cos(a) * 0.105, Math.sin(a) * 0.105, 0], [0.078, 0.078, 0.034], [0, 0, a]);
    }
    put(g, unitSphere(14, 12), s.gold, [0, 0, 0.026], [0.058, 0.058, 0.040]);
    put(g, unitSphere(10, 8), s.leaf, [-0.086, -0.142, -0.030], [0.040, 0.092, 0.020], [0, 0, 0.5]);
  } else if (kind === 'headphones') {
    // Band over the crown in the hat frame so it clears the face, cups on the
    // sides with a darker pad set into them. The cups are cloth rather than
    // the accent: Minty's accent is her own teal and teal cups on a teal head
    // were a smudge, however far the value was pushed.
    const hat = hatFrame(face);
    const band = get('hpband', () => new THREE.TorusGeometry(HUG, 0.030, 8, 24, Math.PI * 0.94));
    put(hat, band, p.accentSoft, null, null, [0, 0, Math.PI * 0.03]);
    for (const sgn of [-1, 1]) {
      put(hat, unitCyl(16), s.cloth, [sgn * (HUG - 0.010), 0.02, 0],
        [0.115, 0.062, 0.115], [0, 0, Math.PI / 2]);
      put(hat, unitCyl(16), p.accentSoft, [sgn * (HUG - 0.048), 0.02, 0],
        [0.086, 0.036, 0.086], [0, 0, Math.PI / 2], false);
    }
  } else if (kind === 'ninja') {
    // The band is the accent, not the cloth: Shadowpaw's own accent is nearly
    // black and on a nearly black bloop the whole accessory disappeared.
    // contrastAccent has already pushed it to a readable value by here.
    const hat = hatFrame(face);
    const t0 = 0.80, t1 = 1.12;
    put(hat, headBand(t0, t1), p.accentSoft);
    const tm = (t0 + t1) / 2;
    const ty = HUG * Math.cos(tm), tr = HUG * Math.sin(tm);
    put(hat, unitSphere(12, 10), s.ivory, [0, ty, tr + 0.008], [0.052, 0.052, 0.020], null, false);
    put(hat, unitSphere(12, 10), p.accent, [0, ty + 0.005, -tr - 0.020], [0.062, 0.056, 0.056]);
    for (const sgn of [-1, 1]) {
      put(hat, unitBox(), p.accentSoft, [sgn * 0.055, ty - 0.140, -tr - 0.085],
        [0.062, 0.290, 0.014], [0.30, 0, sgn * 0.24]);
    }
  }
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const _axis = new THREE.Vector3();

// Spin the body as it rolls. `dist` is in tiles (one tile = one world unit),
// `dir` is the unit direction of travel.
export function rollBody(bloop, dir, dist) {
  const { body } = bloop.userData;
  _axis.set(dir.z, 0, -dir.x).normalize().negate();
  body.rotateOnWorldAxis(_axis, -dist / R);
}
