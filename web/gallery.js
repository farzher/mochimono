const files = document.querySelector('#files');
const sizeInput = document.querySelector('#mediaSize');
const sizeButtons = [...document.querySelectorAll('[data-media-size]')];
const sizes = sizeButtons.map(button => Number(button.dataset.mediaSize));
const pendingGrids = new Set();
const deferredGeometryGrids = new Set();
let frame = 0;
let fullLayout = false;
let lastFilesWidth = 0;

function mediaSize() {
  return Number(sizeInput.value) || 170;
}

function syncSizeButtons() {
  const size = mediaSize();
  sizeButtons.forEach(button => button.classList.toggle('active', Number(button.dataset.mediaSize) === size));
}

function setMediaSize(size) {
  sizeInput.value = size;
  sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
  syncSizeButtons();
  scheduleAll();
}

function cardRatio(card) {
  return Number(card.style.getPropertyValue('--ratio')) || 4 / 3;
}

function px(value) {
  return `${Math.round(value * 100) / 100}px`;
}

function setPx(card, property, value) {
  const next = px(value);
  if (card.style.getPropertyValue(property) !== next) card.style.setProperty(property, next);
}

function clearSize(card) {
  for (const property of ['width','height','flex-basis']) {
    if (card.style.getPropertyValue(property)) card.style.removeProperty(property);
  }
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
  const height = (width - gap * (cards.length - 1)) / ratioSum;
  return height <= target * 1.42;
}

function justifyRun(cards, width, target, gap, closedByNonMedia = false) {
  if (!cards.length) return;
  let row = [];
  let ratioSum = 0;

  for (const card of cards) {
    const ratio = cardRatio(card);
    const nextWidth = (ratioSum + ratio) * target + gap * row.length;
    if (row.length && nextWidth >= width) {
      const currentWidth = ratioSum * target + gap * (row.length - 1);
      if (Math.abs(width - currentWidth) < Math.abs(nextWidth - width)) {
        setRow(row, width, target, true, gap);
        row = [card];
        ratioSum = ratio;
        continue;
      }
      row.push(card);
      ratioSum += ratio;
      setRow(row, width, target, true, gap);
      row = [];
      ratioSum = 0;
      continue;
    }
    row.push(card);
    ratioSum += ratio;
  }

  const fill = shouldFillLastRow(row, width, target, gap) || closedByNonMedia;
  if (!row.length) return;
  if (fill) {
    const ratios = row.reduce((sum, card) => sum + cardRatio(card), 0);
    const height = (width - gap * (row.length - 1)) / ratios;
    setRow(row, width, target, height <= target * 1.42, gap);
  } else setRow(row, width, target, false, gap);
}

function syncRunBreaks(container, cards) {
  const wanted = new Set();
  for (let index = 1; index < cards.length; index++) {
    if (cards[index - 1].classList.contains('media-card') !== cards[index].classList.contains('media-card')) wanted.add(cards[index]);
  }

  for (const marker of container.querySelectorAll(':scope > .gallery-row-break')) {
    if (!wanted.has(marker.nextElementSibling)) marker.remove();
  }
  for (const card of wanted) {
    if (card.previousElementSibling?.classList.contains('gallery-row-break')) continue;
    const marker = document.createElement('span');
    marker.className = 'gallery-row-break';
    marker.setAttribute('aria-hidden', 'true');
    card.before(marker);
  }
}

function justify(container) {
  const cards = [...container.children].filter(child => child.classList.contains('file-card'));
  if (!cards.length) return cards;
  const width = container.clientWidth;
  if (!width) return cards;
  const gap = parseFloat(getComputedStyle(container).columnGap) || 4;
  const target = mediaSize();

  syncRunBreaks(container, cards);
  cards.filter(card => !card.classList.contains('media-card')).forEach(clearSize);

  let run = [];
  for (const card of cards) {
    if (card.classList.contains('media-card')) {
      run.push(card);
      continue;
    }
    justifyRun(run, width, target, gap, true);
    run = [];
  }
  justifyRun(run, width, target, gap, false);
  return cards;
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
  for (const card of cards) card.classList.remove('day-start', 'day-row-start');

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

  const rowTop = new Map(cards.map(card => [card, Math.round(card.offsetTop)]));
  const startRows = new Set(starts.map(card => rowTop.get(card)));
  for (const card of cards) {
    const row = rowTop.get(card) ?? 0;
    if (startRows.has(row) || startRows.has(row - 1) || startRows.has(row + 1)) card.classList.add('day-row-start');
  }

  const existing = new Map([...grid.querySelectorAll(':scope > .day-group-control')].map(button => [button.dataset.periodKey, button]));
  const used = new Set();
  for (const card of starts) {
    const key = card.dataset.day;
    const label = card.dataset.dayLabel || key;
    let button = existing.get(key);
    if (!button) {
      button = dayButton(key, label);
      grid.append(button);
    }
    used.add(key);
    const left = px(card.offsetLeft);
    const top = px(card.offsetTop - 19);
    if (button.style.left !== left) button.style.left = left;
    if (button.style.top !== top) button.style.top = top;
  }
  for (const [key, button] of existing) if (!used.has(key)) button.remove();
}

function layoutGrid(grid) {
  if (!grid?.isConnected || !files.classList.contains('grid')) return;
  const cards = justify(grid);
  if (window.mochimonoGridInteraction?.active?.()) {
    deferredGeometryGrids.add(grid);
    return;
  }
  syncDayLabels(grid, cards);
}

function layout() {
  frame = 0;
  if (!files.classList.contains('grid')) {
    pendingGrids.clear();
    fullLayout = false;
    return;
  }
  const grids = fullLayout ? [...files.querySelectorAll('.date-grid')] : [...pendingGrids];
  fullLayout = false;
  pendingGrids.clear();
  for (const grid of grids) layoutGrid(grid);
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

function scheduleGeometry(grid) {
  if (!grid?.isConnected) return;
  if (window.mochimonoGridInteraction?.active?.()) deferredGeometryGrids.add(grid);
  else schedule(grid);
}

function flushDeferredGeometry() {
  for (const grid of deferredGeometryGrids) if (grid.isConnected) schedule(grid);
  deferredGeometryGrids.clear();
}

function changedGrids(records) {
  const result = new Set();
  for (const record of records) {
    if (record.target instanceof Element && record.target.matches('.date-grid')) result.add(record.target);
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (!(node instanceof Element)) continue;
      if (node.matches('.file-card')) {
        const grid = record.target instanceof Element && record.target.matches('.date-grid') ? record.target : null;
        if (grid) result.add(grid);
      }
      if (node.matches('.date-grid')) result.add(node);
      node.querySelectorAll?.('.date-grid').forEach(grid => result.add(grid));
    }
  }
  return result;
}

const style = document.createElement('style');
style.textContent = `
  .files.grid .date-grid>.gallery-row-break{
    flex:0 0 100%;width:100%;height:0;margin:0;padding:0;pointer-events:none
  }
`;
document.head.append(style);

sizeButtons.forEach(button => button.addEventListener('click', () => setMediaSize(Number(button.dataset.mediaSize))));
sizeInput.addEventListener('input', () => { syncSizeButtons(); scheduleAll(); });
window.addEventListener('mochimono:media-size', scheduleAll);
window.addEventListener('mochimono:geometry', event => {
  const hash = event.detail?.hash;
  if (!hash) return;
  for (const card of files.querySelectorAll(`.media-card[data-hash="${CSS.escape(hash)}"]`)) scheduleGeometry(card.closest('.date-grid'));
});
window.addEventListener('mochimono:grid-interaction-end', flushDeferredGeometry);

new MutationObserver(records => {
  const grids = changedGrids(records);
  for (const grid of grids) schedule(grid);
}).observe(files, { childList: true, subtree: true });
new ResizeObserver(entries => {
  const width = Math.round(entries[0]?.contentRect?.width || 0);
  if (!width || width === lastFilesWidth) return;
  lastFilesWidth = width;
  scheduleAll();
}).observe(files);

const saved = Number(localStorage.getItem('mochimono-media-size')) || 170;
const nearest = sizes.reduce((best, size) => Math.abs(size - saved) < Math.abs(best - saved) ? size : best, sizes[0]);
sizeInput.value = nearest;
syncSizeButtons();
scheduleAll();
