const files = document.querySelector('#files');
const originalReady = window.mochimonoInstantGridReady || Promise.resolve(false);
const geometry = new Map();
const pendingHashes = new Set();
const pendingRows = new Set();
const attempts = new Map();
const CHECK_LIMIT = 500;
const RETRY_DELAY = 180;
const MAX_RETRIES = 2;
let checkTimer = 0;
let checking = false;
let rowFrame = 0;

const style = document.createElement('style');
style.textContent = `
.files.grid .geometry-pending{visibility:hidden}
.files.grid .justified-media-row:has(>.geometry-pending){visibility:hidden}
`;
document.head.append(style);

const validHash = hash => /^[a-f0-9]{64}$/.test(String(hash || ''));
const hashFor = card => String(card?.dataset?.hash || card?.dataset?.instantHash || '');
const hasDimensions = card => Number(card?.dataset?.width) > 0 && Number(card?.dataset?.height) > 0;

function mediaCardsIn(node) {
  if (!(node instanceof Element)) return [];
  const cards = [];
  if (node.matches('.media-card[data-hash],.media-card[data-instant-hash]')) cards.push(node);
  cards.push(...node.querySelectorAll('.media-card[data-hash],.media-card[data-instant-hash]'));
  return cards;
}

function apply(card, width, height) {
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!card || !width || !height) return false;
  const widthText = String(width);
  const heightText = String(height);
  if (card.dataset.width !== widthText) card.dataset.width = widthText;
  if (card.dataset.height !== heightText) card.dataset.height = heightText;
  const ratio = String(width / height);
  if (card.style.getPropertyValue('--ratio') !== ratio) card.style.setProperty('--ratio', ratio);
  return true;
}

function visibleAnchor() {
  if (!files?.isConnected || window.scrollY <= 1) return null;
  const top = Math.max(0, document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0);
  const bounds = files.getBoundingClientRect();
  const xs = [bounds.left + 8, (bounds.left + bounds.right) / 2, bounds.right - 8]
    .map(x => Math.max(1, Math.min(innerWidth - 2, x)));
  for (const y of [top + 2, top + 40, top + 80]) {
    if (y >= innerHeight) break;
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

  for (const row of pendingRows) {
    if (!row.isConnected) {
      pendingRows.delete(row);
      continue;
    }
    const blocking = [...row.querySelectorAll(':scope > .geometry-pending')];
    if (blocking.some(card => !hasDimensions(card))) continue;
    if (!blocking.length && rowIsVisible(row)) continue;
    if (row.getBoundingClientRect().top < innerHeight) needsAnchor = true;
    ready.push(row);
  }
  if (!ready.length) return;

  const anchor = needsAnchor ? visibleAnchor() : null;
  for (const row of ready) {
    pendingRows.delete(row);
    reflowRow(row);
    for (const card of row.querySelectorAll(':scope > .geometry-pending')) {
      if (hasDimensions(card)) {
        card.classList.remove('geometry-pending', 'geometry-fallback');
      }
    }
  }
  restoreAnchor(anchor);
}

function scheduleRows() {
  if (!rowFrame) rowFrame = requestAnimationFrame(flushRows);
}

function queueCardRow(card) {
  if (!(card instanceof Element) || !hasDimensions(card)) return;
  const row = card.closest('.justified-media-row');
  if (!row) return;
  pendingRows.add(row);
  scheduleRows();
}

function remember(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!validHash(hash) || !width || !height) return;
  geometry.set(hash, { width, height });

  const selector = `.media-card[data-hash="${CSS.escape(hash)}"],.media-card[data-instant-hash="${CSS.escape(hash)}"]`;
  for (const card of files?.querySelectorAll(selector) || []) {
    apply(card, width, height);
    const row = card.closest('.justified-media-row');
    if (row) queueCardRow(card);
    else card.classList.remove('geometry-pending', 'geometry-fallback');
  }

  try { window.mochimonoCatalogCache?.rememberDimensions?.(hash, width, height); } catch {}
}

function fallback(hash) {
  hash = String(hash || '');
  if (!validHash(hash)) return;
  const selector = `.media-card[data-hash="${CSS.escape(hash)}"],.media-card[data-instant-hash="${CSS.escape(hash)}"]`;
  for (const card of files?.querySelectorAll(selector) || []) {
    card.classList.remove('geometry-pending');
    card.classList.add('geometry-fallback');
  }
  attempts.delete(hash);
  scheduleRows();
}

async function resolveHashes(hashes) {
  hashes = [...new Set(hashes.map(String).filter(validHash))].slice(0, CHECK_LIMIT);
  if (!hashes.length) return true;
  try {
    const response = await fetch('/api/thumbs/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes })
    });
    if (!response.ok) throw new Error(`Thumbnail geometry check failed (${response.status})`);
    const data = await response.json();
    const ready = new Set();
    for (const item of data.thumbnails || []) {
      const hash = String(item.hash || '');
      const width = Number(item.width) || 0;
      const height = Number(item.height) || 0;
      if (!validHash(hash) || !width || !height) continue;
      ready.add(hash);
      attempts.delete(hash);
      remember(hash, width, height);
    }
    for (const hash of hashes) if (!ready.has(hash)) fallback(hash);
    return true;
  } catch {
    return false;
  }
}

function scheduleCheck(delay = 0) {
  if (checkTimer || checking || !pendingHashes.size) return;
  checkTimer = setTimeout(flushChecks, delay);
}

async function flushChecks() {
  checkTimer = 0;
  if (checking || !pendingHashes.size || document.hidden) return;
  const hashes = [...pendingHashes].slice(0, CHECK_LIMIT);
  hashes.forEach(hash => pendingHashes.delete(hash));
  checking = true;
  const ok = await resolveHashes(hashes);
  checking = false;

  if (!ok) {
    for (const hash of hashes) {
      const count = (attempts.get(hash) || 0) + 1;
      attempts.set(hash, count);
      if (count <= MAX_RETRIES) pendingHashes.add(hash);
      else fallback(hash);
    }
  }
  if (pendingHashes.size) scheduleCheck(ok ? 0 : RETRY_DELAY);
}

function inspectCard(card) {
  if (!(card instanceof Element) || !card.matches('.media-card[data-hash],.media-card[data-instant-hash]')) return;
  const hash = hashFor(card);
  if (!validHash(hash)) return;

  if (hasDimensions(card)) {
    const width = Number(card.dataset.width);
    const height = Number(card.dataset.height);
    geometry.set(hash, { width, height });
    card.classList.remove('geometry-pending');
    return;
  }

  const known = geometry.get(hash);
  if (known) {
    apply(card, known.width, known.height);
    card.classList.remove('geometry-pending', 'geometry-fallback');
    return;
  }

  card.classList.add('geometry-pending');
  pendingHashes.add(hash);
  scheduleCheck();
}

function inspectTree(node) {
  for (const card of mediaCardsIn(node)) inspectCard(card);
}

const observer = files ? new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes') {
      queueCardRow(record.target);
      continue;
    }
    for (const node of record.addedNodes) inspectTree(node);
  }
}) : null;
observer?.observe(files, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-width','data-height'] });

window.addEventListener('scroll', () => {
  if (pendingRows.size) scheduleRows();
}, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pendingHashes.size) scheduleCheck();
});

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

async function primeInstant() {
  const cards = [...files.querySelectorAll('.media-card[data-instant-hash]')];
  cards.forEach(inspectCard);
  const hashes = cards.map(hashFor).filter(hash => validHash(hash) && !geometry.has(hash));
  if (hashes.length) await resolveHashes(hashes);
}

window.mochimonoStartupGeometry = geometry;
window.mochimonoGeometry = {
  get: hash => geometry.get(String(hash || '')) || null,
  prime: hashes => resolveHashes(Array.isArray(hashes) ? hashes : []),
  state: () => ({ known: geometry.size, pending: pendingHashes.size, checking })
};

window.mochimonoInstantGridReady = Promise.resolve(originalReady).then(async painted => {
  const hasInstantGrid = painted || await waitForInstantCards();
  if (hasInstantGrid) await primeInstant();
  return painted;
});
