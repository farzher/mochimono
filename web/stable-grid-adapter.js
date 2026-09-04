import { createStableMediaGrid } from './stable-media-grid.js';

const files = document.querySelector('#files');
const rail = document.querySelector('#dateRail');
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
let edgeObserver = null;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const px = value => `${Math.round(value * 100) / 100}px`;

function normalizedFile(raw, previous = null) {
  if (!raw?.hash) return null;
  const old = previous || {};
  return {
    ...old,
    ...raw,
    hash: String(raw.hash),
    filename: raw.filename == null ? String(old.filename || '') : String(raw.filename || ''),
    mime: raw.mime == null ? String(old.mime || '') : String(raw.mime || ''),
    width: raw.width == null ? Number(old.width) || 0 : Number(raw.width) || 0,
    height: raw.height == null ? Number(old.height) || 0 : Number(raw.height) || 0,
    size: raw.size == null ? Number(old.size) || 0 : Number(raw.size) || 0,
    fileDate: raw.fileDate ?? raw.createdAt ?? old.fileDate ?? old.createdAt ?? 0,
    addedAt: raw.addedAt ?? raw.createdAt ?? old.addedAt ?? old.createdAt ?? raw.fileDate ?? old.fileDate ?? 0
  };
}

function materialChange(previous, next) {
  if (!previous) return true;
  return previous.filename !== next.filename ||
    previous.mime !== next.mime ||
    Number(previous.width) !== Number(next.width) ||
    Number(previous.height) !== Number(next.height) ||
    Number(previous.size) !== Number(next.size) ||
    String(previous.fileDate || '') !== String(next.fileDate || '') ||
    String(previous.addedAt || '') !== String(next.addedAt || '');
}

function captureCatalog(items) {
  if (!Array.isArray(items) || !items.length) return false;
  let changed = false;
  for (const raw of items) {
    const hash = String(raw?.hash || '');
    if (!hash) continue;
    const previous = metadata.get(hash) || null;
    const file = normalizedFile(raw, previous);
    if (!file) continue;
    metadata.set(hash, file);
    changed ||= materialChange(previous, file);
  }
  if (changed) {
    metadataRevision++;
    scheduleSync();
  }
  return changed;
}

function rememberGeometry(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  const previous = metadata.get(hash);
  if (!previous || !width || !height || (previous.width === width && previous.height === height)) return;
  // Keep the current row plane frozen. Learned dimensions are retained for the
  // next intentional layout rebuild instead of reflowing rows during scrolling.
  metadata.set(hash, { ...previous, width, height });
}

if (cache) {
  const load = cache.load?.bind(cache);
  const save = cache.save?.bind(cache);
  const rememberDimensions = cache.rememberDimensions?.bind(cache);
  if (load) cache.load = async (...args) => {
    const value = await load(...args);
    captureCatalog(value?.files);
    return value;
  };
  if (save) cache.save = async (items, ...args) => {
    captureCatalog(items);
    return save(items, ...args);
  };
  if (rememberDimensions) cache.rememberDimensions = (hash, width, height) => {
    rememberGeometry(hash, width, height);
    return rememberDimensions(hash, width, height);
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
  if (!files?.isConnected) return null;
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

function legacyEdges() {
  return [document.querySelector('#top-scroll-sentinel'), document.querySelector('#scroll-sentinel')].filter(Boolean);
}

function hideLegacyEdges() {
  if (!stableGrid.active()) return;
  for (const sentinel of legacyEdges()) sentinel.hidden = true;
}

function watchLegacyEdges() {
  edgeObserver?.disconnect();
  edgeObserver = new MutationObserver(() => hideLegacyEdges());
  for (const sentinel of legacyEdges()) edgeObserver.observe(sentinel, { attributes: true, attributeFilter: ['hidden'] });
  hideLegacyEdges();
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
  let hash = 2166136261;
  for (const value of data.hashes) {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${data.state.sort}|${data.hashes.length}|${hash >>> 0}|${metadataRevision}`;
}

function syncStableGrid() {
  syncFrame = 0;
  if (!window.mochimonoLibrary || !files) return scheduleSync();
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

  const anchor = captureVisibleAnchor() || lastAnchor;
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
  const upsertMany = library.upsertMany?.bind(library);

  library.extend = direction => stableGrid.active() ? stableGrid.extend(direction) : extend?.(direction);
  library.ensureIndex = index => stableGrid.active() ? stableGrid.ensureIndex(index) : ensureIndex?.(index);
  if (upsertMany) library.upsertMany = items => {
    captureCatalog(items);
    return upsertMany(items);
  };
  library.state = () => {
    const base = state?.() || {};
    const virtual = stableGrid.state();
    return virtual ? { ...base, ...virtual } : base;
  };
  watchLegacyEdges();
  scheduleSync();
  return true;
}

function waitForLibrary() {
  if (wrapLibrary()) return;
  requestAnimationFrame(waitForLibrary);
}
waitForLibrary();

if (files) new MutationObserver(() => {
  lastAnchor = captureVisibleAnchor() || lastAnchor;
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
