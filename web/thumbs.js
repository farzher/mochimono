const files = document.querySelector('#files');
const CLIENT = document.documentElement.classList.contains('client-library');
const THUMB_VERSION = 3;
const THUMB_EDGE = 768;
const IMAGE_FALLBACK_DELAY = 8_000;
const VIDEO_FALLBACK_DELAY = 15_000;

const states = new Map();
const cardIndex = new Map();
const observed = new Set();
const nearby = new Set();
const fallbackQueue = [];
const fallbackQueued = new Set();
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
const interactionActive = () => Boolean(window.mochimonoGridInteraction?.active?.());

function kind(card) {
  if (card.classList.contains('video-card')) return 'video';
  if (card.classList.contains('media-card')) return 'image';
  const ext = extension(filename(card));
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return '';
}

function recordFor(card) {
  return { hash: String(card.dataset.hash || ''), filename: filename(card), kind: kind(card), mime: sourceMime({ filename: filename(card) }) };
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

const cardsFor = hash => cardIndex.get(String(hash || '')) || [];

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

function persistDimensions(hash, width, height) {
  window.mochimonoCatalogCache?.rememberDimensions?.(hash, width, height).catch(() => {});
}

function rememberDimensions(hash, width, height) {
  if (!width || !height) return;
  const state = states.get(hash) || {};
  state.width = Number(width) || state.width || 0;
  state.height = Number(height) || state.height || 0;
  states.set(hash, state);
  persistDimensions(hash, state.width, state.height);
}

function persistLearnedDimensions() {
  clearTimeout(geometryTimer);
  geometryTimer = setTimeout(() => {
    for (const [hash, state] of states) if (state.width && state.height) persistDimensions(hash, state.width, state.height);
  }, 800);
}

function markLoaded(hash, card, image) {
  const state = states.get(hash) || {};
  state.ready = true;
  state.missingSince = 0;
  state.nextCheck = 0;
  states.set(hash, state);
  const box = mediaBox(card);
  box?.classList.remove('thumb-failed');
  box?.removeAttribute('title');
  box?.querySelector('.video-thumb-pending')?.remove();
  image.hidden = false;
  rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
}

function startThumbnailImage(image, canonical, knownReady = false) {
  if (interactionActive() && !knownReady) {
    image.dataset.pendingThumbSrc = canonical;
    return;
  }
  delete image.dataset.pendingThumbSrc;
  image.src = canonical;
}

function paintCard(card, force = false) {
  if (!card?.isConnected || !kind(card)) return;
  const hash = String(card.dataset.hash || '');
  if (!hash) return;
  const box = mediaBox(card);
  if (!box) return;
  const canonical = thumbUrl(hash);
  const current = box.querySelector('img.cached-thumb');

  if (current?.dataset.thumbHash === hash) {
    if (current.complete && current.naturalWidth) markLoaded(hash, card, current);
    else if (!interactionActive() && current.dataset.pendingThumbSrc) startThumbnailImage(current, current.dataset.pendingThumbSrc, false);
    return;
  }

  pending(card);
  const image = document.createElement('img');
  image.className = 'cached-thumb';
  image.alt = '';
  image.hidden = true;
  image.decoding = 'async';
  image.loading = 'lazy';
  try { image.fetchPriority = 'low'; } catch {}
  image.dataset.thumbHash = hash;
  image.onload = () => {
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    markLoaded(hash, card, image);
  };
  image.onerror = () => {
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    image.remove();
    const state = states.get(hash) || {};
    state.ready = false;
    state.missingSince ||= performance.now();
    state.nextCheck = performance.now() + 250;
    states.set(hash, state);
    pending(card);
    if (nearby.has(card) && !interactionActive()) scheduleCheck(80);
  };

  box.prepend(image);
  startThumbnailImage(image, canonical, Boolean(states.get(hash)?.ready));
}

function paint(hash, force = false) {
  for (const card of cardsFor(hash)) paintCard(card, force);
}

function loadHash(hash, force = false) {
  hash = String(hash || '');
  if (!hash) return;
  paint(hash, force);
}

async function requestCanonical(hashes) {
  if (CLIENT || !hashes.length || interactionActive()) return;
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
  if (CLIENT || interactionActive() || !onScreen(card)) return;
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
  if (interactionActive()) {
    scheduleCheck(180);
    return;
  }
  const cards = [...nearby].filter(card => card.isConnected && kind(card));
  const now = performance.now();
  const hashes = [...new Set(cards.map(card => card.dataset.hash).filter(hash => {
    const state = states.get(hash) || {};
    return !state.ready && now >= (state.nextCheck || 0);
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
        state.ready = true;
        state.nextCheck = 0;
        states.set(hash, state);
        loadHash(hash, true);
      } else {
        state.ready = false;
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
    state.ready = true;
    state.missingSince = 0;
    state.nextCheck = 0;
    states.set(record.hash, state);
    rememberDimensions(record.hash, result.width, result.height);
    loadHash(record.hash, true);
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
  if (interactionActive()) {
    setTimeout(pumpFallback, 180);
    return;
  }
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
      const image = card.querySelector('img.cached-thumb');
      if (image) image.fetchPriority = interactionActive() ? 'low' : 'high';
      if (interactionActive()) continue;
      loadHash(card.dataset.hash);
      if (!states.get(card.dataset.hash)?.ready) scheduleCheck(50);
    } else nearby.delete(card);
  }
}, { rootMargin: '2200px 0px' }) : null;

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
    paintCard(card);
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

function flushDeferredThumbnails() {
  for (const image of files?.querySelectorAll('img.cached-thumb[data-pending-thumb-src]') || []) {
    if (!image.isConnected) continue;
    const canonical = image.dataset.pendingThumbSrc;
    if (canonical) startThumbnailImage(image, canonical, false);
  }
  for (const card of nearby) {
    if (!card.isConnected) continue;
    const image = card.querySelector('img.cached-thumb');
    if (image) image.fetchPriority = 'high';
    loadHash(card.dataset.hash);
  }
  scheduleCheck(40);
  pumpFallback();
}

if (files) {
  observeTree(files);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) forgetTree(node);
      for (const node of record.addedNodes) observeTree(node);
    }
  }).observe(files, { childList: true, subtree: true });

  window.addEventListener('mochimono:grid-interaction-end', flushDeferredThumbnails);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (interactionActive()) return;
      for (const card of nearby) loadHash(card.dataset.hash);
      scheduleCheck(50);
      pumpFallback();
    }
  });

  window.addEventListener('mochimono:catalog-updated', () => {
    persistLearnedDimensions();
    if (!interactionActive()) scheduleCheck(50);
  });

  addEventListener('beforeunload', () => {
    clearTimeout(checkTimer);
    clearTimeout(geometryTimer);
  }, { once: true });
}
