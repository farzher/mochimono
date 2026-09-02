const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const rail = document.querySelector('#dateRail');
const commandbar = document.querySelector('.commandbar');

let layout = null;
let dirty = true;
let cursorHash = '';
let holding = false;
let railWasHidden = null;
let sentinelState = null;

const arrows = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
const gridActive = () => files?.classList.contains('grid');

function editingControl(event) {
  const control = event.target?.closest?.('input,select,textarea,[contenteditable="true"]');
  if (!control) return false;
  return !(control.id === 'search' && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || !control.value));
}

const style = document.createElement('style');
style.textContent = `
  #dateRail.fast-keyboard-rail[hidden]{display:block!important}
  html.keyboard-navigation-active #files.grid .file-card.context-keyboard-focus:not(.keyboard-cursor){outline:none!important;box-shadow:none!important}
  #files.grid .file-card.keyboard-cursor{position:relative;z-index:2;outline:2px solid rgba(239,160,154,.9)!important;outline-offset:-2px!important}
  #files.grid .file-card.keyboard-cursor .file-context-badge{opacity:.86!important;transform:none!important;transition:none!important}
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
  const entries = [];
  const byHash = new Map();
  for (const card of files.querySelectorAll('[data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const entry = {
      card,
      hash: card.dataset.hash || '',
      index: entries.length,
      cx: rect.left + rect.width / 2,
      top: rect.top + scrollY,
      height: rect.height
    };
    entries.push(entry);
    if (entry.hash) byHash.set(entry.hash, card);
  }

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
    row.entries.forEach(entry => byCard.set(entry.card, { entry, rowIndex }));
  });

  layout = {
    entries,
    cards: entries.map(entry => entry.card),
    rows,
    byCard,
    byHash,
    viewportTop: (commandbar?.getBoundingClientRect().bottom || 0) + 2
  };

  const selected = cursorHash && byHash.get(cursorHash);
  for (const card of files.querySelectorAll('.keyboard-cursor[data-hash]')) {
    if (card !== selected) card.classList.remove('keyboard-cursor');
  }
  selected?.classList.add('keyboard-cursor');
  dirty = false;
  return layout;
}

const currentLayout = () => !layout || dirty ? buildLayout() : layout;
const cursorCard = state => cursorHash ? state.byHash.get(cursorHash) || null : null;

function visibleInfo(state, card) {
  const info = card && state.byCard.get(card);
  if (!info) return null;
  const top = info.entry.top - scrollY;
  const bottom = top + info.entry.height;
  return bottom > state.viewportTop && top < innerHeight ? { ...info, top, bottom } : null;
}

function activeCard(state) {
  const card = document.activeElement?.closest?.('#files [data-hash]');
  return visibleInfo(state, card) ? card : null;
}

function visibleAnchor(state) {
  let best = null;
  let bestTop = Infinity;
  let bestX = Infinity;
  for (const entry of state.entries) {
    const top = entry.top - scrollY;
    if (top + entry.height <= state.viewportTop || top >= innerHeight) continue;
    if (entry.top < bestTop - 3 || (Math.abs(entry.top - bestTop) <= 3 && entry.cx < bestX)) {
      best = entry.card;
      bestTop = entry.top;
      bestX = entry.cx;
    }
  }
  return best || state.cards[0] || null;
}

function freezeRail() {
  if (!rail) return;
  if (railWasHidden == null) railWasHidden = rail.hidden;
  if (railWasHidden) return;
  rail.classList.add('fast-keyboard-rail');
  rail.hidden = true;
}

function releaseRail() {
  if (!rail || railWasHidden == null) return;
  const hidden = railWasHidden;
  railWasHidden = null;
  rail.classList.remove('fast-keyboard-rail');
  rail.hidden = hidden;
}

function hideSentinels() {
  if (sentinelState?.top) sentinelState.top.hidden = true;
  if (sentinelState?.bottom) sentinelState.bottom.hidden = true;
}

function freezeSentinels() {
  if (!sentinelState) {
    const top = document.querySelector('#top-scroll-sentinel');
    const bottom = document.querySelector('#scroll-sentinel');
    sentinelState = { top, bottom, topHidden: top?.hidden, bottomHidden: bottom?.hidden };
  }
  hideSentinels();
}

function releaseSentinels() {
  if (!sentinelState) return;
  const { top, bottom, topHidden, bottomHidden } = sentinelState;
  sentinelState = null;
  const state = window.mochimonoLibrary?.state?.();
  if (top) top.hidden = state ? !state.hasPrevious : Boolean(topHidden);
  if (bottom) bottom.hidden = state ? !state.hasMore : Boolean(bottomHidden);
}

function prioritizeRow(card, state) {
  const info = state.byCard.get(card);
  const row = info && state.rows[info.rowIndex];
  window.mochimonoThumbnails?.prioritize?.(row ? row.entries.map(entry => entry.card) : [card]);
}

function moveCursor(card, state = currentLayout()) {
  if (!card) return false;
  for (const previous of files.querySelectorAll('.keyboard-cursor[data-hash]')) {
    if (previous !== card) previous.classList.remove('keyboard-cursor');
  }
  cursorHash = card.dataset.hash || '';
  card.classList.add('keyboard-cursor');
  document.documentElement.classList.add('keyboard-navigation-active');
  freezeRail();
  prioritizeRow(card, state);

  const info = state.byCard.get(card);
  if (!info) return true;
  const top = info.entry.top - scrollY;
  const bottom = top + info.entry.height;
  let delta = 0;
  if (top < state.viewportTop) delta = top - state.viewportTop;
  else if (bottom > innerHeight - 2) delta = bottom - (innerHeight - 2);
  if (Math.abs(delta) > .5) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
  return true;
}

function bootstrapCursor() {
  if (!viewer?.hidden || !gridActive()) return false;
  dirty = true;
  const state = currentLayout();
  const existing = cursorCard(state);
  const card = visibleInfo(state, existing) ? existing : activeCard(state) || visibleAnchor(state);
  return moveCursor(card, state);
}

function verticalTarget(state, current, direction) {
  const info = state.byCard.get(current);
  const row = info && state.rows[info.rowIndex + direction];
  if (!info || !row) return null;
  let best = null;
  let distance = Infinity;
  for (const entry of row.entries) {
    const next = Math.abs(entry.cx - info.entry.cx);
    if (next < distance) {
      best = entry.card;
      distance = next;
    }
  }
  return best;
}

function targetFor(state, current, key) {
  const info = state.byCard.get(current);
  if (!info) return null;
  if (key === 'ArrowLeft' || key === 'ArrowRight') return state.cards[info.entry.index + (key === 'ArrowLeft' ? -1 : 1)] || null;
  return verticalTarget(state, current, key === 'ArrowUp' ? -1 : 1);
}

function extendAndContinue(key, current) {
  const direction = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
  const hash = current.dataset.hash || '';
  const anchorTop = current.getBoundingClientRect().top;
  let extended = false;
  try {
    extended = Boolean(window.mochimonoLibrary?.extend?.(direction));
  } catch (error) {
    console.error('Mochimono grid extension failed.', error);
  }
  hideSentinels();
  if (!extended) return true;

  dirty = true;
  const same = hash && files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  if (same) {
    const delta = same.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) > .5) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
  }

  const state = buildLayout();
  const start = state.byHash.get(hash);
  const target = start && targetFor(state, start, key);
  if (target) moveCursor(target, state);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!holding || !cursorHash) return;
    dirty = true;
    const settled = currentLayout();
    const selected = cursorCard(settled);
    if (selected) moveCursor(selected, settled);
  }));
  return true;
}

function navigate(key) {
  const state = currentLayout();
  const current = cursorCard(state) || activeCard(state);
  if (!current) return bootstrapCursor();
  if (!cursorHash || cursorHash !== current.dataset.hash) moveCursor(current, state);
  const target = targetFor(state, current, key);
  return target ? moveCursor(target, state) : extendAndContinue(key, current);
}

function press(key) {
  if (!arrows.has(key) || !viewer?.hidden || !gridActive()) return false;
  if (!holding) {
    holding = true;
    freezeSentinels();
    dirty = true;
    const state = currentLayout();
    const existing = cursorCard(state);
    if (!visibleInfo(state, existing)) {
      if (!moveCursor(activeCard(state) || visibleAnchor(state), state)) {
        holding = false;
        releaseRail();
        releaseSentinels();
        return false;
      }
      return true;
    }
  }
  return navigate(key);
}

function release() {
  if (!holding && railWasHidden == null && !sentinelState) return;
  holding = false;
  releaseRail();
  releaseSentinels();
  dirty = true;
  const card = cursorHash && files.querySelector(`[data-hash="${CSS.escape(cursorHash)}"]`);
  if (!card) return;
  const y = scrollY;
  card.focus({ preventScroll: true });
  if (scrollY !== y) scrollTo({ top: y, left: 0, behavior: 'auto' });
}

function resetNavigation(clearCursor = false) {
  holding = false;
  releaseRail();
  releaseSentinels();
  if (!clearCursor) return;
  for (const card of files.querySelectorAll('.keyboard-cursor')) card.classList.remove('keyboard-cursor');
  cursorHash = '';
  document.documentElement.classList.remove('keyboard-navigation-active');
}

function syncReturnedCursor(hash) {
  resetNavigation(true);
  cursorHash = String(hash || '');
  dirty = true;
  const state = currentLayout();
  const card = cursorCard(state);
  if (!card || !gridActive()) return;
  card.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
  dirty = true;
  moveCursor(card, currentLayout());
  releaseRail();
  const y = scrollY;
  card.focus({ preventScroll: true });
  if (scrollY !== y) scrollTo({ top: y, left: 0, behavior: 'auto' });
}

window.mochimonoGridKeyboard = { press, release, reset: resetNavigation };

document.addEventListener('keydown', event => {
  if (editingControl(event) || !press(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
document.addEventListener('keyup', event => {
  if (!arrows.has(event.key)) return;
  release();
}, true);
window.addEventListener('blur', () => resetNavigation());
window.addEventListener('mochimono-viewer-return', event => syncReturnedCursor(event.detail?.hash));
files?.addEventListener('pointerdown', () => resetNavigation(true), true);

if (files) {
  new MutationObserver(records => { if (structuralMutation(records)) dirty = true; }).observe(files, { childList: true, subtree: true });
  new ResizeObserver(() => { dirty = true; }).observe(files);
}
window.addEventListener('mochimono:grid-laid-out', () => { if (!holding) dirty = true; });
window.addEventListener('mochimono:media-size', () => { dirty = true; });
