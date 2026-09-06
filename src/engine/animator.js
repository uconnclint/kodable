// Plays back interpreter step lists as a 3D animation of the bloop.
//
// The interpreter emits one `move` step per *tile*, but a single command rolls
// until it is blocked, so a command is usually a run of several moves. Animating
// each tile independently is what made the old playback feel like a chess piece
// being slid: every tile had the same speed, started instantly and stopped dead.
//
// So the unit of animation here is the **run**, not the tile. On the first move
// step the whole contiguous run is gathered (including the mid-run condition
// turns and pickups), and the bloop is driven along that polyline by a single
// velocity profile: a short ramp up, a cruise, and a longer settle at the end.
// Corners inside a run are rounded rather than snapped, so speed carries
// through a turn the way it would for a real ball. That is the entire reason
// the motion has weight now; the squash, the trail and the particles are all
// secondary to it.
import * as THREE from 'three';
import { onFrame, TILE_COLORS } from './renderer.js';
import { gridToWorld, removeItemAt } from './world.js';
import { rollBody } from './bloop.js';
import { playSfx } from '../audio/sfx.js';
import {
  ease, clamp01, spring, createTrail, clearFx,
  collect as fxCollect, turnPulse, land as fxLand, bump as fxBump,
  celebrate as fxCelebrate, fizzle as fxFizzle, emit as fxEmit,
} from './fx.js';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
// A run of d tiles takes RUN_BASE + PER_TILE * (d - 1) seconds. The old code
// spent a flat 0.16s per tile, so this is *slower* only for a single-tile move
// (0.20s) and faster for everything longer: a five-tile roll drops from 0.80s
// to 0.70s and an eight-tile roll from 1.28s to 1.08s. A child stepping a
// twelve-command program therefore waits less than before overall, while the
// one case that got slower is the one that most needed the extra 40ms -- a
// single tile is the only move short enough to be over before it registers.
// Measured against every level's stored solution: 298 rolls, 79% of them one
// or two tiles long. Total playback across the whole game is 1.9% *shorter*
// than the old flat 0.16s/tile, so nothing in the game got slower to sit
// through -- the time was redistributed into ramps rather than added.
const RUN_BASE = 0.20;
const PER_TILE = 0.125;
// Ramp lengths in *seconds*, not fractions: a long roll should not spend half
// its life accelerating just because it is long. They are scaled down only
// when the run is too short to contain them.
const ACCEL_T = 0.13;
const DECEL_T = 0.19;
// Anticipation: the crouch and pull-back before the bloop leaves. Taken out of
// the run's own budget rather than added to it, so it costs no extra time.
const ANTIC_MAX = 0.06;
// Corner fillet radius, in tiles. A true circular arc tangent to both legs:
// for a 90 degree turn the tangent points sit exactly CORNER_R back from the
// tile centre and the arc's radius *is* CORNER_R, so the curve never exceeds
// that curvature. The previous smootherstep blend passed through the corner
// vertex exactly, which meant the "rounded" corner still had a spike of
// curvature at its apex -- the roll snapped through it, and preview.js, which
// traces the same curve, folded its ribbon over itself there.
// Large enough to read as an arc, small enough (0.34 of a tile, so the apex
// sits 0.14 in from the centre) that the bloop still visibly passes over the
// condition tile that turned it.
const CORNER_R = 0.34;
// Bounce wavelength in tiles and its height. Two tiles per bounce puts the
// contacts at ~3.7Hz at cruise -- a believable dribble. One per tile read as
// vibration, which is what the old 0.06 sine was doing.
const BOUNCE_LEN = 2.0;
const BOUNCE_AMP = 0.105;
// How far the bloop pulls back before it leaves, in tiles.
const BACK = 0.05;
const BLOOP_R = 0.38; // rolling radius, matches bloop.js

// Squash/stretch springs. Stiffness/damping chosen for a ~2.5Hz ring with one
// visible overshoot (zeta ~0.5): two overshoots reads as a glitch to a child,
// none reads as rubber. A unit impulse peaks at about 0.040, which is the
// number every kick() below is scaled against -- kick(8) means "squash to
// roughly a third".
const SQ_K = 250, SQ_C = 16;

// ---------------------------------------------------------------------------
// Velocity profile
// ---------------------------------------------------------------------------
// Normalised speed over the run: smoothstep up over `a`, flat, smoothstep down
// over `b`. Distance is the analytic integral, so position and speed can never
// drift apart the way they do when you ease position and differentiate it.
function makeProfile(total) {
  let a = Math.min(ACCEL_T / total, 1);
  let b = Math.min(DECEL_T / total, 1);
  const sum = a + b;
  if (sum > 0.96) { const k = 0.96 / sum; a *= k; b *= k; }
  return { a, b, area: 1 - a / 2 - b / 2 };
}

// Fraction of the run's distance covered by time-fraction u.
function profileDist(p, u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let s;
  if (u < p.a) { const x = u / p.a; s = p.a * (x * x * x - (x * x * x * x) / 2); }
  else if (u > 1 - p.b) { const y = (1 - u) / p.b; s = p.area - p.b * (y * y * y - (y * y * y * y) / 2); }
  else s = p.a / 2 + (u - p.a);
  return s / p.area;
}

// Normalised speed (0..1 of cruise) at time-fraction u. Drives the stretch,
// the bounce height and the trail, so all three stay in lockstep with the
// actual motion instead of being animated on their own clocks.
function profileSpeed(p, u) {
  if (u <= 0 || u >= 1) return 0;
  if (u < p.a) { const x = u / p.a; return x * x * (3 - 2 * x); }
  if (u > 1 - p.b) { const y = (1 - u) / p.b; return y * y * (3 - 2 * y); }
  return 1;
}

// A circular fillet through one 90 degree corner. `e` is the signed offset
// from the corner in tiles, within +/- CORNER_R; `d0` and `d1` are the unit
// directions in and out. The arc is tangent to both legs at e = -/+ CORNER_R,
// so the curve is C1 with the straight sections either side and its curvature
// never exceeds 1 / CORNER_R anywhere -- which is the property preview.js needs
// to offset a ribbon along it without the inner edge folding over itself.
// preview.js keeps its own copy of this so the prediction and the real roll
// trace the same curve; if the two ever diverge the feature teaches a lie.
function cornerArc(P, d0, d1, e, out) {
  const th = ((e + CORNER_R) / (2 * CORNER_R)) * (Math.PI / 2);
  const c = Math.cos(th), s = Math.sin(th);
  return out.set(
    P.x + CORNER_R * (-d0.x + d1.x + s * d0.x - c * d1.x),
    P.y,
    P.z + CORNER_R * (-d0.z + d1.z + s * d0.z - c * d1.z),
  );
}

// Critically-ish damped follow, used for the face's lag behind the body. This
// is the "secondary motion that continues after the primary stops": the head
// keeps nodding for a moment after the ball has come to rest.
function follow(state, target, dt, k, c) {
  const n = dt > 0.02 ? Math.ceil(dt / 0.02) : 1;
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    state.v += ((target - state.x) * k - state.v * c) * h;
    state.x += state.v * h;
  }
  return state.x;
}

// Returns a controller { cancel } and invokes callbacks:
// onCommand(srcToken), onDone(result)
export function playRun(bloop, level, result, { onCommand, onDone, trailColor }) {
  const steps = result.steps;
  let i = 0;
  let cancelled = false;
  let stop = null;
  let run = null;      // the active roll, see startRun()
  let jump = null;     // the win hop
  const timers = [];   // small deferred beats (the fail shudder)

  const startPos = gridToWorld(level.start.x, level.start.y, level);
  const base = new THREE.Vector3(startPos.x, 0, startPos.z);
  bloop.position.copy(base);
  bloop.scale.set(1, 1, 1);

  const face = bloop.userData && bloop.userData.face;
  const body = bloop.userData && bloop.userData.body;
  if (face) face.scale.set(1, 1, 1);
  // The contact shadow under the character belongs to bloop.js. It exposes
  // either a setter or the plane itself, and older rigs expose neither -- all
  // three cases have to animate, so everything here is feature-detected rather
  // than assumed. `air` is 0 on the ground and 1 at the top of the win hop.
  const ud = bloop.userData || {};
  const setShadow = typeof ud.setShadow === 'function' ? ud.setShadow : null;
  const shadowMesh = !setShadow && ud.shadow && ud.shadow.isObject3D ? ud.shadow : null;
  const shadowBase = shadowMesh ? shadowMesh.scale.clone() : null;
  const trailCol = new THREE.Color(trailColor || '#ffffff');
  const trail = createTrail(trailCol);

  // --- rig state -------------------------------------------------------------
  const sq = spring(SQ_K, SQ_C);          // vertical squash: + is squashed
  const ax = spring(SQ_K * 1.15, SQ_C);   // compression along `axis` (impacts)
  const axis = new THREE.Vector3(1, 0, 0);
  const recoil = spring(320, 19);         // positional kickback along `axis`, in tiles
  // Seeded from wherever the idle animation left the face, so pressing RUN
  // does not snap the head straight in a single frame.
  const leanX = { x: face ? face.rotation.x : 0, v: 0 };  // face lag about X
  const leanZ = { x: face ? face.rotation.z : 0, v: 0 };  // face lag about Z
  let droop = 0;                          // held forward tilt on failure
  let deflate = 0;                        // held squash on failure
  const vel = new THREE.Vector3();
  const prevVel = new THREE.Vector3();
  const accel = new THREE.Vector3();
  const dirV = new THREE.Vector3(1, 0, 0);
  const worldPos = new THREE.Vector3();
  const prevPos = new THREE.Vector3().copy(base);
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  let rollSfxAt = -1;
  let sparkAcc = 0;
  let idleT = 0;
  let lastRunD = 0;   // tiles in the roll that just ended; scales the bump

  const after = (delay, fn) => timers.push({ t: delay, fn });

  // --- step machine ----------------------------------------------------------

  function next() {
    for (;;) {
      if (cancelled) return;
      if (i >= steps.length) { finish(550); return; }
      const s = steps[i];
      if (s.type === 'move') { startRun(); return; }
      i++;
      switch (s.type) {
        case 'command':
          if (onCommand) onCommand(s.src);
          playSfx('select');
          lastRunD = 0; // a new command always starts from a standstill
          break;
        case 'collect':
          doCollect(s);
          break;
        case 'turn':
          doTurn(s);
          break;
        case 'blocked':
          doBlocked(s);
          break;
        case 'win':
          doWin(s);
          return;
        case 'fail':
          doFail(s);
          return;
        default:
          break;
      }
    }
  }

  // Gathers one contiguous roll: every tile the bloop crosses without stopping,
  // plus the pickups and condition turns that happen on the way.
  function startRun() {
    const P = [base.clone()];
    const ev = [null];
    for (; i < steps.length;) {
      const s = steps[i];
      if (s.type === 'move') {
        const w = gridToWorld(s.to.x, s.to.y, level);
        P.push(new THREE.Vector3(w.x, 0, w.z));
        ev.push([]);
        i++;
      } else if (s.type === 'collect' || s.type === 'turn') {
        ev[ev.length - 1].push(s);
        i++;
      } else if (s.type === 'win') {
        ev[ev.length - 1].push(s);
        i++;
        break; // the roll ends on the exit tile; nothing follows it
      } else {
        break; // blocked / fail / the next command all end the roll
      }
    }

    const d = P.length - 1;
    const dirs = [];
    for (let k = 0; k < d; k++) dirs.push(_dir(P[k], P[k + 1]));
    const corner = [];
    for (let k = 0; k <= d; k++) {
      corner.push(k > 0 && k < d && dirs[k - 1].distanceToSquared(dirs[k]) > 1e-6);
    }

    const total = RUN_BASE + PER_TILE * (d - 1);
    const antic = Math.min(ANTIC_MAX, total * 0.28);
    const glide = total - antic;
    run = {
      P, ev, dirs, corner, d, antic, glide,
      prof: makeProfile(glide),
      t: 0, phase: 'antic', fired: 1, s: 0, won: false,
    };
    dirV.copy(dirs[0]);
  }

  function _dir(a, b) {
    return new THREE.Vector3(Math.sign(b.x - a.x), 0, Math.sign(b.z - a.z));
  }

  // Position at arc-length `s` (in tiles) along the run, corners filleted.
  function pathPoint(r, s, out) {
    const k = Math.min(Math.max(Math.floor(s), 0), r.d - 1);
    const j = Math.round(s);
    if (j >= 1 && j <= r.d - 1 && r.corner[j] && Math.abs(s - j) < CORNER_R) {
      return cornerArc(r.P[j], r.dirs[j - 1], r.dirs[j], s - j, out);
    }
    return out.copy(r.P[k]).addScaledVector(r.dirs[k], s - k);
  }

  function doCollect(s) {
    const m = removeItemAt(s.at.x, s.at.y);
    const p = gridToWorld(s.at.x, s.at.y, level);
    const at = m ? m.position.clone() : new THREE.Vector3(p.x, 0.5, p.z);
    // A tiny stretch, not a squash: a pickup should lift the character.
    if (s.item === 'star') { playSfx('star'); sq.kick(-2.6); }
    else { playSfx('coin'); sq.kick(-1.4); }
    fxCollect(at, s.item, m);
  }

  function doTurn(s) {
    playSfx('turn');
    const p = gridToWorld(s.at.x, s.at.y, level);
    turnPulse(new THREE.Vector3(p.x, 0, p.z), TILE_COLORS[s.color] || 0xffffff);
  }

  function doBlocked(s) {
    playSfx('roll');
    const v = DIR_VEC[s.d];
    if (!v) return;
    axis.set(v.x, 0, v.z);
    // Scaled by how far the bloop had been rolling, so nudging a wall from a
    // standing start is a tap and arriving off a six-tile run is a thump. A
    // fixed-size bump was the old code's other tell that nothing had weight.
    const power = Math.min(1, 0.28 + lastRunD * 0.13);
    // Compress along the direction of travel, kick back out of the wall, and
    // let both springs ring down. Squash on impact, overshoot on release --
    // the two halves the old raw-sine bump was missing.
    ax.kick(2.2 + 4.4 * power);
    recoil.kick(-(0.8 + 1.7 * power));
    sq.kick(1.0 + 4.2 * power);
    lastRunD = 0;
    const p = gridToWorld(s.at.x, s.at.y, level);
    fxBump(new THREE.Vector3(p.x, 0.05, p.z), axis, power);
  }

  function doWin(s) {
    playSfx('win');
    const p = gridToWorld(s.at.x, s.at.y, level);
    // Centred on where Bloop actually *is*, not on the exit tile's centre. The
    // roll's fillet leaves the character a little off-centre on its last tile,
    // and a burst anchored to the tile instead of to the character is what made
    // the first pass read as a decal painted inside one tile's rectangle
    // rather than as something coming out of Bloop.
    const at = new THREE.Vector3(bloop.position.x, 0, bloop.position.z);
    if (!isFinite(at.x) || !isFinite(at.z)) at.set(p.x, 0, p.z);
    // Escalation: a plain clear is magnitude 3, collecting every star on the
    // board is 4. (5 is reserved for finishing a world; the animator is not
    // told about that, so main.js would have to raise it.)
    const perfect = level.stars.length > 0 && result.starsGot >= level.stars.length;
    fxCelebrate(at, perfect ? 4 : 3, trailCol);
    // The character itself is the celebration's subject: it crouches, jumps and
    // spins. Two burst() calls could never carry this moment on their own.
    //
    // The perfect clear gets a *different hop*, not a bigger one: higher, and
    // held at the apex (see `hang` below) so the character floats for a beat,
    // then a second small bounce on landing. Escalating by scaling one curve up
    // is the mistake the effects ladder used to make.
    sq.kick(perfect ? 12 : 10);
    jump = {
      t: 0, life: perfect ? 0.92 : 0.72, h: perfect ? 0.86 : 0.66,
      hang: perfect ? 0.24 : 0, at, again: perfect,
    };
    // The celebration's own timeline runs to about 1.9s (the confetti's 1.5s
    // life starting at 0.13s, and on a perfect clear a second volley at 0.62s).
    // Reporting the result at 0.62 + 0.78s put the modal's backdrop blur over
    // the top of it 1.4s in, so the escalation the perfect clear exists to show
    // got a fraction of a second of screen time and the rest played behind
    // frosted glass. The modal now arrives as the last sparkles die.
    after(0.62, () => finish(perfect ? 1900 : 1650));
  }

  function doFail(s) {
    playSfx('fail');
    const p = gridToWorld(s.at.x, s.at.y, level);
    fxFizzle(new THREE.Vector3(p.x, 0, p.z));
    // Deflate and droop rather than shake: a wrong answer should read as "that
    // did not work", never as an error buzzer.
    sq.kick(12);
    deflate = 1;
    droop = 1;
    axis.set(1, 0, 0);
    recoil.kick(3.4);
    after(0.09, () => recoil.kick(-5.2));
    after(0.20, () => recoil.kick(3.6));
    after(0.32, () => recoil.kick(-1.8));
    finish(900);
  }

  function finish(delay) {
    if (cancelled) return;
    setTimeout(() => { if (!cancelled && onDone) onDone(result); }, delay);
    // The frame updater has to outlive the last step -- the celebration hop,
    // the springs and the trail are all still ringing down when the result is
    // reported -- but it must not outlive them, or every completed run would
    // leave another copy of it driving the bloop behind the results dialog.
    setTimeout(() => { if (!cancelled && stop) { stop(); stop = null; } }, delay + 1400);
  }

  // --- frame -----------------------------------------------------------------

  stop = onFrame((dt) => {
    idleT += dt;

    for (let k = timers.length - 1; k >= 0; k--) {
      timers[k].t -= dt;
      if (timers[k].t <= 0) { const fn = timers[k].fn; timers.splice(k, 1); fn(); }
    }

    let vn = 0;          // normalised speed, 0..1 of cruise
    let bounceY = 0;
    let contact = 0;     // 0..1, how hard the ball is meeting the ground
    let antic = 0;

    if (run) {
      run.t += dt;
      if (run.phase === 'antic') {
        antic = clamp01(run.t / run.antic);
        // Crouch and lean back into the direction it is about to leave.
        worldPos.copy(run.P[0]).addScaledVector(run.dirs[0], -BACK * ease.outCubic(antic));
        if (run.t >= run.antic) {
          run.phase = 'glide';
          run.t -= run.antic; // carry the leftover, never drop a frame of motion
          sq.kick(-5.5);      // release: the crouch springs into a stretch
        }
      }
      if (run.phase === 'glide') {
        const u = clamp01(run.t / run.glide);
        vn = profileSpeed(run.prof, u);
        const sNew = profileDist(run.prof, u) * run.d;
        // Fire the tile events the bloop has just rolled over.
        while (run.fired <= run.d && sNew >= run.fired - 0.001) {
          const list = run.ev[run.fired];
          run.fired++;
          if (idleT - rollSfxAt > 0.1) { playSfx('roll'); rollSfxAt = idleT; }
          if (list) for (let k = 0; k < list.length; k++) {
            const st = list[k];
            if (st.type === 'collect') doCollect(st);
            else if (st.type === 'turn') doTurn(st);
            else if (st.type === 'win') { run.won = true; doWin(st); }
          }
        }
        const ds = sNew - run.s;
        run.s = sNew;
        pathPoint(run, sNew, worldPos);
        // Release the anticipation pull-back over the first 100ms of the glide
        // instead of snapping it away on the phase change.
        if (run.t < 0.1) {
          worldPos.addScaledVector(run.dirs[0], -BACK * (1 - ease.outQuad(run.t / 0.1)));
        }

        // Direction from the actual curve, so a rounded corner banks the roll
        // instead of snapping the spin axis 90 degrees in one frame.
        const eps = 0.02;
        pathPoint(run, Math.max(0, sNew - eps), _a);
        pathPoint(run, Math.min(run.d, sNew + eps), _b);
        if (_b.distanceToSquared(_a) > 1e-9) dirV.copy(_b).sub(_a).normalize();
        if (body) rollBody(bloop, { x: dirV.x, z: dirV.z }, ds);

        // Bounce phase is locked to distance travelled, never to time, so
        // acceleration cannot make the ball stutter mid-arc.
        const ph = (sNew / BOUNCE_LEN) % 1;
        const amp = BOUNCE_AMP * Math.pow(vn, 0.8);
        bounceY = amp * 4 * ph * (1 - ph);
        // Contact is a *brief* event -- about 18% of each bounce cycle. Widen
        // the window and the squash stops reading as an impact and starts
        // reading as the character's resting shape.
        const nearGround = Math.min(ph, 1 - ph);
        contact = Math.max(0, 1 - nearGround / 0.09) * Math.pow(vn, 0.8);

        // Trail sparks: sparse, and only while genuinely quick.
        sparkAcc += dt;
        if (vn > 0.55 && sparkAcc > 0.07) {
          sparkAcc = 0;
          _a.copy(worldPos).setY(0.3 + bounceY);
          fxEmit({
            pos: _a, count: 2, shape: 'sphere', sprite: 'blob', curve: 'pop',
            speed: [0.2, 0.9], size: [0.07, 0.02], life: [0.18, 0.34],
            colors: [trailCol], gravity: -0.6, drag: 3, alpha: 0.5, radius: 0.14,
          });
        }

        if (u >= 1) {
          const won = run.won;
          const d0 = run.d;
          base.copy(run.P[run.d]);
          worldPos.copy(base);
          run = null;
          if (!won) {
            lastRunD = d0;
            // A roll only ever stops because the path ran out, so the `blocked`
            // step that follows owns the arrival: it squashes, recoils and
            // kicks up dust, scaled by lastRunD. Firing a landing here as well
            // stacked two effects on one frame. The land branch is kept for the
            // defensive case where a roll somehow ends without a block.
            const nextStep = steps[i];
            if (!nextStep || nextStep.type !== 'blocked') {
              sq.kick(4.5 + Math.min(d0, 6) * 0.7);
              fxLand(base, Math.min(1, 0.25 + d0 * 0.12));
            }
            next();
          }
        }
      }
    } else {
      worldPos.copy(base);
    }

    // --- the win hop ---------------------------------------------------------
    let jumpY = 0;
    if (jump) {
      jump.t += dt;
      const u = clamp01(jump.t / jump.life);
      // Up fast, down slow: a real ballistic arc hangs at the top. `hang` adds
      // an explicit float at the apex for the perfect clear -- not a freeze,
      // a few centimetres of sag over the hold, which is what makes the
      // character look pleased with itself rather than paused.
      const rise = 0.44 * (1 - jump.hang);
      const fall = 1 - rise - jump.hang;
      if (u < rise) jumpY = jump.h * ease.outQuad(u / rise);
      else if (u < rise + jump.hang) {
        const k = (u - rise) / jump.hang;
        jumpY = jump.h * (1 - 0.055 * k * k);
      } else jumpY = jump.h * 0.945 * (1 - ease.inQuad((u - rise - jump.hang) / fall));
      if (body) body.rotation.y += dt * (9 - 6 * u);
      if (u >= 1) {
        const again = jump.again;
        const at = jump.at;
        sq.kick(9);
        fxLand(at, 1);
        // A perfect clear bounces once more. A second, smaller arc is a
        // different event; the same arc played taller is only a bigger number.
        jump = again
          ? { t: 0, life: 0.40, h: 0.24, hang: 0, at, again: false }
          : null;
      }
    }

    // --- rig composition -----------------------------------------------------
    // Velocity and acceleration are measured from the finished position, so the
    // secondary motion is driven by what actually happened on screen rather
    // than by a parallel animation that can fall out of sync.
    prevVel.copy(vel);
    vel.copy(worldPos).sub(prevPos).divideScalar(Math.max(dt, 1e-4));
    prevPos.copy(worldPos);
    accel.copy(vel).sub(prevVel).divideScalar(Math.max(dt, 1e-4));
    // A short roll can pull 150+ tiles/s^2 out of the profile, so the clamp has
    // to sit above the common case or every launch and every stop would peg the
    // lean at its limit and the lag would read as a two-state toggle.
    accel.clampScalar(-260, 260);

    const q = sq.step(dt) + deflate * 0.30;
    const r = ax.step(dt);
    const kick = recoil.step(dt);

    bloop.position.set(
      worldPos.x + axis.x * kick,
      worldPos.y + bounceY + jumpY,
      worldPos.z + axis.z * kick,
    );

    const dx = Math.abs(dirV.x), dz = Math.abs(dirV.z);
    let sx = 1, sy = 1, sz = 1;
    // Stretch through fast motion, pinch across it.
    const gs = 0.16 * vn, gp = 0.06 * vn;
    sx += gs * dx - gp * dz; sz += gs * dz - gp * dx; sy -= gp;
    // Contact squash on each bounce.
    sy -= contact * 0.11; sx += contact * 0.06; sz += contact * 0.06;
    // The body carries a blob deformation, so vertical scale does not just make
    // an ellipsoid of it -- it multiplies the noise, and every lobe near a pole
    // is drawn out into a point. Floor the *continuous* part of the squash (the
    // speed pinch and the per-bounce contact, both of which are on screen for
    // most of every roll) well above where that starts to show. The springs
    // below are impulses that ring out in a couple of hundred milliseconds and
    // are allowed to go further, because a deformation nobody has time to
    // resolve is exactly what squash and stretch is for.
    sy = Math.max(sy, 0.70);
    // Anticipation crouch.
    sy -= antic * 0.13; sx += antic * 0.08; sz += antic * 0.08;
    // Vertical spring: landings, pickups, the win hop, the fail deflate.
    // Volume is roughly conserved (0.55 down against 0.30 out either side), so
    // the character deforms instead of appearing to change size.
    const qc = Math.max(-0.4, Math.min(0.6, q));
    sy -= qc * 0.55; sx += qc * 0.30; sz += qc * 0.30;
    // Axial spring: the blocked bump compresses along the travel axis only,
    // and bulges across it. This is the only place a *directional* squash
    // happens, and it is what makes the wall read as solid.
    const rc = Math.max(-0.35, Math.min(0.55, r));
    sx -= rc * 0.85 * dx; sz -= rc * 0.85 * dz;
    sy += rc * 0.40; sx += rc * 0.42 * dz; sz += rc * 0.42 * dx;
    // One last band on the composite. Two springs can stack -- a pickup landing
    // on top of a bounce -- and past about 1.3 vertical the pole lobes stop
    // being a stretched ball and start being a teardrop with a spike on it.
    sx = Math.min(Math.max(sx, 0.62), 1.38);
    sy = Math.min(Math.max(sy, 0.56), 1.30);
    sz = Math.min(Math.max(sz, 0.62), 1.38);
    bloop.scale.set(sx, sy, sz);

    // Face and accessories lag the body, then overshoot back. A hard stop tops
    // out near 12 degrees, which reads clearly at arm's length without the eyes
    // ever swinging away from the front. The spring is what carries the nod on
    // after the ball itself has stopped.
    if (face) {
      const tz = Math.max(-0.22, Math.min(0.22, accel.x * 0.0011));
      const tx = Math.max(-0.22, Math.min(0.22, -accel.z * 0.0011)) + droop * 0.3;
      face.rotation.z = follow(leanZ, tz, dt, 190, 17);
      face.rotation.x = follow(leanX, tx, dt, 190, 17);
      // The face is a child of the scaled group, so without this the eyes
      // elongate and squeeze together with every squash -- and a squashed eye
      // is not a squashed ball, it is a different expression. At 1.5:1 the
      // character stopped reading as delighted and started reading as alarmed.
      // 60% compensation: the face still follows the deformation enough to
      // belong to the body, but the eyes keep their shape.
      face.scale.set(
        1 / sx * 0.6 + 0.4,
        1 / sy * 0.6 + 0.4,
        1 / sz * 0.6 + 0.4,
      );
    }

    // Contact shadow. It shrinks as the character leaves the ground and snaps
    // back under it on landing; without that the win hop reads as the board
    // moving down rather than as Bloop going up.
    const air = clamp01((bounceY + jumpY) / 0.66);
    if (setShadow) setShadow(air);
    else if (shadowMesh) {
      const k = 1 - air * 0.42;
      shadowMesh.scale.set(shadowBase.x * k, shadowBase.y * k, shadowBase.z * k);
    }

    // The trail is pinned to the ground under the character rather than to its
    // centre: fx.js draws it flat on the tiles, so it needs the ground point.
    trail.update(_a.set(bloop.position.x, 0, bloop.position.z), dt);
  });

  next();

  return {
    cancel() {
      cancelled = true;
      if (stop) { stop(); stop = null; }
      trail.dispose();
      clearFx();
      bloop.scale.set(1, 1, 1);
      if (face) { face.rotation.set(0, 0, 0); face.scale.set(1, 1, 1); }
      if (setShadow) setShadow(0);
      else if (shadowMesh) shadowMesh.scale.copy(shadowBase);
    },
  };
}

const DIR_VEC = {
  U: { x: 0, z: -1 }, D: { x: 0, z: 1 }, L: { x: -1, z: 0 }, R: { x: 1, z: 0 },
};
// Gentle idle: a slow breath, a lazy turn and a tiny sway. The face keeps its
// own phase so the character never looks like one rigid object bobbing.
export function idleBloop(bloop) {
  const baseY = bloop.position.y;
  const baseX = bloop.position.x;
  const body = bloop.userData && bloop.userData.body;
  const face = bloop.userData && bloop.userData.face;
  bloop.scale.set(1, 1, 1);
  // A run that ended mid-squash leaves the face counter-scaled; the idle owns
  // the resting pose, so it clears it rather than inheriting it.
  if (face) face.scale.set(1, 1, 1);
  return onFrame((dt, t) => {
    if (body) body.rotation.y += dt * 0.4;
    // Breathing as a squash pair rather than a bob alone: volume is roughly
    // conserved, which is what stops it looking like the model is scaling.
    const br = Math.sin(t * 1.7);
    const puff = br * 0.022;
    bloop.scale.set(1 + puff, 1 - puff * 0.9, 1 + puff);
    bloop.position.y = baseY + Math.max(0, br) * 0.045;
    bloop.position.x = baseX + Math.sin(t * 0.63) * 0.018;
    if (face) {
      face.rotation.z = Math.sin(t * 0.63 + 1.1) * 0.045;
      face.rotation.x = Math.sin(t * 1.7 - 0.6) * 0.03;
    }
  });
}
