import { h } from './dom.js';
import { icon as uiIcon } from './icons.js';
import { playSfx } from '../audio/sfx.js';

const queue = [];
let showing = 0;
const MAX_VISIBLE = 3;

export function toast({ icon, kind, title, sub }) {
  queue.push({ icon, kind, title, sub });
  drain();
}

export function toastUnlocks(unlocks) {
  for (const u of unlocks) {
    toast({
      icon: u.kind === 'badge' ? uiIcon('badge') : uiIcon(`medal-${u.item.tier}`),
      kind: u.kind === 'badge' ? 'Badge earned!' : 'Achievement!',
      title: u.item.name,
      sub: u.kind === 'achievement' ? h('span', {}, `+${u.item.coins} `, uiIcon('coin')) : u.item.desc,
    });
  }
}

function drain() {
  if (showing >= MAX_VISIBLE || !queue.length) return;
  const t = queue.shift();
  showing++;
  playSfx(t.kind && t.kind.startsWith('Badge') ? 'unlock' : 'achievement');
  const el = h('div.toast', {},
    h('div.t-icon', {}, t.icon || uiIcon('trophy')),
    h('div', {},
      h('h5', {}, t.kind || 'Unlocked'),
      h('p', {}, t.title),
      t.sub ? h('h5', {}, t.sub) : null,
    ),
  );
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => { el.remove(); showing--; drain(); }, 320);
  }, 3400);
}
