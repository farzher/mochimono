const files = document.querySelector('#files');
const CLIENT = document.documentElement.classList.contains('client-library');
const THUMB_VERSION = 3;
const CHECK_LIMIT = 320;
const RECHECK_DELAY = CLIENT ? 140 : 450;
const IMAGE_PRELOAD_MARGIN = Math.max(1200, Math.round(innerHeight * 3.2));

const liveDimensions = new Map();
const modelIndexes = new WeakMap();
const mountedCards = new Map();
const availability = new Map();
const registeredRows = new WeakSet();
const nearRows = new WeakSet();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let geometryTimer = 0;
let geometryAt = 0;
let geometryDirty = false;
let lastScrollAt = 0;
let restoreAnchor = null;
let availabilityTimer = 0;
let availabilityAt = 0;
let availabilityChecking = false;

function modelIndex(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return null;
  let index = modelIndexes.get(snapshot);
  if (!index) {
    index = new Map(snapshot.items.map((item, position) => [String(item?.[0] || ''), position]));
    modelIndexes.set(snapshot, index);
  }
  return index;
}

function applyKnownDimensions(snapshot) {
  const index = modelIndex(snapshot);
  if (!index) return 0;
  let changed = 0;
  for (const [hash, geometry] of liveDimensions) {
    const position = index.get(hash);
    if (!Number.isInteger(position)) continue;
    const item = snapshot.items[position];
    if (!item || (Number(item[3]) === geometry.width && Number(item[4]) === geometry.height)) continue;
    item[3] = geometry.width;
    item[4] = geometry.height;
    changed++;
  }
  return changed;
}

function captureAnchor() {
  if (!files || !window.mochimonoStableGrid?.active?.()) return null;
  const top = (document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0) + 2;
  let best = null;
  let distance = Infinity;
  for (const card of files.querySelectorAll('.stable-grid-row [data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= top || rect.top >= innerHeight) continue;
    const next = Math.abs(rect.top - top);
    if (next >= distance) continue;
    distance = next;
    best = { hash:String(card.dataset.hash || ''), top:rect.top };
  }
  return best;
}

function interactionActive() {
  return Boolean(window.mochimonoGridInteraction?.active?.()) ||
    document.querySelector('#dateRail')?.classList.contains('dragging') ||
    performance.now() - lastScrollAt < 420;
}

function scheduleGeometry(delay = 150) {
  if (!geometryDirty) return;
  const at = performance.now() + delay;
  if (geometryTimer && geometryAt <= at) return;
  if (geometryTimer) clearTimeout(geometryTimer);
  geometryAt = at;
  geometryTimer = setTimeout(flushGeometry, delay);
}

function flushGeometry() {
  geometryTimer = 0;
  geometryAt = 0;
  if (!geometryDirty) return;
  if (interactionActive()) {
    scheduleGeometry(300);
    return;
  }

  const snapshot = window.mochimonoGridModel;
  const stable = window.mochimonoStableGrid;
  if (!snapshot?.items?.length || !stable?.setModel) {
    scheduleGeometry(250);
    return;
  }

  applyKnownDimensions(snapshot);
  geometryDirty = false;
  restoreAnchor = captureAnchor();
  stable.setModel(snapshot);
}

function rememberDimensions(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!hash || width <= 0 || height <= 0) return;

  const previous = liveDimensions.get(hash);
  if (previous?.width === width && previous?.height === height) return;
  liveDimensions.set(hash, { width, height });
  try { window.mochimonoCatalogCache?.rememberDimensions?.(hash, width, height); } catch {}

  const snapshot = window.mochimonoGridModel;
  const index = modelIndex(snapshot);
  const position = index?.get(hash);
  if (!Number.isInteger(position)) return;
  const item = snapshot.items[position];
  if (!item || (Number(item[3]) === width && Number(item[4]) === height)) return;
  item[3] = width;
  item[4] = height;
  geometryDirty = true;
  scheduleGeometry();
}

function visibleCard(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
}

async function revealImage(card, image, animate) {
  if (image.dataset.mochimonoRevealed === '1' || image.dataset.mochimonoRevealing === '1') return;
  image.dataset.mochimonoRevealing = '1';

  // `load` only means the bytes arrived. Chromium can still expose a black box
  // until decode/raster catches up. Keep a late image transparent until decode
  // completes, then release it into the paint path.
  if (image.decode) await image.decode().catch(() => {});
  if (!image.isConnected) return;

  image.dataset.mochimonoRevealed = '1';
  delete image.dataset.mochimonoRevealing;

  if (!animate || reduceMotion.matches || !visibleCard(card)) {
    image.style.removeProperty('transition');
    image.style.opacity = '1';
    return;
  }

  image.style.transition = 'opacity 150ms ease-out';
  requestAnimationFrame(() => {
    if (!image.isConnected) return;
    image.style.opacity = '1';
    image.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => {
      if (image.isConnected) image.style.removeProperty('transform');
    });
    setTimeout(() => {
      if (!image.isConnected) return;
      image.style.removeProperty('transition');
      image.style.removeProperty('opacity');
    }, 180);
  });
}

function availabilityState(hash) {
  let state = availability.get(hash);
  if (!state) availability.set(hash, state = { ready:false, terminal:false, nextCheck:0 });
  return state;
}

function queueAvailability(hash, delay = 0) {
  hash = String(hash || '');
  if (!hash || !mountedCards.has(hash)) return;
  const state = availabilityState(hash);
  if (state.ready || state.terminal) return;
  const at = performance.now() + delay;
  if (!state.nextCheck || at < state.nextCheck) state.nextCheck = at;
  scheduleAvailability(delay);
}

function scheduleAvailability(delay = 0) {
  const at = performance.now() + Math.max(0, delay);
  if (availabilityTimer && availabilityAt <= at) return;
  if (availabilityTimer) clearTimeout(availabilityTimer);
  availabilityAt = at;
  availabilityTimer = setTimeout(runAvailability, Math.max(0, delay));
}

function scheduleNextAvailability() {
  const now = performance.now();
  let next = Infinity;
  for (const [hash] of mountedCards) {
    const state = availability.get(hash);
    if (state?.ready || state?.terminal) continue;
    next = Math.min(next, state?.nextCheck || now);
  }
  if (Number.isFinite(next)) scheduleAvailability(Math.max(0, next - now));
}

function bindImage(card, image, hash, owned = false) {
  if (!(image instanceof HTMLImageElement) || image.dataset.mochimonoWarmBound === '1') return;
  image.dataset.mochimonoWarmBound = '1';
  const alreadyLoaded = image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;

  // This must happen before load. Starting an animation from opacity after load
  // is too late: the decoded pixels can flash for one frame first.
  if (!alreadyLoaded) {
    image.style.transition = 'none';
    image.style.opacity = '0';
  }

  const ready = animate => {
    if (!image.isConnected || image.dataset.thumbHash !== hash || !image.naturalWidth || !image.naturalHeight) return;
    card.querySelector('.video-thumb-pending')?.remove();
    rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
    const state = availabilityState(hash);
    state.ready = true;
    state.terminal = false;
    state.nextCheck = 0;
    revealImage(card, image, animate);
  };

  image.addEventListener('load', () => ready(true), { once:true });
  if (owned) image.addEventListener('error', () => {
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    image.remove();
    const state = availabilityState(hash);
    state.ready = false;
    state.nextCheck = performance.now() + 180;
    scheduleAvailability(180);
  }, { once:true });
  if (alreadyLoaded) ready(false);
}

function primeCard(card) {
  if (!card?.isConnected || !card.classList.contains('media-card')) return;
  const hash = String(card.dataset.hash || '');
  const box = card.querySelector('.media-thumb');
  if (!hash || !box) return;

  const current = box.querySelector('img.cached-thumb');
  if (current) {
    bindImage(card, current, hash, false);
    return;
  }

  const state = availabilityState(hash);
  if (!state.ready) return;

  const image = document.createElement('img');
  image.className = 'cached-thumb';
  image.alt = '';
  image.hidden = false;
  image.decoding = 'async';
  image.loading = 'eager';
  image.style.objectFit = 'cover';
  image.style.opacity = '0';
  image.style.transition = 'none';
  image.dataset.thumbHash = hash;
  try { image.fetchPriority = visibleCard(card) ? 'high' : 'auto'; } catch {}
  bindImage(card, image, hash, true);
  box.prepend(image);
  image.src = `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
  image.decode?.().catch(() => {});
}

function primeRow(row) {
  if (!(row instanceof Element) || !row.isConnected) return;
  for (const card of row.querySelectorAll('.media-card[data-hash]')) {
    const hash = String(card.dataset.hash || '');
    const current = card.querySelector('img.cached-thumb');
    if (current) bindImage(card, current, hash, false);
    if (availability.get(hash)?.ready) primeCard(card);
    else queueAvailability(hash, 0);
  }
}

function primeReadyHash(hash) {
  for (const card of mountedCards.get(hash) || []) {
    const row = card.closest('.stable-grid-row');
    if (row && nearRows.has(row)) primeCard(card);
  }
}

async function runAvailability() {
  availabilityTimer = 0;
  availabilityAt = 0;
  if (availabilityChecking || document.hidden) {
    scheduleAvailability(80);
    return;
  }

  const now = performance.now();
  const hashes = [];
  for (const [hash] of mountedCards) {
    const state = availabilityState(hash);
    if (state.ready || state.terminal || now < (state.nextCheck || 0)) continue;
    hashes.push(hash);
    if (hashes.length >= CHECK_LIMIT) break;
  }
  if (!hashes.length) {
    scheduleNextAvailability();
    return;
  }

  availabilityChecking = true;
  try {
    const response = await fetch('/api/thumbs/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ hashes, background:true })
    });
    if (!response.ok) throw new Error(`Thumbnail check failed (${response.status})`);
    const data = await response.json();
    const ready = new Map((data.thumbnails || []).map(item => [String(item.hash), item]));
    const failures = new Map((data.failures || []).map(item => [String(item.hash), item]));
    const serverMissing = new Set((data.missing || []).map(item => String(item.hash)));
    const request = [];
    const checkedAt = performance.now();

    for (const hash of hashes) {
      if (!mountedCards.has(hash)) {
        availability.delete(hash);
        continue;
      }
      const state = availabilityState(hash);
      const item = ready.get(hash);
      const failure = failures.get(hash);
      if (item) {
        state.ready = true;
        state.terminal = false;
        state.nextCheck = 0;
        rememberDimensions(hash, item.width, item.height);
        primeReadyHash(hash);
      } else if (failure) {
        state.ready = false;
        state.terminal = failure.terminal === true;
        state.nextCheck = state.terminal ? Infinity : checkedAt + Math.max(RECHECK_DELAY, Number(failure.retryAfterMs) || RECHECK_DELAY);
      } else {
        state.ready = false;
        state.terminal = false;
        state.nextCheck = checkedAt + RECHECK_DELAY;
        if (serverMissing.has(hash)) request.push(hash);
      }
    }

    // Desktop /api/thumbs/check queues local provider generation itself. A
    // direct server instead reports `missing`, so ask its agent to prioritize
    // those mounted overscan hashes before they can become visible.
    if (request.length) {
      fetch('/api/thumbs/request', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ hashes:request })
      }).catch(() => {});
    }
  } catch {
    const retry = performance.now() + 900;
    for (const hash of hashes) {
      if (!mountedCards.has(hash)) continue;
      const state = availabilityState(hash);
      state.nextCheck = retry;
    }
  } finally {
    availabilityChecking = false;
    scheduleNextAvailability();
  }
}

const rowObserver = files && typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const row = entry.target;
        if (entry.isIntersecting) {
          nearRows.add(row);
          primeRow(row);
        } else nearRows.delete(row);
      }
    }, { rootMargin:`${IMAGE_PRELOAD_MARGIN}px 0px` })
  : null;

function rowsIn(node) {
  if (!(node instanceof Element)) return [];
  const rows = [];
  if (node.matches('.stable-grid-row')) rows.push(node);
  rows.push(...(node.querySelectorAll?.('.stable-grid-row') || []));
  return rows;
}

function registerCard(card) {
  if (!card?.classList?.contains('media-card')) return;
  const hash = String(card.dataset.hash || '');
  if (!hash) return;
  let cards = mountedCards.get(hash);
  if (!cards) mountedCards.set(hash, cards = new Set());
  cards.add(card);
  queueAvailability(hash, 0);
}

function unregisterCard(card) {
  const hash = String(card?.dataset?.hash || '');
  const cards = hash && mountedCards.get(hash);
  if (!cards) return;
  cards.delete(card);
  if (!cards.size) {
    mountedCards.delete(hash);
    availability.delete(hash);
  }
}

function registerRow(row) {
  if (!(row instanceof Element) || registeredRows.has(row)) return;
  registeredRows.add(row);
  for (const card of row.querySelectorAll('.media-card[data-hash]')) registerCard(card);
  if (rowObserver) rowObserver.observe(row);
  else {
    nearRows.add(row);
    primeRow(row);
  }
}

function unregisterRow(row) {
  if (!(row instanceof Element)) return;
  registeredRows.delete(row);
  rowObserver?.unobserve(row);
  nearRows.delete(row);
  for (const card of row.querySelectorAll('.media-card[data-hash]')) unregisterCard(card);
}

function registerTree(node) {
  for (const row of rowsIn(node)) registerRow(row);
}

function unregisterTree(node) {
  for (const row of rowsIn(node)) unregisterRow(row);
}

const stable = window.mochimonoStableGrid;
if (stable?.setModel && stable.__mochimonoRatioSync !== true) {
  const originalSetModel = stable.setModel.bind(stable);
  stable.setModel = snapshot => {
    applyKnownDimensions(snapshot);
    return originalSetModel(snapshot);
  };
  stable.__mochimonoRatioSync = true;
}

if (files) {
  registerTree(files);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.removedNodes) unregisterTree(node);
    for (const record of records) for (const node of record.addedNodes) registerTree(node);
  }).observe(files, { childList:true, subtree:true });

  window.addEventListener('scroll', () => {
    lastScrollAt = performance.now();
    if (restoreAnchor) restoreAnchor = captureAnchor() || restoreAnchor;
    if (geometryDirty) scheduleGeometry(460);
  }, { passive:true });

  window.addEventListener('mochimono:grid-interaction-end', () => {
    if (geometryDirty) scheduleGeometry(220);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleAvailability(0);
  });

  window.addEventListener('mochimono:stable-grid-installed', () => {
    registerTree(files);
    scheduleAvailability(0);
    const anchor = restoreAnchor;
    restoreAnchor = null;
    if (!anchor?.hash) return;
    const snapshot = window.mochimonoGridModel;
    const index = modelIndex(snapshot)?.get(anchor.hash);
    if (!Number.isInteger(index)) return;
    requestAnimationFrame(() => {
      window.mochimonoStableGrid?.ensureIndex?.(index);
      const card = files.querySelector(`[data-hash="${CSS.escape(anchor.hash)}"]`);
      if (!card) return;
      const delta = card.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > .5) scrollBy(0, delta);
    });
  });

  addEventListener('beforeunload', () => {
    if (geometryTimer) clearTimeout(geometryTimer);
    if (availabilityTimer) clearTimeout(availabilityTimer);
  }, { once:true });
}
