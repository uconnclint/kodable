// All non-gameplay screens: menu, world map, level select, achievements,
// badges, characters. Each screen is re-rendered on entry.
import { h } from './dom.js';
import { icon, coinPill, starRow } from './icons.js';
import { state, worldUnlocked, levelUnlocked, buyCharacter, selectCharacter, resetAll } from '../game/save.js';
import { achievements } from '../game/achievements.js';
import { badges } from '../game/badges.js';
import { characters } from '../game/characters.js';
import { playSfx, setMuted, isMuted } from '../audio/sfx.js';

export const WORLD_INFO = [
  { n: 1, name: 'Bloopberry Meadows', color: '#58cc6d', sub: 'Learn sequences — point Bloop the right way!' },
  { n: 2, name: 'Crystal Caverns', color: '#8f73ff', sub: 'Color conditions — if pink, turn left!' },
  { n: 3, name: 'Loopy Canyon', color: '#ffa53d', sub: 'Loops — repeat patterns like a pro!' },
  { n: 4, name: 'Function Junction', color: '#4db3ff', sub: 'Functions — teach Bloop a trick, use it anywhere!' },
  { n: 5, name: 'Bugstorm Peaks', color: '#ff5c5c', sub: 'The ultimate test. Everything, combined!' },
];

let ctx; // injected from main.js: { show, startLevel, allLevels, refreshBackdrop }
export function initScreens(c) { ctx = c; }

const app = () => document.getElementById('app');

function screen(id, ...kids) {
  let el = document.getElementById(id);
  if (el) el.remove();
  el = h(`div.screen#${id}`, {}, ...kids);
  app().append(el);
  return el;
}

function backBtn(target) {
  return h('button.icon-btn', { onClick: () => { playSfx('ui'); ctx.show(target); } }, icon('back'));
}

const starsTotal = () => Object.values(state.stars).reduce((a, b) => a + b, 0);

// ---------- MENU ----------
export function renderMenu() {
  const setMuteIcon = () => muteBtn.replaceChildren(icon(isMuted() ? 'sound-off' : 'sound-on'));
  const muteBtn = h('button.icon-btn', {
    onClick: () => { setMuted(!isMuted()); setMuteIcon(); playSfx('ui'); },
  });
  setMuteIcon();

  return screen('screen-menu',
    h('div.game-logo', {},
      h('h1', { html: 'BLOOP<span class="fz">TOPIA</span>' }),
      h('div.tagline', {}, 'A 3D coding adventure — program your bloop!'),
    ),
    h('div.menu-buttons', {},
      h('button.btn.big.green', { onClick: () => { playSfx('run'); ctx.show('worldmap'); } }, icon('play'), ' PLAY'),
      h('div.menu-row', {},
        h('button.btn', { onClick: () => { playSfx('ui'); ctx.show('characters'); } }, icon('bloop'), ' Bloops'),
        h('button.btn.orange', { onClick: () => { playSfx('ui'); ctx.show('achievements'); } }, icon('trophy'), ' Awards'),
        h('button.btn', { onClick: () => { playSfx('ui'); ctx.show('badges'); } }, icon('badge'), ' Badges'),
      ),
      h('div.menu-row', {},
        muteBtn,
        h('button.icon-btn', {
          onClick: () => {
            if (confirm('Reset ALL progress? This cannot be undone!')) { resetAll(); location.reload(); }
          },
        }, icon('trash')),
      ),
    ),
  );
}

// ---------- WORLD MAP ----------
export function renderWorldMap() {
  const cards = WORLD_INFO.map((w) => {
    const wl = ctx.allLevels.filter((l) => l.world === w.n);
    const done = wl.filter((l) => state.completed[l.id]).length;
    const stars = wl.reduce((a, l) => a + (state.stars[l.id] || 0), 0);
    const unlocked = worldUnlocked(w.n, ctx.allLevels);
    return h(`button.world-card${unlocked ? '' : '.locked'}`, {
      style: { '--wc': w.color },
      onClick: () => {
        if (!unlocked) { playSfx('fail'); return; }
        playSfx('select');
        ctx.currentWorld = w.n;
        ctx.show('levels');
      },
    },
      h('div.w-emoji', {}, icon(`world-${w.n}`)),
      h('h3', {}, `World ${w.n}: ${w.name}`),
      h('div.w-sub', {}, w.sub),
      h('div.w-progress', {}, h('div', { style: { width: `${(done / 12) * 100}%` } })),
      h('div.w-stats', {}, h('span', {}, `${done}/12 levels`), h('span', {}, icon('star-filled'), ` ${stars}/36`)),
      unlocked ? null : h('div.lock-badge', {}, icon('lock')),
    );
  });

  return screen('screen-worldmap',
    h('div.topbar', {}, backBtn('menu'),
      h('div.title', {}, 'Choose a World'),
      h('div.spacer'),
      coinPill(state.coins),
      h('div.coin-pill', { style: { marginLeft: '4px' } }, icon('star-filled'), ` ${starsTotal()}/180`),
    ),
    h('div.panel-scroll', {}, h('div.world-grid', {}, cards)),
  );
}

// ---------- LEVEL SELECT ----------
export function renderLevels() {
  const w = WORLD_INFO[ctx.currentWorld - 1];
  const wl = ctx.allLevels.filter((l) => l.world === ctx.currentWorld).sort((a, b) => a.index - b.index);
  const cards = wl.map((lv) => {
    const unlocked = levelUnlocked(lv, ctx.allLevels);
    const stars = state.stars[lv.id] || 0;
    return h(`button.level-card${unlocked ? '' : '.locked'}${state.perfect[lv.id] ? '.perfect' : ''}`, {
      onClick: () => {
        if (!unlocked) { playSfx('fail'); return; }
        playSfx('run');
        ctx.startLevel(lv);
      },
    },
      h('div.l-num', {}, unlocked ? String(lv.index) : icon('lock')),
      h('div.l-name', {}, lv.name),
      h('div.l-stars', {}, ...starRow(stars, 3)),
    );
  });

  return screen('screen-levels',
    h('div.topbar', {}, backBtn('worldmap'),
      h('div.title', {}, icon(`world-${w.n}`), ` ${w.name}`),
      h('div.spacer'),
      coinPill(state.coins),
    ),
    h('div.panel-scroll', {}, h('div.level-grid', {}, cards)),
  );
}

// ---------- ACHIEVEMENTS ----------
export function renderAchievements() {
  const unlockedCount = achievements.filter((a) => state.achievementsUnlocked[a.id]).length;
  const cards = achievements
    .slice()
    .sort((a, b) => (state.achievementsUnlocked[b.id] ? 1 : 0) - (state.achievementsUnlocked[a.id] ? 1 : 0))
    .map((a) => {
      const got = !!state.achievementsUnlocked[a.id];
      return h(`div.ach-card.t-${a.tier}${got ? '' : '.locked'}`, {},
        h('div.a-icon', {}, got ? icon(`medal-${a.tier}`) : icon('question')),
        h('div', {}, h('h4', {}, a.name), h('p', {}, a.desc)),
        h('div.a-coins', {}, `+${a.coins} `, icon('coin')),
      );
    });

  return screen('screen-achievements',
    h('div.topbar', {}, backBtn('menu'),
      h('div.title', {}, icon('trophy'), ' Achievements'),
      h('div.spacer'), coinPill(state.coins),
    ),
    h('div.progress-line', {}, `${unlockedCount} / ${achievements.length} unlocked`),
    h('div.panel-scroll', {}, h('div.ach-grid', {}, cards)),
  );
}

// ---------- BADGES ----------
export function renderBadges() {
  const got = badges.filter((b) => state.badgesEarned[b.id]).length;
  const cards = badges.map((b) => {
    const earned = !!state.badgesEarned[b.id];
    return h(`div.badge-card${earned ? '' : '.locked'}`, {},
      h('div.b-icon', {}, earned ? icon('badge') : icon('lock')),
      h('h4', {}, b.name),
      h('p', {}, b.desc),
    );
  });

  return screen('screen-badges',
    h('div.topbar', {}, backBtn('menu'),
      h('div.title', {}, icon('badge'), ' Badge Wall'),
      h('div.spacer'),
    ),
    h('div.progress-line', {}, `${got} / ${badges.length} earned`),
    h('div.panel-scroll', {}, h('div.badge-grid', {}, cards)),
  );
}

// ---------- CHARACTERS ----------
export function renderCharacters() {
  let selectedId = state.currentChar;

  const listEl = h('div.char-list');
  const detailEl = h('div.char-detail');

  const rerender = () => {
    listEl.replaceChildren(...characters.map((c) => {
      const owned = state.unlockedChars.includes(c.id);
      return h(`button.char-card${c.id === selectedId ? '.selected' : ''}${owned ? '.owned' : '.locked'}`, {
        onClick: () => { playSfx('select'); selectedId = c.id; rerender(); ctx.previewCharacter(c); },
      },
        h('div.c-ball', { style: { '--cb': c.colors.body } }),
        h('h4', {}, c.name),
        owned
          ? h('div.c-cost', {}, c.id === state.currentChar ? '✓ Active' : 'Owned')
          : h('div.c-cost', {}, icon('coin'), ` ${c.cost}`),
      );
    }));

    const c = characters.find((x) => x.id === selectedId);
    const owned = state.unlockedChars.includes(c.id);
    let action;
    if (owned && c.id === state.currentChar) action = h('button.btn.green', { disabled: true }, '✓ Active');
    else if (owned) action = h('button.btn.green', { onClick: () => { selectCharacter(c.id); playSfx('select'); rerender(); } }, 'Choose');
    else action = h('button.btn.orange', {
      onClick: () => {
        if (buyCharacter(c)) { playSfx('buy'); selectCharacter(c.id); ctx.onPurchase(); }
        else playSfx('fail');
        rerender();
      },
    }, state.coins >= c.cost ? h('span', {}, 'Buy ', icon('coin'), ` ${c.cost}`) : h('span', {}, 'Need ', icon('coin'), ` ${c.cost}`));

    detailEl.replaceChildren(
      h('div.cd-panel', {},
        h('h3', {}, c.name),
        h('p', {}, c.desc),
        action,
      ),
    );
  };
  rerender();
  ctx.previewCharacter(characters.find((c) => c.id === selectedId));

  return screen('screen-characters',
    h('div.topbar', {}, backBtn('menu'),
      h('div.title', {}, icon('bloop'), ' Bloop Collection'),
      h('div.spacer'), coinPill(state.coins),
    ),
    h('div.char-layout', {}, listEl, detailEl),
  );
}
