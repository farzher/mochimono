const files = document.querySelector('#files');
const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 2;
const THUMB_VERSION = 1;
const THUMB_EDGE = 768;
const states = new Map();
const urls = new Map();
const requested = new Set();
const fallbackQueue = [];
const fallbackQueued = new Set();
let cachePromise;
let scanFrame = 0;
let requestTimer = 0;
let fallbackActive = false;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'm2v', 'mts', 'm2ts', '3gp']);

function extension(name) {
  return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
}

function kindFor(file, card) {
  const base = String(file?.mime || '').split('/')[0];
  if (base === 'image' || base === 'video') return base;
  if (card?.classList.contains('video-card')) return 'video';
  if (card?.classList.contains('media-card')) return 'image';
  const ext = extension(file?.filename || card?.title || card?.querySelector('strong')?.textContent);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return '';
}

function cache() {
  if (!cachePromise) {
    cachePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_NAME, CACHE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'hash' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'hash' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return cachePromise;
}

const idb = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function cachedRows(cards) {
  const db = await cache();
  const transaction = db.transaction(['files', 'thumbs']);
  const fileStore = transaction.objectStore('files');
  const thumbStore = transaction.objectStore('thumbs');
  return Promise.all(cards.map(async card => ({
    card,
    file: await idb(fileStore.get(card.dataset.hash)),
    thumb: await idb(thumbStore.get(card.dataset.hash))
  })));
}

async function cacheThumb(hash, blob, width, height, source = 'server') {
  const db = await cache();
  const thumbTx = db.transaction('thumbs', 'readwrite');
  thumbTx.objectStore('thumbs').put({ hash, blob, source, version: THUMB_VERSION });

  if (width && height) {
    const file = await idb(db.transaction('files').objectStore('files').get(hash));
    if (file && (!file.width || !file.height || file.width !== width || file.height !== height)) {
      file.width = width;
      file.height = height;
      db.transaction('files', 'readwrite').objectStore('files').put(file);
    }
  }
}

function mediaBox(card, kind) {
  let box = card.querySelector('.media-thumb');
  if (box) return box;

  if (!card.classList.contains('file-row') && !card.classList.contains('file-folder-row')) return null;
  box = document.createElement('span');
  box.className = `tiny-preview media-thumb ${kind === 'video' ? 'video' : ''}`;
  const old = card.classList.contains('file-row') ? card.querySelector('.type') : card.querySelector('.document-icon');
  old?.replaceWith(box);
  return box;
}

function pendingBox(box, hash) {
  if (!box || box.querySelector('.cached-thumb')) return;
  let pending = box.querySelector('.video-thumb-pending');
  if (!pending) {
    pending = document.createElement('span');
    pending.className = 'video-thumb-pending';
    pending.dataset.videoThumb = hash;
    const old = box.querySelector('img,video');
    if (old) {
      old.removeAttribute?.('src');
      old.load?.();
      old.replaceWith(pending);
    } else box.prepend(pending);
  }
}

function objectUrl(hash, blob) {
  let url = urls.get(hash);
  if (!url) {
    url = URL.createObjectURL(blob);
    urls.set(hash, url);
  }
  return url;
}

function applyBlob(hash, blob) {
  const url = objectUrl(hash, blob);
  for (const card of files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"]`)) {
    const box = card.querySelector('.media-thumb');
    if (!box) continue;
    box.classList.remove('thumb-failed');
    box.removeAttribute('title');
    let image = box.querySelector('img.cached-thumb');
    if (!image) {
      image = document.createElement('img');
      image.className = 'cached-thumb';
      image.loading = 'lazy';
      image.alt = card.title || card.querySelector('strong')?.textContent || '';
      const old = box.querySelector('img,video,.video-thumb-pending');
      if (old) old.replaceWith(image);
      else box.prepend(image);
    }
    image.src = url;
  }
}

function nearViewport(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom > -800 && rect.top < innerHeight + 1200;
}

function visible(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= innerHeight;
}

function queueRequest(hash) {
  requested.add(hash);
  if (requestTimer) return;
  requestTimer = setTimeout(flushRequests, 40);
}

async function flushRequests() {
  requestTimer = 0;
  const hashes = [...requested].slice(0, 500);
  hashes.forEach(hash => requested.delete(hash));
  if (!hashes.length) return;
  try {
    await fetch('/api/thumbs/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes })
    });
  } catch {}
  if (requested.size) requestTimer = setTimeout(flushRequests, 50);
}

function scheduleRetry(hash, delay) {
  const state = states.get(hash) || {};
  state.next = performance.now() + delay;
  state.loading = false;
  states.set(hash, state);
  setTimeout(scheduleScan, delay + 20);
}

function queueFallback(file, card) {
  if (!file || fallbackQueued.has(file.hash) || states.get(file.hash)?.fallbackDone) return;
  fallbackQueued.add(file.hash);
  fallbackQueue.push({ file, kind: kindFor(file, card) });
  pumpFallback();
}

async function fetchServerThumb(file, card, box) {
  const hash = file.hash;
  const current = states.get(hash) || {};
  if (current.loading || (current.next || 0) > performance.now()) return;
  current.loading = true;
  states.set(hash, current);

  try {
    const response = await fetch(`/api/thumbs/${hash}`);
    if (response.ok) {
      const blob = await response.blob();
      const width = Number(response.headers.get('x-mochimono-width')) || 0;
      const height = Number(response.headers.get('x-mochimono-height')) || 0;
      await cacheThumb(hash, blob, width, height, 'server');
      applyBlob(hash, blob);
      states.set(hash, { ready: true });
      return;
    }

    if (response.status === 404) {
      if (visible(card)) queueRequest(hash);
      const misses = (current.misses || 0) + 1;
      current.misses = misses;
      if (misses >= 3 && visible(card)) {
        current.loading = false;
        states.set(hash, current);
        queueFallback(file, card);
      } else {
        states.set(hash, current);
        scheduleRetry(hash, misses === 1 ? 900 : 1800);
      }
      return;
    }
    scheduleRetry(hash, 3000);
  } catch {
    scheduleRetry(hash, 2500);
  } finally {
    const state = states.get(hash);
    if (state && !state.ready) state.loading = false;
  }
}

async function scan() {
  scanFrame = 0;
  const cards = [...files.querySelectorAll('[data-hash]')].filter(card => nearViewport(card));
  if (!cards.length) return;
  const rows = await cachedRows(cards).catch(() => []);

  for (const { card, file, thumb } of rows) {
    const record = file || { hash: card.dataset.hash, filename: card.title || card.querySelector('strong')?.textContent || '', mime: '' };
    const kind = kindFor(record, card);
    if (!kind) continue;
    const box = mediaBox(card, kind);
    if (!box) continue;

    if (thumb?.blob) applyBlob(record.hash, thumb.blob);
    else pendingBox(box, record.hash);

    if (!states.get(record.hash)?.ready) fetchServerThumb(record, card, box).catch(console.warn);
  }
}

function scheduleScan() {
  if (!scanFrame) scanFrame = requestAnimationFrame(() => scan().catch(console.warn));
}

function waitFor(target, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
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
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
}

async function imageFallback(file) {
  const response = await fetch(`/api/objects/${file.hash}`);
  if (!response.ok) throw new Error('Image unavailable');
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = makeCanvas(width, height);
  canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return { blob: await canvasBlob(canvas), width, height, duration: null };
}

function decodedFrame(video) {
  if (!video.requestVideoFrameCallback) return new Promise(resolve => setTimeout(resolve, 50));
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 1200);
    video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
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

async function videoFallback(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = `/api/objects/${file.hash}`;
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

async function uploadFallback(file, result) {
  if (!result.blob) throw new Error('Preview encoding failed');
  const response = await fetch(`/api/thumbs/${file.hash}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/webp',
      'x-mochimono-thumb-version': String(THUMB_VERSION),
      'x-mochimono-width': String(result.width || 0),
      'x-mochimono-height': String(result.height || 0),
      ...(result.duration == null ? {} : { 'x-mochimono-duration': String(result.duration) }),
      ...(file.mime ? { 'x-mochimono-source-mime': file.mime } : {})
    },
    body: result.blob
  });
  if (!response.ok) throw new Error('Could not save preview');
}

async function runFallback(job) {
  const { file, kind } = job;
  try {
    const result = kind === 'image' ? await imageFallback(file) : await videoFallback(file);
    await uploadFallback(file, result);
    await cacheThumb(file.hash, result.blob, result.width, result.height, 'browser');
    applyBlob(file.hash, result.blob);
    states.set(file.hash, { ready: true, fallbackDone: true });
  } catch (error) {
    const state = states.get(file.hash) || {};
    state.fallbackDone = true;
    state.next = performance.now() + 30_000;
    states.set(file.hash, state);
    for (const box of files.querySelectorAll(`[data-hash="${CSS.escape(file.hash)}"] .media-thumb`)) {
      box.classList.add('thumb-failed');
      box.title = `Preview unavailable: ${error.message}`;
    }
  }
}

function pumpFallback() {
  if (fallbackActive || !fallbackQueue.length || document.hidden) return;
  const job = fallbackQueue.shift();
  fallbackQueued.delete(job.file.hash);
  fallbackActive = true;
  const run = () => runFallback(job).finally(() => {
    fallbackActive = false;
    pumpFallback();
  });
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 60);
}

new MutationObserver(scheduleScan).observe(files, { childList: true, subtree: true });
window.addEventListener('scroll', scheduleScan, { passive: true });
window.addEventListener('resize', scheduleScan, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { scheduleScan(); pumpFallback(); }
});
const rescan = setInterval(scheduleScan, 2000);
scheduleScan();

window.addEventListener('beforeunload', () => {
  clearInterval(rescan);
  clearTimeout(requestTimer);
  for (const url of urls.values()) URL.revokeObjectURL(url);
});
