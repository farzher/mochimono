const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const sizeInput = document.querySelector('#mediaSize');
const sizeButtons = [...document.querySelectorAll('[data-media-size]')];
const sizes = sizeButtons.map(button => Number(button.dataset.mediaSize));
const pendingGrids = new Set();
const deferredLabelGrids = new Set();
const ROW_CLASS = 'justified-media-row';
const GRID_CLASS = 'justified-row-grid';
const GUARD_SCREENS = 2.25;
const MIN_GUARD_PX = 900;
let frame = 0;
let fullLayout = false;
let lastFilesWidth = 0;
let guardFrame = 0;
let guardDirection = 1;
let lastScrollY = window.scrollY;

const style = document.createElement('style');
style.textContent = `
.files.grid .date-grid.${GRID_CLASS}{display:block!important;position:relative}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}{display:flex;align-items:flex-start;gap:var(--mochimono-row-gap,4px);width:100%;margin:0 0 var(--mochimono-row-gap,4px);padding:0}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}.last-layout-row{margin-bottom:0}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}>.file-card{flex:none}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}>.day-start{position:relative;overflow:visible}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}>.day-start>.thumb{overflow:hidden;border-radius:3px}
`;
document.head.append(style);

const mediaSize = () => Number(sizeInput.value) || 170;
const px = value => `${Math.round(value * 100) / 100}px`;

function syncSizeButtons() {
  const size = mediaSize();
  sizeButtons.forEach(button => button.classList.toggle('active', Number(button.dataset.mediaSize) === size));
}

function setMediaSize(size) {
  sizeInput.value = size;
  sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function cardRatio(card) {
  const width = Number(card.dataset.width) || 0;
  const height = Number(card.dataset.height) || 0;
  return width && height ? Math.max(.65, Math.min(2.1, width / height)) : 1;
}

function setPx(card, property, value) {
  const next = px(value);
  if (card.style.getPropertyValue(property) !== next) card.style.setProperty(property, next);
}

function setRow(cards, width, target, fill, gap) {
  if (!cards.length) return;
  const ratios = cards.map(cardRatio);
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);
  const filledHeight = (width - gap * (cards.length - 1)) / sum;
  const height = fill ? filledHeight : target;
  cards.forEach((card, index) => {
    const itemWidth = ratios[index] * height;
    setPx(card, 'width', itemWidth);
    setPx(card, 'height', height);
    setPx(card, 'flex-basis', itemWidth);
  });
}

function shouldFillLastRow(cards, width, target, gap) {
  if (cards.length < 2) return false;
  const ratioSum = cards.reduce((sum, card) => sum + cardRatio(card), 0);
  return (width - gap * (cards.length - 1)) / ratioSum <= target * 1.42;
}

function rowPlans(cards, width, target, gap) {
  const plans = [];
  let row = [];
  let ratioSum = 0;

  const finish = fill => {
    if (!row.length) return;
    plans.push({ cards: row, fill });
    row = [];
    ratioSum = 0;
  };

  for (const card of cards) {
    const ratio = cardRatio(card);
    const nextWidth = (ratioSum + ratio) * target + gap * row.length;
    if (row.length && nextWidth >= width) {
      const currentWidth = ratioSum * target + gap * (row.length - 1);
      if (Math.abs(width - currentWidth) < Math.abs(nextWidth - width)) {
        finish(true);
        row = [card];
        ratioSum = ratio;
        continue;
      }
      row.push(card);
      ratioSum += ratio;
      finish(true);
      continue;
    }
    row.push(card);
    ratioSum += ratio;
  }

  if (row.length) finish(shouldFillLastRow(row, width, target, gap));
  return plans;
}

function rowFragment(plans, width, target, gap) {
  const fragment = document.createDocumentFragment();
  for (const plan of plans) {
    setRow(plan.cards, width, target, plan.fill, gap);
    const row = document.createElement('div');
    row.className = ROW_CLASS;
    row.append(...plan.cards);
    fragment.append(row);
  }
  return fragment;
}

function syncLastRow(grid) {
  const rows = [...grid.querySelectorAll(`:scope > .${ROW_CLASS}`)];
  for (const row of rows) row.classList.remove('last-layout-row');
  rows.at(-1)?.classList.add('last-layout-row');
}

function rebuildGrid(grid, cards, width, target, gap) {
  const plans = rowPlans(cards, width, target, gap);
  grid.replaceChildren(rowFragment(plans, width, target, gap));
  grid.classList.add(GRID_CLASS);
  grid.style.setProperty('--mochimono-row-gap', `${gap}px`);
  syncLastRow(grid);
}

function directCards(grid) {
  return [...grid.children].filter(child => child.classList?.contains('file-card'));
}

function rowsIn(grid) {
  return [...grid.children].filter(child => child.classList?.contains(ROW_CLASS));
}

function cleanupRows(grid) {
  for (const row of rowsIn(grid)) if (!row.querySelector(':scope > .file-card')) row.remove();
}

function repackEdge(grid, direction, loose, width, target, gap) {
  if (!loose.length) return;
  const rows = rowsIn(grid);
  const edge = direction < 0 ? rows[0] : rows.at(-1);
  if (!edge) return rebuildGrid(grid, [...grid.querySelectorAll('.file-card')], width, target, gap);

  const edgeCards = [...edge.querySelectorAll(':scope > .file-card')];
  const cards = direction < 0 ? [...loose, ...edgeCards] : [...edgeCards, ...loose];
  const marker = edge.nextSibling;
  const fragment = rowFragment(rowPlans(cards, width, target, gap), width, target, gap);
  edge.remove();

  if (direction < 0) {
    const firstRow = rowsIn(grid)[0];
    grid.insertBefore(fragment, firstRow || grid.firstChild);
  } else {
    const safeMarker = marker?.isConnected && marker.parentElement === grid ? marker : grid.querySelector(':scope > .day-group-control');
    grid.insertBefore(fragment, safeMarker || null);
  }
}

function incrementalGrid(grid, width, target, gap) {
  cleanupRows(grid);
  let rows = rowsIn(grid);
  const loose = directCards(grid);
  if (!rows.length) return rebuildGrid(grid, [...grid.querySelectorAll('.file-card')], width, target, gap);
  if (!loose.length) return syncLastRow(grid);

  const children = [...grid.children];
  const firstRowIndex = children.indexOf(rows[0]);
  const lastRowIndex = children.indexOf(rows.at(-1));
  const leading = [];
  const trailing = [];
  const middle = [];
  for (const card of loose) {
    const index = children.indexOf(card);
    if (index < firstRowIndex) leading.push(card);
    else if (index > lastRowIndex) trailing.push(card);
    else middle.push(card);
  }

  if (middle.length) return rebuildGrid(grid, [...grid.querySelectorAll('.file-card')], width, target, gap);
  if (leading.length) repackEdge(grid, -1, leading, width, target, gap);
  if (trailing.length) repackEdge(grid, 1, trailing, width, target, gap);
  grid.classList.add(GRID_CLASS);
  grid.style.setProperty('--mochimono-row-gap', `${gap}px`);
  syncLastRow(grid);
}

function dayButton(key, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'timeline-group-select day-group-control';
  button.dataset.selectPeriod = 'day';
  button.dataset.periodKey = key;
  button.dataset.periodLabel = label;
  button.setAttribute('aria-label', `Select ${label}`);
  button.innerHTML = `<span class="timeline-check" aria-hidden="true"></span><span>${label}</span>`;
  return button;
}

function syncDayLabels(grid, cards) {
  if (!cards.length) return;
  for (const card of cards) card.classList.remove('day-start');

  const starts = [];
  let previousDay = '';
  for (const card of cards) {
    const day = card.dataset.day || '';
    if (day && day !== previousDay) {
      card.classList.add('day-start');
      starts.push(card);
    }
    previousDay = day;
  }

  const existing = new Map([...grid.querySelectorAll(':scope > .day-group-control')].map(button => [button.dataset.periodKey, button]));
  const used = new Set();
  const gridRect = grid.getBoundingClientRect();
  for (const card of starts) {
    const key = card.dataset.day;
    const label = card.dataset.dayLabel || key;
    let button = existing.get(key);
    if (!button) {
      button = dayButton(key, label);
      grid.append(button);
    }
    used.add(key);
    const rect = card.getBoundingClientRect();
    const left = px(rect.left - gridRect.left);
    const top = px(rect.top - gridRect.top - 19);
    if (button.style.left !== left) button.style.left = left;
    if (button.style.top !== top) button.style.top = top;
  }
  for (const [key, button] of existing) if (!used.has(key)) button.remove();
}

function layoutGrid(grid, rebuild = false) {
  if (!grid?.isConnected || !files.classList.contains('grid')) return;
  const cards = [...grid.querySelectorAll('.file-card')];
  if (!cards.length) return;
  const width = grid.clientWidth;
  if (!width) return;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 4;
  const target = mediaSize();

  if (rebuild || !grid.classList.contains(GRID_CLASS) || !rowsIn(grid).length) rebuildGrid(grid, cards, width, target, gap);
  else incrementalGrid(grid, width, target, gap);

  const ordered = [...grid.querySelectorAll('.file-card')];
  if (window.mochimonoGridInteraction?.active?.()) {
    deferredLabelGrids.add(grid);
    return;
  }
  syncDayLabels(grid, ordered);
}

function layout() {
  frame = 0;
  if (!files.classList.contains('grid')) {
    pendingGrids.clear();
    fullLayout = false;
    return;
  }
  const rebuild = fullLayout;
  const grids = rebuild ? [...files.querySelectorAll('.date-grid')] : [...pendingGrids];
  fullLayout = false;
  pendingGrids.clear();
  for (const grid of grids) layoutGrid(grid, rebuild);
  window.dispatchEvent(new CustomEvent('mochimono:grid-laid-out'));
}

function schedule(grid) {
  if (grid?.isConnected) pendingGrids.add(grid);
  if (!frame) frame = requestAnimationFrame(layout);
}

function scheduleAll() {
  fullLayout = true;
  if (!frame) frame = requestAnimationFrame(layout);
}

function flushDeferredLabels() {
  for (const grid of deferredLabelGrids) if (grid.isConnected) {
    const cards = [...grid.querySelectorAll('.file-card')];
    syncDayLabels(grid, cards);
  }
  deferredLabelGrids.clear();
}

function changedGrids(records) {
  const result = new Set();
  for (const record of records) {
    const targetGrid = record.target instanceof Element ? record.target.closest?.('.date-grid') : null;
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (!(node instanceof Element)) continue;
      if (node.matches(`.file-card,.date-grid,.${ROW_CLASS}`) || node.querySelector?.('.file-card')) {
        if (node.matches('.date-grid')) result.add(node);
        else if (targetGrid) result.add(targetGrid);
        node.querySelectorAll?.('.date-grid').forEach(grid => result.add(grid));
      }
    }
  }
  return result;
}

function layoutNow() {
  for (const grid of changedGrids(gridObserver.takeRecords())) if (grid.isConnected) pendingGrids.add(grid);
  if (!pendingGrids.size && !fullLayout) return false;
  if (frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  layout();
  return true;
}

function guardMargin() {
  const top = Math.max(0, document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0);
  return Math.max(MIN_GUARD_PX, Math.max(300, innerHeight - top) * GUARD_SCREENS);
}

function needsGuard(direction) {
  const library = window.mochimonoLibrary;
  const state = library?.state?.();
  if (!state || state.view !== 'grid' || !files.classList.contains('grid') || (viewer && !viewer.hidden)) return false;
  const margin = guardMargin();
  if (direction < 0) {
    if (!state.hasPrevious) return false;
    const sentinel = document.querySelector('#top-scroll-sentinel');
    return Boolean(sentinel && !sentinel.hidden && sentinel.getBoundingClientRect().bottom >= -margin);
  }
  if (!state.hasMore) return false;
  const sentinel = document.querySelector('#scroll-sentinel');
  return Boolean(sentinel && !sentinel.hidden && sentinel.getBoundingClientRect().top <= innerHeight + margin);
}

function fillGuard() {
  guardFrame = 0;
  if (!needsGuard(guardDirection)) return;
  if (!window.mochimonoLibrary?.extend?.(guardDirection)) return;
  layoutNow();
  guardFrame = requestAnimationFrame(fillGuard);
}

function scheduleGuard(direction = guardDirection) {
  guardDirection = direction < 0 ? -1 : 1;
  if (!guardFrame) guardFrame = requestAnimationFrame(fillGuard);
}

sizeButtons.forEach(button => button.addEventListener('click', () => setMediaSize(Number(button.dataset.mediaSize))));
window.addEventListener('mochimono:media-size', () => {
  syncSizeButtons();
  scheduleAll();
  scheduleGuard(guardDirection);
});
window.addEventListener('mochimono:grid-interaction-end', flushDeferredLabels);

const gridObserver = new MutationObserver(records => {
  for (const grid of changedGrids(records)) schedule(grid);
});
gridObserver.observe(files, { childList: true, subtree: true });

window.mochimonoGallery = { layoutNow };

new ResizeObserver(entries => {
  const width = Math.round(entries[0]?.contentRect?.width || 0);
  if (!width || width === lastFilesWidth) return;
  lastFilesWidth = width;
  scheduleAll();
  scheduleGuard(guardDirection);
}).observe(files);

window.addEventListener('wheel', event => {
  if (!event.deltaY || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  scheduleGuard(event.deltaY < 0 ? -1 : 1);
}, { passive: true, capture: true });

window.addEventListener('scroll', () => {
  const next = window.scrollY;
  if (Math.abs(next - lastScrollY) > 1) guardDirection = next < lastScrollY ? -1 : 1;
  lastScrollY = next;
  scheduleGuard(guardDirection);
}, { passive: true });

document.addEventListener('keydown', event => {
  if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') scheduleGuard(-1);
  else if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End') scheduleGuard(1);
}, true);

window.addEventListener('mochimono:catalog-cache-restored', () => scheduleGuard(1));
window.addEventListener('mochimono:catalog-updated', () => scheduleGuard(guardDirection));
window.addEventListener('mochimono:grid-laid-out', () => scheduleGuard(guardDirection));

const saved = Number(localStorage.getItem('mochimono-media-size')) || 170;
const nearest = sizes.reduce((best, size) => Math.abs(size - saved) < Math.abs(best - saved) ? size : best, sizes[0]);
sizeInput.value = nearest;
syncSizeButtons();
scheduleAll();
requestAnimationFrame(() => scheduleGuard(1));