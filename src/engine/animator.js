// Plays back interpreter step lists as a 3D animation of the bloop.
import * as THREE from 'three';
import { onFrame, burst } from './renderer.js';
import { gridToWorld, removeItemAt } from './world.js';
import { rollBody } from './bloop.js';
import { playSfx } from '../audio/sfx.js';

const MOVE_TIME = 0.16; // seconds per tile

// Returns a controller { cancel } and invokes callbacks:
// onCommand(srcToken), onDone(result)
export function playRun(bloop, level, result, { onCommand, onDone, trailColor }) {
  const steps = result.steps;
  let i = 0;
  let cancelled = false;
  let stop = null;
  let moveState = null; // {from, to, t, dir}
  let idlePhase = 0;

  const startPos = gridToWorld(level.start.x, level.start.y, level);
  bloop.position.set(startPos.x, 0, startPos.z);

  const trailCol = new THREE.Color(trailColor || '#ffffff');

  function next() {
    if (cancelled) return;
    if (i >= steps.length) { finish(); return; }
    const s = steps[i++];
    switch (s.type) {
      case 'command':
        onCommand && onCommand(s.src);
        playSfx('select');
        next();
        break;
      case 'move': {
        const from = bloop.position.clone();
        const to = gridToWorld(s.to.x, s.to.y, level);
        moveState = { from, to: new THREE.Vector3(to.x, 0, to.z), t: 0, d: s.d };
        break; // frame loop advances
      }
      case 'turn':
        playSfx('turn');
        burst(bloop.position.clone().setY(0.4), trailCol, 8, 2, 0.4);
        next();
        break;
      case 'collect': {
        const m = removeItemAt(s.at.x, s.at.y);
        const p = gridToWorld(s.at.x, s.at.y, level);
        if (s.item === 'star') { playSfx('star'); burst(new THREE.Vector3(p.x, 0.5, p.z), 0xffc93d, 18, 3.4, 0.8); }
        else { playSfx('coin'); burst(new THREE.Vector3(p.x, 0.45, p.z), 0xffd95e, 10, 2.6, 0.5); }
        void m;
        next();
        break;
      }
      case 'blocked':
        // little bump squish
        squish();
        next();
        break;
      case 'win':
        playSfx('win');
        burst(bloop.position.clone().setY(0.4), 0xffc93d, 30, 4.5, 1.1);
        burst(bloop.position.clone().setY(0.4), 0xffffff, 20, 3.5, 0.9);
        finish();
        break;
      case 'fail':
        playSfx('fail');
        shake();
        finish();
        break;
      default:
        next();
    }
  }

  function squish() {
    let t = 0;
    const off = onFrame((dt) => {
      t += dt * 8;
      const k = Math.sin(Math.min(t, Math.PI));
      bloop.scale.set(1 + k * 0.15, 1 - k * 0.2, 1 + k * 0.15);
      if (t >= Math.PI) { bloop.scale.set(1, 1, 1); off(); }
    });
  }

  function shake() {
    let t = 0;
    const base = bloop.position.clone();
    const off = onFrame((dt) => {
      t += dt;
      bloop.position.x = base.x + Math.sin(t * 40) * 0.06 * Math.max(0, 0.4 - t);
      if (t > 0.45) { bloop.position.copy(base); off(); }
    });
  }

  function finish() {
    if (stop) { stop(); stop = null; }
    if (!cancelled) setTimeout(() => !cancelled && onDone && onDone(result), 550);
  }

  stop = onFrame((dt) => {
    idlePhase += dt;
    if (!moveState) return;
    moveState.t += dt / MOVE_TIME;
    const k = Math.min(moveState.t, 1);
    bloop.position.lerpVectors(moveState.from, moveState.to, k);
    bloop.position.y = Math.sin(k * Math.PI) * 0.06; // tiny hop per tile
    const dirV = { x: Math.sign(moveState.to.x - moveState.from.x), z: Math.sign(moveState.to.z - moveState.from.z) };
    rollBody(bloop, dirV, dt / MOVE_TIME);
    if (k >= 1) {
      bloop.position.copy(moveState.to);
      moveState = null;
      playSfx('roll');
      next();
    }
  });

  next();

  return {
    cancel() {
      cancelled = true;
      if (stop) { stop(); stop = null; }
    },
  };
}

// Gentle idle bob + spin for menus / pre-run.
export function idleBloop(bloop) {
  const baseY = bloop.position.y;
  return onFrame((dt, t) => {
    bloop.userData.body.rotation.y += dt * 0.4;
    bloop.position.y = baseY + Math.sin(t * 2) * 0.04;
  });
}
