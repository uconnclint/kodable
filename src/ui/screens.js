// All non-gameplay screens: menu, world map, level select, achievements,
// badges, characters. Each screen is re-rendered on entry.
import { h } from './dom.js';
import { icon, coinPill, starRow } from './icons.js';
import { state, worldUnlocked, levelUnlocked, buyCharacter, selectCharacter, resetAll } from '../game/save.js';
import { achievements } from '../game/achievements.js';
import { badges } from '../game/badges.js';
import { characters } from '../game/characters.js';
import { characterThumbnail } from '../engine/bloop.js';
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
  return h('button.icon-btn', { 'aria-label': 'Back', onClick: () => { playSfx('ui'); ctx.show(target); } }, icon('back'));
}

const starsTotal = () => Object.values(state.stars).reduce((a, b) => a + b, 0);

// ---------- MENU ----------
export function renderMenu() {
  const setMuteIcon = () => {
    muteBtn.replaceChildren(icon(isMuted() ? 'sound-off' : 'sound-on'));
    muteBtn.setAttribute('aria-label', isMuted() ? 'Turn sound on' : 'Turn sound off');
  };
  const muteBtn = h('button.icon-btn', {
    'aria-label': isMuted() ? 'Turn sound on' : 'Turn sound off',
    onClick: () => { setMuted(!isMuted()); setMuteIcon(); playSfx('ui'); },
  });
  setMuteIcon();

  return screen('screen-menu',
    h('div.game-logo', {},
      h('h1', { html: 'BLOOP<span class="fz">TOPIA</span>' }),
      h('div.tagline', {}, 'A 3D coding adventure — program your bloop!'),
    ),
    h('div.menu-buttons', {},
      h('button.btn.big.green', { onClick: () => { playSfx('run'); ctx.show('worldmap'); } }, icon('play'), 'PLAY'),
      h('div.menu-row', {},
        h('button.btn', { onClick: () => { playSfx('ui'); ctx.show('characters'); } }, icon('bloop'), 'Bloops'),
        h('button.btn.orange', { onClick: () => { playSfx('ui'); ctx.show('achievements'); } }, icon('trophy'), 'Awards'),
        h('button.btn', { onClick: () => { playSfx('ui'); ctx.show('badges'); } }, icon('badge'), 'Badges'),
      ),
      h('div.menu-row', {}, muteBtn),
      // The two grown-up affordances, together and away from the play buttons.
      // Wiping every star, badge and purchase used to be an unlabelled 52px
      // square sitting twelve pixels from the sound toggle, with identical
      // treatment — one mis-tap from a five-year-old away from erasing a term's
      // work. It now says what it does, in a warning colour, next to the other
      // thing on this screen written for an adult.
      h('div.adult-row', {},
        h('a.guide-link', { href: './teacher-guide.html', target: '_blank', rel: 'noopener' }, '🍎 Grown-Ups’ Corner — Teacher Guide'),
        h('button.danger-link', {
          'aria-label': 'Reset all progress. This erases every star, badge and bloop.',
          onClick: () => {
            if (confirm('Reset ALL progress? Every star, badge and bloop will be erased. This cannot be undone!')) { resetAll(); location.reload(); }
          },
        }, icon('trash'), 'Reset all progress'),
      ),
    ),
    h('div.copyright', {}, '© 2026 Clint McLeod'),
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
      disabled: !unlocked,
      'aria-label': unlocked
        ? `World ${w.n}: ${w.name}. ${done} of 12 levels complete, ${stars} of 36 stars.`
        : `World ${w.n}: ${w.name}. Locked. Complete 9 levels in the previous world to unlock.`,
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
      h('div.w-stats', {}, h('span', {}, `${done}/12 levels`), h('span', {}, icon('star-filled'), `${stars}/36`)),
      // A locked card should explain itself. Previously the only hint was a
      // translucent veil with a padlock, which read as a rendering fault.
      unlocked ? null : h('div.w-locked-note', {}, icon('lock'), `Finish 9 levels in World ${w.n - 1} to open this`),
      unlocked ? null : h('div.lock-badge', {}, icon('lock')),
    );
  });

  return screen('screen-worldmap',
    h('div.topbar', {}, backBtn('menu'),
      h('div.title', {}, 'Choose a World'),
      h('div.spacer'),
      coinPill(state.coins),
      h('div.coin-pill', {}, icon('star-filled'), `${starsTotal()}/180`),
    ),
    h('div.panel-scroll', {}, h('div.world-grid', {}, cards)),
  );
}

// ---------- LEVEL SELECT ----------
export function renderLevels() {
  const w = WORLD_INFO[ctx.currentWorld - 1];
  const wl = ctx.allLevels.filter((l) => l.world === ctx.currentWorld).sort((a, b) => a.index - b.index);
  // The one card that says "start here". Eleven locked cards and one playable
  // one differed only by fill, and 1.18:1 of it, so the screen had no positive
  // mark for the thing it is actually asking a child to do next.
  const nextUp = wl.find((l) => levelUnlocked(l, ctx.allLevels) && !state.completed[l.id]);
  const cards = wl.map((lv) => {
    const unlocked = levelUnlocked(lv, ctx.allLevels);
    const stars = state.stars[lv.id] || 0;
    return h(`button.level-card${unlocked ? '' : '.locked'}${lv === nextUp ? '.next-up' : ''}${state.perfect[lv.id] ? '.perfect' : ''}`, {
      disabled: !unlocked,
      'aria-label': unlocked
        ? `Level ${lv.index}: ${lv.name}. ${stars} of 3 stars${state.perfect[lv.id] ? ', perfect' : ''}.`
        : `Level ${lv.index}: ${lv.name}. Locked. Complete the previous level to unlock.`,
      onClick: () => {
        if (!unlocked) { playSfx('fail'); return; }
        playSfx('run');
        ctx.startLevel(lv);
      },
    },
      // The numeral always shows. Replacing it with a padlock made eleven of
      // the twelve cards in a world identical, which erased the one thing the
      // screen is teaching — that levels run in an order. The lock is a corner
      // chip instead, exactly as it is on the world cards.
      h('div.l-num', {}, String(lv.index)),
      h('div.l-name', {}, lv.name),
      h('div.l-stars', {}, ...starRow(stars, 3)),
      unlocked ? null : h('div.lock-badge', { 'aria-hidden': 'true' }, icon('lock')),
      state.perfect[lv.id] ? h('div.l-perfect', { 'aria-hidden': 'true' }, icon('perfect')) : null,
    );
  });

  return screen('screen-levels',
    h('div.topbar', {}, backBtn('worldmap'),
      h('div.title', {}, icon(`world-${w.n}`), w.name),
      h('div.spacer'),
      coinPill(state.coins),
    ),
    // --wc is the world's accent, which the next-up card's rail reads.
    h('div.panel-scroll', {}, h('div.level-grid', { style: { '--wc': w.color } }, cards)),
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
      // The medal shows whether or not it is earned, drained of colour until
      // it is. Sixty-three identical question marks on identical grey plates
      // hid the entire bronze/silver/gold ladder — which is the one thing that
      // makes a wall of awards feel like a wall worth climbing.
      // The plate carries the tier; the glyph carries the award. Every
      // achievement ships its own icon and the wall was throwing all 63 of
      // them away in favour of one medal drawing repeated 63 times, so the
      // only thing separating one row from the next was 13px of description.
      return h(`div.ach-card.t-${a.tier}${got ? '' : '.locked'}`, {},
        h('div.a-icon', {}, h('span.a-glyph', { 'aria-hidden': 'true' }, a.icon),
          got ? null : h('span.a-lock', { 'aria-hidden': 'true' }, icon('lock'))),
        h('div', {}, h('h4', {}, a.name), h('p', {}, a.desc)),
        // No literal space before the coin: the row is a flex container with a
        // gap, so a space becomes a second, unequal gutter of its own.
        h('div.a-coins', {}, `+${a.coins}`, icon('coin')),
      );
    });

  return screen('screen-achievements',
    h('div.topbar', {}, backBtn('menu'),
      h('div.title', {}, icon('trophy'), 'Achievements'),
      h('div.spacer'), coinPill(state.coins),
    ),
    h('div.progress-line', {}, h('span', {}, `${unlockedCount} of ${achievements.length} unlocked`)),
    h('div.panel-scroll', {}, h('div.ach-grid', {}, cards)),
  );
}

// ---------- BADGES ----------
export function renderBadges() {
  const got = badges.filter((b) => state.badgesEarned[b.id]).length;
  const cards = badges.map((b) => {
    const earned = !!state.badgesEarned[b.id];
    // Same art whether earned or not, greyed until it is. Swapping every
    // unearned badge for a padlock turned a wall of twenty-two distinct awards
    // into twenty-two copies of one shape.
    return h(`div.badge-card${earned ? '' : '.locked'}`, {},
      h('div.b-icon', {}, h('span.b-glyph', { 'aria-hidden': 'true' }, b.icon)),
      h('h4', {}, b.name),
      h('p', {}, b.desc),
      earned ? null : h('div.lock-badge', { 'aria-hidden': 'true' }, icon('lock')),
    );
  });

  return screen('screen-badges',
    h('div.topbar', {}, backBtn('menu'),
      h('div.title', {}, icon('badge'), 'Badge Wall'),
      h('div.spacer'),
    ),
    h('div.progress-line', {}, h('span', {}, `${got} of ${badges.length} earned`)),
    h('div.panel-scroll', {}, h('div.badge-grid', {}, cards)),
  );
}

// ---------- CHARACTERS ----------
// One card's avatar: the rendered model when WebGL is available, the flat
// gradient chip when it is not.
function charChip(c) {
  const shot = characterThumbnail(c, 168);
  if (!shot) {
    return h('div.c-ball', { style: { '--cb': c.colors.body, '--cb2': c.colors.accent } });
  }
  return h('img.c-ball.c-shot', { src: shot, alt: '', width: '58', height: '58', draggable: 'false' });
}

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
        // The real 3D model, rendered once per character to an offscreen
        // canvas and cached. This grid exists to sell sixteen silhouettes, so
        // drawing them all as the same tinted circle sold none of them: the
        // crown, the horns, the headphones and the eye styles are the entire
        // reason to save up 1200 coins, and they were invisible here.
        // `characterThumbnail` returns null if it cannot get a GL context, in
        // which case we keep the flat chip — body *and* accent, because on hue
        // alone Mossy, Minty and Zapp were three greens and Rosie, Coral and
        // Bubbles three pinks, a difference a colour-blind child cannot see.
        charChip(c),
        h('h4', {}, c.name),
        owned
          ? h('div.c-cost', {}, c.id === state.currentChar ? '✓ Active' : 'Owned')
          : h(`div.c-cost${state.coins >= c.cost ? '.afford' : ''}`, {}, icon('coin'), String(c.cost)),
      );
    }));

    const c = characters.find((x) => x.id === selectedId);
    const owned = state.unlockedChars.includes(c.id);
    let action;
    if (owned && c.id === state.currentChar) action = h('button.btn.green.state-on', { disabled: true }, '✓ Active');
    else if (owned) action = h('button.btn.green', { onClick: () => { selectCharacter(c.id); playSfx('select'); rerender(); } }, 'Choose');
    else action = h('button.btn.orange', {
      onClick: () => {
        if (buyCharacter(c)) {
          playSfx('buy');
          selectCharacter(c.id);
          ctx.onPurchase();
          ctx.show('characters');
          return;
        }
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
      h('div.title', {}, icon('bloop'), 'Bloop Collection'),
      h('div.spacer'), coinPill(state.coins),
    ),
    h('div.char-layout', {}, listEl, detailEl),
  );
}
