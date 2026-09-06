import { h } from './dom.js';
import { icon as uiIcon } from './icons.js';
import { playSfx } from '../audio/sfx.js';

const queue = [];
let showing = 0;
const MAX_VISIBLE = 1;

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
  // The accent rail colour tells badges and achievements apart at a glance.
  const el = h(`div.toast.k-${t.kind && t.kind.startsWith('Badge') ? 'badge' : 'ach'}`, { role: 'status', 'aria-live': 'polite' },
    h('div.t-icon', {}, t.icon || uiIcon('trophy')),
    h('div', {},
      h('h5', {}, t.kind || 'Unlocked'),
      h('p', {}, t.title),
      // Not an <h5>. Reusing the kicker element put the reward — "+10 coins" —
      // through 11px uppercase with 0.08em tracking, and ran a whole sentence
      // of badge description through the same treatment.
      t.sub ? h('p.t-sub', {}, t.sub) : null,
    ),
  );
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => { el.remove(); showing--; drain(); }, 320);
  }, 2400);
}
