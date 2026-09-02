const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const views = document.querySelector('#views');

let layout = null;
let dirty = true;
let paging = false;
let queuedKey = '';

const arrowKeys = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
const typingTarget = target => Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
const gridActive = () => views?.querySelector('[data-view="grid"]')?.classList.contains('active');

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
  return files.querySelector('.context-keyboard-focus[data-hash]') || null;
}

function focusCard(card) {
  if (!card) return false;
  if (card.tabIndex < 0) card.tabIndex = 0;
  card.focus({ preventScroll: true });
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

// Register before context-ui.js. This owns repeated grid arrow navigation and
// stops the older O(n) geometry scan from running for the same key event.
document.addEventListener('keydown', event => {
  if (!arrowKeys.has(event.key) || !viewer?.hidden || !gridActive() || typingTarget(event.target)) return;
  if (!document.activeElement?.closest?.('#files [data-hash]')) return;
  if (!navigate(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

if (files) {
  new MutationObserver(records => {
    if (structuralMutation(records)) dirty = true;
  }).observe(files, { childList: true, subtree: true });
  new ResizeObserver(() => { dirty = true; }).observe(files);
}
window.addEventListener('mochimono:grid-laid-out', () => { dirty = true; });
window.addEventListener('mochimono:media-size', () => { dirty = true; });
