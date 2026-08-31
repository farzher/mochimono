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

function setRow(cards, width, target, full, gap) {
  if (!cards.length) return;
  const ratios = cards.map(cardRatio);
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);
  const height = full ? (width - gap * (cards.length - 1)) / sum : target;
  cards.forEach((card, index) => {
    const itemWidth = ratios[index] * height;
    card.style.width = `${itemWidth}px`;
    card.style.height = `${height}px`;
    card.style.flexBasis = `${itemWidth}px`;
  });
}

function syncDayBreaks(container, cards) {
  const existing = [...container.querySelectorAll(':scope > .day-break')];
  if (container.classList.contains('flat-grid')) {
    existing.forEach(node => node.remove());
    return;
  }

  let used = 0;
  let previousDay = '';
  for (const card of cards) {
    const day = card.dataset.day || '';
    if (previousDay && day && day !== previousDay) {
      let breaker = existing[used++];
      if (!breaker) {
        breaker = document.createElement('span');
        breaker.className = 'day-break';
        breaker.setAttribute('aria-hidden', 'true');
      }
      if (breaker.nextElementSibling !== card) container.insertBefore(breaker, card);
    }
    if (day) previousDay = day;
  }
  existing.slice(used).forEach(node => node.remove());
}

function justify(container) {
  const cards = [...container.children].filter(child => child.classList.contains('file-card'));
  if (!cards.length) return;
  syncDayBreaks(container, cards);

  if (!cards.every(card => card.classList.contains('media-card'))) {
    cards.forEach(card => {
      card.style.removeProperty('width');
      card.style.removeProperty('height');
      card.style.removeProperty('flex-basis');
    });
    return;
  }

  const width = container.clientWidth;
  if (!width) return;
  const gap = parseFloat(getComputedStyle(container).columnGap) || 4;
  const target = mediaSize();
  const splitDays = !container.classList.contains('flat-grid');
  let row = [];
  let ratioSum = 0;
  let previousDay = '';

  for (const card of cards) {
    const day = card.dataset.day || '';
    if (splitDays && row.length && previousDay && day && day !== previousDay) {
      setRow(row, width, target, false, gap);
      row = [];
      ratioSum = 0;
    }

    const ratio = cardRatio(card);
    const nextWidth = (ratioSum + ratio) * target + gap * row.length;

    if (row.length && nextWidth >= width) {
      const currentWidth = ratioSum * target + gap * (row.length - 1);
      if (Math.abs(width - currentWidth) < Math.abs(nextWidth - width)) {
        setRow(row, width, target, true, gap);
        row = [card];
        ratioSum = ratio;
        previousDay = day;
        continue;
      }

      row.push(card);
      ratioSum += ratio;
      setRow(row, width, target, true, gap);
      row = [];
      ratioSum = 0;
      previousDay = day;
      continue;
    }

    row.push(card);
    ratioSum += ratio;
    previousDay = day;
  }

  setRow(row, width, target, false, gap);
}

function layout() {
  frame = 0;
  if (!files.classList.contains('grid')) return;
  document.querySelectorAll('#files .date-grid').forEach(justify);
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(layout);
}

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
