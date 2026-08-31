const files = document.querySelector('#files');
const CLIENT = document.documentElement.classList.contains('client-library');
const THUMB_VERSION = 3;
const THUMB_EDGE = 768;
const IMAGE_FALLBACK_DELAY = 8_000;
const VIDEO_FALLBACK_DELAY = 15_000;
const REQUEST_COOLDOWN = 10_000;
const MAX_FALLBACK_URLS = 40;

const states = new Map();
const observed = new Set();
const nearby = new Set();
const requestedAt = new Map();
const fallbackQueue = [];
const fallbackQueued = new Set();
const fallbackUrls = new Map();
let checkTimer = 0;
let checking = false;
let missRounds = 0;
let fallbackActive = false;

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

function kind(card) {
  if (card.classList.contains('video-card')) return 'video';
  if (card.classList.contains('media-card')) return 'image';
  const ext = extension(filename(card));
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return '';
}

function sourceMime(record) {
  return MIME.get(extension(record.filename)) || 'application/octet-stream';
}

function recordFor(card, mediaKind = kind(card)) {
  return { hash: card.dataset.hash, filename: filename(card), mime: mediaKind ? `${mediaKind}/unknown` : '' };
}

function cardsFor(hash) {
  return files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"]`);
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

function ensurePending(card, mediaKind = kind(card)) {
  const box = mediaBox(card, mediaKind);
  if (!box || box.querySelector('.cached-thumb,.video-thumb-pending')) return;
  const pending = document.createElement('span');
  pending.className = 'video-thumb-pending';
  pending.dataset.videoThumb = card.dataset.hash || '';
  box.prepend(pending);
}

function applyDimensions(hash, width, height) {
  if (!width || !height) return;
  const ratio = Math.max(.65, Math.min(2.1, width / height));
  for (const card of cardsFor(hash)) if (card.classList.contains('media-card')) card.style.setProperty('--ratio', ratio);
}

function applyReady(hash, width = 0, height = 0, localUrl = '') {
  const state = states.get(hash) || {};
  state.ready = true;
  state.missingSince = 0;
  state.width = width || state.width || 0;
  state.height = height || state.height || 0;
  states.set(hash, state);
  requestedAt.delete(hash);
  applyDimensions(hash, state.width, state.height);

  for (const card of cardsFor(hash)) {
    const mediaKind = kind(card);
    if (!mediaKind) continue;
    const box = mediaBox(card, mediaKind);
    if (!box || box.querySelector('img.cached-thumb')) continue;
    box.classList.remove('thumb-failed');
    box.removeAttribute('title');
    const image = document.createElement('img');
    image.className = 'cached-thumb server-thumb';
    image.decoding = 'async';
    image.loading = 'lazy';
    image.alt = filename(card);
    image.onload = () => {
      if (image.naturalWidth && image.naturalHeight) applyDimensions(hash, image.naturalWidth, image.naturalHeight);
    };
    image.onerror = () => {
      image.remove();
      const current = states.get(hash) || {};
      current.ready = false;
      current.missingSince ||= performance.now();
      states.set(hash, current);
      missRounds = 0;
      scheduleCheck(250);
    };
    const old = box.querySelector('img,.video-thumb-pending');
    old ? old.replaceWith(image) : box.prepend(image);
    image.src = localUrl || thumbUrl(hash);
  }
}

function nearbyCards() {
  return [...nearby].filter(card => card.isConnected && kind(card));
}

function onScreen(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= innerHeight;
}

async function requestCanonical(hashes) {
  if (CLIENT || !hashes.length) return;
  const now = performance.now();
  const fresh = hashes.filter(hash => now - (requestedAt.get(hash) || -Infinity) >= REQUEST_COOLDOWN);
  if (!fresh.length) return;
  fresh.forEach(hash => requestedAt.set(hash, now));
  for (let offset = 0; offset < fresh.length; offset += 500) {
    try {
      await fetch('/api/thumbs/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashes: fresh.slice(offset, offset + 500) })
      });
    } catch {}
  }
}

function queueFallback(card) {
  if (CLIENT || !onScreen(card)) return;
  const mediaKind = kind(card);
  const record = recordFor(card, mediaKind);
  const state = states.get(record.hash) || {};
  if (!record.hash || state.ready || fallbackQueued.has(record.hash) || (state.nextFallback || 0) > performance.now()) return;
  const delay = mediaKind === 'video' ? VIDEO_FALLBACK_DELAY : IMAGE_FALLBACK_DELAY;
  if (performance.now() - (state.missingSince || performance.now()) < delay) return;
  fallbackQueued.add(record.hash);
  fallbackQueue.push({ record, kind: mediaKind });
  pumpFallback();
}

async function checkNearby() {
  checkTimer = 0;
  if (checking || document.hidden || !files) return;
  const cards = nearbyCards();
  if (!cards.length) return;

  const hashes = [];
  for (const card of cards) {
    const hash = card.dataset.hash;
    const mediaKind = kind(card);
    ensurePending(card, mediaKind);
    const state = states.get(hash) || {};
    if (state.ready) {
      applyReady(hash, state.width, state.height);
      continue;
    }
    if (hash && !hashes.includes(hash)) hashes.push(hash);
  }
  if (!hashes.length) return;

  checking = true;
  let becameReady = 0;
  const ready = new Map();
  try {
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

    const now = performance.now();
    const missing = [];
    for (const hash of hashes) {
      const thumbnail = ready.get(hash);
      if (thumbnail) {
        if (!states.get(hash)?.ready) becameReady++;
        applyReady(hash, Number(thumbnail.width), Number(thumbnail.height));
      } else {
        const state = states.get(hash) || {};
        state.ready = false;
        state.missingSince ||= now;
        states.set(hash, state);
        missing.push(hash);
      }
    }

    if (!CLIENT && missing.length) {
      await requestCanonical(missing);
      for (const card of cards) if (missing.includes(card.dataset.hash)) queueFallback(card);
    }
  } catch {}
  finally {
    checking = false;
    if (becameReady) missRounds = 0;
    else missRounds = Math.min(5, missRounds + 1);
    if (nearbyCards().some(card => !states.get(card.dataset.hash)?.ready)) {
      scheduleCheck(Math.min(5000, 500 * 2 ** Math.max(0, missRounds - 1)));
    }
  }
}

function scheduleCheck(delay = 30) {
  clearTimeout(checkTimer);
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

function canvasBlob(canvas) {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/webp', quality: .82 });
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
}

function makeCanvas(width, height) {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
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

function decodedFrame(video) {
  if (!video.requestVideoFrameCallback) return new Promise(resolve => setTimeout(resolve, 50));
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, 500);
    video.requestVideoFrameCallback(() => { clearTimeout(timer); finish(); });
  });
}

function frameBlank(canvas) {
  const width = Math.min(40, canvas.width);
  const height = Math.min(28, canvas.height);
  const sample = makeCanvas(width, height);
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  let brightness = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 16) {
    brightness += data[index] + data[index + 1] + data[index + 2];
    count += 3;
  }
  return brightness / Math.max(1, count) < 5;
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
    const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - .02) : 4;
    const times = [...new Set([.2, 1, 4].map(value => Math.min(end, value)))];
    for (let index = 0; index < times.length; index++) {
      if (Math.abs(video.currentTime - times[index]) > .01) {
        if (video.fastSeek) video.fastSeek(times[index]);
        else video.currentTime = times[index];
        await waitFor(video, 'seeked');
      }
      if (video.readyState < 2) await waitFor(video, 'loadeddata');
      await decodedFrame(video);
      context.drawImage(video, 0, 0, width, height);
      if (index === times.length - 1 || !frameBlank(canvas)) break;
    }
    return { blob: await canvasBlob(canvas), width, height, duration: Number.isFinite(video.duration) ? video.duration : null };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

async function uploadFallback(record, result) {
  if (!result.blob) throw new Error('Preview encoding failed');
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

async function canonicalExists(hash) {
  try { return (await fetch(thumbUrl(hash), { method: 'HEAD' })).ok; }
  catch { return false; }
}

function trimFallbackUrls() {
  while (fallbackUrls.size > MAX_FALLBACK_URLS) {
    const [hash, url] = fallbackUrls.entries().next().value;
    URL.revokeObjectURL(url);
    fallbackUrls.delete(hash);
  }
}

function localFallbackUrl(hash, blob) {
  const previous = fallbackUrls.get(hash);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(blob);
  fallbackUrls.set(hash, url);
  trimFallbackUrls();
  return url;
}

async function runFallback({ record, kind: mediaKind }) {
  const state = states.get(record.hash) || {};
  if (state.ready) return;
  if (await canonicalExists(record.hash)) {
    missRounds = 0;
    scheduleCheck();
    return;
  }

  try {
    const result = mediaKind === 'image' ? await imageFallback(record) : await videoFallback(record);
    if (states.get(record.hash)?.ready) return;
    if (await canonicalExists(record.hash)) {
      missRounds = 0;
      scheduleCheck();
      return;
    }
    await uploadFallback(record, result);
    applyReady(record.hash, result.width, result.height, localFallbackUrl(record.hash, result.blob));
  } catch (error) {
    const latest = states.get(record.hash) || {};
    latest.fallbackFailures = (latest.fallbackFailures || 0) + 1;
    latest.nextFallback = performance.now() + Math.min(120_000, 30_000 * latest.fallbackFailures);
    states.set(record.hash, latest);
    for (const card of cardsFor(record.hash)) {
      const box = card.querySelector('.media-thumb');
      if (!box) continue;
      box.classList.add('thumb-failed');
      box.title = `Preview unavailable: ${error.message}`;
    }
  }
}

function pumpFallback() {
  if (CLIENT || fallbackActive || !fallbackQueue.length || document.hidden) return;
  const job = fallbackQueue.shift();
  fallbackQueued.delete(job.record.hash);
  fallbackActive = true;
  const run = () => runFallback(job).finally(() => {
    fallbackActive = false;
    pumpFallback();
  });
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 20);
}

const observer = files ? new IntersectionObserver(entries => {
  let entered = false;
  for (const entry of entries) {
    if (entry.isIntersecting) {
      nearby.add(entry.target);
      entered = true;
    } else nearby.delete(entry.target);
  }
  if (entered) {
    missRounds = 0;
    scheduleCheck();
  }
}, { rootMargin: '800px 0px' }) : null;

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
    if (observed.has(card) || !kind(card)) continue;
    observed.add(card);
    observer.observe(card);
  }
}

function forgetTree(node) {
  if (!observer) return;
  for (const card of cardsIn(node)) {
    if (!observed.delete(card)) continue;
    nearby.delete(card);
    observer.unobserve(card);
  }
}

if (files) {
  for (const card of files.querySelectorAll('[data-hash]')) observeTree(card);
  const mutations = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) forgetTree(node);
      for (const node of record.addedNodes) observeTree(node);
    }
  });
  mutations.observe(files, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      missRounds = 0;
      scheduleCheck();
      pumpFallback();
    }
  });
  addEventListener('beforeunload', () => {
    clearTimeout(checkTimer);
    for (const url of fallbackUrls.values()) URL.revokeObjectURL(url);
  });
}
