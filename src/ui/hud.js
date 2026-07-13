// The play screen: command palette, program trays (main / loop / function F1),
// condition binders, run controls, and the results modal.
import { h } from './dom.js';
import { icon, dirIconName, coinPill, starRow } from './icons.js';
import { playSfx } from '../audio/sfx.js';
import { state } from '../game/save.js';

const dirIcon = (d) => icon(dirIconName(d));

let ctx; // { show, session } injected by main
export function initHud(c) { ctx = c; }

export function renderPlay(session) {
  const { level } = session;
  const a = level.allowed;

  const program = { main: [], functions: a.functions ? [[]] : [], conditions: [] };
  let activeTray = 'main'; // 'main' | 'fn' | loopToken reference
  let running = false;
  const tokenEls = new Map(); // token object -> element

  const old = document.getElementById('screen-play');
  if (old) old.remove();

  // ----- trays -----
  const mainSlots = h('div.slot-row');
  const mainCount = h('span', {}, '');
  const mainTray = h('div.tray.clickable', { onClick: () => setActive('main') },
    h('div.tray-label', {}, 'Program'), mainSlots, mainCount);

  let fnTray = null, fnSlots = null;
  if (a.functions) {
    fnSlots = h('div.slot-row');
    fnTray = h('div.tray.clickable', { onClick: () => setActive('fn') },
      h('div.tray-label', {}, 'F1 ', icon('function')), fnSlots);
  }

  let condTray = null;
  const condPicks = {};
  if (a.conditions.length) {
    condTray = h('div.tray', {}, h('div.tray-label', {}, 'If color'),
      ...a.conditions.map((color) => {
        const arrowEl = h('span.cond-arrow', {}, '·');
        const slot = h('button.cond-slot', {
          onClick: (e) => { e.stopPropagation(); cycleCondition(color, arrowEl); },
        }, h(`span.cond-dot.c-${color}`), arrowEl);
        condPicks[color] = arrowEl;
        return slot;
      }),
    );
  }

  // ----- palette -----
  const palette = h('div.palette', {},
    h('div.tray-label', {}, 'Add'),
    ...a.dirs.map((d) =>
      h(`button.token.d-${d}`, { onClick: () => addDir(d) }, dirIcon(d))),
    a.loops ? h('button.token.loop-block', { onClick: addLoop, style: { padding: '4px 12px' } }, icon('loop'), ' loop') : null,
    a.functions ? h('button.token.call-token', { onClick: addCall, style: { width: 'auto', padding: '0 12px' } }, 'F1') : null,
  );

  const msg = h('div.hud-msg', {}, level.intro || 'Build a program, then Preview or Run!');

  const runBtn = h('button.btn.big.green', { onClick: run }, icon('run'), ' RUN');
  const previewBtn = h('button.btn.big.blue', { onClick: preview }, icon('preview'), ' Preview');
  const clearBtn = h('button.btn.ghost', { onClick: () => { if (!running) { session.clearPreview(); program.main.length = 0; if (fnSlots) program.functions[0].length = 0; playSfx('remove'); render(); } } }, icon('clear'), ' Clear');

  const el = h('div.screen#screen-play', {},
    h('div.hud-top', {},
      h('button.icon-btn', { onClick: () => { if (!running) { playSfx('ui'); session.exit(); } } }, icon('back')),
      h('div.lv-name', {}, `${level.id.toUpperCase()} · ${level.name}`),
      h('div.spacer', { style: { flex: 1 } }),
      coinPill(state.coins),
    ),
    msg,
    h('div', { style: { flex: 1 }, onClick: () => {} }),
    h('div.hud-bottom', {},
      condTray,
      fnTray,
      mainTray,
      h('div.tray', {}, palette),
      h('div.run-controls', {}, clearBtn, previewBtn, runBtn),
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
    target.push({ t: 'dir', d });
    playSfx('place');
    render();
  }

  function addLoop() {
    if (running) return;
    if (program.main.length >= a.maxMain) { flash(`Max ${a.maxMain} commands!`); playSfx('fail'); return; }
    const tok = { t: 'loop', n: 2, body: [] };
    program.main.push(tok);
    activeTray = tok;
    playSfx('place');
    render();
  }

  function addCall() {
    if (running) return;
    if (program.main.length >= a.maxMain) { flash(`Max ${a.maxMain} commands!`); playSfx('fail'); return; }
    program.main.push({ t: 'call', f: 0 });
    playSfx('place');
    render();
  }

  function cycleCondition(color, arrowEl) {
    if (running) return;
    session.clearPreview();
    const order = [null, 'U', 'D', 'L', 'R'];
    const idx = program.conditions.findIndex((c) => c.color === color);
    const cur = idx >= 0 ? program.conditions[idx].d : null;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    if (idx >= 0) program.conditions.splice(idx, 1);
    if (next) program.conditions.push({ color, d: next });
    arrowEl.replaceChildren(next ? dirIcon(next) : document.createTextNode('·'));
    playSfx('select');
  }

  function setActive(t) {
    if (running) return;
    activeTray = t;
    render();
  }

  function removeToken(arr, tok) {
    if (running) return;
    const i = arr.indexOf(tok);
    if (i >= 0) arr.splice(i, 1);
    if (activeTray === tok) activeTray = 'main';
    playSfx('remove');
    render();
  }

  // ----- rendering -----
  function tokenEl(tok, arr) {
    if (tok.t === 'dir') {
      const e = h(`button.token.d-${tok.d}`, { onClick: (ev) => { ev.stopPropagation(); removeToken(arr, tok); } }, dirIcon(tok.d));
      tokenEls.set(tok, e);
      return e;
    }
    if (tok.t === 'call') {
      const e = h('button.token.call-token', { style: { width: 'auto', padding: '0 12px' }, onClick: (ev) => { ev.stopPropagation(); removeToken(arr, tok); } }, 'F1');
      tokenEls.set(tok, e);
      return e;
    }
    // loop block
    const countChip = h('button.loop-count', {
      onClick: (ev) => { ev.stopPropagation(); if (!running) { tok.n = tok.n >= 5 ? 2 : tok.n + 1; playSfx('select'); render(); } },
    }, `×${tok.n}`);
    const body = h('div.loop-body', {},
      ...tok.body.map((b) => tokenEl(b, tok.body)),
      tok.body.length === 0 ? h('span', { style: { fontSize: '12px', opacity: 0.8 } }, 'tap arrows…') : null,
    );
    const del = h('button', { style: { fontSize: '13px', opacity: 0.85 }, onClick: (ev) => { ev.stopPropagation(); removeToken(program.main, tok); } }, '✕');
    const e = h(`button.token.loop-block${activeTray === tok ? '' : ''}`, {
      onClick: (ev) => { ev.stopPropagation(); setActive(tok); },
      style: activeTray === tok ? { outline: '3px solid #ffc93d' } : {},
    }, icon('loop'), countChip, body, del);
    tokenEls.set(tok, e);
    return e;
  }

  function render() {
    session.clearPreview();
    tokenEls.clear();
    mainSlots.replaceChildren(
      ...program.main.map((tok) => tokenEl(tok, program.main)),
      ...(program.main.length === 0 ? [h('span.token.ghost-slot', { style: { width: 'auto', padding: '0 10px' } }, 'tap arrows below')] : []),
    );
    mainCount.textContent = `${program.main.length}/${a.maxMain}`;
    mainCount.style.cssText = 'font-weight:700;font-size:13px;opacity:0.6;';
    mainTray.classList.toggle('active', activeTray === 'main' || (activeTray !== 'fn' && activeTray !== 'main'));
    if (fnTray) {
      fnSlots.replaceChildren(
        ...program.functions[0].map((tok) => tokenEl(tok, program.functions[0])),
        ...(program.functions[0].length === 0 ? [h('span.token.ghost-slot', { style: { width: 'auto', padding: '0 10px' } }, 'teach F1 some moves')] : []),
      );
      fnTray.classList.toggle('active', activeTray === 'fn');
      mainTray.classList.toggle('active', activeTray !== 'fn');
    }
  }

  let flashTimer = null;
  function flash(text) {
    msg.textContent = text;
    msg.style.background = 'rgba(214,60,60,0.9)';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { msg.textContent = level.intro || ''; msg.style.background = ''; }, 2200);
  }
  function verdict(text, good) {
    msg.textContent = text;
    msg.style.background = good ? 'rgba(46,160,80,0.94)' : 'rgba(224,132,44,0.94)';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { msg.textContent = level.intro || ''; msg.style.background = ''; }, 4200);
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
      verdict(`Preview: Bloop reaches the goal and grabs ${stars}! ${s === 3 ? 'Perfect route!' : 'Ready to Run.'}`, true);
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
    msg.textContent = 'Go Bloop, go!';
    session.run(program, {
      onCommand(src) {
        for (const e of tokenEls.values()) e.classList.remove('executing');
        const e = tokenEls.get(src);
        if (e) e.classList.add('executing');
      },
      onDone(res, summary, unlocks) {
        for (const e of tokenEls.values()) e.classList.remove('executing');
        running = false;
        runBtn.disabled = false;
        if (res.win) showResults(res, summary);
        else {
          flash(res.reason === 'out-of-commands' ? 'Bloop ran out of commands! Tweak your program.' : 'Almost! Try again.');
          session.resetBoard();
        }
        void unlocks;
      },
    });
  }

  function showResults(res, summary) {
    const wrap = h('div.modal-wrap', {},
      h('div.modal', {},
        h('h2', {}, res.starsGot === 3 ? h('span', {}, icon('win'), ' Amazing!') : 'Level Complete!'),
        h('div.stars-row', {}, ...starRow(res.starsGot, 3)),
        summary.perfect ? h('div.earn-line', { style: { color: '#e8a820' } }, icon('perfect'), ' PERFECT — under par!') : null,
        h('div.earn-line', {}, `+${summary.coins} `, icon('coin'), ' earned'),
        h('div.modal-btns', {},
          h('button.btn.ghost', { style: { color: '#2a2440' }, onClick: () => { wrap.remove(); session.replay(); } }, icon('replay'), ' Replay'),
          h('button.btn.ghost', { style: { color: '#2a2440' }, onClick: () => { wrap.remove(); session.exit(); } }, icon('back'), ' Levels'),
          session.hasNext() ? h('button.btn.green', { onClick: () => { wrap.remove(); session.next(); } }, 'Next ', icon('next')) : null,
        ),
      ),
    );
    document.body.append(wrap);
  }
}
