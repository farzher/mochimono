const files = document.querySelector('#files');
const sizeInput = document.querySelector('#mediaSize');
const sizeButtons = [...document.querySelectorAll('[data-media-size]')];
const sizes = sizeButtons.map(button => Number(button.dataset.mediaSize));
let frame = 0;

function mediaSize() {
  return Number(sizeInput.value) || 158;
}

function syncSizeButtons() {
  const size = mediaSize();
  sizeButtons.forEach(button => button.classList.toggle('active', Number(button.dataset.mediaSize) === size));
}

function setMediaSize(size) {
  sizeInput.value = size;
  sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
  syncSizeButtons();
  schedule();
}

function cardRatio(card) {
  return Number(card.style.getPropertyValue('--ratio')) || 4 / 3;
}

function clearSize(card) {
  card.style.removeProperty('width');
  card.style.removeProperty('height');
  card.style.removeProperty('flex-basis');
}

function setRow(cards, width, target, full, gap) {
  if (!cards.length) return;
  const ratios = cards.map(cardRatio);
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);
  const fullHeight = (width - gap * (cards.length - 1)) / sum;
  const height = full ? fullHeight : target;
  cards.forEach((card, index) => {
    const itemWidth = ratios[index] * height;
    card.style.width = `${itemWidth}px`;
    card.style.height = `${height}px`;
    card.style.flexBasis = `${itemWidth}px`;
  });
}

function shouldFillLastRow(cards, width, target, gap) {
  if (cards.length < 2) return false;
  const ratioSum = cards.reduce((sum, card) => sum + cardRatio(card), 0);
  const height = (width - gap * (cards.length - 1)) / ratioSum;
  // Fill a nearly-complete final row, but never make leftovers dramatically
  // larger than the chosen preview size just to touch the right edge.
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

  // A run interrupted by a document/non-media tile is a real row boundary,
  // so fill it whenever that remains visually reasonable. The final month row
  // uses the same rule to avoid the old series of ragged right edges.
  setRow(row, width, target, shouldFillLastRow(row, width, target, gap) || closedByNonMedia, gap);
  if (row.length && closedByNonMedia) {
    const ratios = row.reduce((sum, card) => sum + cardRatio(card), 0);
    const filledHeight = (width - gap * (row.length - 1)) / ratios;
    if (filledHeight > target * 1.42) setRow(row, width, target, false, gap);
  }
}

function syncRunBreaks(container, cards) {
  container.querySelectorAll(':scope > .gallery-row-break').forEach(item => item.remove());
  for (let index = 1; index < cards.length; index++) {
    const previousMedia = cards[index - 1].classList.contains('media-card');
    const currentMedia = cards[index].classList.contains('media-card');
    if (previousMedia === currentMedia) continue;
    const marker = document.createElement('span');
    marker.className = 'gallery-row-break';
    marker.setAttribute('aria-hidden', 'true');
    cards[index].before(marker);
  }
}

function justify(container) {
  const cards = [...container.children].filter(child => child.classList.contains('file-card'));
  if (!cards.length) return;

  const width = container.clientWidth;
  if (!width) return;
  const gap = parseFloat(getComputedStyle(container).columnGap) || 4;
  const target = mediaSize();

  // Non-media cards used to disable justification for the entire month. Keep
  // chronological order, but isolate transitions so documents cannot poison
  // the image/video rows around them.
  syncRunBreaks(container, cards);
  cards.filter(card => !card.classList.contains('media-card')).forEach(clearSize);

  let run = [];
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    if (card.classList.contains('media-card')) {
      run.push(card);
      continue;
    }
    justifyRun(run, width, target, gap, true);
    run = [];
  }
  justifyRun(run, width, target, gap, false);
}

function syncDayLabels() {
  for (const grid of document.querySelectorAll('#files .date-grid')) {
    for (const card of grid.querySelectorAll(':scope > .day-start[data-day]')) {
      const button = [...grid.querySelectorAll(':scope > .day-group-control')]
        .find(item => item.dataset.periodKey === card.dataset.day);
      if (!button) continue;
      button.style.left = `${card.offsetLeft}px`;
      button.style.top = `${card.offsetTop - 19}px`;
    }
  }
}

function layout() {
  frame = 0;
  if (!files.classList.contains('grid')) return;
  document.querySelectorAll('#files .date-grid').forEach(justify);
  requestAnimationFrame(syncDayLabels);
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(layout);
}

const style = document.createElement('style');
style.textContent = `
  .files.grid .date-grid>.gallery-row-break{
    flex:0 0 100%;
    width:100%;
    height:0;
    margin:0;
    padding:0;
    pointer-events:none;
  }
`;
document.head.append(style);

sizeButtons.forEach(button => button.addEventListener('click', () => setMediaSize(Number(button.dataset.mediaSize))));
sizeInput.addEventListener('input', schedule);
files.addEventListener('load', event => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('cached-thumb')) return;
  const card = image.closest('.media-card');
  if (!card || !image.naturalWidth || !image.naturalHeight) return;
  card.style.setProperty('--ratio', Math.max(.65, Math.min(2.1, image.naturalWidth / image.naturalHeight)));
  schedule();
}, true);
new MutationObserver(schedule).observe(files, { childList: true, subtree: true });
new ResizeObserver(schedule).observe(files);

const saved = Number(localStorage.getItem('mochimono-media-size')) || 158;
const nearest = sizes.reduce((best, size) => Math.abs(size - saved) < Math.abs(best - saved) ? size : best, sizes[0]);
setMediaSize(nearest);
