const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const views = document.querySelector('#views');
const rail = document.querySelector('#dateRail');
const commandbar = document.querySelector('.commandbar');

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
      top: rect.top + scrollY,
      height: rect.height
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

  layout = {
    cards,
    entries,
    rows,
    byCard,
    viewportTop: (commandbar?.getBoundingClientRect().bottom || 0) + 2
  };
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
  if (!directFocused?.isConnected) directFocused = files.querySelector('.context-keyboard-focus[data-hash]');
  if (directFocused && directFocused !== card) directFocused.classList.remove('context-keyboard-focus');
  directFocused = card;
  card.classList.add('context-keyboard-focus');
  document.documentElement.classList.add('keyboard-navigation-active');
}

function scrollCachedTargetIntoView(state, card) {
  const info = state.byCard.get(card);
  if (!info) return;
  const top = info.entry.top - scrollY;
  const bottom = top + info.entry.height;
  const viewportTop = state.viewportTop;
  const viewportBottom = innerHeight - 2;
  if (top < viewportTop) scrollBy(0, top - viewportTop);
  else if (bottom > viewportBottom) scrollBy(0, bottom - viewportBottom);
}

function focusCard(card, state = null) {
  if (!card) return false;
  state ||= currentLayout();
  if (card.tabIndex < 0) card.tabIndex = 0;
  paintDirectFocus(card);
  freezeRailScan();
  suppressFocus = true;
  card.focus({ preventScroll: true });
  suppressFocus = false;
  scrollCachedTargetIntoView(state, card);
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
    if (target) focusCard(target, state);
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
  if (target) return focusCard(target, state);
  return extendAndContinue(key, current.dataset.hash || '');
}

function settleHold() {
  if (!holding && railWasHidden == null) return;
  holding = false;
  releaseRailScan();
  dirty = true;

  const active = document.activeElement?.closest?.('#files [data-hash]');
  if (active) active.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
}

files?.addEventListener('focusin', event => {
  if (!suppressFocus) return;
  event.stopImmediatePropagation();
  event.stopPropagation();
}, true);

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
window.addEventListener('mochimono:grid-laid-out', () => { if (!holding) dirty = true; });
window.addEventListener('mochimono:media-size', () => { dirty = true; });
