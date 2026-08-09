// Custom-art icon system. Every UI/button glyph is an <img> loaded from
// /assets/ui/<name>.png. Until the generated art is dropped in, each icon
// gracefully falls back to its emoji so the game is never broken.
//
// Drop PNGs (transparent, square) into public/assets/ui/ using the names below
// (see docs/ART_SPEC.md). No code change needed — reload and the art appears.

import { h } from './dom.js';

// Direction arrows are drawn as vector shapes, not loaded PNGs — an
// illustrated "gem" icon reads as decoration, not as an unambiguous arrow,
// and these are the highest-frequency glyphs in the whole game (every command
// a kid places). A plain bold chevron+shaft is instantly recognizable at any
// size and is trivially recolored per-direction via `currentColor`.
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const ARROW_POINTS = '2,8 13,8 13,2 22,12 13,22 13,16 2,16';
const ARROW_ROTATE = { R: 0, D: 90, L: 180, U: 270 };

// A bold arrow icon pointing `d` ('U'|'D'|'L'|'R'). Color comes from CSS
// `color` on an ancestor (uses currentColor) so it matches each direction's
// token border/theme automatically.
export function dirArrowIcon(d, cls = '') {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24', class: 'ui-icon dir-arrow' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true',
  });
  svg.style.transform = `rotate(${ARROW_ROTATE[d]}deg)`;
  svg.append(svgEl('polygon', {
    points: ARROW_POINTS, fill: 'currentColor', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  return svg;
}

const FALLBACK = {
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
  return h('div.coin-pill' + cls, { role: 'status', 'aria-label': `${n} coins` }, icon('coin'), ` ${n}`);
}

// A row of `total` stars, `filled` of them lit. `cls` for extra sizing context.
export function starRow(filled, total = 3, cls = '') {
  const kids = [];
  for (let i = 0; i < total; i++) {
    kids.push(icon(i < filled ? 'star-filled' : 'star-empty', i < filled ? cls : `${cls} dim`.trim()));
  }
  return kids;
}
