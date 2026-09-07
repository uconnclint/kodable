// Copyright (c) 2026 Clint McLeod. All rights reserved.
// Blooptopia 3D — bootstrap & orchestration.
import * as THREE from 'three';
import { initRenderer, applyTheme, frameView, onFrame } from './engine/renderer.js';
import { parseGrid, runProgram } from './engine/interpreter.js';
import { buildLevel, disposeLevel, getCurrentWorldModel } from './engine/world.js';
import { showPreviewPath, clearPreviewPath } from './engine/preview.js';
import { buildBloop, rollBody } from './engine/bloop.js';
import { playRun, idleBloop } from './engine/animator.js';
import { initAudio, startMusic, playSfx } from './audio/sfx.js';
import { state, recordRun, checkUnlocks, levelUnlocked } from './game/save.js';
import { characters } from './game/characters.js';
import { levels as w1 } from './game/levels/world1.js';
import { levels as w2 } from './game/levels/world2.js';
import { levels as w3 } from './game/levels/world3.js';
import { levels as w4 } from './game/levels/world4.js';
import { levels as w5 } from './game/levels/world5.js';
import { initScreens, renderMenu, renderWorldMap, renderLevels, renderAchievements, renderBadges, renderCharacters } from './ui/screens.js';
import { initHud, renderPlay } from './ui/hud.js';
import { toastUnlocks } from './ui/toasts.js';

const allLevels = [...w1, ...w2, ...w3, ...w4, ...w5];

const { scene } = initRenderer();

// audio unlock on first gesture
const unlockAudio = () => { initAudio(); startMusic(currentMusic); document.removeEventListener('pointerdown', unlockAudio); };
document.addEventListener('pointerdown', unlockAudio);
let currentMusic = 0;

function music(world) {
  currentMusic = world;
  startMusic(world);
}

// ---------- backdrop (menu / preview scenes) ----------
let backdrop = null; // { bloop, stopIdle }
const MENU_GRID = [
  '  ###E ',
  ' ##p## ',
  '#S#*## ',
  ' ##*#* ',
  '  ###  ',
];

function clearBackdrop() {
  if (backdrop) {
    if (backdrop.stopIdle) backdrop.stopIdle();
    if (backdrop.bloop) scene.remove(backdrop.bloop);
    backdrop = null;
  }
  disposeLevel();
}

function menuBackdrop() {
  clearBackdrop();
  const parsed = parseGrid(MENU_GRID);
  buildLevel(parsed, 0);
  const bloop = spawnBloop();
  const p = { x: parsed.start.x - (parsed.cols - 1) / 2, z: parsed.start.y - (parsed.rows - 1) / 2 };
  bloop.position.set(p.x, 0, p.z);
  const stopIdle = idleBloop(bloop);
  backdrop = { bloop, stopIdle };
  frameView(new THREE.Vector3(0, 0, 0), parsed.cols + 2, parsed.rows + 2);
}

// The shop's hero. This is the only place in the game a character is shown for
// its own sake, and it was framed as scenery: 448 x 552 pixels of bloop in a
// 3200 x 2000 frame, sitting low and right of the free area with roughly a
// thousand by two thousand pixels of empty purple above it. The card list ends
// at 29% of the width and the info card starts at 71%, so the free pane is
// exactly the middle of the viewport -- which is where the hero framing mode
// aims already. It just needed to be centred *in* it and framed tight.
function previewBackdrop(char) {
  clearBackdrop();
  applyTheme(0);
  const bloop = buildBloop(char);
  bloop.scale.setScalar(2.4);
  // On the origin, so the framing box and the character have the same centre.
  // Offsetting the model inside a loosely framed box is what put it off to one
  // side of its own pane.
  bloop.position.set(0, 0, 0);
  // No contact patch: there is no ground here, and a shadow disc floating in
  // open space reads as a smudge on the backdrop. This is the documented
  // override in bloop.js -- a lift below the floor fades the patch out.
  if (bloop.userData.shadow) bloop.userData.shadow.userData.lift = -1;
  scene.add(bloop);
  let spin = 0;
  const stopIdle = onFrame((dt, t) => {
    spin += dt;
    bloop.rotation.y = Math.sin(spin * 0.8) * 0.6;
    bloop.position.y = Math.sin(t * 2) * 0.06;
  });
  backdrop = { bloop, stopIdle };
  // A box just big enough to hold the tallest character, with a little air.
  // frameView always centres its box on y = 0, and a bloop's origin is at its
  // *feet* -- so the vertical extent has to be given as "from just under the
  // floor to just over the crown" (Regalia's points and Seraph's halo both
  // reach about 0.98 model units, which is 2.35 world units at this scale).
  // Passing a symmetric yLo/yHi instead is what left the character sitting a
  // couple of hundred pixels above the middle of its own pane. Tight framing is
  // the whole point: the subject of this screen is one bloop, at a considered
  // size, in the middle of the space the shop's two panels leave for it.
  // The depth span is deliberately much smaller than the width. frameView fits
  // the *corners* of a box, and from 53 degrees above, depth costs more
  // projected height than height does -- so a box as deep as the character is
  // wide spends a third of the pane framing empty air in front of and behind a
  // sphere. Ball ends up filling ~45% of the frame height, centred.
  frameView(new THREE.Vector3(0, 0, 0), 1.8, 0.6, { yLo: -0.35, yHi: 2.25 });
}

function spawnBloop() {
  const char = characters.find((c) => c.id === state.currentChar) || characters[0];
  const bloop = buildBloop(char);
  bloop.castShadow = true;
  scene.add(bloop);
  return bloop;
}

// ---------- screen router ----------
const screens = {
  menu: () => { music(0); menuBackdrop(); renderMenu(); },
  worldmap: () => { music(0); menuBackdrop(); renderWorldMap(); },
  levels: () => { music(0); menuBackdrop(); renderLevels(); },
  achievements: () => { renderAchievements(); },
  badges: () => { renderBadges(); },
  characters: () => { music(0); renderCharacters(); },
};

function show(name) {
  for (const el of document.querySelectorAll('#app > .screen')) el.remove();
  screens[name]();
}

const ctx = {
  show,
  allLevels,
  currentWorld: 1,
  startLevel,
  previewCharacter: (c) => previewBackdrop(c),
  onPurchase: () => { toastUnlocks(checkUnlocks()); },
};
initScreens(ctx);
initHud(ctx);

// ---------- play session ----------
let session = null;

function startLevel(level) {
  if (session) { session.dispose(); session = null; }
  clearBackdrop();
  for (const el of document.querySelectorAll('#app > .screen')) el.remove();
  for (const el of document.querySelectorAll('.modal-wrap')) el.remove();

  const parsed = parseGrid(level.grid);
  music(level.world);

  let bloop = null;
  let stopIdle = null;
  let runCtl = null;

  function setupBoard() {
    disposeLevel();
    buildLevel(parsed, level.world);
    if (bloop) scene.remove(bloop);
    bloop = spawnBloop();
    const p = { x: parsed.start.x - (parsed.cols - 1) / 2, z: parsed.start.y - (parsed.rows - 1) / 2 };
    bloop.position.set(p.x, 0, p.z);
    if (stopIdle) stopIdle();
    stopIdle = idleBloop(bloop);
  }

  session = {
    level,
    parsed,
    // Non-scored dry run: draw the predicted path, return the outcome.
    preview(program) {
      const res = runProgram(parsed, program);
      showPreviewPath(parsed, res);
      return res;
    },
    clearPreview() {
      clearPreviewPath();
    },
    run(program, cbs) {
      if (runCtl) runCtl.cancel();
      clearPreviewPath();
      setupBoard();
      if (stopIdle) { stopIdle(); stopIdle = null; }
      const res = runProgram(parsed, program);
      runCtl = playRun(bloop, parsed, res, {
        trailColor: (characters.find((c) => c.id === state.currentChar) || characters[0]).trail,
        onCommand: cbs.onCommand,
        onDone() {
          // Hand the character back to the idle animation. run() stopped it on
          // the way in and nothing ever started it again, so after a run -- won
          // or failed -- Bloop stood perfectly still until the board was
          // rebuilt: no breath, no sway, no slow turn. By the time this fires
          // the animator has finished its last beat and the rig is at rest.
          if (stopIdle) stopIdle();
          stopIdle = idleBloop(bloop);
          const summary = recordRun(level, res, program, allLevels);
          const unlocks = checkUnlocks();
          cbs.onDone(res, summary, unlocks);
          toastUnlocks(unlocks);
        },
      });
    },
    resetBoard() {
      if (runCtl) { runCtl.cancel(); runCtl = null; }
      clearPreviewPath();
      setupBoard();
    },
    replay() {
      session.resetBoard();
    },
    hasNext() {
      return !!nextLevel();
    },
    next() {
      const nl = nextLevel();
      if (nl) startLevel(nl);
      else session.exit();
    },
    dispose() {
      if (runCtl) { runCtl.cancel(); runCtl = null; }
      clearPreviewPath();
      if (stopIdle) { stopIdle(); stopIdle = null; }
      if (bloop) { scene.remove(bloop); bloop = null; }
      disposeLevel();
    },
    exit() {
      session.dispose();
      session = null;
      ctx.currentWorld = level.world;
      show('levels');
    },
  };

  function nextLevel() {
    const nl = allLevels.find((l) => l.world === level.world && l.index === level.index + 1)
      || allLevels.find((l) => l.world === level.world + 1 && l.index === 1);
    return nl && levelUnlocked(nl, allLevels) ? nl : null;
  }

  setupBoard();
  renderPlay(session);
}

void getCurrentWorldModel; void rollBody; void playSfx;

// go!
show('menu');

// Tells the boot watchdog in index.html that the bundle parsed and ran, so it
// stays quiet. Anything that stops us reaching this line shows the failure
// screen instead of a blank page.
globalThis.__blooptopiaBooted = true;

// Automation hook for the visual-regression harness in `tools/shot.mjs`. It is
// a handful of already-exported functions hung off one global: no gameplay
// depends on it, and nothing reads it at runtime. Keeping it here (rather than
// re-deriving the router in the harness) means screenshots always drive the
// game through exactly the same code paths a player does.
globalThis.__blooptopia = {
  show,
  startLevel,
  allLevels,
  levelAt: (world, index) => allLevels.find((l) => l.world === world && l.index === index),
  runProgram: (program) => {
    if (!session) return null;
    return runProgram(session.parsed, program);
  },
  getSession: () => session,
  scene,
};
