const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const CLIENT = document.documentElement.classList.contains('client-library');
const THUMB_VERSION = 3;
const CHECK_LIMIT = 500;
const RECHECK_DELAY = CLIENT ? 140 : 500;
const PRELOAD_MARGIN = Math.max(900, Math.round(window.innerHeight * 2.25));
const IMAGE_POOL_MAX = 512;

const states = new Map();
const cardsByHash = new Map();
const dimensions = new Map();
const nearby = new Set();
const prioritized = new Set();
const mountedGridCards = new Set();
const preparedCards = new WeakSet();
const imagePool = new Map();
const externalQueue = new Map();
const waitersByHash = new Map();
const browserFallback = CLIENT ? null : import('./browser-thumbnail-fallback.js').catch(() => null);

let checkTimer = 0;
let checkAt = 0;
let checking = false;

const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);

const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const filename = card => card.dataset.filename || card.title || card.querySelector('strong')?.textContent || '';
const thumbUrl = hash => `/api/thumbs/${hash}?v=${THUMB_VERSION}`;

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

function visible(card) {
  if (!card?.isConnected) return false;
  const rect = card.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
}

function activeCard(card) {
  return mountedGridCards.has(card) || nearby.has(card) || prioritized.has(card) || visible(card);
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
  if (card.closest('.stable-grid-row')) mountedGridCards.add(card);
  const known = dimensions.get(hash);
  if (known) applyDimensions(card, known.width, known.height);
}

function unindexCard(card) {
  prioritized.delete(card);
  nearby.delete(card);
  mountedGridCards.delete(card);
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
  while (imagePool.size > IMAGE_POOL_MAX) {
    const oldest = imagePool.keys().next().value;
    imagePool.delete(oldest);
  }
}

function stashImage(card) {
  const hash = String(card?.dataset?.hash || '');
  if (!hash) return;
  const image = card.querySelector('img.cached-thumb');
  if (!image) return;

  image.onload = null;
  image.onerror = null;
  image.style.removeProperty('transition');
  image.style.removeProperty('transform');

  if (image.complete && image.naturalWidth && image.dataset.thumbDecoded === '1') {
    image.style.opacity = '1';
    image.remove();
    touchPool(hash, image);
    return;
  }

  // A virtual row can disappear while its thumbnail is still fetching/decoding.
  // Cancel that detached node and clear the per-hash loading latch so a later
  // remount can immediately reuse cache bytes or start a fresh request.
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
  image.style.removeProperty('transition');
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

  image.dataset.thumbDecoded = '1';
  image.hidden = false;
  image.style.objectFit = 'cover';
  image.style.removeProperty('transition');
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

  // Decode has completed. Force one paint invalidation, but do not add a fade or
  // any artificial delay before the pixels become visible.
  image.style.transform = 'translateZ(0)';
  requestAnimationFrame(() => {
    if (image.isConnected) image.style.removeProperty('transform');
  });
}

function paintCard(card, urgent = false) {
  if (!card?.isConnected || !kind(card)) return;
  const hash = String(card.dataset.hash || '');
  const box = hash && mediaBox(card);
  if (!hash || !box) return;

  const current = box.querySelector('img.cached-thumb');
  if (current?.dataset.thumbHash === hash) {
    if (urgent && !current.complete) {
      current.loading = 'eager';
      try { current.fetchPriority = 'high'; } catch {}
    }
    if (current.complete && current.naturalWidth) {
      if (current.dataset.thumbDecoded === '1') {
        current.style.opacity = '1';
        current.style.objectFit = 'cover';
        const state = stateFor(hash);
        state.ready = true;
        state.loading = false;
        rememberDimensions(hash, current.naturalWidth, current.naturalHeight);
        settleHashWaiters(hash);
      } else revealLoadedImage(hash, card, current);
    }
    return;
  }

  if (adoptPooledImage(card, hash, box)) return;

  const state = stateFor(hash);
  const now = performance.now();
  if (state.failed && now >= (state.nextTry || 0)) {
    state.failed = false;
    state.terminal = false;
    setFailedVisual(hash, false);
  }
  if (state.terminal || now < (state.nextTry || 0) || state.loading) {
    pending(card);
    return;
  }

  const mountedGrid = mountedGridCards.has(card);
  if (!mountedGrid && !state.ready) {
    pending(card);
    state.nextCheck = Math.min(state.nextCheck || Infinity, now);
    scheduleCheck(0);
    return;
  }

  pending(card);
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
  try { image.fetchPriority = urgent || visible(card) || card.classList.contains('keyboard-cursor') ? 'high' : 'auto'; } catch {}

  state.loading = true;
  image.onload = () => {
    if (image.isConnected && image.dataset.thumbHash === hash) revealLoadedImage(hash, card, image);
  };
  image.onerror = () => {
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
  image.decode?.().then(() => {
    if (image.isConnected && image.dataset.thumbHash === hash) revealLoadedImage(hash, card, image);
  }).catch(() => {});
}

function loadHash(hash) {
  for (const card of cardsByHash.get(String(hash || '')) || []) {
    if (mountedGridCards.has(card) || nearby.has(card) || prioritized.has(card) || visible(card)) {
      paintCard(card, prioritized.has(card) || visible(card));
    }
  }
}

function scheduleCheck(delay = 50) {
  const at = performance.now() + Math.max(0, delay);
  if (checkTimer && checkAt <= at) return;
  if (checkTimer) clearTimeout(checkTimer);
  checkAt = at;
  checkTimer = setTimeout(runChecks, Math.max(0, delay));
}

function cardCheckSet() {
  const result = new Set();
  if (viewer?.hidden === false) return result;
  for (const card of prioritized) if (card?.isConnected) result.add(card);
  for (const card of nearby) if (card?.isConnected) result.add(card);
  for (const card of mountedGridCards) if (card?.isConnected) result.add(card);
  return result;
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

async function requestMissing(hashes) {
  if (!hashes.length || CLIENT) return;
  fetch('/api/thumbs/request', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ hashes })
  }).catch(() => {});

  const fallback = await browserFallback;
  for (const hash of hashes) {
    const card = [...(cardsByHash.get(hash) || [])].find(item => item.isConnected && activeCard(item));
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
      state.loading = false;
      state.failed = false;
      state.terminal = false;
      state.nextCheck = 0;
      state.nextTry = 0;
      setFailedVisual(hash, false);
      rememberDimensions(hash, item.width, item.height);
      loadHash(hash);
    } else if (state.ready) {
      // A direct thumbnail GET completed while this status request was in flight.
    } else if (state.loading) {
      // Do not let a stale/missing status response cancel an in-flight direct GET.
      state.nextCheck = now + RECHECK_DELAY;
    } else if (failure) {
      markFailed(hash, failure);
    } else {
      state.ready = false;
      state.loading = false;
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
    const urgent = prioritized.has(card) || visible(card);
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

const observer = files && typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const card = entry.target;
        if (!entry.isIntersecting) {
          nearby.delete(card);
          continue;
        }
        nearby.add(card);
        paintCard(card, visible(card));
      }
      scheduleCheck(0);
    }, { rootMargin:`${PRELOAD_MARGIN}px 0px` })
  : null;

function prepare(node) {
  for (const card of cardsIn(node)) {
    if (preparedCards.has(card)) continue;
    preparedCards.add(card);
    indexCard(card);
    if (!kind(card)) continue;

    const box = mediaBox(card);
    const hash = String(card.dataset.hash || '');
    if (box && !box.querySelector('img.cached-thumb')) adoptPooledImage(card, hash, box);

    const image = card.querySelector('img.cached-thumb');
    if (image?.complete && image.naturalWidth) {
      if (image.dataset.thumbDecoded === '1') {
        const state = stateFor(hash);
        state.ready = true;
        state.loading = false;
        rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
      } else revealLoadedImage(hash, card, image);
    }

    // Stable-grid has already decided this row is worth keeping in overscan.
    // That row mount itself is the preload boundary; there is no second IO gate.
    if (mountedGridCards.has(card)) paintCard(card, false);
    else observer?.observe(card);
  }
  scheduleCheck(0);
}

function release(node) {
  for (const card of cardsIn(node)) {
    if (!preparedCards.has(card)) continue;
    stashImage(card);
    observer?.unobserve(card);
    unindexCard(card);
    preparedCards.delete(card);
  }
}

function refreshVisible() {
  for (const card of cardCheckSet()) if (visible(card)) paintCard(card, true);
  scheduleCheck(0);
}

function repairViewport() {
  if (!files || document.hidden) return;
  for (const card of files.querySelectorAll('[data-hash]')) {
    if (!kind(card) || !visible(card)) continue;
    if (!preparedCards.has(card)) prepare(card);
    nearby.add(card);
    paintCard(card, true);
  }
  scheduleCheck(0);
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
      if (!preparedCards.has(card)) prepare(card);
      prioritized.add(card);
      paintCard(card, true);
    }
    scheduleCheck(0);
  },
  clearPriority() { prioritized.clear(); },
  state() {
    return {
      cards:[...cardsByHash.values()].reduce((sum, group) => sum + group.size, 0),
      nearby:nearby.size,
      mountedGrid:mountedGridCards.size,
      pooled:imagePool.size,
      states:states.size,
      external:externalQueue.size,
      checking
    };
  }
};

if (files) {
  prepare(files);
  requestAnimationFrame(repairViewport);

  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) if (node instanceof Element) release(node);
      for (const node of record.addedNodes) if (node instanceof Element) prepare(node);
    }
  }).observe(files, { childList:true, subtree:true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshVisible();
      requestAnimationFrame(repairViewport);
    }
  });

  window.addEventListener('mochimono:grid-interaction-end', () => {
    repairViewport();
    scheduleOutstanding();
  });

  window.addEventListener('mochimono:catalog-updated', () => {
    resetFailures();
    refreshVisible();
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

  addEventListener('beforeunload', () => {
    if (checkTimer) clearTimeout(checkTimer);
  }, { once:true });
}
