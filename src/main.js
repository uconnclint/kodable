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

function previewBackdrop(char) {
  clearBackdrop();
  applyTheme(0);
  const bloop = buildBloop(char);
  bloop.scale.setScalar(2.2);
  bloop.position.set(1.2, -0.4, 0);
  scene.add(bloop);
  let spin = 0;
  const stopIdle = onFrame((dt, t) => {
    spin += dt;
    bloop.rotation.y = Math.sin(spin * 0.8) * 0.6;
    bloop.position.y = -0.4 + Math.sin(t * 2) * 0.06;
  });
  backdrop = { bloop, stopIdle };
  frameView(new THREE.Vector3(0.6, 0, 0), 6, 4);
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
