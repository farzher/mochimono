const files = document.querySelector('#files');
const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 2;
const VIDEO_THUMB_VERSION = 2;
const THUMB_EDGE = 768;
const MAX_ATTEMPTS = 3;
const queue = [];
const queued = new Set();
const urls = new Map();
const attempts = new Map();
const retryTimers = new Map();
let cachePromise;
let busy = false;
let scanFrame = 0;

const VIDEO_EXTENSIONS = new Set(['m4v', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'm2v', 'mts', 'm2ts', '3gp']);

function extension(name) {
  const match = String(name || '').toLowerCase().match(/\.([^.]+)$/);
  return match?.[1] || '';
}

function isVideoName(name) {
  return VIDEO_EXTENSIONS.has(extension(name));
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
    }).catch(error => {
      console.warn('Video thumbnail cache unavailable', error);
      return null;
    });
  }
  return cachePromise;
}

const idb = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function cardName(card) {
  return card?.getAttribute('title') || card?.querySelector('strong')?.textContent || '';
}

function ensureTinyPlaceholder(card) {
  if (!card || card.querySelector('.media-thumb')) return;
  if (!isVideoName(cardName(card))) return;

  const box = document.createElement('span');
  box.className = 'tiny-preview media-thumb video';
  const pending = document.createElement('span');
  pending.className = 'video-thumb-pending';
  pending.dataset.videoThumb = card.dataset.hash;
  box.append(pending);

  const old = card.classList.contains('file-row')
    ? card.querySelector('.type')
    : card.querySelector('.document-icon');
  old?.replaceWith(box);
}

function replaceVideoElement(video) {
  if (video.dataset.thumbIntercepted) return;
  video.dataset.thumbIntercepted = '1';
  const card = video.closest('[data-hash]');
  if (!card) return;

  const pending = document.createElement('span');
  pending.className = 'video-thumb-pending';
  pending.dataset.videoThumb = card.dataset.hash;
  video.removeAttribute('src');
  video.load();
  video.replaceWith(pending);
  enqueue(card.dataset.hash);
}

function placeholderHash(element) {
  return element.dataset.videoThumb || element.closest('[data-hash]')?.dataset.hash || '';
}

function scheduleScan() {
  if (!scanFrame) scanFrame = requestAnimationFrame(scan);
}

function scan() {
  scanFrame = 0;
  const rows = [...files.querySelectorAll('.file-row[data-hash], .folder-row.file-folder-row[data-hash]')];
  rows.forEach(ensureTinyPlaceholder);
  files.querySelectorAll('video.video-thumb').forEach(replaceVideoElement);
  files.querySelectorAll('.video-card[data-hash]').forEach(card => enqueue(card.dataset.hash));
  rows.filter(card => isVideoName(cardName(card))).forEach(card => enqueue(card.dataset.hash));
  files.querySelectorAll('.video-thumb-pending').forEach(element => enqueue(placeholderHash(element)));
}

function enqueue(hash, front = false) {
  if (!hash || queued.has(hash) || urls.has(hash) || retryTimers.has(hash)) return;
  queued.add(hash);
  if (front) queue.unshift(hash);
  else queue.push(hash);
  pump();
}

function cardFor(hash) {
  return files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
}

function viewportScore(hash) {
  const card = cardFor(hash);
  if (!card) return Number.POSITIVE_INFINITY;
  const rect = card.getBoundingClientRect();
  if (rect.bottom >= 0 && rect.top <= innerHeight) return Math.max(0, rect.top);
  if (rect.bottom < 0) return Math.abs(rect.bottom) + innerHeight;
  return rect.top;
}

function takeNext() {
  if (!queue.length) return '';
  let best = 0;
  let bestScore = viewportScore(queue[0]);
  for (let index = 1; index < queue.length; index++) {
    const score = viewportScore(queue[index]);
    if (score < bestScore) {
      best = index;
      bestScore = score;
      if (score === 0) break;
    }
  }
  return queue.splice(best, 1)[0];
}

function runLowPriority(callback, visible) {
  if (visible) return setTimeout(callback, 0);
  if ('requestIdleCallback' in window) return requestIdleCallback(callback, { timeout: 900 });
  return setTimeout(callback, 80);
}

function waitFor(target, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for video ${event}`));
    }, timeout);
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Video could not be decoded')); };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', failed, { once: true });
  });
}

function decodedFrame(video, timeout = 5000) {
  if (!('requestVideoFrameCallback' in video)) return new Promise(resolve => setTimeout(resolve, 70));
  return new Promise(resolve => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve();
    }, timeout);
    video.requestVideoFrameCallback(() => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

async function seekToFrame(video, time) {
  if (Math.abs(video.currentTime - time) > .005) {
    video.currentTime = time;
    await waitFor(video, 'seeked');
  }
  if (video.readyState < 2) await waitFor(video, 'loadeddata');
  await decodedFrame(video);
}

function canvasBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
}

function frameLooksBlank(canvas) {
  const width = Math.min(48, canvas.width);
  const height = Math.min(32, canvas.height);
  if (!width || !height) return true;
  const sample = document.createElement('canvas');
  sample.width = width;
  sample.height = height;
  const context = sample.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  let total = 0;
  let total2 = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 16) {
    const value = (data[index] + data[index + 1] + data[index + 2]) / 3;
    total += value;
    total2 += value * value;
    count++;
  }
  const mean = total / Math.max(1, count);
  const variance = total2 / Math.max(1, count) - mean * mean;
  return mean < 5 && variance < 8;
}

function candidateTimes(duration) {
  if (!Number.isFinite(duration) || duration <= .05) return [0];
  const end = Math.max(0, duration - .03);
  const candidates = [
    Math.min(end, Math.min(2, Math.max(.12, duration * .08))),
    Math.min(end, Math.min(12, Math.max(.5, duration * .3))),
    Math.min(end, Math.min(30, Math.max(1, duration * .6)))
  ];
  return [...new Set(candidates.map(value => Number(value.toFixed(3))))];
}

async function cachedThumb(hash) {
  const db = await cache();
  if (!db) return null;
  return idb(db.transaction('thumbs').objectStore('thumbs').get(hash));
}

async function saveResult(hash, blob, width, height) {
  const db = await cache();
  if (!db) return;
  const file = await idb(db.transaction('files').objectStore('files').get(hash));
  const transaction = db.transaction(['thumbs', 'files'], 'readwrite');
  transaction.objectStore('thumbs').put({ hash, blob, videoVersion: VIDEO_THUMB_VERSION });
  if (file) {
    file.width = width;
    file.height = height;
    if (file.mime === 'application/octet-stream' && isVideoName(file.filename)) file.mime = 'video/mp4';
    transaction.objectStore('files').put(file);
  }
}

function applyBlob(hash, blob) {
  if (!blob) return;
  let url = urls.get(hash);
  if (!url) {
    url = URL.createObjectURL(blob);
    urls.set(hash, url);
  }

  files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"] .media-thumb`).forEach(box => {
    box.classList.remove('thumb-failed');
    let image = box.querySelector('img.cached-thumb');
    if (!image) {
      image = document.createElement('img');
      image.className = 'cached-thumb';
      image.loading = 'lazy';
      image.alt = box.closest('[data-hash]')?.getAttribute('title') || cardName(box.closest('[data-hash]'));
      const old = box.querySelector('img,video,.video-thumb-pending');
      if (old) old.replaceWith(image);
      else box.prepend(image);
    }
    image.src = url;
  });
}

function markFailed(hash, message) {
  files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"] .media-thumb`).forEach(box => {
    box.classList.add('thumb-failed');
    box.title = `Preview unavailable: ${message}`;
  });
}

async function generate(hash) {
  const existing = await cachedThumb(hash);
  if (existing?.blob && existing.videoVersion === VIDEO_THUMB_VERSION) {
    applyBlob(hash, existing.blob);
    return true;
  }
  if (!cardFor(hash)) return false;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = `/api/objects/${hash}`;

  try {
    if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('Video has no frame size');

    const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    const times = candidateTimes(video.duration);

    for (let index = 0; index < times.length; index++) {
      await seekToFrame(video, times[index]);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (index === times.length - 1 || !frameLooksBlank(canvas)) break;
    }

    const blob = await canvasBlob(canvas);
    if (!blob) throw new Error('Could not encode video thumbnail');
    await saveResult(hash, blob, width, height);
    applyBlob(hash, blob);
    attempts.delete(hash);
    return true;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function retry(hash, error) {
  const count = (attempts.get(hash) || 0) + 1;
  attempts.set(hash, count);
  if (count >= MAX_ATTEMPTS || !cardFor(hash)) {
    markFailed(hash, error.message);
    return;
  }
  const delay = count === 1 ? 500 : 1800;
  const timer = setTimeout(() => {
    retryTimers.delete(hash);
    enqueue(hash, true);
  }, delay);
  retryTimers.set(hash, timer);
}

function pump() {
  if (busy || !queue.length) return;
  const hash = takeNext();
  if (!hash) return;
  const card = cardFor(hash);
  const rect = card?.getBoundingClientRect();
  const visible = Boolean(rect && rect.bottom >= 0 && rect.top <= innerHeight);
  busy = true;
  runLowPriority(async () => {
    try {
      await generate(hash);
    } catch (error) {
      console.warn('Video thumbnail failed', hash, error);
      retry(hash, error);
    } finally {
      queued.delete(hash);
      busy = false;
      if (queue.length) setTimeout(pump, 35);
    }
  }, visible);
}

new MutationObserver(scheduleScan).observe(files, { childList: true, subtree: true });
window.addEventListener('scroll', () => {
  if (queue.length && !busy) pump();
}, { passive: true });
scheduleScan();

window.addEventListener('beforeunload', () => {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  for (const timer of retryTimers.values()) clearTimeout(timer);
});
