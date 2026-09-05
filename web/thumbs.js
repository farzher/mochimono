const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const CLIENT = document.documentElement.classList.contains('client-library');
const THUMB_VERSION = 3;
const CHECK_LIMIT = 320;
const RECHECK_DELAY = CLIENT ? 140 : 500;
const PRELOAD_MARGIN = Math.max(1600, Math.round(window.innerHeight * 4.75));
const IMAGE_POOL_MAX = 1200;

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
  return nearby.has(card) || prioritized.has(card) || visible(card);
}

function stateFor(hash) {
  let state = states.get(hash);
  if (!state) {
    state = { ready:false, failed:false, terminal:false, nextTry:0, nextCheck:0 };
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
  if (card.classList.contains('media-card')) card.style.setProperty('--ratio', String(width / height));
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
  try { window.mochimonoStableGrid?.updateDimensions?.(hash, width, height); } catch {}
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
  if (!image?.complete || !image.naturalWidth || image.dataset.thumbDecoded !== '1') return;
  image.onload = null;
  image.onerror = null;
  image.style.removeProperty('transition');
  image.style.removeProperty('transform');
  image.style.opacity = '1';
  image.remove();
  touchPool(hash, image);
}

function adoptPooledImage(card, hash, box) {
  const image = imagePool.get(hash);
  if (!image?.complete || !image.naturalWidth) {
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
  state.failed = false;
  state.terminal = false;
  state.nextCheck = 0;
  state.nextTry = 0;
  rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
  return true;
}

async function revealLoadedImage(hash, card, image, animate = true) {
  if (!image.isConnected || image.dataset.thumbHash !== hash || !image.naturalWidth || !image.naturalHeight) return;

  try { await image.decode?.(); } catch {}
  if (!image.isConnected || image.dataset.thumbHash !== hash) return;

  image.dataset.thumbDecoded = '1';
  image.hidden = false;
  image.style.objectFit = 'cover';
  rememberDimensions(hash, image.naturalWidth, image.naturalHeight);

  const box = mediaBox(card);
  box?.classList.remove('thumb-failed');
  box?.removeAttribute('title');
  box?.querySelector('.video-thumb-pending')?.remove();

  const state = stateFor(hash);
  state.ready = true;
  state.failed = false;
  state.terminal = false;
  state.nextCheck = 0;
  state.nextTry = 0;

  if (!animate || !visible(card) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    image.style.removeProperty('transition');
    image.style.opacity = '1';
    return;
  }

  image.style.transition = 'opacity 150ms ease-out';
  requestAnimationFrame(() => {
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    image.style.opacity = '1';
    image.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => {
      if (image.isConnected) image.style.removeProperty('transform');
    });
    setTimeout(() => {
      if (!image.isConnected) return;
      image.style.removeProperty('transition');
      image.style.removeProperty('opacity');
    }, 190);
  });
}

function paintCard(card, urgent = false) {
  if (!card?.isConnected || !kind(card)) return;
  const hash = String(card.dataset.hash || '');
  const box = hash && mediaBox(card);
  if (!hash || !box) return;

  const current = box.querySelector('img.cached-thumb');
  if (current?.dataset.thumbHash === hash) {
    if (current.complete && current.naturalWidth) {
      if (current.dataset.thumbDecoded === '1') {
        current.style.opacity = '1';
        current.style.objectFit = 'cover';
        const state = stateFor(hash);
        state.ready = true;
        rememberDimensions(hash, current.naturalWidth, current.naturalHeight);
      } else {
        revealLoadedImage(hash, card, current, false);
      }
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
  if (state.terminal || now < (state.nextTry || 0)) {
    pending(card);
    return;
  }

  // Never probe a thumbnail URL that the status endpoint has not declared ready.
  // That old 404/retry path was one source of late wall-of-images flashes.
  if (!state.ready) {
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

  image.onload = () => {
    if (image.isConnected && image.dataset.thumbHash === hash) revealLoadedImage(hash, card, image, true);
  };
  image.onerror = () => {
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    image.remove();
    const failed = stateFor(hash);
    failed.ready = false;
    failed.nextTry = performance.now() + 350;
    failed.nextCheck = Math.min(failed.nextCheck || Infinity, performance.now() + 80);
    pending(card);
    scheduleCheck(80);
  };

  box.prepend(image);
  image.src = thumbUrl(hash);
}

function loadHash(hash) {
  for (const card of cardsByHash.get(String(hash || '')) || []) {
    if (nearby.has(card) || prioritized.has(card) || visible(card)) paintCard(card, prioritized.has(card) || visible(card));
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
  for (const card of prioritized) if (card?.isConnected) result.add(card);
  for (const card of nearby) if (card?.isConnected) result.add(card);

  // Stable-grid has already paid to mount these rows. Start availability/generation
  // for all of them, including while PageUp/PageDown is active, without allocating
  // image nodes until the card enters the preload margin.
  if (viewer?.hidden !== false) {
    for (const card of mountedGridCards) if (card?.isConnected) result.add(card);
  }
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
    if (state.ready || state.terminal) continue;
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
      state.failed = false;
      state.terminal = false;
      state.nextCheck = 0;
      state.nextTry = 0;
      setFailedVisual(hash, false);
      rememberDimensions(hash, item.width, item.height);
      loadHash(hash);
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
    if (state.ready || state.terminal || now < (state.nextCheck || 0)) continue;
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
    for (const item of candidates) {
      const state = stateFor(item.hash);
      state.nextCheck = retry;
      settleHashWaiters(item.hash);
    }
  } finally {
    checking = false;
    scheduleOutstanding();
  }
}

const observer = files ? new IntersectionObserver(entries => {
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
}, { rootMargin:`${PRELOAD_MARGIN}px 0px` }) : null;

function prepare(node) {
  if (!observer) return;
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
        rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
      } else revealLoadedImage(hash, card, image, false);
    }
    observer.observe(card);
  }
  scheduleCheck(0);
}

function release(node) {
  if (!observer) return;
  for (const card of cardsIn(node)) {
    if (!preparedCards.has(card)) continue;
    stashImage(card);
    observer.unobserve(card);
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
  const unique = [...new Set((Array.isArray(hashes) ? hashes : [hashes])
    .map(String)
    .filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
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
  clearPriority() {
    prioritized.clear();
  },
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
    for (const record of records) for (const node of record.removedNodes) if (node instanceof Element) release(node);
    for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) prepare(node);
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
