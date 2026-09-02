// Three.js scene, camera, lights, sky, clouds, particles, render loop.
import * as THREE from 'three';

export const WORLD_THEMES = {
  0: { sky: 0x8f7bff, fog: 0xa495ff, grass: 0x7ecb5f, dirt: 0x8a5a3c, deco: 'meadow' },
  1: { sky: 0x9adfff, fog: 0xbfeaff, grass: 0x7ecb5f, dirt: 0x8a5a3c, deco: 'meadow' },
  2: { sky: 0x2e2b52, fog: 0x45408a, grass: 0x6fc7c7, dirt: 0x4a4270, deco: 'crystal' },
  3: { sky: 0xffc98a, fog: 0xffddb0, grass: 0xe8a25c, dirt: 0xb05f2e, deco: 'canyon' },
  4: { sky: 0xa8ccff, fog: 0xc9e0ff, grass: 0x6fa8ff, dirt: 0x3e5a8a, deco: 'tech' },
  5: { sky: 0x3a2f4a, fog: 0x584a6e, grass: 0x9aa7b8, dirt: 0x5a6270, deco: 'storm' },
};

export const TILE_COLORS = { p: 0xff6fae, b: 0x4db3ff, g: 0x58cc6d, o: 0xffa53d };

let renderer, scene, camera;
const updaters = new Set();
let clouds = [];
let lastFrameTime = performance.now();
let elapsedTime = 0;

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
    if (fail) fail('This device\u2019s graphics support is too old to run Blooptopia.', 'update');
    throw new Error('WebGL2 is not available on this device.');
  }
  probe.getExtension('WEBGL_lose_context')?.loseContext();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 12, 11);
  camera.lookAt(0, 0, 0);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8877aa, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(6, 14, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -12; sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12; sun.shadow.camera.bottom = -12;
  sun.shadow.camera.far = 50;
  scene.add(sun);

  makeClouds();

  window.addEventListener('resize', resize);
  resize();
  renderer.setAnimationLoop(tick);
  return { scene, camera, renderer };
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function tick() {
  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.2);
  lastFrameTime = now;
  elapsedTime += dt;
  const t = elapsedTime;
  for (const fn of [...updaters]) fn(dt, t);
  for (const c of clouds) {
    c.position.x += c.userData.speed * dt;
    if (c.position.x > 30) c.position.x = -30;
  }
  updateParticles(dt);
  renderer.render(scene, camera);
}

export function onFrame(fn) { updaters.add(fn); return () => updaters.delete(fn); }
export function getScene() { return scene; }
export function getCamera() { return camera; }

export function applyTheme(world) {
  const th = WORLD_THEMES[world] || WORLD_THEMES[0];
  scene.background = new THREE.Color(th.sky);
  scene.fog = new THREE.Fog(th.fog, 22, 60);
  return th;
}

// ---- clouds ----
function makeClouds() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1 });
  for (let i = 0; i < 10; i++) {
    const cloud = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let j = 0; j < n; j++) {
      const s = 0.7 + Math.random() * 1.1;
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), mat);
      m.position.set(j * 1.1 - n * 0.5, Math.random() * 0.4, Math.random() * 0.8);
      m.scale.y = 0.6;
      cloud.add(m);
    }
    cloud.position.set(Math.random() * 60 - 30, 6 + Math.random() * 6, -14 - Math.random() * 18);
    cloud.userData.speed = 0.2 + Math.random() * 0.4;
    scene.add(cloud);
    clouds.push(cloud);
  }
}

// ---- particles ----
const particles = [];
const particleGeo = new THREE.TetrahedronGeometry(0.09);

export function burst(pos, color, count = 14, speed = 3, life = 0.7) {
  const mat = new THREE.MeshBasicMaterial({ color });
  for (let i = 0; i < count; i++) {
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

// Smoothly move camera to frame a box of given size at center.
let camTween = null;
export function frameView(center, spanX, spanZ, opts = {}) {
  const dist = Math.max(spanX * 1.15, spanZ * 1.5, 6) + 4;
  const target = new THREE.Vector3(center.x, 0, center.z);
  const eye = new THREE.Vector3(center.x, dist * 0.95, center.z + dist * 0.78);
  if (opts.instant) {
    camera.position.copy(eye);
    camera.lookAt(target);
    return;
  }
  const from = camera.position.clone();
  const lookFrom = currentLook();
  let t = 0;
  if (camTween) camTween();
  camTween = onFrame((dt) => {
    t = Math.min(1, t + dt * 1.6);
    const e = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(from, eye, e);
    camera.lookAt(lookFrom.clone().lerp(target, e));
    if (t >= 1) { camTween(); camTween = null; }
  });
}

function currentLook() {
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  return camera.position.clone().addScaledVector(d, 10);
}
