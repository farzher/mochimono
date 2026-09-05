const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const CLIENT = document.documentElement.classList.contains('client-library');
const THUMB_VERSION = 3;
const CHECK_LIMIT = 160;
const RECHECK_DELAY = CLIENT ? 140 : 500;
const CARD_PRELOAD_MARGIN = Math.max(900, Math.round(innerHeight * 2.25));
const ROW_PRELOAD_MARGIN = Math.max(1200, Math.round(innerHeight * 2.75));
const IMAGE_POOL_MAX = 512;
const MAX_IMAGE_LOADS = 48;
const NEAR_LOAD_LIMIT = 40;
const WARM_LOAD_LIMIT = 24;
const ROW_WORK_BUDGET_MS = 4;

const states = new Map();
const cardsByHash = new Map();
const dimensions = new Map();
const nearby = new Set();
const prioritized = new Set();
const preparedCards = new WeakSet();
const mountedRows = new WeakSet();
const activeRows = new Set();
const imagePool = new Map();
const externalQueue = new Map();
const waitersByHash = new Map();
const browserFallback = CLIENT ? null : import('./browser-thumbnail-fallback.js').catch(() => null);

const rowWork = [[], [], []];
const queuedRows = new WeakMap();
const loadWork = [[], [], []];
const queuedCards = new WeakMap();
const cleanupRows = [];

let rowWorkTimer = 0;
let activeImageLoads = 0;
let checkTimer = 0;
let checkAt = 0;
let checking = false;

const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);

const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const filename = card => card.dataset.filename || card.title || card.querySelector('strong')?.textContent || '';
const thumbUrl = hash => `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
const clampTier = value => Math.max(0, Math.min(2, Number(value) || 0));

function kind(card) {
  if (card.classList.contains('video-card')) return 'video';
  if (card.classList.contains('media-card')) return 'image';
  const ext = extension(filename(card));
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return '';
}

function cardsIn(node) {
  if (!(node instanceof Element)) return [];
  const cards = [];
  if (node.matches('[data-hash]')) cards.push(node);
  cards.push(...node.querySelectorAll('[data-hash]'));
  return cards;
}

function stateFor(hash) {
  let state = states.get(hash);
  if (!state) {
    state = { ready:false, loading:false, failed:false, terminal:false, nextTry:0, nextCheck:0 };
    states.set(hash, state);
  }
  return state;
}

function applyDimensions(card, width, height) {
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!card || width <= 0 || height <= 0) return;
  card.dataset.width = String(width);
  card.dataset.height = String(height);
  if (card.classList.contains('media-card') && !card.closest('.stable-grid-row')) {
    card.style.setProperty('--ratio', String(width / height));
  }
}

function rememberDimensions(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!hash || width <= 0 || height <= 0) return;
  const previous = dimensions.get(hash);
  if (previous?.width === width && previous?.height === height) return;
  dimensions.set(hash, { width, height });
  for (const card of cardsByHash.get(hash) || []) applyDimensions(card, width, height);
  try { window.mochimonoCatalogCache?.rememberDimensions?.(hash, width, height); } catch {}
}

function indexCard(card) {
  const hash = String(card?.dataset?.hash || '');
  if (!hash) return;
  let group = cardsByHash.get(hash);
  if (!group) cardsByHash.set(hash, group = new Set());
  group.add(card);
  const known = dimensions.get(hash);
  if (known) applyDimensions(card, known.width, known.height);
}

function unindexCard(card) {
  prioritized.delete(card);
  nearby.delete(card);
  queuedCards.delete(card);
  const hash = String(card?.dataset?.hash || '');
  const group = hash && cardsByHash.get(hash);
  if (!group) return;
  group.delete(card);
  if (!group.size) cardsByHash.delete(hash);
}

function mediaBox(card, mediaKind = kind(card)) {
  let box = card.querySelector('.media-thumb');
  if (box) return box;
  if (!card.classList.contains('file-row') && !card.classList.contains('file-folder-row')) return null;
  box = document.createElement('span');
  box.className = `tiny-preview media-thumb ${mediaKind === 'video' ? 'video' : ''}`;
  const old = card.classList.contains('file-row') ? card.querySelector('.type') : card.querySelector('.document-icon');
  old?.replaceWith(box);
  return box;
}

function pending(card) {
  const box = mediaBox(card);
  if (!box || box.querySelector('.video-thumb-pending')) return;
  const item = document.createElement('span');
  item.className = 'video-thumb-pending';
  item.dataset.videoThumb = card.dataset.hash || '';
  box.prepend(item);
}

function setFailedVisual(hash, failed, terminal = false) {
  for (const card of cardsByHash.get(String(hash || '')) || []) {
    const box = mediaBox(card);
    if (!box) continue;
    if (failed) {
      pending(card);
      box.classList.add('thumb-failed');
      box.title = terminal ? 'Thumbnail unavailable' : 'Thumbnail generation failed; retrying later';
    } else {
      box.classList.remove('thumb-failed');
      box.removeAttribute('title');
    }
  }
}

function markFailed(hash, failure) {
  const now = performance.now();
  const terminal = failure?.terminal === true;
  const retryAt = terminal ? Infinity : now + Math.max(RECHECK_DELAY, Number(failure?.retryAfterMs) || RECHECK_DELAY);
  const state = stateFor(hash);
  state.ready = false;
  state.loading = false;
  state.failed = true;
  state.terminal = terminal;
  state.nextTry = retryAt;
  state.nextCheck = retryAt;
  setFailedVisual(hash, true, terminal);
}

function resetFailures() {
  for (const [hash, state] of states) {
    if (!state.failed) continue;
    state.failed = false;
    state.terminal = false;
    state.nextCheck = 0;
    state.nextTry = 0;
    setFailedVisual(hash, false);
  }
}

function touchPool(hash, image) {
  imagePool.delete(hash);
  imagePool.set(hash, image);
  while (imagePool.size > IMAGE_POOL_MAX) imagePool.delete(imagePool.keys().next().value);
}

function finishNetwork(image) {
  if (image?.dataset?.thumbActive !== '1') return;
  delete image.dataset.thumbActive;
  activeImageLoads = Math.max(0, activeImageLoads - 1);
  pumpImageLoads();
}

function stashImage(card) {
  const hash = String(card?.dataset?.hash || '');
  if (!hash) return;
  const image = card.querySelector('img.cached-thumb');
  if (!image) return;
  image.onload = null;
  image.onerror = null;
  image.style.removeProperty('transform');

  if (image.complete && image.naturalWidth && image.dataset.thumbDecoded === '1') {
    image.style.opacity = '1';
    image.remove();
    touchPool(hash, image);
    return;
  }

  finishNetwork(image);
  image.removeAttribute('src');
  image.remove();
  const state = stateFor(hash);
  state.loading = false;
  state.nextCheck = 0;
}

function adoptPooledImage(card, hash, box) {
  const image = imagePool.get(hash);
  if (!image?.complete || !image.naturalWidth || image.dataset.thumbDecoded !== '1') {
    if (image) imagePool.delete(hash);
    return false;
  }
  imagePool.delete(hash);
  image.onload = null;
  image.onerror = null;
  image.hidden = false;
  image.style.objectFit = 'cover';
  image.style.removeProperty('transform');
  image.style.opacity = '1';
  image.dataset.thumbHash = hash;
  box.querySelector('.video-thumb-pending')?.remove();
  box.prepend(image);

  const state = stateFor(hash);
  state.ready = true;
  state.loading = false;
  state.failed = false;
  state.terminal = false;
  state.nextCheck = 0;
  state.nextTry = 0;
  rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
  settleHashWaiters(hash);
  return true;
}

async function revealLoadedImage(hash, card, image) {
  if (!image.isConnected || image.dataset.thumbHash !== hash || image.dataset.thumbDecoded === '1') return;
  try { await image.decode?.(); } catch {}
  if (!image.isConnected || image.dataset.thumbHash !== hash || image.dataset.thumbDecoded === '1') return;
  if (!image.naturalWidth || !image.naturalHeight) return;

  image.dataset.thumbDecoded = '1';
  image.hidden = false;
  image.style.objectFit = 'cover';
  image.style.opacity = '1';
  rememberDimensions(hash, image.naturalWidth, image.naturalHeight);

  const box = mediaBox(card);
  box?.classList.remove('thumb-failed');
  box?.removeAttribute('title');
  box?.querySelector('.video-thumb-pending')?.remove();

  const state = stateFor(hash);
  state.ready = true;
  state.loading = false;
  state.failed = false;
  state.terminal = false;
  state.nextCheck = 0;
  state.nextTry = 0;
  settleHashWaiters(hash);
}

function queueCard(card, tier = 1) {
  if (!card?.isConnected || !kind(card)) return;
  tier = clampTier(tier);
  const previous = queuedCards.get(card);
  if (previous != null && previous <= tier) return;
  queuedCards.set(card, tier);
  loadWork[tier].push(card);
  pumpImageLoads();
}

function nextQueuedCard() {
  const limits = [MAX_IMAGE_LOADS, NEAR_LOAD_LIMIT, WARM_LOAD_LIMIT];
  for (let tier = 0; tier < loadWork.length; tier++) {
    if (activeImageLoads >= limits[tier]) continue;
    while (loadWork[tier].length) {
      const card = loadWork[tier].shift();
      if (queuedCards.get(card) !== tier) continue;
      queuedCards.delete(card);
      if (!card?.isConnected) continue;
      const row = card.closest('.stable-grid-row');
      if (row && !activeRows.has(row) && !prioritized.has(card)) continue;
      return { card, tier };
    }
  }
  return null;
}

function startImage(card, tier) {
  if (!card?.isConnected || !kind(card)) return false;
  const hash = String(card.dataset.hash || '');
  const box = hash && mediaBox(card);
  if (!hash || !box) return false;

  const current = box.querySelector('img.cached-thumb');
  if (current?.dataset.thumbHash === hash) {
    if (current.complete && current.naturalWidth) revealLoadedImage(hash, card, current);
    return false;
  }
  if (adoptPooledImage(card, hash, box)) return false;

  const state = stateFor(hash);
  const now = performance.now();
  if (state.failed && now >= (state.nextTry || 0)) {
    state.failed = false;
    state.terminal = false;
    setFailedVisual(hash, false);
  }
  if (state.terminal || now < (state.nextTry || 0) || state.loading) {
    pending(card);
    return false;
  }

  pending(card);
  const image = document.createElement('img');
  image.className = 'cached-thumb';
  image.alt = '';
  image.decoding = 'async';
  image.loading = 'eager';
  image.style.objectFit = 'cover';
  image.style.opacity = '0';
  image.dataset.thumbHash = hash;
  image.dataset.thumbActive = '1';
  try { image.fetchPriority = tier === 0 || prioritized.has(card) ? 'high' : 'auto'; } catch {}

  state.loading = true;
  activeImageLoads++;
  image.onload = () => {
    finishNetwork(image);
    if (image.isConnected && image.dataset.thumbHash === hash) revealLoadedImage(hash, card, image);
  };
  image.onerror = () => {
    finishNetwork(image);
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    image.remove();
    const failed = stateFor(hash);
    failed.ready = false;
    failed.loading = false;
    failed.nextTry = performance.now() + RECHECK_DELAY;
    failed.nextCheck = performance.now();
    pending(card);
    scheduleCheck(0);
  };

  box.prepend(image);
  image.src = thumbUrl(hash);
  return true;
}

function pumpImageLoads() {
  if (viewer?.hidden === false) return;
  while (activeImageLoads < MAX_IMAGE_LOADS) {
    const next = nextQueuedCard();
    if (!next) break;
    startImage(next.card, next.tier);
  }
}

function prepareCard(card, tier = 1, direct = false) {
  if (!card?.isConnected) return;
  if (!preparedCards.has(card)) {
    preparedCards.add(card);
    indexCard(card);
  }
  if (!kind(card)) return;

  const hash = String(card.dataset.hash || '');
  const box = mediaBox(card);
  if (!hash || !box) return;
  if (!box.querySelector('img.cached-thumb') && adoptPooledImage(card, hash, box)) return;

  const image = box.querySelector('img.cached-thumb');
  if (image?.complete && image.naturalWidth) {
    revealLoadedImage(hash, card, image);
    return;
  }

  const state = stateFor(hash);
  if (direct || state.ready) queueCard(card, tier);
  else {
    pending(card);
    state.nextCheck = Math.min(state.nextCheck || Infinity, performance.now());
    scheduleCheck(0);
  }
}

function cleanupCard(card) {
  if (!preparedCards.has(card)) return;
  stashImage(card);
  cardObserver?.unobserve(card);
  unindexCard(card);
  preparedCards.delete(card);
}

function queueRow(row, tier = 1) {
  if (!row?.isConnected || !mountedRows.has(row)) return;
  tier = clampTier(tier);
  const previous = queuedRows.get(row);
  if (previous != null && previous <= tier) return;
  queuedRows.set(row, tier);
  rowWork[tier].push(row);
  scheduleRowWork();
}

function rowTier(entry) {
  const rect = entry.boundingClientRect;
  if (rect.bottom > 0 && rect.top < innerHeight) return 0;
  const distance = rect.bottom <= 0 ? -rect.bottom : Math.max(0, rect.top - innerHeight);
  return distance <= innerHeight * 1.2 ? 1 : 2;
}

function prepareRow(row, tier) {
  if (!row?.isConnected || !activeRows.has(row)) return;
  for (const card of row.querySelectorAll('[data-hash]')) {
    nearby.add(card);
    prepareCard(card, tier, true);
  }
}

function cleanupRow(row) {
  activeRows.delete(row);
  queuedRows.delete(row);
  for (const card of row.querySelectorAll('[data-hash]')) cleanupCard(card);
}

function scheduleRowWork() {
  if (rowWorkTimer) return;
  rowWorkTimer = setTimeout(flushRowWork, 0);
}

function flushRowWork() {
  rowWorkTimer = 0;
  const started = performance.now();

  while (cleanupRows.length && performance.now() - started < ROW_WORK_BUDGET_MS) {
    cleanupRow(cleanupRows.shift());
  }

  for (let tier = 0; tier < rowWork.length && performance.now() - started < ROW_WORK_BUDGET_MS; tier++) {
    while (rowWork[tier].length && performance.now() - started < ROW_WORK_BUDGET_MS) {
      const row = rowWork[tier].shift();
      if (queuedRows.get(row) !== tier) continue;
      queuedRows.delete(row);
      prepareRow(row, tier);
    }
  }

  if (cleanupRows.length || rowWork.some(queue => queue.length)) scheduleRowWork();
  pumpImageLoads();
}

const rowObserver = files && typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const row = entry.target;
        if (!entry.isIntersecting) {
          activeRows.delete(row);
          for (const card of row.querySelectorAll('[data-hash]')) nearby.delete(card);
          continue;
        }
        activeRows.add(row);
        queueRow(row, rowTier(entry));
      }
    }, { rootMargin:`${ROW_PRELOAD_MARGIN}px 0px` })
  : null;

const cardObserver = files && typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const card = entry.target;
        if (!entry.isIntersecting) {
          nearby.delete(card);
          continue;
        }
        nearby.add(card);
        prepareCard(card, 0, false);
      }
      scheduleCheck(0);
    }, { rootMargin:`${CARD_PRELOAD_MARGIN}px 0px` })
  : null;

function mountRow(row) {
  if (!(row instanceof Element) || mountedRows.has(row)) return;
  mountedRows.add(row);
  rowObserver?.observe(row);
}

function unmountRow(row) {
  if (!(row instanceof Element) || !mountedRows.has(row)) return;
  rowObserver?.unobserve(row);
  mountedRows.delete(row);
  activeRows.delete(row);
  queuedRows.delete(row);
  cleanupRows.push(row);
  scheduleRowWork();
}

function prepare(node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.stable-grid-row')) {
    mountRow(node);
    return;
  }
  const stableRows = node.querySelectorAll('.stable-grid-row');
  if (stableRows.length) {
    for (const row of stableRows) mountRow(row);
    return;
  }
  for (const card of cardsIn(node)) {
    if (card.closest('.stable-grid-row')) continue;
    if (!preparedCards.has(card)) {
      preparedCards.add(card);
      indexCard(card);
    }
    if (kind(card)) cardObserver?.observe(card);
  }
}

function release(node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.stable-grid-row')) {
    unmountRow(node);
    return;
  }
  const stableRows = node.querySelectorAll('.stable-grid-row');
  if (stableRows.length) {
    for (const row of stableRows) unmountRow(row);
    return;
  }
  for (const card of cardsIn(node)) cleanupCard(card);
}

function loadHash(hash) {
  for (const card of cardsByHash.get(String(hash || '')) || []) {
    if (!card.isConnected) continue;
    if (prioritized.has(card)) queueCard(card, 0);
    else if (nearby.has(card)) queueCard(card, 1);
  }
}

function cardCheckSet() {
  const result = new Set();
  if (viewer?.hidden === false) return result;
  for (const card of prioritized) if (card?.isConnected) result.add(card);
  for (const card of nearby) if (card?.isConnected) result.add(card);
  return result;
}

function scheduleCheck(delay = 50) {
  const at = performance.now() + Math.max(0, delay);
  if (checkTimer && checkAt <= at) return;
  if (checkTimer) clearTimeout(checkTimer);
  checkAt = at;
  checkTimer = setTimeout(runChecks, Math.max(0, delay));
}

function scheduleOutstanding() {
  const now = performance.now();
  let next = Infinity;
  if (externalQueue.size) next = now;
  for (const card of cardCheckSet()) {
    if (!kind(card)) continue;
    const hash = String(card.dataset.hash || '');
    const state = stateFor(hash);
    if (state.ready || state.loading || state.terminal) continue;
    next = Math.min(next, state.nextCheck || now);
  }
  if (Number.isFinite(next)) scheduleCheck(Math.max(0, next - now));
}

function activeCardForHash(hash) {
  return [...(cardsByHash.get(hash) || [])].find(card => card.isConnected && (nearby.has(card) || prioritized.has(card)));
}

async function requestMissing(hashes) {
  if (!hashes.length || CLIENT) return;
  fetch('/api/thumbs/request', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ hashes })
  }).catch(() => {});

  const fallback = await browserFallback;
  for (const hash of hashes) {
    const card = activeCardForHash(hash);
    if (card) fallback?.queueBrowserThumbnail?.({ hash, filename:filename(card), kind:kind(card) });
  }
}

function settleHashWaiters(hash) {
  const waiters = waitersByHash.get(hash);
  if (!waiters?.size) return;
  waitersByHash.delete(hash);
  const state = stateFor(hash);
  for (const waiter of waiters) {
    waiter.remaining.delete(hash);
    if (state.ready) waiter.ready.add(hash);
    else if (state.terminal || state.failed) waiter.failed.add(hash);
    if (!waiter.remaining.size) waiter.resolve({ ready:[...waiter.ready], failed:[...waiter.failed] });
  }
}

async function checkBatch(hashes, background) {
  if (!hashes.length) return;
  const response = await fetch('/api/thumbs/check', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ hashes, background })
  });
  if (!response.ok) throw new Error(`Thumbnail check failed (${response.status})`);
  const data = await response.json();

  const ready = new Map((data.thumbnails || []).map(item => [String(item.hash), item]));
  const failures = new Map((data.failures || []).map(item => [String(item.hash), item]));
  const missingFromServer = new Set((data.missing || []).map(item => String(item.hash)));
  const request = [];
  const now = performance.now();

  for (const hash of hashes) {
    externalQueue.delete(hash);
    const item = ready.get(hash);
    const failure = failures.get(hash);
    const state = stateFor(hash);

    if (item) {
      state.ready = true;
      state.failed = false;
      state.terminal = false;
      state.nextCheck = 0;
      state.nextTry = 0;
      setFailedVisual(hash, false);
      rememberDimensions(hash, item.width, item.height);
      loadHash(hash);
    } else if (state.ready || state.loading) {
      state.nextCheck = now + RECHECK_DELAY;
    } else if (failure) {
      markFailed(hash, failure);
    } else {
      state.ready = false;
      state.failed = false;
      state.terminal = false;
      state.nextCheck = now + RECHECK_DELAY;
      setFailedVisual(hash, false);
      if (missingFromServer.has(hash)) request.push(hash);
    }
    settleHashWaiters(hash);
  }

  requestMissing(request);
}

function candidateHashes() {
  const now = performance.now();
  const byHash = new Map();

  for (const [hash, item] of externalQueue) {
    const state = stateFor(hash);
    if (state.ready || state.terminal) {
      settleHashWaiters(hash);
      externalQueue.delete(hash);
      continue;
    }
    byHash.set(hash, { hash, urgent:item.background === false, due:0 });
  }

  for (const card of cardCheckSet()) {
    if (!kind(card)) continue;
    const hash = String(card.dataset.hash || '');
    if (!hash) continue;
    const state = stateFor(hash);
    if (state.ready || state.loading || state.terminal || now < (state.nextCheck || 0)) continue;
    const urgent = prioritized.has(card);
    const current = byHash.get(hash);
    if (!current) byHash.set(hash, { hash, urgent, due:state.nextCheck || 0 });
    else if (urgent) current.urgent = true;
  }

  return [...byHash.values()]
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.due - b.due)
    .slice(0, CHECK_LIMIT);
}

async function runChecks() {
  checkTimer = 0;
  checkAt = 0;
  if (checking || document.hidden) return;

  const candidates = candidateHashes();
  if (!candidates.length) {
    scheduleOutstanding();
    return;
  }

  const urgent = candidates.filter(item => item.urgent).map(item => item.hash);
  const background = candidates.filter(item => !item.urgent).map(item => item.hash);
  checking = true;
  try {
    await Promise.all([
      urgent.length ? checkBatch(urgent, false) : null,
      background.length ? checkBatch(background, true) : null
    ]);
  } catch {
    const retry = performance.now() + 900;
    for (const item of candidates) stateFor(item.hash).nextCheck = retry;
  } finally {
    checking = false;
    scheduleOutstanding();
  }
}

function ensureHashes(hashes, options = {}) {
  const background = options.background === true;
  const unique = [...new Set((Array.isArray(hashes) ? hashes : [hashes]).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  if (!unique.length) return Promise.resolve({ ready:[], failed:[] });

  return new Promise(resolve => {
    const waiter = { remaining:new Set(), ready:new Set(), failed:new Set(), resolve };
    for (const hash of unique) {
      const state = stateFor(hash);
      if (state.ready) {
        waiter.ready.add(hash);
        continue;
      }
      if (state.terminal || state.failed) {
        waiter.failed.add(hash);
        continue;
      }

      waiter.remaining.add(hash);
      let waiters = waitersByHash.get(hash);
      if (!waiters) waitersByHash.set(hash, waiters = new Set());
      waiters.add(waiter);

      const queued = externalQueue.get(hash);
      if (!queued) externalQueue.set(hash, { background });
      else if (!background) queued.background = false;
    }

    if (!waiter.remaining.size) {
      resolve({ ready:[...waiter.ready], failed:[...waiter.failed] });
      return;
    }
    scheduleCheck(0);
  });
}

window.mochimonoThumbnails = {
  prepare,
  release,
  ensureHashes,
  prioritize(cards) {
    prioritized.clear();
    for (const card of Array.isArray(cards) ? cards : [cards]) {
      if (!card?.isConnected || !kind(card)) continue;
      if (!preparedCards.has(card)) {
        preparedCards.add(card);
        indexCard(card);
      }
      prioritized.add(card);
      nearby.add(card);
      prepareCard(card, 0, true);
      queueCard(card, 0);
    }
    scheduleCheck(0);
  },
  clearPriority() { prioritized.clear(); },
  state() {
    return {
      cards:[...cardsByHash.values()].reduce((sum, group) => sum + group.size, 0),
      nearby:nearby.size,
      activeRows:activeRows.size,
      pooled:imagePool.size,
      queuedImages:loadWork.reduce((sum, queue) => sum + queue.length, 0),
      activeImageLoads,
      states:states.size,
      external:externalQueue.size,
      checking
    };
  }
};

if (files) {
  prepare(files);

  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) if (node instanceof Element) release(node);
      for (const node of record.addedNodes) if (node instanceof Element) prepare(node);
    }
  }).observe(files, { childList:true, subtree:true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pumpImageLoads();
      scheduleOutstanding();
    }
  });

  window.addEventListener('mochimono:grid-interaction-end', () => {
    pumpImageLoads();
    scheduleOutstanding();
  });

  window.addEventListener('mochimono:catalog-updated', () => {
    resetFailures();
    scheduleOutstanding();
  });

  window.addEventListener('mochimono:browser-thumbnail-ready', event => {
    const hash = String(event.detail?.hash || '');
    if (!hash) return;
    const state = stateFor(hash);
    state.ready = false;
    state.loading = false;
    state.failed = false;
    state.terminal = false;
    state.nextCheck = 0;
    state.nextTry = 0;
    setFailedVisual(hash, false);
    scheduleCheck(0);
  });

  if (viewer && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (viewer.hidden) pumpImageLoads();
    }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
  }

  addEventListener('beforeunload', () => {
    if (checkTimer) clearTimeout(checkTimer);
    if (rowWorkTimer) clearTimeout(rowWorkTimer);
  }, { once:true });
}
