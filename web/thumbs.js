const files = document.querySelector('#files');
const CLIENT = document.documentElement.classList.contains('client-library');
const THUMB_VERSION = 3;
const CACHE_NAME = `mochimono-thumbnails-v${THUMB_VERSION}`;
const THUMB_EDGE = 768;
const IMAGE_FALLBACK_DELAY = 8_000;
const VIDEO_FALLBACK_DELAY = 15_000;
const MAX_OBJECT_URLS = 240;

const states = new Map();
const cardIndex = new Map();
const observed = new Set();
const nearby = new Set();
const objectUrls = new Map();
const fallbackQueue = [];
const fallbackQueued = new Set();
let cachePromise = null;
let checkTimer = 0;
let checking = false;
let fallbackActive = false;
let geometryTimer = 0;

const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
const MIME = new Map([
  ['jpg','image/jpeg'],['jpeg','image/jpeg'],['png','image/png'],['gif','image/gif'],['webp','image/webp'],
  ['heic','image/heic'],['heif','image/heic'],['avif','image/avif'],['bmp','image/bmp'],['tif','image/tiff'],['tiff','image/tiff'],
  ['mp4','video/mp4'],['m4v','video/mp4'],['mov','video/quicktime'],['mkv','video/x-matroska'],['webm','video/webm'],
  ['avi','video/x-msvideo'],['mpg','video/mpeg'],['mpeg','video/mpeg'],['m2v','video/mpeg'],['mts','video/mp2t'],['m2ts','video/mp2t'],['3gp','video/3gpp']
]);

const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const filename = card => card.dataset.filename || card.title || card.querySelector('strong')?.textContent || '';
const thumbUrl = hash => `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
const sourceMime = record => MIME.get(extension(record.filename)) || 'application/octet-stream';

function kind(card) {
  if (card.classList.contains('video-card')) return 'video';
  if (card.classList.contains('media-card')) return 'image';
  const ext = extension(filename(card));
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return '';
}

function recordFor(card) {
  const mediaKind = kind(card);
  return { hash: String(card.dataset.hash || ''), filename: filename(card), kind: mediaKind, mime: sourceMime({ filename: filename(card) }) };
}

function cacheStorage() {
  if (!('caches' in window)) return Promise.resolve(null);
  if (!cachePromise) cachePromise = caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

function rememberObjectUrl(hash, blob) {
  const previous = objectUrls.get(hash);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(blob);
  objectUrls.delete(hash);
  objectUrls.set(hash, url);
  while (objectUrls.size > MAX_OBJECT_URLS) {
    const [oldHash, oldUrl] = objectUrls.entries().next().value;
    objectUrls.delete(oldHash);
    URL.revokeObjectURL(oldUrl);
    const state = states.get(oldHash);
    if (state?.url === oldUrl) state.url = '';
  }
  return url;
}

function indexCard(card) {
  const hash = String(card?.dataset?.hash || '');
  if (!hash) return;
  let group = cardIndex.get(hash);
  if (!group) cardIndex.set(hash, group = new Set());
  group.add(card);
}

function unindexCard(card) {
  const hash = String(card?.dataset?.hash || '');
  const group = hash && cardIndex.get(hash);
  if (!group) return;
  group.delete(card);
  if (!group.size) cardIndex.delete(hash);
}

function cardsFor(hash) {
  return cardIndex.get(String(hash || '')) || [];
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
  if (!box || box.querySelector('.cached-thumb,.video-thumb-pending')) return;
  const item = document.createElement('span');
  item.className = 'video-thumb-pending';
  item.dataset.videoThumb = card.dataset.hash || '';
  box.prepend(item);
}

function persistDimensions(hash, width, height) {
  window.mochimonoCatalogCache?.rememberDimensions?.(hash, width, height).catch(() => {});
}

function rememberDimensions(hash, width, height) {
  if (!width || !height) return;
  const state = states.get(hash) || {};
  state.width = Number(width) || state.width || 0;
  state.height = Number(height) || state.height || 0;
  states.set(hash, state);

  // Thumbnail decoding is paint, not layout. Learn missing geometry for the next
  // render, but never resize a card that is already on screen.
  persistDimensions(hash, state.width, state.height);
}

function persistLearnedDimensions() {
  clearTimeout(geometryTimer);
  geometryTimer = setTimeout(() => {
    for (const [hash, state] of states) {
      if (state.width && state.height) persistDimensions(hash, state.width, state.height);
    }
  }, 800);
}

function paint(hash) {
  const state = states.get(hash);
  if (!state?.ready || !state.url) return;
  for (const card of cardsFor(hash)) {
    if (!card.isConnected || !kind(card)) continue;
    const box = mediaBox(card);
    if (!box) continue;
    const current = box.querySelector('img.cached-thumb');
    if (current?.dataset.objectUrl === state.url) continue;

    const image = document.createElement('img');
    image.className = 'cached-thumb';
    image.alt = filename(card);
    image.decoding = 'async';
    image.loading = 'eager';
    image.dataset.objectUrl = state.url;
    image.onload = () => {
      box.classList.remove('thumb-failed');
      box.removeAttribute('title');
      rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
    };
    image.onerror = () => {
      if (image.dataset.objectUrl !== state.url) return;
      image.remove();
      state.ready = false;
      state.url = '';
      state.nextCheck = performance.now();
      states.set(hash, state);
      pending(card);
      scheduleCheck(50);
    };
    const old = box.querySelector('img,.video-thumb-pending');
    old ? old.replaceWith(image) : box.prepend(image);
    image.src = state.url;
  }
}

async function responseFor(hash) {
  const canonical = thumbUrl(hash);
  const cache = await cacheStorage();
  const cached = await cache?.match(canonical);
  if (cached?.ok) return cached;

  // Preserve anything the previous viewer already put in the browser's immutable
  // HTTP cache. The first visit after this rewrite promotes that response into
  // Mochimono's explicit Cache Storage without downloading it again.
  const response = await fetch(canonical, { cache: 'force-cache' });
  if (!response.ok) return response;
  cache?.put(canonical, response.clone()).catch(() => {});
  return response;
}

async function loadHash(hash) {
  hash = String(hash || '');
  if (!hash) return;
  const state = states.get(hash) || {};
  if (state.ready && state.url) return paint(hash);
  if (state.loading) return;
  state.loading = true;
  states.set(hash, state);

  try {
    const response = await responseFor(hash);
    if (!response.ok) {
      state.ready = false;
      state.missingSince ||= performance.now();
      state.nextCheck = performance.now() + 300;
      return;
    }
    const blob = await response.blob();
    state.url = rememberObjectUrl(hash, blob);
    state.ready = true;
    state.missingSince = 0;
    state.nextCheck = 0;
    paint(hash);
  } catch {
    state.ready = false;
    state.nextCheck = performance.now() + 1000;
  } finally {
    state.loading = false;
    states.set(hash, state);
    if (!state.ready) scheduleCheck(300);
  }
}

async function requestCanonical(hashes) {
  if (CLIENT || !hashes.length) return;
  for (let offset = 0; offset < hashes.length; offset += 500) {
    fetch('/api/thumbs/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: hashes.slice(offset, offset + 500) })
    }).catch(() => {});
  }
}

function onScreen(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= innerHeight;
}

function queueFallback(card) {
  if (CLIENT || !onScreen(card)) return;
  const record = recordFor(card);
  const state = states.get(record.hash) || {};
  const delay = record.kind === 'video' ? VIDEO_FALLBACK_DELAY : IMAGE_FALLBACK_DELAY;
  if (!record.hash || state.ready || fallbackQueued.has(record.hash)) return;
  if (performance.now() - (state.missingSince || performance.now()) < delay) return;
  if ((state.nextFallback || 0) > performance.now()) return;
  fallbackQueued.add(record.hash);
  fallbackQueue.push(record);
  pumpFallback();
}

async function checkNearby() {
  checkTimer = 0;
  if (checking || document.hidden || !files) return;
  const cards = [...nearby].filter(card => card.isConnected && kind(card));
  const now = performance.now();
  const hashes = [...new Set(cards.map(card => card.dataset.hash).filter(hash => {
    const state = states.get(hash) || {};
    return !state.ready && !state.loading && now >= (state.nextCheck || 0);
  }))];
  if (!hashes.length) return;

  checking = true;
  try {
    const ready = new Map();
    for (let offset = 0; offset < hashes.length; offset += 500) {
      const response = await fetch('/api/thumbs/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashes: hashes.slice(offset, offset + 500) })
      });
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of data.thumbnails || []) ready.set(item.hash, item);
    }

    const missing = [];
    for (const hash of hashes) {
      const state = states.get(hash) || {};
      const item = ready.get(hash);
      if (item) {
        rememberDimensions(hash, Number(item.width), Number(item.height));
        state.nextCheck = 0;
        states.set(hash, state);
        loadHash(hash);
      } else {
        state.missingSince ||= now;
        state.nextCheck = now + 1200;
        states.set(hash, state);
        missing.push(hash);
      }
    }
    await requestCanonical(missing);
    const missingSet = new Set(missing);
    for (const card of cards) if (missingSet.has(card.dataset.hash)) queueFallback(card);
  } catch {
    for (const hash of hashes) {
      const state = states.get(hash) || {};
      state.nextCheck = performance.now() + 2000;
      states.set(hash, state);
    }
  } finally {
    checking = false;
    if ([...nearby].some(card => !states.get(card.dataset.hash)?.ready)) scheduleCheck(1400);
  }
}

function scheduleCheck(delay = 80) {
  if (checkTimer) return;
  checkTimer = setTimeout(checkNearby, delay);
}

function waitFor(target, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)); }, timeout);
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Media could not be decoded')); };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', failed, { once: true });
  });
}

function makeCanvas(width, height) {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
}

function canvasBlob(canvas) {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/webp', quality: .82 });
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
}

async function imageBitmap(blob) {
  if ('createImageBitmap' in window) return createImageBitmap(blob, { imageOrientation: 'from-image' });
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image could not be decoded')); };
    image.src = url;
  });
}

async function imageFallback(record) {
  const response = await fetch(`/api/objects/${record.hash}`);
  if (!response.ok) throw new Error('Image unavailable');
  const bitmap = await imageBitmap(await response.blob());
  const sourceWidth = bitmap.width || bitmap.naturalWidth;
  const sourceHeight = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, THUMB_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = makeCanvas(width, height);
  canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return { blob: await canvasBlob(canvas), width, height, duration: null };
}

async function videoFallback(record) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = `/api/objects/${record.hash}`;
  try {
    if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) throw new Error('Video has no frame size');
    const scale = Math.min(1, THUMB_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - .02) : 2;
    if (video.duration > .2) {
      video.currentTime = Math.min(end, 1);
      await waitFor(video, 'seeked');
    }
    if (video.readyState < 2) await waitFor(video, 'loadeddata');
    context.drawImage(video, 0, 0, width, height);
    return { blob: await canvasBlob(canvas), width, height, duration: Number.isFinite(video.duration) ? video.duration : null };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

async function uploadFallback(record, result) {
  const response = await fetch(`/api/thumbs/${record.hash}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/webp',
      'x-mochimono-thumb-version': String(THUMB_VERSION),
      'x-mochimono-width': String(result.width || 0),
      'x-mochimono-height': String(result.height || 0),
      ...(result.duration == null ? {} : { 'x-mochimono-duration': String(result.duration) }),
      'x-mochimono-source-mime': sourceMime(record)
    },
    body: result.blob
  });
  if (!response.ok) throw new Error('Could not save preview');
}

async function runFallback(record) {
  const state = states.get(record.hash) || {};
  if (state.ready) return;
  try {
    const result = record.kind === 'video' ? await videoFallback(record) : await imageFallback(record);
    if (states.get(record.hash)?.ready) return;
    await uploadFallback(record, result);
    const cache = await cacheStorage();
    const response = new Response(result.blob, { headers: { 'content-type': 'image/webp' } });
    cache?.put(thumbUrl(record.hash), response.clone()).catch(() => {});
    state.url = rememberObjectUrl(record.hash, result.blob);
    state.ready = true;
    state.missingSince = 0;
    state.nextCheck = 0;
    states.set(record.hash, state);
    rememberDimensions(record.hash, result.width, result.height);
    paint(record.hash);
  } catch (error) {
    state.nextFallback = performance.now() + 30_000;
    states.set(record.hash, state);
    for (const card of cardsFor(record.hash)) {
      const box = mediaBox(card);
      if (!box) continue;
      box.classList.add('thumb-failed');
      box.title = `Preview unavailable: ${error.message}`;
    }
  }
}

function pumpFallback() {
  if (CLIENT || fallbackActive || !fallbackQueue.length || document.hidden) return;
  const record = fallbackQueue.shift();
  fallbackQueued.delete(record.hash);
  fallbackActive = true;
  const run = () => runFallback(record).finally(() => {
    fallbackActive = false;
    pumpFallback();
  });
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 20);
}

const observer = files ? new IntersectionObserver(entries => {
  for (const entry of entries) {
    const card = entry.target;
    if (entry.isIntersecting) {
      nearby.add(card);
      pending(card);
      loadHash(card.dataset.hash);
    } else nearby.delete(card);
  }
}, { rootMargin: '1400px 0px' }) : null;

function cardsIn(node) {
  if (!(node instanceof Element)) return [];
  const cards = [];
  if (node.matches('[data-hash]')) cards.push(node);
  cards.push(...node.querySelectorAll('[data-hash]'));
  return cards;
}

function observeTree(node) {
  if (!observer) return;
  for (const card of cardsIn(node)) {
    indexCard(card);
    if (observed.has(card) || !kind(card)) continue;
    observed.add(card);
    pending(card);
    observer.observe(card);
  }
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

if (files) {
  observeTree(files);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) forgetTree(node);
      for (const node of record.addedNodes) observeTree(node);
    }
  }).observe(files, { childList: true, subtree: true });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      for (const card of nearby) loadHash(card.dataset.hash);
      scheduleCheck(100);
      pumpFallback();
    }
  });

  window.addEventListener('mochimono:catalog-updated', () => {
    persistLearnedDimensions();
    scheduleCheck(100);
  });
  addEventListener('beforeunload', () => {
    clearTimeout(checkTimer);
    clearTimeout(geometryTimer);
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  }, { once: true });
}
