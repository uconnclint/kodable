// Procedural low-poly bloop-ball character builder + rolling rig.
// Rig: root (position) -> body (spins when rolling) + face (stays upright).
import * as THREE from 'three';

const flat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...extra });

export function buildBloop(char) {
  const root = new THREE.Group();
  const bodyColor = new THREE.Color(char.colors.body);
  const accent = new THREE.Color(char.colors.accent);

  // spinning body: icosahedron + bloop cones
  const body = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), flat(bodyColor));
  core.castShadow = true;
  body.add(core);
  const bloopMat = flat(bodyColor.clone().offsetHSL(0, 0, 0.06));
  const coneGeo = new THREE.ConeGeometry(0.05, 0.16, 4);
  const dirs = new THREE.IcosahedronGeometry(0.34, 0).attributes.position;
  const seen = new Set();
  for (let i = 0; i < dirs.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(dirs, i);
    const k = v.toArray().map((n) => n.toFixed(2)).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    const c = new THREE.Mesh(coneGeo, bloopMat);
    c.position.copy(v.clone().normalize().multiplyScalar(0.36));
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize());
    body.add(c);
  }
  body.position.y = 0.38;
  root.add(body);

  // upright face + accessory carrier
  const face = new THREE.Group();
  face.position.y = 0.38;
  root.add(face);
  addEyes(face, char.eyes, accent);
  addAccessory(face, char.accessory, accent, bodyColor);

  root.userData = { body, face, char };
  return root;
}

function addEyes(face, kind, accent) {
  const whiteMat = flat(0xffffff);
  const blackMat = flat(0x222233);
  const z = 0.3;
  const mk = (x, geoW, matW) => {
    const m = new THREE.Mesh(geoW, matW);
    m.position.set(x, 0.08, z);
    face.add(m);
    return m;
  };
  const roundEye = (x) => {
    mk(x, new THREE.SphereGeometry(0.085, 8, 6), whiteMat).position.z = z;
    const p = mk(x, new THREE.SphereGeometry(0.045, 8, 6), blackMat);
    p.position.z = z + 0.06;
  };
  const arcEye = (x, flip = 1) => {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.018, 6, 10, Math.PI), blackMat);
    arc.position.set(x, 0.08, z + 0.05);
    arc.rotation.z = flip < 0 ? Math.PI : 0;
    face.add(arc);
  };
  const starEye = (x) => {
    const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), flat(0xffc93d, { emissive: 0xe8a820, emissiveIntensity: 0.6 }));
    s.position.set(x, 0.08, z + 0.05);
    s.scale.z = 0.5;
    face.add(s);
  };
  if (kind === 'happy') { arcEye(-0.13); arcEye(0.13); }
  else if (kind === 'sleepy') { arcEye(-0.13, -1); arcEye(0.13, -1); }
  else if (kind === 'star') { starEye(-0.13); starEye(0.13); }
  else if (kind === 'wink') { roundEye(-0.13); arcEye(0.13); }
  else if (kind === 'angry') {
    roundEye(-0.13); roundEye(0.13);
    for (const [x, r] of [[-0.13, -0.5], [0.13, 0.5]]) {
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.03), blackMat);
      brow.position.set(x, 0.19, z + 0.06);
      brow.rotation.z = r;
      face.add(brow);
    }
  } else { roundEye(-0.13); roundEye(0.13); }
  // little smile for everyone but angry
  if (kind !== 'angry') {
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.016, 6, 10, Math.PI), blackMat);
    smile.position.set(0, -0.06, z + 0.05);
    smile.rotation.z = Math.PI;
    face.add(smile);
  }
}

function addAccessory(face, kind, accent, bodyColor) {
  const aMat = flat(accent);
  const top = 0.36;
  if (kind === 'antennae') {
    for (const x of [-0.1, 0.1]) {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 5), aMat);
      stem.position.set(x, top + 0.1, 0);
      stem.rotation.z = -x * 2;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), flat(accent, { emissive: accent, emissiveIntensity: 0.5 }));
      tip.position.set(x * 1.8, top + 0.22, 0);
      face.add(stem, tip);
    }
  } else if (kind === 'crown') {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.09, 8, 1, true), flat(0xffc93d, { metalness: 0.5, roughness: 0.4 }));
    band.position.y = top + 0.04;
    face.add(band);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 4), flat(0xffc93d, { metalness: 0.5, roughness: 0.4 }));
      spike.position.set(Math.cos(a) * 0.15, top + 0.13, Math.sin(a) * 0.15);
      face.add(spike);
    }
  } else if (kind === 'horns') {
    for (const x of [-0.16, 0.16]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 5), aMat);
      horn.position.set(x, top - 0.02, 0);
      horn.rotation.z = -x * 3.2;
      face.add(horn);
    }
  } else if (kind === 'halo') {
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 6, 16), flat(0xffe08a, { emissive: 0xffd34d, emissiveIntensity: 0.8 }));
    halo.rotation.x = Math.PI / 2;
    halo.position.y = top + 0.2;
    face.add(halo);
  } else if (kind === 'cap') {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), aMat);
    dome.position.y = top - 0.02;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 8), aMat);
    brim.position.set(0, top, 0.17);
    brim.scale.z = 1.6;
    face.add(dome, brim);
  } else if (kind === 'bow') {
    const mid = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), aMat);
    mid.position.set(0, top + 0.06, 0);
    face.add(mid);
    for (const x of [-0.09, 0.09]) {
      const wing = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.14, 4), aMat);
      wing.position.set(x, top + 0.06, 0);
      wing.rotation.z = x > 0 ? -Math.PI / 2 : Math.PI / 2;
      face.add(wing);
    }
  } else if (kind === 'spikes') {
    for (let i = 0; i < 4; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 4), aMat);
      const a = -0.6 + i * 0.4;
      spike.position.set(Math.sin(a) * 0.3, top - 0.05 + Math.cos(a) * 0.12, -0.12);
      spike.rotation.z = -a;
      spike.rotation.x = -0.5;
      face.add(spike);
    }
  } else if (kind === 'glasses') {
    const gMat = flat(0x2a2440);
    for (const x of [-0.13, 0.13]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.015, 6, 12), gMat);
      rim.position.set(x, 0.08, 0.34);
      face.add(rim);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.02), gMat);
    bridge.position.set(0, 0.08, 0.34);
    face.add(bridge);
  } else if (kind === 'flower') {
    const cen = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), flat(0xffc93d));
    cen.position.set(0.12, top + 0.05, 0.08);
    face.add(cen);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const petal = new THREE.Mesh(new THREE.SphereGeometry(0.035, 5, 4), aMat);
      petal.position.set(0.12 + Math.cos(a) * 0.06, top + 0.05 + Math.sin(a) * 0.06, 0.08);
      face.add(petal);
    }
  } else if (kind === 'headphones') {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.03, 6, 14, Math.PI), aMat);
    band.position.y = 0.02;
    face.add(band);
    for (const x of [-0.36, 0.36]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.07, 8), aMat);
      cup.position.set(x, 0.02, 0);
      cup.rotation.z = Math.PI / 2;
      face.add(cup);
    }
  } else if (kind === 'ninja') {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.1, 10, 1, true), flat(0x2a2440));
    band.position.y = 0.16;
    face.add(band);
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), flat(0x2a2440));
    knot.position.set(0, 0.16, -0.34);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.02), aMat);
    tail.position.set(0.04, 0.03, -0.38);
    tail.rotation.z = 0.3;
    face.add(knot, tail);
  }
  void bodyColor;
}

// Spin the body as it rolls: dist in tiles, dir {x,z}
export function rollBody(bloop, dir, dist) {
  const { body } = bloop.userData;
  const axis = new THREE.Vector3(dir.z, 0, -dir.x).normalize().negate();
  const angle = (dist / 0.38) * -1; // radius ~0.38
  body.rotateOnWorldAxis(axis, angle);
}
