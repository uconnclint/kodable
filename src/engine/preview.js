// Draws a "dry run" of the player's program as a glowing dotted path over the
// board, so kids can check their logic before committing to a real run.
// Non-destructive: never moves the real bloop, never records stats.
import * as THREE from 'three';
import { onFrame, getScene } from './renderer.js';
import { gridToWorld } from './world.js';

let current = null;

export function clearPreviewPath() {
  if (current) { current.dispose(); current = null; }
}

// level: parsed level, result: runProgram() output.
export function showPreviewPath(level, result) {
  clearPreviewPath();
  const scene = getScene();
  const group = new THREE.Group();
  const stops = [];

  // Ordered tile path: start, then every tile the bloop rolls onto.
  const path = [{ x: level.start.x, y: level.start.y }];
  for (const s of result.steps) if (s.type === 'move') path.push({ x: s.to.x, y: s.to.y });

  const win = result.win;
  const col = win ? 0x5ce07a : 0xffb02e;
  const dotGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.04, 14);

  const dots = [];
  path.forEach((p, i) => {
    const w = gridToWorld(p.x, p.y, level);
    const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85 });
    const dot = new THREE.Mesh(dotGeo, mat);
    dot.position.set(w.x, 0.14, w.z);
    dot.userData.i = i;
    group.add(dot);
    dots.push(dot);
  });

  // End marker: pulsing ring (green = reaches goal, amber = stops short).
  const end = path[path.length - 1];
  const ew = gridToWorld(end.x, end.y, level);
  const ringMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.05, 8, 22), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(ew.x, 0.2, ew.z);
  group.add(ring);

  const n = dots.length;
  stops.push(onFrame((dt, t) => {
    // Comet-like crest travelling start -> end to show direction of motion.
    const crest = (t * 6) % (n + 6);
    dots.forEach((d) => {
      const dist = Math.abs(d.userData.i - crest);
      d.material.opacity = 0.4 + Math.max(0, 1 - dist / 3) * 0.55;
      const s = 1 + Math.max(0, 1 - dist / 3) * 0.5;
      d.scale.setScalar(s);
    });
    ring.scale.setScalar(1 + Math.sin(t * 5) * 0.14);
    ring.rotation.z += dt * 1.5;
  }));

  scene.add(group);
  current = { dispose() { stops.forEach((s) => s()); scene.remove(group); } };
}
