import { createStableMediaGrid } from './stable-media-grid.js';

const files = document.querySelector('#files');
const rail = document.querySelector('#dateRail');
const topSentinel = document.querySelector('#top-scroll-sentinel');
const bottomSentinel = document.querySelector('#scroll-sentinel');
const mediaSizeInput = document.querySelector('#mediaSize');
const cache = window.mochimonoCatalogCache;
const metadata = new Map();

let metadataRevision = 0;
let activeSort = 'date-desc';
let lastSignature = '';
let lastAnchor = null;
let syncFrame = 0;
let railScrubbing = false;
let lastRailJump = 0;
let libraryWrapped = false;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const px = value => `${Math.round(value * 100) / 100}px`;

function normalizedFile(raw) {
  if (!raw?.hash) return null;
  return {
    ...raw,
    hash: String(raw.hash),
    filename: String(raw.filename || ''),
    mime: String(raw.mime || ''),
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    size: Number(raw.size) || 0,
    fileDate: raw.fileDate || raw.createdAt || 0,
    addedAt: raw.addedAt || raw.createdAt || raw.fileDate || 0
  };
}

function captureCatalog(items) {
  if (!Array.isArray(items) || !items.length) return;
  let changed = false;
  for (const raw of items) {
    const file = normalizedFile(raw);
    if (!file) continue;
    const previous = metadata.get(file.hash);
    metadata.set(file.hash, previous ? { ...previous, ...file } : file);
    changed = true;
  }
  if (changed) {
    metadataRevision++;
    scheduleSync();
  }
}

function captureRenderedDimensions() {
  let changed = false;
  for (const card of files?.querySelectorAll?.('[data-hash][data-width][data-height]') || []) {
    const width = Number(card.dataset.width) || 0;
    const height = Number(card.dataset.height) || 0;
    if (!width || !height) continue;
    const file = metadata.get(card.dataset.hash);
    if (!file || (file.width === width && file.height === height)) continue;
    metadata.set(card.dataset.hash, { ...file, width, height });
    changed = true;
  }
  if (changed) metadataRevision++;
}

if (cache) {
  const load = cache.load?.bind(cache);
  const save = cache.save?.bind(cache);
  if (load) cache.load = async (...args) => {
    const value = await load(...args);
    captureCatalog(value?.files);
    return value;
  };
  if (save) cache.save = async (items, ...args) => {
    captureCatalog(items);
    return save(items, ...args);
  };
  load?.().then(value => captureCatalog(value?.files)).catch(() => {});
}

function isMedia(file) {
  return file?.mime?.startsWith('image/') || file?.mime?.startsWith('video/');
}

function timelineDate(file) {
  const value = activeSort === 'date-added' ? file.addedAt || file.fileDate : file.fileDate;
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function monthKey(file) {
  const date = timelineDate(file);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthName(file) {
  return timelineDate(file).toLocaleDateString(undefined, { month: 'long' });
}

function dayKey(file) {
  const date = timelineDate(file);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayLabel(file) {
  return timelineDate(file).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function ratioFor(file) {
  return file.width && file.height ? Math.max(.65, Math.min(2.1, file.width / file.height)) : 4 / 3;
}

function renderCard(file, box) {
  const video = file.mime.startsWith('video/');
  const ratio = ratioFor(file);
  const day = dayKey(file);
  const label = dayLabel(file);
  return `<button class="file-card media-card ${video ? 'video-card' : ''} stable-media-card" data-hash="${file.hash}" data-filename="${escapeHtml(file.filename)}" data-day="${day}" data-day-label="${escapeHtml(label)}" data-width="${file.width}" data-height="${file.height}" style="left:${px(box.x)};top:${px(box.y)};width:${px(box.width)};height:${px(box.height)};flex-basis:${px(box.width)};--ratio:${ratio}" title="${escapeHtml(file.filename)}"><div class="thumb media-thumb"><span class="video-thumb-pending" data-video-thumb="${file.hash}"></span>${video ? '<span class="play-badge">▶</span>' : ''}</div></button>`;
}

const stableGrid = createStableMediaGrid({
  files,
  isMedia,
  ratioFor,
  renderCard,
  monthKey,
  monthName,
  dayKey,
  dayLabel,
  escapeHtml,
  mediaSize: () => Number(mediaSizeInput?.value) || 170
});

function captureVisibleAnchor() {
  if (!stableGrid.active() || !files) return null;
  const top = Math.max(0, document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0);
  const bounds = files.getBoundingClientRect();
  const xs = [bounds.left + 8, (bounds.left + bounds.right) / 2, bounds.right - 8]
    .map(x => Math.max(1, Math.min(innerWidth - 2, x)));
  for (const y of [top + 2, top + 40, top + 80, top + 120]) {
    if (y >= innerHeight) break;
    for (const x of xs) {
      const card = document.elementFromPoint(x, y)?.closest?.('#files [data-hash]');
      if (card) return { hash: card.dataset.hash, top: card.getBoundingClientRect().top };
    }
  }
  return null;
}

function hideLegacyEdges() {
  if (topSentinel) topSentinel.hidden = true;
  if (bottomSentinel) bottomSentinel.hidden = true;
}

function legacyState() {
  return window.mochimonoLibrary?.state?.() || null;
}

function stableItems() {
  const library = window.mochimonoLibrary;
  const state = library?.state?.();
  const hashes = library?.filteredHashes?.();
  if (!state || state.view !== 'grid' || !Array.isArray(hashes) || !hashes.length) return null;
  const result = new Array(hashes.length);
  for (let index = 0; index < hashes.length; index++) {
    const file = metadata.get(hashes[index]);
    if (!file || !isMedia(file)) return null;
    result[index] = file;
  }
  return { state, hashes, items: result };
}

function signatureFor(data) {
  const first = data.hashes[0] || '';
  const last = data.hashes.at(-1) || '';
  return `${data.state.sort}|${data.hashes.length}|${first}|${last}|${metadataRevision}`;
}

function syncStableGrid() {
  syncFrame = 0;
  if (!window.mochimonoLibrary || !files) return scheduleSync();
  captureRenderedDimensions();
  const data = stableItems();
  if (!data) {
    if (stableGrid.active()) {
      stableGrid.destroy();
      lastSignature = '';
    }
    return;
  }

  const signature = signatureFor(data);
  if (stableGrid.active() && files.classList.contains('stable-media-grid') && signature === lastSignature) {
    hideLegacyEdges();
    return;
  }

  const anchor = stableGrid.active() ? (captureVisibleAnchor() || lastAnchor) : lastAnchor;
  activeSort = data.state.sort;
  stableGrid.render(data.items, { sort: activeSort, anchor });
  lastSignature = signature;
  hideLegacyEdges();
}

function scheduleSync() {
  if (syncFrame) return;
  syncFrame = requestAnimationFrame(syncStableGrid);
}

function wrapLibrary() {
  const library = window.mochimonoLibrary;
  if (!library || libraryWrapped) return Boolean(library);
  libraryWrapped = true;
  const extend = library.extend?.bind(library);
  const ensureIndex = library.ensureIndex?.bind(library);
  const state = library.state?.bind(library);

  library.extend = direction => stableGrid.active() ? stableGrid.extend(direction) : extend?.(direction);
  library.ensureIndex = index => stableGrid.active() ? stableGrid.ensureIndex(index) : ensureIndex?.(index);
  library.state = () => {
    const base = state?.() || {};
    const virtual = stableGrid.state();
    return virtual ? { ...base, ...virtual } : base;
  };
  scheduleSync();
  return true;
}

function waitForLibrary() {
  if (wrapLibrary()) return;
  requestAnimationFrame(waitForLibrary);
}
waitForLibrary();

if (files) new MutationObserver(() => {
  if (stableGrid.active()) lastAnchor ||= captureVisibleAnchor();
  scheduleSync();
}).observe(files, { childList: true, subtree: false, attributes: true, attributeFilter: ['class'] });

window.addEventListener('scroll', () => {
  if (!stableGrid.active()) return;
  lastAnchor = captureVisibleAnchor() || lastAnchor;
}, { passive: true });
window.addEventListener('mochimono:catalog-updated', () => {
  setTimeout(() => cache?.load?.().then(value => captureCatalog(value?.files)).catch(() => {}), 0);
});
window.addEventListener('mochimono:catalog-cache-restored', scheduleSync);

function railIndex(event) {
  const hashes = window.mochimonoLibrary?.filteredHashes?.();
  if (!hashes?.length || !rail) return -1;
  const rect = rail.getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) * (hashes.length - 1));
}

function setRailThumb(index) {
  const hashes = window.mochimonoLibrary?.filteredHashes?.();
  const thumb = document.querySelector('#railThumb');
  if (!hashes?.length || !thumb || index < 0) return;
  const safe = Math.max(0, Math.min(hashes.length - 1, index));
  thumb.style.top = `${(hashes.length === 1 ? 0 : safe / (hashes.length - 1)) * 100}%`;
  const file = metadata.get(hashes[safe]);
  if (file) thumb.querySelector('span').textContent = activeSort === 'size-desc'
    ? `${Math.round(file.size / 1_000_000)} MB`
    : timelineDate(file).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

function jumpToIndex(index) {
  const hashes = window.mochimonoLibrary?.filteredHashes?.();
  if (!hashes?.[index]) return;
  stableGrid.ensureIndex(index);
  const hash = hashes[index];
  requestAnimationFrame(() => files.querySelector(`[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ behavior: 'auto', block: 'center' }));
}

if (rail) {
  rail.addEventListener('pointerdown', event => {
    if (!stableGrid.active() || rail.hidden) return;
    railScrubbing = true;
    rail.setPointerCapture?.(event.pointerId);
    rail.classList.add('dragging');
    const index = railIndex(event);
    setRailThumb(index);
    jumpToIndex(index);
    lastRailJump = performance.now();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  rail.addEventListener('pointermove', event => {
    if (!stableGrid.active() || !railScrubbing) return;
    const index = railIndex(event);
    setRailThumb(index);
    if (performance.now() - lastRailJump > 70) {
      lastRailJump = performance.now();
      jumpToIndex(index);
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  const finishRail = event => {
    if (!stableGrid.active() || !railScrubbing) return;
    railScrubbing = false;
    rail.classList.remove('dragging');
    const index = railIndex(event);
    setRailThumb(index);
    jumpToIndex(index);
    rail.releasePointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  rail.addEventListener('pointerup', finishRail, true);
  rail.addEventListener('pointercancel', event => {
    if (!stableGrid.active()) return;
    railScrubbing = false;
    rail.classList.remove('dragging');
    event.stopImmediatePropagation();
  }, true);
  rail.addEventListener('click', event => {
    if (!stableGrid.active()) return;
    const tick = event.target.closest('[data-index]');
    if (tick) jumpToIndex(Number(tick.dataset.index));
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

window.mochimonoStableGrid = stableGrid;
