const files = document.querySelector('#files');
const CLIENT = document.documentElement.classList.contains('client-library');
const THUMB_VERSION = 3;
const CHECK_LIMIT = 320;
const RECHECK_DELAY = CLIENT ? 120 : 500;
const PRELOAD_MARGIN = 360;

const states = new Map();
const cardsByHash = new Map();
const observed = new Set();
const nearby = new Set();
const pendingTrees = new Set();
const browserFallback = CLIENT ? null : import('./browser-thumbnail-fallback.js').catch(() => null);
let observeFrame = 0;
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

function indexCard(card) {
  const hash = String(card?.dataset?.hash || '');
  if (!hash) return;
  let group = cardsByHash.get(hash);
  if (!group) cardsByHash.set(hash, group = new Set());
  group.add(card);
}

function unindexCard(card) {
  const hash = String(card?.dataset?.hash || '');
  const group = hash && cardsByHash.get(hash);
  if (!group) return;
  group.delete(card);
  if (!group.size) {
    cardsByHash.delete(hash);
    states.delete(hash);
  }
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
      box.title = terminal ? 'Preview unavailable' : 'Preview generation failed; retrying later';
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
  const state = states.get(hash) || {};
  state.ready = false;
  state.failed = true;
  state.terminal = terminal;
  state.nextTry = retryAt;
  state.nextCheck = retryAt;
  states.set(hash, state);
  setFailedVisual(hash, true, terminal);
}

function resetFailures() {
  for (const [hash, state] of states) {
    if (!state.failed) continue;
    state.failed = false;
    state.terminal = false;
    state.nextCheck = 0;
    state.nextTry = 0;
    states.set(hash, state);
    setFailedVisual(hash, false);
  }
}

function rememberDimensions(hash, width, height) {
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!width || !height) return;
  window.mochimonoCatalogCache?.rememberDimensions?.(hash, width, height).catch(() => {});
}

function markLoaded(hash, card, image) {
  const state = states.get(hash) || {};
  state.ready = true;
  state.failed = false;
  state.terminal = false;
  state.nextCheck = 0;
  state.nextTry = 0;
  states.set(hash, state);
  const box = mediaBox(card);
  box?.classList.remove('thumb-failed');
  box?.removeAttribute('title');
  box?.querySelector('.video-thumb-pending')?.remove();
  image.hidden = false;
  rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
}

function paintCard(card, urgent = false) {
  if (!card?.isConnected || !kind(card)) return;
  const hash = String(card.dataset.hash || '');
  const box = hash && mediaBox(card);
  if (!hash || !box) return;

  const current = box.querySelector('img.cached-thumb');
  if (current?.dataset.thumbHash === hash) {
    if (current.complete && current.naturalWidth) markLoaded(hash, card, current);
    return;
  }

  const state = states.get(hash) || {};
  const now = performance.now();
  if (state.failed && now >= (state.nextTry || 0)) {
    state.failed = false;
    state.terminal = false;
    states.set(hash, state);
    setFailedVisual(hash, false);
  }
  if (now < (state.nextTry || 0)) {
    pending(card);
    return;
  }

  pending(card);
  const image = document.createElement('img');
  image.className = 'cached-thumb';
  image.alt = '';
  image.hidden = true;
  image.decoding = 'async';
  image.loading = 'eager';
  image.dataset.thumbHash = hash;
  try { image.fetchPriority = urgent || card.classList.contains('keyboard-cursor') ? 'high' : 'low'; } catch {}
  image.onload = () => {
    if (image.isConnected && image.dataset.thumbHash === hash) markLoaded(hash, card, image);
  };
  image.onerror = () => {
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    image.remove();
    const failed = states.get(hash) || {};
    failed.ready = false;
    failed.nextTry = performance.now() + 500;
    failed.nextCheck = Math.min(failed.nextCheck || Infinity, performance.now() + 80);
    states.set(hash, failed);
    pending(card);
    if (nearby.has(card)) scheduleCheck(80);
  };
  box.prepend(image);
  image.src = thumbUrl(hash);
}

function loadHash(hash) {
  for (const card of cardsByHash.get(String(hash || '')) || []) paintCard(card);
}

function scheduleCheck(delay = 80) {
  const at = performance.now() + delay;
  if (checkTimer && checkAt <= at) return;
  if (checkTimer) clearTimeout(checkTimer);
  checkAt = at;
  checkTimer = setTimeout(checkNearby, delay);
}

function scheduleOutstanding() {
  const now = performance.now();
  let next = Infinity;
  for (const card of nearby) {
    if (!kind(card)) continue;
    const state = states.get(card.dataset.hash || '');
    if (state?.ready) continue;
    const at = state?.nextCheck || now + RECHECK_DELAY;
    if (at < next) next = at;
  }
  if (Number.isFinite(next)) scheduleCheck(Math.max(0, next - now));
}

function refreshVisible() {
  for (const card of nearby) paintCard(card, true);
  scheduleCheck(0);
}

async function requestMissing(hashes) {
  if (!hashes.length) return;
  if (!CLIENT) {
    fetch('/api/thumbs/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes })
    }).catch(() => {});

    const fallback = await browserFallback;
    for (const hash of hashes) {
      const card = [...(cardsByHash.get(hash) || [])].find(item => item.isConnected && nearby.has(item));
      if (card) fallback?.queueBrowserThumbnail?.({ hash, filename: filename(card), kind: kind(card) });
    }
  }
}

async function checkNearby() {
  checkTimer = 0;
  checkAt = 0;
  if (checking || document.hidden || !nearby.size) return;

  const now = performance.now();
  const cursor = files.querySelector('.keyboard-cursor[data-hash]');
  const hashes = [];
  const seen = new Set();
  const add = hash => {
    const state = states.get(hash) || {};
    if (!hash || seen.has(hash) || state.ready || now < (state.nextCheck || 0) || hashes.length >= CHECK_LIMIT) return;
    seen.add(hash);
    hashes.push(hash);
  };
  if (cursor && nearby.has(cursor)) add(cursor.dataset.hash || '');

  for (const card of nearby) {
    if (card === cursor || !kind(card)) continue;
    add(card.dataset.hash || '');
    if (hashes.length >= CHECK_LIMIT) break;
  }
  if (!hashes.length) return;

  checking = true;
  try {
    const response = await fetch('/api/thumbs/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes })
    });
    if (!response.ok) throw new Error(`Thumbnail check failed (${response.status})`);
    const data = await response.json();
    const ready = new Map((data.thumbnails || []).map(item => [String(item.hash), item]));
    const failures = new Map((data.failures || []).map(item => [String(item.hash), item]));
    const missing = [];

    for (const hash of hashes) {
      if (!cardsByHash.has(hash)) {
        states.delete(hash);
        continue;
      }
      const state = states.get(hash) || {};
      const item = ready.get(hash);
      const failure = failures.get(hash);
      if (item) {
        state.ready = true;
        state.failed = false;
        state.terminal = false;
        state.nextCheck = 0;
        state.nextTry = 0;
        states.set(hash, state);
        setFailedVisual(hash, false);
        rememberDimensions(hash, item.width, item.height);
        loadHash(hash);
      } else if (failure) {
        markFailed(hash, failure);
      } else {
        state.ready = false;
        state.failed = false;
        state.terminal = false;
        state.nextCheck = performance.now() + RECHECK_DELAY;
        states.set(hash, state);
        setFailedVisual(hash, false);
        missing.push(hash);
      }
    }
    requestMissing(missing);
  } catch {
    const retry = performance.now() + 1200;
    for (const hash of hashes) {
      if (!cardsByHash.has(hash)) {
        states.delete(hash);
        continue;
      }
      const state = states.get(hash) || {};
      state.nextCheck = retry;
      states.set(hash, state);
    }
  } finally {
    checking = false;
    scheduleOutstanding();
  }
}

function nearViewport(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom > -PRELOAD_MARGIN && rect.top < innerHeight + PRELOAD_MARGIN;
}

const observer = files ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    const card = entry.target;
    if (!entry.isIntersecting) {
      nearby.delete(card);
      continue;
    }
    nearby.add(card);
    paintCard(card, true);
  }
  scheduleCheck(40);
}, { rootMargin: `${PRELOAD_MARGIN}px 0px` }) : null;

function observeTree(node) {
  if (!observer) return;
  let prepainted = false;
  for (const card of cardsIn(node)) {
    indexCard(card);
    if (observed.has(card) || !kind(card)) continue;
    observed.add(card);
    observer.observe(card);
    if (nearViewport(card)) {
      nearby.add(card);
      paintCard(card, true);
      prepainted = true;
    }
  }
  if (prepainted) scheduleCheck(0);
}

function queueObserveTree(node) {
  if (!(node instanceof Element)) return;
  pendingTrees.add(node);
  if (observeFrame) return;
  observeFrame = requestAnimationFrame(() => {
    observeFrame = 0;
    for (const tree of pendingTrees) if (tree.isConnected) observeTree(tree);
    pendingTrees.clear();
  });
}

function forgetTree(node) {
  if (!observer) return;
  for (const card of cardsIn(node)) {
    unindexCard(card);
    if (!observed.delete(card)) continue;
    nearby.delete(card);
    observer.unobserve(card);
  }
}

function reusableImages(records) {
  const images = new Map();
  for (const record of records) {
    for (const node of record.removedNodes) {
      for (const card of cardsIn(node)) {
        const image = card.querySelector('img.cached-thumb:not([hidden])');
        if (image?.complete && image.naturalWidth) images.set(String(card.dataset.hash || ''), image);
      }
    }
  }
  return images;
}

function reuseImages(node, images) {
  for (const card of cardsIn(node)) {
    const image = images.get(String(card.dataset.hash || ''));
    const box = image && mediaBox(card);
    if (!box || box.querySelector('img.cached-thumb')) continue;
    box.querySelector('.video-thumb-pending')?.remove();
    box.prepend(image);
  }
}

window.mochimonoThumbnails = {
  prioritize(cards) {
    for (const card of Array.isArray(cards) ? cards : [cards]) {
      if (!card?.isConnected || !kind(card)) continue;
      indexCard(card);
      paintCard(card, true);
    }
    scheduleCheck(30);
  }
};

if (files) {
  observeTree(files);
  new MutationObserver(records => {
    const reusable = reusableImages(records);
    for (const record of records) for (const node of record.removedNodes) forgetTree(node);
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        reuseImages(node, reusable);
        queueObserveTree(node);
      }
    }
  }).observe(files, { childList: true, subtree: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshVisible();
  });
  window.addEventListener('mochimono:catalog-updated', () => {
    resetFailures();
    refreshVisible();
  });
  window.addEventListener('mochimono:browser-thumbnail-ready', event => {
    const hash = String(event.detail?.hash || '');
    if (!hash) return;
    const state = states.get(hash) || {};
    state.ready = false;
    state.failed = false;
    state.terminal = false;
    state.nextCheck = 0;
    state.nextTry = 0;
    states.set(hash, state);
    setFailedVisual(hash, false);
    loadHash(hash);
    scheduleCheck(50);
  });
  addEventListener('beforeunload', () => {
    if (checkTimer) clearTimeout(checkTimer);
    if (observeFrame) cancelAnimationFrame(observeFrame);
  }, { once: true });
}
