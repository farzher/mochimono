import './stable-grid.js';

const files = document.querySelector('#files');
const sizeInput = document.querySelector('#mediaSize');
const sizeButtons = [...document.querySelectorAll('[data-media-size]')];
const sizes = sizeButtons.map(button => Number(button.dataset.mediaSize));
const pendingGrids = new Set();
const deferredLabelGrids = new Set();
const ROW_CLASS = 'justified-media-row';
const GRID_CLASS = 'justified-row-grid';
let frame = 0;
let fullLayout = false;
let lastFilesWidth = 0;

const style = document.createElement('style');
style.textContent = `
.files.grid .date-grid.${GRID_CLASS}{display:block!important;position:relative}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}{display:flex;align-items:flex-start;gap:var(--mochimono-row-gap,4px);width:100%;margin:0 0 var(--mochimono-row-gap,4px);padding:0;overflow:hidden}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}.last-layout-row{margin-bottom:0}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}>.file-card{flex:none;min-width:0;max-width:none}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}>.day-start{position:relative;overflow:visible}
.files.grid .date-grid.${GRID_CLASS}>.${ROW_CLASS}>.day-start>.thumb{overflow:hidden;border-radius:3px}
`;
document.head.append(style);

const stableOwns = () => Boolean(window.mochimonoStableGrid?.owns?.());
const mediaSize = () => Number(sizeInput?.value) || 170;
const px = value => `${Math.round(value * 100) / 100}px`;

function syncSizeButtons() {
  const size = mediaSize();
  sizeButtons.forEach(button => button.classList.toggle('active', Number(button.dataset.mediaSize) === size));
}

function setMediaSize(size) {
  if (!sizeInput) return;
  sizeInput.value = String(size);
  sizeInput.dispatchEvent(new Event('input', { bubbles:true }));
}

function cardRatio(card) {
  const width = Number(card.dataset.width) || 0;
  const height = Number(card.dataset.height) || 0;
  return width && height ? Math.max(.65, Math.min(2.1, width / height)) : 4 / 3;
}

function idealHeight(cards, width, gap) {
  const sum = cards.reduce((total, card) => total + cardRatio(card), 0);
  return (width - gap * Math.max(0, cards.length - 1)) / Math.max(.001, sum);
}

function rowPlans(cards, width, target, gap) {
  const MAX_ROW_HEIGHT = target * 1.28;
  const LAST_ROW_FILL_MAX = target * 1.16;
  const plans = [];
  let start = 0;

  while (start < cards.length) {
    let sum = 0;
    let previousHeight = Infinity;
    let end = cards.length;
    for (let index = start; index < cards.length; index++) {
      sum += cardRatio(cards[index]);
      const count = index - start + 1;
      const height = (width - gap * Math.max(0, count - 1)) / Math.max(.001, sum);
      if (count >= 2 && height <= target) {
        if (count > 2 && previousHeight <= MAX_ROW_HEIGHT && Math.abs(previousHeight - target) < Math.abs(height - target)) end = index;
        else end = index + 1;
        break;
      }
      previousHeight = height;
    }

    if (end >= cards.length) {
      const row = cards.slice(start);
      const ideal = idealHeight(row, width, gap);
      plans.push({ cards:row, fill:row.length >= 2 && ideal >= target && ideal <= LAST_ROW_FILL_MAX });
      break;
    }

    plans.push({ cards:cards.slice(start, end), fill:true });
    start = end;
  }
  return plans;
}

function applyRow(cards, width, target, gap, fill) {
  if (!cards.length) return;
  const ideal = idealHeight(cards, width, gap);
  const naturalTargetWidth = cards.reduce((sum, card) => sum + cardRatio(card) * target, 0) + gap * Math.max(0, cards.length - 1);
  const height = fill ? ideal : naturalTargetWidth > width ? Math.min(target, ideal) : target;
  const safeHeight = Math.max(1, Math.min(target * 1.28, height));
  let x = 0;

  cards.forEach((card, index) => {
    const last = index === cards.length - 1;
    const naturalWidth = cardRatio(card) * safeHeight;
    const remaining = Math.max(1, width - x);
    const itemWidth = fill && last ? remaining : Math.min(naturalWidth, remaining);
    card.style.width = px(itemWidth);
    card.style.height = px(safeHeight);
    card.style.flexBasis = px(itemWidth);
    x += itemWidth + gap;
  });
}

function rebuildGrid(grid) {
  if (!grid?.isConnected || stableOwns() || !files.classList.contains('grid')) return;
  const cards = [...grid.querySelectorAll('.file-card')];
  if (!cards.length) return;
  const width = grid.clientWidth;
  if (!width) return;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 4;
  const target = mediaSize();
  const plans = rowPlans(cards, width, target, gap);
  const fragment = document.createDocumentFragment();

  plans.forEach((plan, index) => {
    applyRow(plan.cards, width, target, gap, plan.fill);
    const row = document.createElement('div');
    row.className = `${ROW_CLASS}${index === plans.length - 1 ? ' last-layout-row' : ''}`;
    row.append(...plan.cards);
    fragment.append(row);
  });

  grid.replaceChildren(fragment);
  grid.classList.add(GRID_CLASS);
  grid.style.setProperty('--mochimono-row-gap', `${gap}px`);
  if (window.mochimonoGridInteraction?.active?.()) deferredLabelGrids.add(grid);
  else syncDayLabels(grid);
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

function syncDayLabels(grid) {
  if (!grid?.isConnected || stableOwns()) return;
  const cards = [...grid.querySelectorAll('.file-card')];
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
    button.style.left = px(rect.left - gridRect.left);
    button.style.top = px(rect.top - gridRect.top - 19);
  }
  for (const [key, button] of existing) if (!used.has(key)) button.remove();
}

function changedGrids(records) {
  const result = new Set();
  for (const record of records) {
    const targetGrid = record.target instanceof Element ? record.target.closest?.('.date-grid') : null;
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (!(node instanceof Element)) continue;
      if (node.matches('.date-grid')) result.add(node);
      else if (targetGrid && (node.matches('.file-card,.justified-media-row') || node.querySelector?.('.file-card'))) result.add(targetGrid);
      node.querySelectorAll?.('.date-grid').forEach(grid => result.add(grid));
    }
  }
  return result;
}

function layout() {
  frame = 0;
  if (stableOwns() || !files.classList.contains('grid')) {
    pendingGrids.clear();
    fullLayout = false;
    return;
  }
  const grids = fullLayout ? [...files.querySelectorAll('.date-grid')] : [...pendingGrids];
  fullLayout = false;
  pendingGrids.clear();
  for (const grid of grids) rebuildGrid(grid);
  window.dispatchEvent(new CustomEvent('mochimono:grid-laid-out'));
}

function schedule(grid) {
  if (stableOwns()) return;
  if (grid?.isConnected) pendingGrids.add(grid);
  if (!frame) frame = requestAnimationFrame(layout);
}

function scheduleAll() {
  if (stableOwns()) return;
  fullLayout = true;
  if (!frame) frame = requestAnimationFrame(layout);
}

function layoutNow() {
  if (stableOwns()) return false;
  for (const grid of changedGrids(gridObserver.takeRecords())) if (grid.isConnected) pendingGrids.add(grid);
  if (!pendingGrids.size && !fullLayout) return false;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  layout();
  return true;
}

function flushDeferredLabels() {
  if (stableOwns()) {
    deferredLabelGrids.clear();
    return;
  }
  for (const grid of deferredLabelGrids) syncDayLabels(grid);
  deferredLabelGrids.clear();
}

sizeButtons.forEach(button => button.addEventListener('click', () => setMediaSize(Number(button.dataset.mediaSize))));
window.addEventListener('mochimono:media-size', () => {
  syncSizeButtons();
  scheduleAll();
});
window.addEventListener('mochimono:grid-interaction-end', flushDeferredLabels);

const gridObserver = new MutationObserver(records => {
  if (stableOwns()) return;
  for (const grid of changedGrids(records)) schedule(grid);
});
gridObserver.observe(files, { childList:true, subtree:true });

window.mochimonoGallery = { layoutNow };

new ResizeObserver(entries => {
  const width = Math.round(entries[0]?.contentRect?.width || 0);
  if (!width || width === lastFilesWidth) return;
  lastFilesWidth = width;
  scheduleAll();
}).observe(files);

const saved = Number(localStorage.getItem('mochimono-media-size')) || 170;
const nearest = sizes.length ? sizes.reduce((best, size) => Math.abs(size - saved) < Math.abs(best - saved) ? size : best, sizes[0]) : saved;
if (sizeInput) sizeInput.value = String(nearest);
syncSizeButtons();
scheduleAll();
