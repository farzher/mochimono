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
let directFocused = null;
let railWasHidden = null;
let preextendCancel = null;
let preextendDirection = 0;

const arrowKeys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
const gridActive = () => views?.querySelector('[data-view="grid"]')?.classList.contains('active');

function editingControl(event) {
  const control = event.target?.closest?.('input,select,textarea,[contenteditable="true"]');
  if (!control) return false;
  if (control.id === 'search' && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || !control.value)) return false;
  return true;
}

const style = document.createElement('style');
style.textContent = `
  #dateRail.fast-keyboard-rail[hidden]{display:block!important}
  html.keyboard-navigation-active #files.grid .file-card.context-keyboard-focus:not(.keyboard-cursor){outline:none!important;box-shadow:none!important}
  #files.grid .file-card.keyboard-cursor{position:relative;z-index:2;outline:none!important}
  #files.grid .file-card.media-card.keyboard-cursor::before{opacity:0!important;transform:none!important;transition:none!important}
  #files.grid .file-card.media-card.keyboard-cursor::after{content:""!important;z-index:20!important;inset:0!important;width:auto!important;height:auto!important;padding:0!important;border-radius:3px!important;opacity:1!important;transform:none!important;background:none!important;box-shadow:inset 0 0 0 2px rgba(239,160,154,.82),inset 0 0 0 3px rgba(0,0,0,.34)!important;transition:none!important;pointer-events:none}
  #files.grid .file-card:not(.media-card).keyboard-cursor{box-shadow:inset 0 0 0 2px rgba(239,160,154,.82),inset 0 0 0 3px rgba(0,0,0,.34)!important}
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
  for (const card of files.querySelectorAll('[data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    entries.push({ card, hash: card.dataset.hash || '', index: entries.length, cx: rect.left + rect.width / 2, top: rect.top + scrollY, height: rect.height });
  }
  const cards = entries.map(entry => entry.card);
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

  layout = { cards, entries, rows, byCard, viewportTop: (commandbar?.getBoundingClientRect().bottom || 0) + 2 };
  dirty = false;
  return layout;
}

const currentLayout = () => !layout || dirty ? buildLayout() : layout;

function focusedCard(state) {
  if (holding && directFocused?.isConnected && state.byCard.has(directFocused)) return directFocused;
  const cursor = files.querySelector('.keyboard-cursor[data-hash]');
  if (cursor && state.byCard.has(cursor)) return cursor;
  return null;
}

function firstVisibleCard(state) {
  const top = scrollY + state.viewportTop;
  const bottom = scrollY + innerHeight;
  let rowTop = Infinity;
  let best = null;
  for (const entry of state.entries) {
    if (entry.top + entry.height <= top || entry.top >= bottom) continue;
    if (entry.top < rowTop - 3) { rowTop = entry.top; best = entry; }
    else if (Math.abs(entry.top - rowTop) <= 3 && entry.cx < best.cx) best = entry;
  }
  return best?.card || state.cards[0] || null;
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

function moveFocus(card, state = currentLayout()) {
  if (!card) return false;
  if (directFocused && directFocused !== card) directFocused.classList.remove('keyboard-cursor');
  else if (!directFocused) files.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
  directFocused = card;
  card.classList.add('keyboard-cursor');
  document.documentElement.classList.add('keyboard-navigation-active');
  freezeRailScan();

  const info = state.byCard.get(card);
  if (!info) return true;
  const top = info.entry.top - scrollY;
  const bottom = top + info.entry.height;
  if (top < state.viewportTop) scrollBy(0, top - state.viewportTop);
  else if (bottom > innerHeight - 2) scrollBy(0, bottom - (innerHeight - 2));
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
    if (next < distance) { best = entry.card; distance = next; }
  }
  return best;
}

function navigateWithin(state, current, key) {
  const info = state.byCard.get(current);
  if (!info) return null;
  if (key === 'ArrowLeft' || key === 'ArrowRight') return state.cards[info.entry.index + (key === 'ArrowLeft' ? -1 : 1)] || null;
  return adjacentVertical(state, current, key === 'ArrowUp' ? -1 : 1);
}

function clearPreextend() {
  preextendCancel?.();
  preextendCancel = null;
  preextendDirection = 0;
}

function nearWindowEdge(card, state, direction) {
  const info = state.byCard.get(card);
  if (!info || state.cards.length < 2) return false;
  const margin = Math.max(24, Math.floor(state.cards.length / 3));
  return direction < 0 ? info.entry.index < margin : info.entry.index >= state.cards.length - margin;
}

function rotateWindow(direction, current, afterLayout = null) {
  clearPreextend();
  const hash = current.dataset.hash || '';
  const anchorTop = current.getBoundingClientRect().top;
  paging = true;
  if (!window.mochimonoLibrary?.extend?.(direction)) {
    paging = false;
    return false;
  }
  if (current.isConnected) {
    const delta = current.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) > .5) scrollBy(0, delta);
  }

  dirty = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const state = currentLayout();
    const start = state.entries.find(entry => entry.hash === hash)?.card || focusedCard(state);
    afterLayout?.(state, start);
    paging = false;
    const queued = queuedKey;
    queuedKey = '';
    if (queued) navigate(queued);
  }));
  return true;
}

function schedulePreextend(card, state, key) {
  const direction = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
  if (!nearWindowEdge(card, state, direction)) {
    if (preextendDirection === direction) clearPreextend();
    return;
  }
  if (preextendCancel && preextendDirection === direction) return;
  clearPreextend();
  preextendDirection = direction;

  const run = () => {
    preextendCancel = null;
    preextendDirection = 0;
    if (!holding || paging || !directFocused?.isConnected) return;
    const latest = currentLayout();
    if (nearWindowEdge(directFocused, latest, direction)) rotateWindow(direction, directFocused);
  };

  if ('requestIdleCallback' in window) {
    const handle = requestIdleCallback(run, { timeout: 70 });
    preextendCancel = () => cancelIdleCallback(handle);
  } else {
    const handle = setTimeout(run, 16);
    preextendCancel = () => clearTimeout(handle);
  }
}

function extendAndContinue(key, current) {
  const direction = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
  return rotateWindow(direction, current, (state, start) => {
    const target = start && navigateWithin(state, start, key);
    if (!target) return;
    moveFocus(target, state);
    schedulePreextend(target, state, key);
  });
}

function navigate(key) {
  if (paging) { queuedKey = key; return true; }
  const state = currentLayout();
  const current = focusedCard(state);
  if (!current) return moveFocus(firstVisibleCard(state), state);
  const target = navigateWithin(state, current, key);
  if (!target) return extendAndContinue(key, current);
  const moved = moveFocus(target, state);
  if (moved) schedulePreextend(target, state, key);
  return moved;
}

function settleHold() {
  clearPreextend();
  queuedKey = '';
  if (!holding && railWasHidden == null) return;
  holding = false;
  releaseRailScan();
  dirty = true;
  const card = directFocused?.isConnected ? directFocused : null;
  if (!card) return;
  if (card.tabIndex < 0) card.tabIndex = 0;
  const y = scrollY;
  card.focus({ preventScroll: true });
  if (scrollY !== y) scrollTo(0, y);
}

document.addEventListener('keydown', event => {
  if (!arrowKeys.has(event.key) || !viewer?.hidden || !gridActive() || editingControl(event)) return;
  if (!holding) {
    const state = currentLayout();
    directFocused = focusedCard(state);
    holding = true;
    if (!directFocused) {
      if (!moveFocus(firstVisibleCard(state), state)) { holding = false; return; }
      document.activeElement?.closest?.('input,select,textarea,[contenteditable="true"]')?.blur?.();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }
  if (!navigate(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

document.addEventListener('keyup', event => { if (arrowKeys.has(event.key)) settleHold(); }, true);
window.addEventListener('blur', settleHold);

files?.addEventListener('pointerdown', () => {
  document.documentElement.classList.remove('keyboard-navigation-active');
  files.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
}, true);

if (files) {
  new MutationObserver(records => { if (structuralMutation(records)) dirty = true; }).observe(files, { childList: true, subtree: true });
  new ResizeObserver(() => { dirty = true; }).observe(files);
}
window.addEventListener('mochimono:grid-laid-out', () => { if (!holding) dirty = true; });
window.addEventListener('mochimono:media-size', () => { dirty = true; });
