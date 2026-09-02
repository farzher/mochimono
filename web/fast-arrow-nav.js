const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const views = document.querySelector('#views');
const rail = document.querySelector('#dateRail');
const commandbar = document.querySelector('.commandbar');

let layout = null;
let dirty = true;
let cursorHash = '';
let holding = false;
let pagingToken = 0;
let nextPagingToken = 1;
let queuedKey = '';
let railWasHidden = null;

const arrows = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
const gridActive = () => views?.querySelector('[data-view="grid"]')?.classList.contains('active');

function editingControl(event) {
  const control = event.target?.closest?.('input,select,textarea,[contenteditable="true"]');
  if (!control) return false;
  return !(control.id === 'search' && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || !control.value));
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
  const visible = state.entries.filter(entry => {
    const top = entry.top - scrollY;
    return top + entry.height > state.viewportTop && top < innerHeight;
  });
  if (!visible.length) return state.cards[0] || null;
  const top = Math.min(...visible.map(entry => entry.top));
  const row = visible.filter(entry => Math.abs(entry.top - top) <= 3);
  return row.reduce((best, entry) => entry.cx < best.cx ? entry : best, row[0]).card;
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
  const state = currentLayout();
  const existing = cursorCard(state);
  if (visibleInfo(state, existing)) return moveCursor(existing, state);
  const card = activeCard(state) || visibleAnchor(state);
  const moved = moveCursor(card, state);
  if (moved && !holding) releaseRail();
  return moved;
}
window.mochimonoGridKeyboardStart = bootstrapCursor;

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

function cancelPaging() {
  pagingToken = 0;
  queuedKey = '';
}

const afterLayout = callback => requestAnimationFrame(() => requestAnimationFrame(callback));

function rotateWindow(direction, current, after) {
  const hash = current.dataset.hash || '';
  const token = nextPagingToken++;
  pagingToken = token;

  let extended = false;
  try {
    // The library owns scroll-anchor preservation when it appends/prepends/trims.
    // Do not independently compensate here or the two scroll corrections race.
    extended = Boolean(window.mochimonoLibrary?.extend?.(direction));
  } catch (error) {
    console.error('Mochimono grid extension failed.', error);
  }
  if (!extended) {
    if (pagingToken === token) pagingToken = 0;
    return false;
  }

  dirty = true;
  afterLayout(() => {
    if (pagingToken !== token) return;
    let queued = '';
    try {
      const state = currentLayout();
      const start = state.byHash.get(hash) || cursorCard(state);
      after?.(state, start);
    } catch (error) {
      console.error('Mochimono grid paging failed.', error);
      dirty = true;
    } finally {
      if (pagingToken === token) {
        pagingToken = 0;
        queued = queuedKey;
        queuedKey = '';
      }
    }
    if (queued) navigate(queued);
  });
  return true;
}

function extendAndContinue(key, current) {
  const direction = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
  return rotateWindow(direction, current, (state, start) => {
    const target = start && targetFor(state, start, key);
    if (target) moveCursor(target, state);
  });
}

function navigate(key) {
  if (pagingToken) {
    queuedKey = key;
    return true;
  }
  const state = currentLayout();
  const current = cursorCard(state) || activeCard(state);
  if (!current) return moveCursor(visibleAnchor(state), state);
  if (!cursorHash || cursorHash !== current.dataset.hash) moveCursor(current, state);
  const target = targetFor(state, current, key);
  return target ? moveCursor(target, state) : extendAndContinue(key, current);
}

function settleHold() {
  queuedKey = '';
  if (!holding && railWasHidden == null) return;
  holding = false;
  releaseRail();
  dirty = true;
  const card = cursorHash && files.querySelector(`[data-hash="${CSS.escape(cursorHash)}"]`);
  if (!card) return;
  if (card.tabIndex < 0) card.tabIndex = 0;
  const y = scrollY;
  card.focus({ preventScroll: true });
  if (scrollY !== y) scrollTo({ top: y, left: 0, behavior: 'auto' });
}

function resetNavigation(clearCursor = false) {
  cancelPaging();
  holding = false;
  releaseRail();
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
  moveCursor(card, state);
  releaseRail();
  if (card.tabIndex < 0) card.tabIndex = 0;
  const y = scrollY;
  card.focus({ preventScroll: true });
  if (scrollY !== y) scrollTo({ top: y, left: 0, behavior: 'auto' });
}

document.addEventListener('keydown', event => {
  if (!arrows.has(event.key) || !viewer?.hidden || !gridActive() || editingControl(event)) return;

  // Grid navigation owns arrow keys completely. Never let the browser also scroll
  // the document when the cursor reaches a hard edge or while a page is rotating.
  event.preventDefault();
  event.stopImmediatePropagation();

  const state = currentLayout();
  if (!holding) {
    holding = true;
    const existing = cursorCard(state);
    if (!visibleInfo(state, existing)) {
      const start = activeCard(state) || visibleAnchor(state);
      if (!moveCursor(start, state)) {
        holding = false;
        releaseRail();
        return;
      }
      document.activeElement?.closest?.('input,select,textarea,[contenteditable="true"]')?.blur?.();
      return;
    }
  }
  navigate(event.key);
}, true);

document.addEventListener('keyup', event => { if (arrows.has(event.key)) settleHold(); }, true);
window.addEventListener('blur', () => resetNavigation());
window.addEventListener('mochimono-viewer-return', event => syncReturnedCursor(event.detail?.hash));
files?.addEventListener('pointerdown', () => resetNavigation(true), true);

if (files) {
  new MutationObserver(records => { if (structuralMutation(records)) dirty = true; }).observe(files, { childList: true, subtree: true });
  new ResizeObserver(() => { dirty = true; }).observe(files);
}
window.addEventListener('mochimono:grid-laid-out', () => { if (!holding) dirty = true; });
window.addEventListener('mochimono:media-size', () => { dirty = true; });
