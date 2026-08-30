const files = document.querySelector('#files');
const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 2;
const THUMB_EDGE = 768;
const queue = [];
const queued = new Set();
const urls = new Map();
let cachePromise;
let busy = false;
let scanFrame = 0;

const VIDEO_EXTENSIONS = new Set(['m4v', 'mp4', 'mov', 'mkv', 'webm', 'avi']);

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
  files.querySelectorAll('.file-row[data-hash], .folder-row.file-folder-row[data-hash]').forEach(ensureTinyPlaceholder);
  files.querySelectorAll('video.video-thumb').forEach(replaceVideoElement);
  files.querySelectorAll('.video-thumb-pending').forEach(element => enqueue(placeholderHash(element)));
}

function enqueue(hash) {
  if (!hash || queued.has(hash) || urls.has(hash)) return;
  queued.add(hash);
  queue.push(hash);
  pump();
}

function idle(callback) {
  if ('requestIdleCallback' in window) requestIdleCallback(callback, { timeout: 1500 });
  else setTimeout(callback, 60);
}

function waitFor(target, event, timeout = 12000) {
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

function canvasBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
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
  transaction.objectStore('thumbs').put({ hash, blob });
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

async function generate(hash) {
  const existing = await cachedThumb(hash);
  if (existing?.blob) {
    applyBlob(hash, existing.blob);
    return;
  }
  if (!files.querySelector(`[data-hash="${CSS.escape(hash)}"]`)) return;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = `/api/objects/${hash}`;

  try {
    if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('Video has no frame size');

    if (Number.isFinite(video.duration) && video.duration > .05) {
      const target = Math.min(.1, Math.max(.01, video.duration / 20));
      if (Math.abs(video.currentTime - target) > .005) {
        video.currentTime = target;
        await waitFor(video, 'seeked');
      }
    } else if (video.readyState < 2) {
      await waitFor(video, 'loadeddata');
    }

    const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas);
    if (!blob) throw new Error('Could not encode video thumbnail');
    await saveResult(hash, blob, width, height);
    applyBlob(hash, blob);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  idle(async () => {
    const hash = queue.shift();
    try {
      await generate(hash);
    } catch (error) {
      console.warn('Video thumbnail failed', error);
    } finally {
      queued.delete(hash);
      busy = false;
      if (queue.length) pump();
    }
  });
}

new MutationObserver(scheduleScan).observe(files, { childList: true, subtree: true });
scheduleScan();

window.addEventListener('beforeunload', () => {
  for (const url of urls.values()) URL.revokeObjectURL(url);
});
