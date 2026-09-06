// The play screen: command palette, program trays (main / loop / function F1),
// condition binders, run controls, and the results modal.
import { h } from './dom.js';
import { icon, dirArrowIcon, coinPill, starRow } from './icons.js';
import { playSfx } from '../audio/sfx.js';
import { state } from '../game/save.js';
import { TILE_COLORS } from '../engine/renderer.js';
import * as engineWorld from '../engine/world.js';

const dirIcon = (d) => dirArrowIcon(d);
const DIR_NAME = { U: 'Up', D: 'Down', L: 'Left', R: 'Right' };

// A child learns "pink means turn left" by matching the dot on the binder to
// the tile on the board, so those two colours have to be the *same* colour.
// They were not: the stylesheet carried its own copy of the four hexes while
// the board applied an albedo gain on top of them, and the pair had visibly
// drifted. The values now come off the engine and are published as custom
// properties, so the CSS can never hold a second opinion.
//
// world.js publishes the post-gain albedo as TILE_UI_COLORS, which is what is
// actually on screen; renderer.js's raw TILE_COLORS is the fallback for a
// build where that export is not present.
function conditionColorSource() {
  const tinted = engineWorld.TILE_UI_COLORS;
  return tinted && typeof tinted === 'object' && Object.keys(tinted).length ? tinted : TILE_COLORS;
}

function toCssColor(v) {
  if (typeof v === 'number') return `#${v.toString(16).padStart(6, '0')}`;
  if (typeof v === 'string') return v;
  if (v && typeof v.getHexString === 'function') return `#${v.getHexString()}`;
  return null;
}

function syncConditionColors() {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(conditionColorSource())) {
    const css = toCssColor(value);
    if (css) root.style.setProperty(`--cond-${key}`, css);
  }
}

function learningPrompt(level) {
  if (level.world === 1 && level.index <= 2) return level.intro;
  if (level.world === 1) return 'Plan the turns. Bloop keeps rolling until the path ends.';
  if (level.world === 2 && level.index === 1) return level.intro;
  if (level.world === 2) return 'Set each color rule, then build the main program.';
  if (level.world === 3 && level.index === 1) return level.intro;
  if (level.world === 3) return 'Look for a move pattern that repeats.';
  if (level.world === 4 && level.index === 1) return level.intro;
  if (level.world === 4) return 'Teach F1 a useful move pattern, then call it from the program.';
  return 'Choose the right mix of commands, rules, loops, and functions.';
}

let ctx; // { show, session } injected by main
export function initHud(c) { ctx = c; }

export function renderPlay(session) {
  const { level } = session;
  const a = level.allowed;
  syncConditionColors();

  const program = { main: [], functions: a.functions ? [[]] : [], conditions: [] };
  let activeTray = 'main'; // 'main' | 'fn' | loopToken reference
  let running = false;
  const tokenEls = new Map(); // token object -> element
  let flashTimer = null;
  let lastExecuting = null;
  let hintLevel = 0;
  let justAdded = null; // token placed by the most recent edit, for the pop-in
  const undoStack = [];

  const cloneProgram = () => JSON.parse(JSON.stringify(program));
  function remember() {
    undoStack.push(cloneProgram());
    if (undoStack.length > 40) undoStack.shift();
  }
  function restore(snapshot) {
    program.main.splice(0, program.main.length, ...snapshot.main);
    program.functions.splice(0, program.functions.length, ...snapshot.functions);
    program.conditions.splice(0, program.conditions.length, ...snapshot.conditions);
    activeTray = 'main';
    render();
  }
  function undo() {
    if (running || !undoStack.length) return;
    restore(undoStack.pop());
    playSfx('remove');
  }

  const old = document.getElementById('screen-play');
  if (old) old.remove();

  // ----- trays -----
  const mainSlots = h('div.slot-row');
  // The counter lives in the row's head, directly under the label, so program
  // length reads as a heading-level fact rather than as fine print floating
  // off at the far edge of a wide bar.
  const mainCount = h('span.tray-count', { role: 'status' });
  const mainTray = h('div.tray.row-main.clickable', {
    role: 'group', 'aria-label': 'Main program', tabindex: '0',
    onClick: () => setActive('main'),
    onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setActive('main'); } },
  },
    h('div.tray-head', {}, h('div.tray-label', {}, 'Program'), mainCount), mainSlots);

  // F1 is the Program row's twin: same chips, same wells, same gesture. It
  // therefore gets the same counter and the same honest capacity — it used to
  // draw three wells for a surface that holds eight, and carry no count at
  // all, so two rows with one visual grammar were quietly telling a child two
  // different stories.
  const FN_CAPACITY = 8;
  let fnTray = null, fnSlots = null, fnCount = null;
  if (a.functions) {
    fnSlots = h('div.slot-row');
    fnCount = h('span.tray-count', { role: 'status' });
    fnTray = h('div.tray.row-fn.clickable', {
      role: 'group', 'aria-label': 'Function F1', tabindex: '0',
      onClick: () => setActive('fn'),
      onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setActive('fn'); } },
    },
      h('div.tray-head', {}, h('div.tray-label', {}, 'F1 ', icon('function')), fnCount), fnSlots);
  }

  let condTray = null;
  const condPicks = {};
  if (a.conditions.length) {
    condTray = h('div.tray.row-cond', {}, h('div.tray-head', {}, h('div.tray-label', {}, 'If color')),
      ...a.conditions.map((color) => {
        const arrowEl = h('span.cond-arrow.empty', {}, '·');
        const slot = h('button.cond-slot', {
          'aria-label': `Set ${colorName(color)} condition. No direction selected.`,
          onClick: (e) => { e.stopPropagation(); cycleCondition(color, arrowEl); },
        }, h(`span.cond-dot.c-${color}`), arrowEl);
        condPicks[color] = arrowEl;
        return slot;
      }),
      // The one tray with no hint and no counter, sitting directly above a row
      // that says "Tap a command below to add it here" — so a child had no
      // reason to think the dashed box next to the dot did anything at all.
      h('span.slot-hint', {}, 'Tap a colour to pick which way it turns'),
    );
  }

  // ----- palette -----
  const palette = h('div.palette', {},
    ...a.dirs.map((d) =>
      h(`button.token.d-${d}`, { 'aria-label': `Add ${DIR_NAME[d]} command`, onClick: () => addDir(d) }, dirIcon(d))),
    a.loops ? h('button.token.loop-block', { 'aria-label': 'Add loop block', onClick: addLoop }, icon('loop'), ' loop') : null,
    a.functions ? h('button.token.call-token', { 'aria-label': 'Add F1 function call', onClick: addCall }, 'F1') : null,
  );

  const prompt = learningPrompt(level);
  const msg = h('div.hud-msg', { role: 'status', 'aria-live': 'polite' }, prompt || 'Build a program, then Preview or Run!');
  const coins = coinPill(state.coins);
  // One chip, and only the fact that changes from level to level. "Reach the
  // exit" and "Collect 3 stars" were true of all sixty levels, restated on
  // every one of them, and cost the board a strip of height each time.
  const goals = h('div.level-goals', {},
    h('span', {}, `Perfect: ≤ ${level.parCommands} main block${level.parCommands === 1 ? '' : 's'}`),
  );

  const runBtn = h('button.btn.big.green', { onClick: run }, icon('run'), ' RUN');
  const previewBtn = h('button.btn.big.blue', { onClick: preview }, icon('preview'), ' Preview');
  const hintBtn = h('button.btn.ghost.hint-btn', { onClick: hint }, icon('question'), ' Hint');
  // All four utility glyphs come from the same drawn set, at the same weight,
  // and the stylesheet drains them to one ink. Undo was a bare '↶' character
  // rendered in whatever fallback font the device had, next to a thin arc, an
  // illustrated broom and a solid badge — four idioms in one row of four
  // buttons. Undo is now the Reset arrow mirrored, which is also exactly what
  // the gesture is.
  const undoBtn = h('button.btn.ghost.utility-btn', { 'aria-label': 'Undo last program edit', onClick: undo }, icon('replay', 'flip-x'), ' Undo');
  const resetBtn = h('button.btn.ghost.utility-btn', { 'aria-label': 'Reset Bloop to the start', onClick: () => { if (!running) { session.resetBoard(); flash('Bloop is back at the start.'); } } }, icon('replay'), ' Reset');
  const clearBtn = h('button.btn.ghost.utility-btn', { onClick: () => {
    if (!running && (program.main.length || (fnSlots && program.functions[0].length))) {
      remember();
      session.clearPreview();
      program.main.length = 0;
      if (fnSlots) program.functions[0].length = 0;
      program.conditions.length = 0;
      playSfx('remove');
      render();
    }
  } }, icon('trash'), ' Clear');

  const el = h('div.screen#screen-play', {},
    h('div.hud-top', {},
      h('button.icon-btn', { 'aria-label': 'Back to levels', onClick: () => { if (!running) { playSfx('ui'); session.exit(); } } }, icon('back')),
      h('div.lv-name', {}, `${level.id.toUpperCase()} · ${level.name}`),
      h('div.spacer', { style: { flex: 1 } }),
      coins,
    ),
    h('div.hud-coach', {}, msg, goals),
    h('div', { style: { flex: 1 }, onClick: () => {} }),
    // The run controls live *inside* the console card, as its right-hand
    // column on a wide screen. Two things fall out of that: the card is no
    // longer 60% blank paper on its right side, and the HUD gives a whole row
    // of height back to the board. DOM order is unchanged — the grid places
    // the column, so reading and tab order still run trays, palette, controls.
    h('div.hud-bottom', {},
      h('div.console', {},
        h('div.console-rows', {},
          condTray,
          fnTray,
          mainTray,
          h('div.tray.row-palette', { role: 'group', 'aria-label': 'Command palette' },
            h('div.tray-head', {}, h('div.tray-label', {}, 'Add')), palette),
        ),
        h('div.run-controls', {},
          h('div.utility-controls', {}, undoBtn, resetBtn, clearBtn, hintBtn),
          h('div.hero-controls', {}, previewBtn, runBtn),
        ),
      ),
    ),
  );
  document.getElementById('app').append(el);
  render();
  return el;

  // ----- editing -----
  function currentTarget() {
    if (activeTray === 'fn') return program.functions[0];
    if (activeTray !== 'main' && activeTray) return activeTray.body; // loop token
    return program.main;
  }

  function addDir(d) {
    if (running) return;
    const target = currentTarget();
    if (target === program.main && program.main.length >= a.maxMain) { flash(`Max ${a.maxMain} commands — try loops or fewer moves!`); playSfx('fail'); return; }
    if (target !== program.main && target.length >= 8) { playSfx('fail'); return; }
    remember();
    justAdded = { t: 'dir', d };
    target.push(justAdded);
    playSfx('place');
    render();
  }

  function addLoop() {
    if (running) return;
    if (program.main.length >= a.maxMain) { flash(`Max ${a.maxMain} commands!`); playSfx('fail'); return; }
    remember();
    const tok = { t: 'loop', n: 2, body: [] };
    justAdded = tok;
    program.main.push(tok);
    activeTray = tok;
    playSfx('place');
    render();
  }

  function addCall() {
    if (running) return;
    if (program.main.length >= a.maxMain) { flash(`Max ${a.maxMain} commands!`); playSfx('fail'); return; }
    remember();
    justAdded = { t: 'call', f: 0 };
    program.main.push(justAdded);
    playSfx('place');
    render();
  }

  function cycleCondition(color, arrowEl) {
    if (running) return;
    session.clearPreview();
    remember();
    const order = [null, 'U', 'D', 'L', 'R'];
    const idx = program.conditions.findIndex((c) => c.color === color);
    const cur = idx >= 0 ? program.conditions[idx].d : null;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    if (idx >= 0) program.conditions.splice(idx, 1);
    if (next) program.conditions.push({ color, d: next });
    arrowEl.replaceChildren(next ? dirIcon(next) : document.createTextNode('·'));
    arrowEl.classList.toggle('empty', !next);
    arrowEl.parentElement.setAttribute('aria-label', `Set ${colorName(color)} condition. ${next ? `${DIR_NAME[next]} selected.` : 'No direction selected.'}`);
    playSfx('select');
  }

  function setActive(t) {
    if (running) return;
    activeTray = t;
    render();
  }

  function removeToken(arr, tok) {
    if (running) return;
    remember();
    const i = arr.indexOf(tok);
    if (i >= 0) arr.splice(i, 1);
    if (activeTray === tok) activeTray = 'main';
    playSfx('remove');
    render();
  }

  // ----- rendering -----
  function tokenEl(tok, arr) {
    if (tok.t === 'dir') {
      const e = h(`button.token.d-${tok.d}${tok === justAdded ? '.just-added' : ''}`, { 'aria-label': `Remove ${DIR_NAME[tok.d]} command`, onClick: (ev) => { ev.stopPropagation(); removeToken(arr, tok); } }, dirIcon(tok.d));
      tokenEls.set(tok, e);
      return e;
    }
    if (tok.t === 'call') {
      const e = h(`button.token.call-token${tok === justAdded ? '.just-added' : ''}`, { 'aria-label': 'Remove F1 function call', onClick: (ev) => { ev.stopPropagation(); removeToken(arr, tok); } }, 'F1');
      tokenEls.set(tok, e);
      return e;
    }
    // loop block
    const countChip = h('button.loop-count', {
      'aria-label': `Loop repeats ${tok.n} times. Increase repeat count.`,
      onClick: (ev) => { ev.stopPropagation(); if (!running) { remember(); tok.n = tok.n >= 5 ? 2 : tok.n + 1; playSfx('select'); render(); } },
    }, `×${tok.n}`);
    // The well inside an open loop follows the same rule as the tray wells: it
    // only beckons while this loop is the surface chips are landing in.
    const loopActive = activeTray === tok;
    const body = h('div.loop-body', {},
      ...tok.body.map((b) => tokenEl(b, tok.body)),
      tok.body.length === 0
        ? h(`span.token.ghost-slot${loopActive ? '.next' : ''}`, { 'aria-hidden': 'true', style: { width: '40px', height: '40px', minWidth: '40px' } }, loopActive ? '+' : '')
        : null,
    );
    const del = h('button.loop-del', { 'aria-label': 'Remove loop block', onClick: (ev) => { ev.stopPropagation(); removeToken(program.main, tok); } }, '✕');
    // `.editing` rather than an inline outline: the outline property is
    // reserved for the focus ring, and mixing the two made keyboard focus on
    // an open loop invisible.
    const e = h(`div.token.loop-block${activeTray === tok ? '.editing' : ''}${tok === justAdded ? '.just-added' : ''}`, {
      role: 'button', tabindex: '0', 'aria-label': `Edit loop that repeats ${tok.n} times`,
      onClick: (ev) => { ev.stopPropagation(); setActive(tok); },
      onKeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setActive(tok); } },
    }, icon('loop'), countChip, body, del);
    tokenEls.set(tok, e);
    return e;
  }

  // Every unused slot is drawn, numbered, and the first one of the *active*
  // tray is highlighted. Showing the whole capacity is what makes program
  // length legible to a five-year-old — far more than a "2/5" caption ever
  // could — and it gives the tray an obvious "commands land here" affordance
  // when it is empty.
  //
  // `isActive` matters: the highlight is a promise about where the next chip
  // will land, and only one tray can keep that promise. Marking the first well
  // of every tray put two identical pulsing purple targets on screen at once
  // with only one of them live.
  function ghostSlots(used, capacity, isActive) {
    const out = [];
    for (let i = used; i < capacity; i++) {
      const next = isActive && i === used;
      out.push(h(`span.token.ghost-slot${next ? '.next' : ''}`, { 'aria-hidden': 'true' }, next ? '+' : ''));
    }
    return out;
  }

  function render() {
    session.clearPreview();
    tokenEls.clear();
    // Strictly the main list — not "anything that isn't F1". While a loop is
    // open its body is the insertion point, so the loop's own well beckons and
    // this one must not, even though the main tray stays visually highlighted
    // (the loop lives inside it).
    const mainActive = activeTray === 'main';
    mainSlots.replaceChildren(
      ...program.main.map((tok) => tokenEl(tok, program.main)),
      ...ghostSlots(program.main.length, a.maxMain, mainActive),
      ...(program.main.length === 0 ? [h('span.slot-hint', {}, 'Tap a command below to add it here')] : []),
    );
    mainCount.replaceChildren(
      h('span.tc-now', { 'aria-hidden': 'true' }, String(program.main.length)),
      h('span.tc-max', { 'aria-hidden': 'true' }, `/${a.maxMain}`),
      h('span.sr-only', {}, `${program.main.length} of ${a.maxMain} blocks used`),
    );
    mainCount.classList.toggle('full', program.main.length >= a.maxMain);
    mainTray.classList.toggle('active', activeTray === 'main' || (activeTray !== 'fn' && activeTray !== 'main'));
    if (fnTray) {
      const fnLen = program.functions[0].length;
      fnSlots.replaceChildren(
        ...program.functions[0].map((tok) => tokenEl(tok, program.functions[0])),
        ...ghostSlots(fnLen, FN_CAPACITY, activeTray === 'fn'),
        ...(fnLen === 0 ? [h('span.slot-hint', {}, 'Teach F1 some moves')] : []),
      );
      fnCount.replaceChildren(
        h('span.tc-now', { 'aria-hidden': 'true' }, String(fnLen)),
        h('span.tc-max', { 'aria-hidden': 'true' }, `/${FN_CAPACITY}`),
        h('span.sr-only', {}, `${fnLen} of ${FN_CAPACITY} blocks used in F1`),
      );
      fnCount.classList.toggle('full', fnLen >= FN_CAPACITY);
      fnTray.classList.toggle('active', activeTray === 'fn');
      mainTray.classList.toggle('active', activeTray !== 'fn');
    }
    for (const [color, arrowEl] of Object.entries(condPicks)) {
      const selected = program.conditions.find((c) => c.color === color)?.d || null;
      arrowEl.replaceChildren(selected ? dirIcon(selected) : document.createTextNode('·'));
      arrowEl.classList.toggle('empty', !selected);
      arrowEl.parentElement.setAttribute('aria-label', `Set ${colorName(color)} condition. ${selected ? `${DIR_NAME[selected]} selected.` : 'No direction selected.'}`);
    }
    undoBtn.disabled = undoStack.length === 0;
    justAdded = null;
  }

  // Tone is a class so the stylesheet owns the colours — the inline rgba()s
  // this replaces were light enough that white text on them missed AA.
  function setTone(tone) {
    msg.classList.remove('tone-bad', 'tone-good', 'tone-warn');
    if (tone) msg.classList.add(`tone-${tone}`);
  }
  function say(text, tone, holdMs) {
    msg.textContent = text;
    setTone(tone);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { msg.textContent = prompt || ''; setTone(null); }, holdMs);
  }
  function flash(text) { say(text, 'bad', 2200); }
  function verdict(text, good) { say(text, good ? 'good' : 'warn', 4200); }

  function hint() {
    if (running) return;
    hintLevel++;
    if (hintLevel === 1) {
      verdict(`Hint: a perfect solution uses ${level.parCommands} main block${level.parCommands === 1 ? '' : 's'}. Look for the longest useful roll or repeating pattern.`, false);
      return;
    }
    const first = level.solution?.main?.[0];
    const firstHint = first?.t === 'dir' ? `Start by rolling ${DIR_NAME[first.d].toUpperCase()}.`
      : first?.t === 'loop' ? 'Your first main block should be a LOOP.'
        : first?.t === 'call' ? 'Your first main block should call F1.'
          : 'Trace the route from Bloop to the exit.';
    verdict(`Stronger hint: ${firstHint}`, false);
  }

  // ----- preview: non-scored dry run that draws the predicted path -----
  function preview() {
    if (running) return;
    if (!program.main.length) { flash('Add some commands first, then Preview!'); playSfx('fail'); return; }
    const res = session.preview(program);
    playSfx(res.win ? 'select' : 'turn');
    const s = res.starsGot;
    const stars = `${s} of 3 stars`;
    if (res.win) {
      verdict(`Preview reaches the goal and grabs ${stars}. Run it when you are ready!`, true);
    } else if (res.reason === 'out-of-commands') {
      verdict(`Preview: Bloop runs out of moves with ${stars}. Add more commands!`, false);
    } else {
      verdict(`Preview: Bloop gets stuck with ${stars}. Try a different path!`, false);
    }
  }

  // ----- running -----
  function run() {
    if (running) return;
    if (!program.main.length) { flash('Add some commands first!'); playSfx('fail'); return; }
    running = true;
    runBtn.disabled = true;
    playSfx('run');
    setTone(null);
    msg.textContent = 'Go Bloop, go!';
    session.run(program, {
      onCommand(src) {
        for (const e of tokenEls.values()) e.classList.remove('executing');
        const e = tokenEls.get(src);
        if (e) { e.classList.add('executing'); lastExecuting = e; }
      },
      onDone(res, summary, unlocks) {
        running = false;
        runBtn.disabled = false;
        coins.replaceChildren(icon('coin'), ` ${state.coins}`);
        coins.setAttribute('aria-label', `${state.coins} coins`);
        if (res.win) {
          for (const e of tokenEls.values()) e.classList.remove('executing');
          showResults(res, summary);
        }
        else {
          const fail = res.steps.slice().reverse().find((s) => s.type === 'fail');
          const commands = res.steps.filter((s) => s.type === 'command').length;
          const where = fail?.at ? ` at row ${fail.at.y + 1}, column ${fail.at.x + 1}` : '';
          verdict(`Debug: the program ended${where} after ${commands} command${commands === 1 ? '' : 's'}. The highlighted block ran last.`, false);
          if (lastExecuting) lastExecuting.classList.add('executing');
        }
        void unlocks;
      },
    });
  }

  function showResults(res, summary) {
    const wrap = h('div.modal-wrap', { role: 'presentation' },
      h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Level results' },
        h('h2', {}, res.starsGot === 3 ? h('span', {}, icon('win'), ' Amazing!') : 'Level Complete!'),
        h('div.stars-row', {}, ...starRow(res.starsGot, 3)),
        summary.perfect ? h('div.earn-line.perfect', {}, icon('perfect'), ' PERFECT — under par!') : null,
        h('div.earn-line', {}, `+${summary.coins} `, icon('coin'), ' earned'),
        h('div.modal-btns', {},
          h('button.btn.ghost', { onClick: () => {
            wrap.remove();
            session.replay();
            msg.textContent = prompt;
            setTone(null);
          } }, icon('replay'), ' Replay'),
          h('button.btn.ghost', { onClick: () => { wrap.remove(); session.exit(); } }, icon('back'), ' Levels'),
          session.hasNext() ? h('button.btn.green', { onClick: () => { wrap.remove(); session.next(); } }, 'Next ', icon('next')) : null,
        ),
      ),
    );
    document.body.append(wrap);
  }

  function colorName(color) {
    return ({ p: 'pink', b: 'blue', g: 'green', o: 'orange' })[color] || color;
  }
}
