const files = document.querySelector('#files');
const originalReady = window.mochimonoInstantGridReady || Promise.resolve(false);
const geometry = new Map();
const pendingRows = new Set();
const STARTUP_VISIBLE_MS = 1800;
let startupVisibleUntil = 0;
let rowFrame = 0;
let userInteracted = false;

function apply(card, width, height) {
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!card || !width || !height) return false;
  card.dataset.width = String(width);
  card.dataset.height = String(height);
  card.style.setProperty('--ratio', String(width / height));
  return true;
}

function applyKnown(node) {
  if (!(node instanceof Element)) return;
  const cards = [];
  if (node.matches('[data-hash]')) cards.push(node);
  cards.push(...node.querySelectorAll('[data-hash]'));
  if (cards.length && !startupVisibleUntil) startupVisibleUntil = performance.now() + STARTUP_VISIBLE_MS;
  for (const card of cards) {
    if (Number(card.dataset.width) > 0 && Number(card.dataset.height) > 0) continue;
    const known = geometry.get(String(card.dataset.hash || ''));
    if (known) apply(card, known.width, known.height);
  }
}

function visibleAnchor() {
  if (!files?.isConnected || window.scrollY <= 1) return null;
  const top = Math.max(0, document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0);
  const bounds = files.getBoundingClientRect();
  const xs = [bounds.left + 8, (bounds.left + bounds.right) / 2, bounds.right - 8]
    .map(x => Math.max(1, Math.min(innerWidth - 2, x)));
  for (const y of [top + 2, top + 40, top + 80]) {
    for (const x of xs) {
      const card = document.elementFromPoint(x, y)?.closest?.('#files [data-hash]');
      if (card) return { hash: card.dataset.hash, top: card.getBoundingClientRect().top };
    }
  }
  return null;
}

function restoreAnchor(anchor) {
  if (!anchor?.hash) return;
  const card = files.querySelector(`[data-hash="${CSS.escape(anchor.hash)}"]`);
  if (!card) return;
  const delta = card.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) > .5) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
}

function rowIsVisible(row) {
  const rect = row.getBoundingClientRect();
  const top = Math.max(0, document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0);
  return rect.bottom > top && rect.top < innerHeight;
}

function syncDayLabels(grid) {
  if (!grid) return;
  const gridRect = grid.getBoundingClientRect();
  const firstByDay = new Map();
  for (const card of grid.querySelectorAll('.file-card[data-day]')) {
    const key = String(card.dataset.day || '');
    if (key && !firstByDay.has(key)) firstByDay.set(key, card);
  }
  for (const button of grid.querySelectorAll(':scope > .day-group-control[data-period-key]')) {
    const card = firstByDay.get(String(button.dataset.periodKey || ''));
    if (!card) continue;
    const rect = card.getBoundingClientRect();
    button.style.left = `${Math.round((rect.left - gridRect.left) * 100) / 100}px`;
    button.style.top = `${Math.round((rect.top - gridRect.top - 19) * 100) / 100}px`;
  }
}

function reflowRow(row) {
  const grid = row.closest('.date-grid');
  const cards = [...row.querySelectorAll(':scope > .file-card')];
  if (!grid || !cards.length) return;
  const width = grid.clientWidth;
  if (!width) return;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 4;
  const target = Number(document.querySelector('#mediaSize')?.value) || 170;
  const ratios = cards.map(card => {
    const width = Number(card.dataset.width) || 0;
    const height = Number(card.dataset.height) || 0;
    return width && height ? Math.max(.65, Math.min(2.1, width / height)) : 1;
  });
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);
  const filledHeight = (width - gap * (cards.length - 1)) / Math.max(.001, sum);
  const last = row.classList.contains('last-layout-row');
  const fill = !last || (cards.length >= 2 && filledHeight <= target * 1.42);
  const height = fill ? filledHeight : target;

  cards.forEach((card, index) => {
    const itemWidth = ratios[index] * height;
    card.style.setProperty('width', `${Math.round(itemWidth * 100) / 100}px`);
    card.style.setProperty('height', `${Math.round(height * 100) / 100}px`);
    card.style.setProperty('flex-basis', `${Math.round(itemWidth * 100) / 100}px`);
  });
  syncDayLabels(grid);
}

function flushRows() {
  rowFrame = 0;
  if (!pendingRows.size) return;
  const ready = [];
  let needsAnchor = false;
  const allowVisible = !userInteracted && startupVisibleUntil && performance.now() <= startupVisibleUntil;
  for (const row of pendingRows) {
    if (!row.isConnected) {
      pendingRows.delete(row);
      continue;
    }
    const rect = row.getBoundingClientRect();
    if (rowIsVisible(row) && !allowVisible) continue;
    if (rect.top < innerHeight) needsAnchor = true;
    ready.push(row);
  }
  if (!ready.length) return;

  const anchor = needsAnchor ? visibleAnchor() : null;
  for (const row of ready) {
    pendingRows.delete(row);
    reflowRow(row);
  }
  restoreAnchor(anchor);
}

function scheduleRows() {
  if (!rowFrame) rowFrame = requestAnimationFrame(flushRows);
}

function queueCardRow(card) {
  if (!(card instanceof Element)) return;
  if (!(Number(card.dataset.width) > 0 && Number(card.dataset.height) > 0)) return;
  const row = card.closest('.justified-media-row');
  if (!row) return;
  pendingRows.add(row);
  scheduleRows();
}

const observer = files ? new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes') {
      queueCardRow(record.target);
      continue;
    }
    for (const node of record.addedNodes) applyKnown(node);
  }
}) : null;
observer?.observe(files, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-width','data-height'] });

window.addEventListener('scroll', () => {
  if (pendingRows.size) scheduleRows();
}, { passive: true });

for (const eventName of ['wheel','pointerdown','keydown','touchstart']) {
  window.addEventListener(eventName, () => { userInteracted = true; }, { passive: true, capture: true, once: true });
}

function waitForInstantCards(timeout = 400) {
  if (files?.querySelector('[data-instant-hash]')) return Promise.resolve(true);
  if (!files) return Promise.resolve(false);
  return new Promise(resolve => {
    let done = false;
    let timer = 0;
    const finish = value => {
      if (done) return;
      done = true;
      watch.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const watch = new MutationObserver(() => {
      if (files.querySelector('[data-instant-hash]')) finish(true);
    });
    watch.observe(files, { childList: true, subtree: true });
    timer = setTimeout(() => finish(false), timeout);
  });
}

async function prime() {
  const cards = [...files.querySelectorAll('[data-instant-hash]')];
  const hashes = [...new Set(cards.map(card => String(card.dataset.instantHash || '')).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  if (!hashes.length) return;

  try {
    const response = await fetch('/api/thumbs/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes })
    });
    if (!response.ok) return;
    const data = await response.json();
    for (const item of data.thumbnails || []) {
      const hash = String(item.hash || '');
      const width = Number(item.width) || 0;
      const height = Number(item.height) || 0;
      if (!hash || !width || !height) continue;
      geometry.set(hash, { width, height });
      const instant = files.querySelector(`[data-instant-hash="${CSS.escape(hash)}"]`);
      apply(instant, width, height);
    }
  } catch {}

  // Feed the catalog cache before this startup promise resolves. The first real
  // grid can therefore use these dimensions instead of freezing fallback ratios.
  for (const [hash, item] of geometry) {
    window.mochimonoCatalogCache?.rememberDimensions?.(hash, item.width, item.height);
  }
}

window.mochimonoStartupGeometry = geometry;
window.mochimonoInstantGridReady = Promise.resolve(originalReady).then(async painted => {
  const hasInstantGrid = painted || await waitForInstantCards();
  if (hasInstantGrid) await prime();
  return painted;
});
