// Tiny DOM helper: h('div.cls#id', {attrs/on*}, ...children)
export function h(spec, props = {}, ...children) {
  const [tag, ...rest] = spec.split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const r of rest) {
    if (r[0] === '.') el.classList.add(r.slice(1));
    else if (r[0] === '#') el.id = r.slice(1);
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

const DIR_ARROWS = { U: '⬆️', D: '⬇️', L: '⬅️', R: '➡️' };
export function dirArrow(d) { return DIR_ARROWS[d] || d; }

// ---------------------------------------------------------------------------
// Focus policy: is this focus worth drawing a ring around?
//
// `:focus-visible` answers that question natively, but it only reached Safari
// in 15.4 and the device floor is iPadOS 15.0 — and an unrecognised
// pseudo-class invalidates the *entire* selector list it appears in, so on
// those iPads a rule gated on `:not(:focus-visible)` does not exist at all.
// The stylesheet used to rely on exactly that to suppress the ring for touch,
// which meant every tap on an old iPad left a violet ring stuck on the control
// a child had just pressed.
//
// So the suppression hangs on a class instead. The document starts in the
// quiet state and the first key that could move focus turns rings back on,
// which matches what `:focus-visible` does and works on every engine we ship
// to. The stylesheet still consults `:focus-visible` where it parses; this is
// the layer that is always there.
const focusRoot = document.documentElement;
focusRoot.classList.add('pointer-focus');

const usingPointer = () => focusRoot.classList.add('pointer-focus');
// Modifier-only presses (a screenshot chord, say) are not navigation.
const usingKeyboard = (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  focusRoot.classList.remove('pointer-focus');
};

// Capture phase, so a handler that stops propagation cannot desync the state.
addEventListener('keydown', usingKeyboard, true);
addEventListener('mousedown', usingPointer, true);
addEventListener('pointerdown', usingPointer, true);
addEventListener('touchstart', usingPointer, { capture: true, passive: true });
