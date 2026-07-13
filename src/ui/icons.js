// Custom-art icon system. Every UI/button glyph is an <img> loaded from
// /assets/ui/<name>.png. Until the generated art is dropped in, each icon
// gracefully falls back to its emoji so the game is never broken.
//
// Drop PNGs (transparent, square) into public/assets/ui/ using the names below
// (see docs/ART_SPEC.md). No code change needed — reload and the art appears.

import { h } from './dom.js';

const DIR_ICON = { U: 'dir-up', D: 'dir-down', L: 'dir-left', R: 'dir-right' };
export const dirIconName = (d) => DIR_ICON[d];

const FALLBACK = {
  'dir-up': '⬆️', 'dir-down': '⬇️', 'dir-left': '⬅️', 'dir-right': '➡️',
  loop: '🔁', function: 'F1', play: '▶', run: '▶', next: '▶', preview: '👁️',
  back: '←', 'sound-on': '🔊', 'sound-off': '🔇', trash: '🗑️', clear: '🧹',
  replay: '↻', map: '🗺️', coin: '🪙', 'star-filled': '⭐', 'star-empty': '☆',
  lock: '🔒', bloop: '🐹', trophy: '🏆', badge: '🎖️', win: '🎉', perfect: '💯',
  question: '❓',
  'world-1': '🌸', 'world-2': '💎', 'world-3': '🌀', 'world-4': '🧩', 'world-5': '⛈️',
};

// Names we've already seen 404 this session — skip the network round-trip.
const missing = new Set();

function fallbackSpan(name, cls) {
  const span = document.createElement('span');
  span.className = 'ui-icon ui-icon-fallback' + (cls ? ' ' + cls : '');
  span.textContent = FALLBACK[name] ?? '';
  return span;
}

// Returns an inline icon element. `cls` adds extra classes for sizing/context.
export function icon(name, cls = '') {
  if (missing.has(name)) return fallbackSpan(name, cls);
  const img = document.createElement('img');
  img.className = 'ui-icon' + (cls ? ' ' + cls : '');
  img.src = `/assets/ui/${name}.png`;
  img.alt = '';
  img.draggable = false;
  img.onerror = () => { missing.add(name); img.replaceWith(fallbackSpan(name, cls)); };
  return img;
}

// A coin counter pill: [coin art] N
export function coinPill(n, cls = '') {
  return h('div.coin-pill' + cls, {}, icon('coin'), ` ${n}`);
}

// A row of `total` stars, `filled` of them lit. `cls` for extra sizing context.
export function starRow(filled, total = 3, cls = '') {
  const kids = [];
  for (let i = 0; i < total; i++) {
    kids.push(icon(i < filled ? 'star-filled' : 'star-empty', i < filled ? cls : `${cls} dim`.trim()));
  }
  return kids;
}
