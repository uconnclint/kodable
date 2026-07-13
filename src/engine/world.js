// Builds the 3D floating-island maze for a parsed level.
import * as THREE from 'three';
import { TILE_COLORS, applyTheme, onFrame, getScene, frameView } from './renderer.js';

let current = null; // { group, itemMeshes: Map"x,y"->mesh, portal, dispose() }

const flat = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9, ...extra });

function starGeometry() {
  const shape = new THREE.Shape();
  const R = 0.28, r = 0.12;
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
  }
  return new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false });
}
const STAR_GEO = starGeometry();

export function gridToWorld(x, y, level) {
  return new THREE.Vector3(x - (level.cols - 1) / 2, 0, y - (level.rows - 1) / 2);
}

export function buildLevel(level, worldNum) {
  disposeLevel();
  const theme = applyTheme(worldNum);
  const scene = getScene();
  const group = new THREE.Group();
  const itemMeshes = new Map();
  const stops = [];

  const grassMat = flat(theme.grass);
  const dirtMat = flat(theme.dirt);
  const topGeo = new THREE.BoxGeometry(0.98, 0.18, 0.98);
  const baseGeo = new THREE.BoxGeometry(0.9, 0.7, 0.9);

  for (let y = 0; y < level.rows; y++) {
    for (let x = 0; x < level.cols; x++) {
      const t = level.tiles[y][x];
      if (!t) continue;
      const p = gridToWorld(x, y, level);

      let topMat = grassMat;
      if (t.kind === 'color') topMat = flat(TILE_COLORS[t.color], { emissive: TILE_COLORS[t.color], emissiveIntensity: 0.25 });
      if (t.kind === 'exit') topMat = flat(0xd9c8ff, { emissive: 0x7c5cff, emissiveIntensity: 0.35 });

      const top = new THREE.Mesh(topGeo, topMat);
      top.position.set(p.x, -0.09, p.z);
      top.receiveShadow = true;
      group.add(top);

      const base = new THREE.Mesh(baseGeo, dirtMat);
      base.position.set(p.x, -0.55, p.z);
      base.receiveShadow = true;
      group.add(base);

      // hanging rock for floating-island silhouette (sparse)
      if ((x * 7 + y * 13) % 4 === 0) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.7 + ((x + y) % 3) * 0.3, 5), dirtMat);
        cone.rotation.x = Math.PI;
        cone.position.set(p.x, -1.2, p.z);
        group.add(cone);
      }
    }
  }

  // start pad
  {
    const p = gridToWorld(level.start.x, level.start.y, level);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 12), flat(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.2 }));
    ring.position.set(p.x, 0.02, p.z);
    group.add(ring);
  }

  // exit portal: spinning ring + inner glow
  const portal = new THREE.Group();
  {
    const p = gridToWorld(level.exit.x, level.exit.y, level);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.07, 6, 14), flat(0xffc93d, { emissive: 0xffb02e, emissiveIntensity: 0.6 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.12;
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 12), new THREE.MeshBasicMaterial({ color: 0xfff0b8, transparent: true, opacity: 0.7 }));
    glow.position.y = 0.05;
    portal.add(ring, glow);
    portal.position.set(p.x, 0, p.z);
    group.add(portal);
    stops.push(onFrame((dt, t) => {
      ring.rotation.z += dt * 1.2;
      ring.position.y = 0.12 + Math.sin(t * 2.4) * 0.05;
      glow.material.opacity = 0.55 + Math.sin(t * 3) * 0.2;
    }));
  }

  // stars
  const starMat = flat(0xffc93d, { emissive: 0xffb02e, emissiveIntensity: 0.5 });
  for (const s of level.stars) {
    const p = gridToWorld(s.x, s.y, level);
    const m = new THREE.Mesh(STAR_GEO, starMat);
    m.position.set(p.x, 0.5, p.z);
    m.castShadow = true;
    m.userData.baseY = 0.5;
    group.add(m);
    itemMeshes.set(`${s.x},${s.y}`, m);
  }
  // coins
  const coinMat = flat(0xffd95e, { emissive: 0xcf9b1d, emissiveIntensity: 0.35, metalness: 0.4 });
  for (const c of level.coins) {
    const p = gridToWorld(c.x, c.y, level);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 10), coinMat);
    m.rotation.z = Math.PI / 2;
    m.position.set(p.x, 0.45, p.z);
    m.castShadow = true;
    m.userData.baseY = 0.45;
    group.add(m);
    itemMeshes.set(`${c.x},${c.y}`, m);
  }
  stops.push(onFrame((dt, t) => {
    for (const m of itemMeshes.values()) {
      m.rotation.y += dt * 2.2;
      m.position.y = m.userData.baseY + Math.sin(t * 2.5 + m.position.x) * 0.07;
    }
  }));

  addDecorations(group, level, theme);

  scene.add(group);
  frameView(new THREE.Vector3(0, 0, 0), level.cols, level.rows, { instant: false });

  current = {
    group, itemMeshes, portal, level,
    dispose() {
      stops.forEach((s) => s());
      scene.remove(group);
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
  if (m) { current.group.remove(m); current.itemMeshes.delete(key); }
  return m;
}

// ---- per-world decoration on empty cells adjacent to the island ----
function addDecorations(group, level, theme) {
  const rng = mulberry(level.rows * 31 + level.cols * 7);
  for (let y = 0; y < level.rows; y++) {
    for (let x = 0; x < level.cols; x++) {
      const t = level.tiles[y][x];
      if (!t || t.kind !== 'path') continue;
      if (rng() > 0.22) continue;
      const p = gridToWorld(x, y, level);
      const off = { x: (rng() - 0.5) * 0.6, z: (rng() - 0.5) * 0.6 };
      const deco = makeDeco(theme.deco, rng);
      if (!deco) continue;
      deco.position.set(p.x + off.x * 0.4, 0, p.z + off.z * 0.4);
      // keep decor at tile edges so it doesn't block the read of the path
      deco.position.x += Math.sign(off.x) * 0.32;
      deco.position.z += Math.sign(off.z) * 0.32;
      deco.scale.setScalar(0.55 + rng() * 0.3);
      group.add(deco);
    }
  }
}

function makeDeco(kind, rng) {
  const g = new THREE.Group();
  if (kind === 'meadow') {
    if (rng() < 0.5) {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.3, 5), flat(0x4c9c46));
      stem.position.y = 0.15;
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), flat([0xff6fae, 0xffc93d, 0xffffff][Math.floor(rng() * 3)]));
      head.position.y = 0.34;
      g.add(stem, head);
    } else {
      const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 5), flat(0x5cb653));
      tuft.position.y = 0.14;
      g.add(tuft);
    }
  } else if (kind === 'crystal') {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.45, 5), flat(0x9d7bff, { emissive: 0x6a3fe0, emissiveIntensity: 0.5 }));
    c.position.y = 0.22;
    c.rotation.z = (rng() - 0.5) * 0.4;
    g.add(c);
  } else if (kind === 'canyon') {
    const cactus = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.3, 2, 6), flat(0x4c9c46));
    cactus.position.y = 0.25;
    g.add(cactus);
  } else if (kind === 'tech') {
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 6), flat(0x8fa8c8, { metalness: 0.6, roughness: 0.4 }));
    bolt.position.y = 0.06;
    g.add(bolt);
  } else if (kind === 'storm') {
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 0), flat(0x6e788a));
    rock.position.y = 0.1;
    const shard = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 4), flat(0xff5c5c, { emissive: 0xc22525, emissiveIntensity: 0.5 }));
    shard.position.y = 0.28;
    g.add(rock, shard);
  }
  return g;
}

function mulberry(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
