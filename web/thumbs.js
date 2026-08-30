const files = document.querySelector('#files');
const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 2;
const THUMB_VERSION = 3;
const THUMB_EDGE = 768;
const CHECK_BATCH = 500;
const DOWNLOAD_WORKERS = 6;
const MAX_MEMORY_THUMBS = 600;
const PRIORITY_REFRESH = 5_000;
const VISIBLE_CHECK_DELAY = 300;
const IMAGE_FALLBACK_DELAY = 8_000;
const VIDEO_FALLBACK_DELAY = 15_000;

const states = new Map();
const urls = new Map();
const checkQueue = new Map();
const downloadPriority = new Map();
const downloadBackground = new Map();
const requested = new Set();
const requestTimes = new Map();
const fallbackQueue = [];
const fallbackQueued = new Set();
let cachePromise;
let scanFrame = 0;
let checkTimer = 0;
let checking = false;
let requestTimer = 0;
let downloadActive = 0;
let fallbackActive = false;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'm2v', 'mts', 'm2ts', '3gp']);
const MIME = new Map([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['heic', 'image/heic'], ['heif', 'image/heic'], ['avif', 'image/avif'], ['bmp', 'image/bmp'], ['tif', 'image/tiff'], ['tiff', 'image/tiff'],
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['mov', 'video/quicktime'], ['mkv', 'video/x-matroska'], ['webm', 'video/webm'],
  ['avi', 'video/x-msvideo'], ['mpg', 'video/mpeg'], ['mpeg', 'video/mpeg'], ['m2v', 'video/mpeg'], ['mts', 'video/mp2t'], ['m2ts', 'video/mp2t'], ['3gp', 'video/3gpp']
]);

function extension(name) {
  return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
}

function kindFor(file, card) {
  const base = String(file?.mime || '').split('/')[0];
  if (base === 'image' || base === 'video') return base;
  if (card?.classList.contains('video-card')) return 'video';
  const ext = extension(file?.filename || card?.title || card?.querySelector('strong')?.textContent);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (card?.classList.contains('media-card')) return 'image';
  return '';
}

function sourceMime(file) {
  if (file?.mime && file.mime !== 'application/octet-stream') return file.mime;
  return MIME.get(extension(file?.filename)) || file?.mime || 'application/octet-stream';
}

function cache() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
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
    }).catch(error => {
      console.warn('Preview cache unavailable', error);
      return null;
    });
  }
  return cachePromise;
}

const idb = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const txDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
});

async function cachedRows(cards) {
  const db = await cache();
  if (!db) return cards.map(card => ({ card, file: null, thumb: null }));
  const transaction = db.transaction(['files', 'thumbs']);
  const done = txDone(transaction);
  const fileStore = transaction.objectStore('files');
  const thumbStore = transaction.objectStore('thumbs');
  const requests = cards.map(card => ({
    card,
    file: fileStore.get(card.dataset.hash),
    thumb: thumbStore.get(card.dataset.hash)
  }));
  const rows = await Promise.all(requests.map(async row => ({
    card: row.card,
    file: await idb(row.file),
    thumb: await idb(row.thumb)
  })));
  await done;
  return rows;
}

async function cacheThumb(hash, blob, width, height, source = 'server') {
  const db = await cache();
  if (db) {
    const thumbTx = db.transaction('thumbs', 'readwrite');
    const thumbDone = txDone(thumbTx);
    thumbTx.objectStore('thumbs').put({ hash, blob, source, version: THUMB_VERSION });
    await thumbDone;

    if (width && height) {
      const readTx = db.transaction('files');
      const readDone = txDone(readTx);
      const file = await idb(readTx.objectStore('files').get(hash));
      await readDone;
      if (file && (!file.width || !file.height || file.width !== width || file.height !== height)) {
        file.width = width;
        file.height = height;
        const fileTx = db.transaction('files', 'readwrite');
        const fileDone = txDone(fileTx);
        fileTx.objectStore('files').put(file);
        await fileDone;
      }
    }
  }
}

async function deleteCachedThumb(hash) {
  const db = await cache();
  if (!db) return;
  const transaction = db.transaction('thumbs', 'readwrite');
  const done = txDone(transaction);
  transaction.objectStore('thumbs').delete(hash);
  await done;
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

function trimMemoryUrls() {
  if (urls.size <= MAX_MEMORY_THUMBS) return;
  for (const [hash, entry] of urls) {
    if (urls.size <= MAX_MEMORY_THUMBS) break;
    if (hashVisible(hash)) continue;
    URL.revokeObjectURL(entry.url);
    urls.delete(hash);
  }
}

function objectUrl(hash, blob) {
  const current = urls.get(hash);
  if (current?.blob === blob) {
    urls.delete(hash);
    urls.set(hash, current);
    return current.url;
  }
  if (current) URL.revokeObjectURL(current.url);
  const url = URL.createObjectURL(blob);
  urls.set(hash, { blob, url });
  trimMemoryUrls();
  return url;
}

function applyDimensions(hash, width, height) {
  if (!width || !height) return;
  const ratio = Math.max(.65, Math.min(2.1, width / height));
  for (const card of files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"].media-card`)) card.style.setProperty('--ratio', ratio);
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
  return rect.bottom > -600 && rect.top < innerHeight + 900;
}

function visible(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= innerHeight;
}

function hashVisible(hash) {
  return [...files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"]`)].some(visible);
}

function currentCard(hash) {
  return files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
}

function scheduleRetry(hash, delay) {
  const state = states.get(hash) || {};
  state.next = performance.now() + delay;
  states.set(hash, state);
  setTimeout(scheduleScan, delay + 20);
}

function queueRequest(hash) {
  const time = performance.now();
  if (time - (requestTimes.get(hash) || -Infinity) < PRIORITY_REFRESH) return;
  requestTimes.set(hash, time);
  requested.add(hash);
  if (requestTimer) return;
  requestTimer = setTimeout(flushRequests, 35);
}

async function flushRequests() {
  requestTimer = 0;
  const hashes = [...requested].slice(0, CHECK_BATCH);
  hashes.forEach(hash => requested.delete(hash));
  if (!hashes.length) return;
  try {
    await fetch('/api/thumbs/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes })
    });
  } catch {}
  if (requested.size) requestTimer = setTimeout(flushRequests, 40);
}

function queueCheck(file, card) {
  const hash = file.hash;
  const state = states.get(hash) || {};
  if (state.ready || state.downloading || state.downloadQueued || (state.next || 0) > performance.now()) return;
  const priority = visible(card);
  const queued = checkQueue.get(hash);
  if (!queued || priority) checkQueue.set(hash, { file, priority: priority || queued?.priority || false });
  if (!checkTimer) checkTimer = setTimeout(flushChecks, 25);
}

function takeChecks() {
  const entries = [...checkQueue.entries()]
    .sort((a, b) => Number(b[1].priority) - Number(a[1].priority))
    .slice(0, CHECK_BATCH);
  for (const [hash] of entries) checkQueue.delete(hash);
  return entries.map(([, job]) => job);
}

async function checkReady(hashes) {
  const response = await fetch('/api/thumbs/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hashes })
  });
  if (!response.ok) throw new Error(`Preview check failed: ${response.status}`);
  return response.json();
}

async function flushChecks() {
  checkTimer = 0;
  if (checking) return;
  const jobs = takeChecks();
  if (!jobs.length) return;
  checking = true;
  try {
    const data = await checkReady(jobs.map(job => job.file.hash));
    const ready = new Map((data.thumbnails || []).map(row => [row.hash, row]));
    for (const job of jobs) {
      const row = ready.get(job.file.hash);
      if (row) queueDownload(job.file, job.priority, row);
      else handleMissing(job.file);
    }
  } catch {
    for (const job of jobs) scheduleRetry(job.file.hash, 3000);
  } finally {
    checking = false;
    if (checkQueue.size && !checkTimer) checkTimer = setTimeout(flushChecks, 30);
  }
}

function handleMissing(file) {
  const hash = file.hash;
  const state = states.get(hash) || {};
  const isVisible = hashVisible(hash);
  const now = performance.now();
  state.firstMissingAt ||= now;
  state.misses = (state.misses || 0) + 1;
  states.set(hash, state);

  if (isVisible) {
    queueRequest(hash);
    const kind = kindFor(file, currentCard(hash));
    const fallbackDelay = kind === 'video' ? VIDEO_FALLBACK_DELAY : IMAGE_FALLBACK_DELAY;
    if (now - state.firstMissingAt >= fallbackDelay) queueFallback(file, currentCard(hash));
  }
  scheduleRetry(hash, isVisible ? VISIBLE_CHECK_DELAY : 4000);
}

function queueDownload(file, priority, metadata) {
  const hash = file.hash;
  const state = states.get(hash) || {};
  if (state.ready || state.downloading || state.downloadQueued) return;
  state.downloadQueued = true;
  states.set(hash, state);
  if (priority) {
    downloadBackground.delete(hash);
    downloadPriority.set(hash, { file, metadata });
  } else {
    downloadBackground.set(hash, { file, metadata });
  }
  pumpDownloads();
}

function nextDownload() {
  const queue = downloadPriority.size ? downloadPriority : downloadBackground;
  const entry = queue.entries().next().value;
  if (!entry) return null;
  queue.delete(entry[0]);
  return entry[1];
}

async function downloadThumb(job) {
  const { file, metadata } = job;
  const hash = file.hash;
  const state = states.get(hash) || {};
  state.downloadQueued = false;
  state.downloading = true;
  states.set(hash, state);
  try {
    const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`);
    if (response.ok) {
      const blob = await response.blob();
      const width = Number(response.headers.get('x-mochimono-width')) || Number(metadata?.width) || 0;
      const height = Number(response.headers.get('x-mochimono-height')) || Number(metadata?.height) || 0;
      applyDimensions(hash, width, height);
      applyBlob(hash, blob);
      states.set(hash, { ready: true });
      cacheThumb(hash, blob, width, height, 'server').catch(error => console.warn('Preview cache write failed', error));
      return;
    }
    if (response.status === 404) handleMissing(file);
    else scheduleRetry(hash, 3000);
  } catch {
    scheduleRetry(hash, 2500);
  } finally {
    const latest = states.get(hash);
    if (latest && !latest.ready) {
      latest.downloading = false;
      latest.downloadQueued = false;
    }
  }
}

function pumpDownloads() {
  while (downloadActive < DOWNLOAD_WORKERS && (downloadPriority.size || downloadBackground.size)) {
    const job = nextDownload();
    if (!job) break;
    downloadActive++;
    downloadThumb(job).finally(() => {
      downloadActive--;
      pumpDownloads();
    });
  }
}

async function scan() {
  scanFrame = 0;
  if (document.hidden) return;
  const cards = [...files.querySelectorAll('[data-hash]')].filter(card => nearViewport(card));
  if (!cards.length) return;

  const unresolved = [];
  for (const card of cards) {
    const hash = card.dataset.hash;
    const existing = urls.get(hash);
    if (existing && card.querySelector('.media-thumb')) {
      applyBlob(hash, existing.blob);
      continue;
    }
    unresolved.push(card);
  }
  if (!unresolved.length) return;

  const rows = await cachedRows(unresolved).catch(() => unresolved.map(card => ({ card, file: null, thumb: null })));
  for (const { card, file, thumb } of rows) {
    if (!card.isConnected) continue;
    const record = file || { hash: card.dataset.hash, filename: card.title || card.querySelector('strong')?.textContent || '', mime: '' };
    const kind = kindFor(record, card);
    if (!kind) continue;
    const box = mediaBox(card, kind);
    if (!box) continue;

    const existing = urls.get(record.hash);
    if (existing) {
      applyBlob(record.hash, existing.blob);
      states.set(record.hash, { ready: true });
      continue;
    }
    if (thumb?.blob && thumb.version === THUMB_VERSION) {
      applyDimensions(record.hash, Number(file?.width) || 0, Number(file?.height) || 0);
      applyBlob(record.hash, thumb.blob);
      states.set(record.hash, { ready: true });
      continue;
    }
    if (thumb?.blob) deleteCachedThumb(record.hash).catch(() => {});
    pendingBox(box, record.hash);
    queueCheck(record, card);
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

async function imageFallback(file) {
  const response = await fetch(`/api/objects/${file.hash}`);
  if (!response.ok) throw new Error('Image unavailable');
  const blob = await response.blob();
  const bitmap = await imageBitmap(blob);
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
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, 1200);
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
      'x-mochimono-source-mime': sourceMime(file)
    },
    body: result.blob
  });
  if (!response.ok) throw new Error('Could not save preview');
}

function queueFallback(file, card) {
  if (!file || fallbackQueued.has(file.hash) || states.get(file.hash)?.ready) return;
  const state = states.get(file.hash) || {};
  if ((state.nextFallback || 0) > performance.now()) return;
  const kind = kindFor(file, card);
  if (!kind) return;
  fallbackQueued.add(file.hash);
  fallbackQueue.push({ file, kind });
  pumpFallback();
}

async function serverReadyBeforeFallback(file) {
  try {
    const data = await checkReady([file.hash]);
    const row = data.thumbnails?.find(item => item.hash === file.hash);
    if (!row) return false;
    queueDownload(file, true, row);
    return true;
  } catch {
    return false;
  }
}

async function runFallback(job) {
  const { file, kind } = job;
  if (states.get(file.hash)?.ready) return;
  if (await serverReadyBeforeFallback(file)) return;
  try {
    const result = kind === 'image' ? await imageFallback(file) : await videoFallback(file);
    if (states.get(file.hash)?.ready) return;
    if (await serverReadyBeforeFallback(file)) return;
    await uploadFallback(file, result);
    applyDimensions(file.hash, result.width, result.height);
    applyBlob(file.hash, result.blob);
    states.set(file.hash, { ready: true });
    cacheThumb(file.hash, result.blob, result.width, result.height, 'browser').catch(error => console.warn('Preview cache write failed', error));
  } catch (error) {
    const state = states.get(file.hash) || {};
    state.fallbackFailures = (state.fallbackFailures || 0) + 1;
    state.nextFallback = performance.now() + Math.min(120_000, 30_000 * state.fallbackFailures);
    state.next = Math.min(state.next || Infinity, performance.now() + 5000);
    states.set(file.hash, state);
    for (const box of files.querySelectorAll(`[data-hash="${CSS.escape(file.hash)}"] .media-thumb`)) {
      box.classList.add('thumb-failed');
      box.title = `Preview unavailable: ${error.message}`;
    }
    setTimeout(scheduleScan, Math.min(120_000, 30_000 * state.fallbackFailures) + 50);
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
const rescan = setInterval(scheduleScan, 1500);
scheduleScan();

window.addEventListener('beforeunload', () => {
  clearInterval(rescan);
  clearTimeout(checkTimer);
  clearTimeout(requestTimer);
  for (const entry of urls.values()) URL.revokeObjectURL(entry.url);
});
