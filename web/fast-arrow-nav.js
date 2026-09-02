const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const views = document.querySelector('#views');
const rail = document.querySelector('#dateRail');

let layout = null;
let dirty = true;
let paging = false;
let queuedKey = '';
let holding = false;
let suppressFocus = false;
let directFocused = null;
let railWasHidden = null;

const arrowKeys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
const typingTarget = target => Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
const gridActive = () => views?.querySelector('[data-view="grid"]')?.classList.contains('active');

const style = document.createElement('style');
style.textContent = `
  #dateRail.fast-keyboard-rail[hidden]{display:block!important}
`;
document.head.append(style);

function structuralMutation(records) {
  for (const record of records) {
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (!(node instanceof Element)) continue;
      if (node.matches('[data-hash],.date-grid,.date-group') || node.querySelector?.('[data-hash],.date-grid,.date-group')) return true;
    }
  }
  return false;
}

function buildLayout() {
  const cards = [...files.querySelectorAll('[data-hash]')].filter(card => card.offsetWidth > 0 && card.offsetHeight > 0);
  const entries = cards.map((card, index) => {
    const rect = card.getBoundingClientRect();
    return {
      card,
      hash: card.dataset.hash || '',
      index,
      cx: rect.left + rect.width / 2,
      top: rect.top + scrollY
    };
  });

  const rows = [];
  const byCard = new WeakMap();
  for (const entry of entries) {
    let row = rows.at(-1);
    if (!row || Math.abs(row.top - entry.top) > 3) {
      row = { top: entry.top, entries: [] };
      rows.push(row);
    }
    row.entries.push(entry);
  }
  rows.forEach((row, rowIndex) => {
    row.entries.sort((a, b) => a.cx - b.cx);
    row.entries.forEach((entry, rowPosition) => byCard.set(entry.card, { entry, rowIndex, rowPosition }));
  });

  layout = { cards, entries, rows, byCard };
  dirty = false;
  return layout;
}

function currentLayout() {
  return !layout || dirty ? buildLayout() : layout;
}

function focusedCard(state) {
  const active = document.activeElement?.closest?.('#files [data-hash]');
  if (active && state.byCard.has(active)) return active;
  return directFocused?.isConnected ? directFocused : files.querySelector('.context-keyboard-focus[data-hash]');
}

function freezeRailScan() {
  if (!rail) return;
  if (railWasHidden == null) railWasHidden = rail.hidden;
  if (!railWasHidden) {
    rail.classList.add('fast-keyboard-rail');
    // library-app's scroll handler exits immediately when hidden. CSS above keeps
    // the already-rendered rail visible while we hold the key.
    rail.hidden = true;
  }
}

function releaseRailScan() {
  if (!rail || railWasHidden == null) return;
  const restoreHidden = railWasHidden;
  railWasHidden = null;
  rail.classList.remove('fast-keyboard-rail');
  rail.hidden = restoreHidden;
}

function paintDirectFocus(card) {
  if (directFocused && directFocused !== card) directFocused.classList.remove('context-keyboard-focus');
  directFocused = card;
  card.classList.add('context-keyboard-focus');
  document.documentElement.classList.add('keyboard-navigation-active');
}

function focusCard(card) {
  if (!card) return false;
  if (card.tabIndex < 0) card.tabIndex = 0;
  paintDirectFocus(card);
  freezeRailScan();
  // context-ui normally responds to focusin by rescanning every rendered card.
  // During arrow navigation we already know exactly which card changed, so skip
  // that O(n) path and synchronize it once when the key is released.
  suppressFocus = true;
  card.focus({ preventScroll: true });
  suppressFocus = false;
  card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  return true;
}

function adjacentVertical(state, current, direction) {
  const info = state.byCard.get(current);
  if (!info) return null;
  const row = state.rows[info.rowIndex + direction];
  if (!row) return null;
  const x = info.entry.cx;
  let best = null;
  let distance = Infinity;
  for (const entry of row.entries) {
    const next = Math.abs(entry.cx - x);
    if (next < distance) {
      best = entry.card;
      distance = next;
    }
  }
  return best;
}

function navigateWithin(state, current, key) {
  const info = state.byCard.get(current);
  if (!info) return null;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    return state.cards[info.entry.index + (key === 'ArrowLeft' ? -1 : 1)] || null;
  }
  return adjacentVertical(state, current, key === 'ArrowUp' ? -1 : 1);
}

function afterLayout(callback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function extendAndContinue(key, hash) {
  const direction = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
  if (!window.mochimonoLibrary?.extend?.(direction)) return false;
  paging = true;
  dirty = true;
  afterLayout(() => {
    const state = currentLayout();
    const current = state.entries.find(entry => entry.hash === hash)?.card || focusedCard(state);
    const target = current && navigateWithin(state, current, key);
    if (target) focusCard(target);
    paging = false;
    const queued = queuedKey;
    queuedKey = '';
    if (queued) navigate(queued);
  });
  return true;
}

function navigate(key) {
  if (paging) {
    queuedKey = key;
    return true;
  }
  const state = currentLayout();
  const current = focusedCard(state);
  if (!current) return false;
  const target = navigateWithin(state, current, key);
  if (target) return focusCard(target);
  return extendAndContinue(key, current.dataset.hash || '');
}

function settleHold() {
  if (!holding && railWasHidden == null) return;
  holding = false;
  releaseRailScan();
  dirty = true;

  const active = document.activeElement?.closest?.('#files [data-hash]');
  if (active) {
    // Let context-ui learn the final focused hash and do one normal decoration
    // after the entire key-repeat burst instead of once per repeat.
    active.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  }
}

// This listener is registered before context-ui.js. Suppress only focus events
// generated by our known keyboard move; pointer/programmatic focus still follows
// the normal context-ui path.
files?.addEventListener('focusin', event => {
  if (!suppressFocus) return;
  event.stopImmediatePropagation();
  event.stopPropagation();
}, true);

// Register before context-ui.js. This owns grid arrow navigation and prevents the
// older O(n) geometry scan from running for the same key event.
document.addEventListener('keydown', event => {
  if (!arrowKeys.has(event.key) || !viewer?.hidden || !gridActive() || typingTarget(event.target)) return;
  if (!document.activeElement?.closest?.('#files [data-hash]')) return;
  holding = true;
  if (!navigate(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

document.addEventListener('keyup', event => {
  if (arrowKeys.has(event.key)) settleHold();
}, true);
window.addEventListener('blur', settleHold);

if (files) {
  new MutationObserver(records => {
    if (structuralMutation(records)) dirty = true;
  }).observe(files, { childList: true, subtree: true });
  new ResizeObserver(() => { dirty = true; }).observe(files);
}
// Thumbnail geometry can settle continuously while a key is held. Keep the row
// map stable through that burst; structural card changes above still invalidate it.
window.addEventListener('mochimono:grid-laid-out', () => { if (!holding) dirty = true; });
window.addEventListener('mochimono:media-size', () => { dirty = true; });
