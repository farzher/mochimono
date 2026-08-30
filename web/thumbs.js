const files = document.querySelector('#files');
const THUMB_VERSION = 3;
const THUMB_EDGE = 768;
const PRIORITY_REFRESH = 5_000;
const IMAGE_FALLBACK_DELAY = 8_000;
const VIDEO_FALLBACK_DELAY = 15_000;
const MAX_FALLBACK_URLS = 40;

const states = new Map();
const requestTimes = new Map();
const requested = new Set();
const retryTimers = new Map();
const fallbackQueue = [];
const fallbackQueued = new Set();
const fallbackUrls = new Map();
let scanFrame = 0;
let requestTimer = 0;
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

function filenameFor(card) {
  return card.title || card.querySelector('strong')?.textContent || '';
}

function kindForCard(card) {
  if (card.classList.contains('video-card')) return 'video';
  if (card.classList.contains('media-card')) return 'image';
  const ext = extension(filenameFor(card));
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return '';
}

function sourceMime(record) {
  return MIME.get(extension(record.filename)) || 'application/octet-stream';
}

function recordFor(card, kind = kindForCard(card)) {
  return {
    hash: card.dataset.hash,
    filename: filenameFor(card),
    mime: kind ? `${kind}/unknown` : ''
  };
}

function thumbUrl(hash) {
  return `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
}

function visible(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= innerHeight;
}

function cardsFor(hash) {
  return files.querySelectorAll(`[data-hash="${CSS.escape(hash)}"]`);
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
    box.prepend(pending);
  }
}

function applyDimensions(hash, width, height) {
  if (!width || !height) return;
  const ratio = Math.max(.65, Math.min(2.1, width / height));
  for (const card of cardsFor(hash)) if (card.classList.contains('media-card')) card.style.setProperty('--ratio', ratio);
}

function clearRetry(hash) {
  const timer = retryTimers.get(hash);
  if (timer) clearTimeout(timer);
  retryTimers.delete(hash);
}

function trimFallbackUrls() {
  while (fallbackUrls.size > MAX_FALLBACK_URLS) {
    const [hash, url] = fallbackUrls.entries().next().value;
    URL.revokeObjectURL(url);
    fallbackUrls.delete(hash);
  }
}

function applyFallbackBlob(hash, blob, width, height) {
  const old = fallbackUrls.get(hash);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  fallbackUrls.set(hash, url);
  trimFallbackUrls();
  applyDimensions(hash, width, height);

  for (const card of cardsFor(hash)) {
    const kind = kindForCard(card);
    const box = mediaBox(card, kind);
    if (!box) continue;
    box.classList.remove('thumb-failed');
    box.removeAttribute('title');
    const image = document.createElement('img');
    image.className = 'cached-thumb';
    image.decoding = 'async';
    image.alt = filenameFor(card);
    image.src = url;
    box.querySelector('img,.video-thumb-pending')?.replaceWith(image) || box.prepend(image);
  }
}

function queueRequest(hash) {
  const time = performance.now();
  if (time - (requestTimes.get(hash) || -Infinity) < PRIORITY_REFRESH) return;
  requestTimes.set(hash, time);
  requested.add(hash);
  if (!requestTimer) requestTimer = setTimeout(flushRequests, 25);
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
  if (requested.size) requestTimer = setTimeout(flushRequests, 30);
}

function queueFallback(record, kind) {
  const state = states.get(record.hash) || {};
  if (state.ready || fallbackQueued.has(record.hash) || (state.nextFallback || 0) > performance.now()) return;
  fallbackQueued.add(record.hash);
  fallbackQueue.push({ record, kind });
  pumpFallback();
}

function handleMissing(card, kind) {
  const hash = card.dataset.hash;
  const state = states.get(hash) || {};
  const now = performance.now();
  state.loading = false;
  state.missing = true;
  state.missingSince ||= now;
  states.set(hash, state);

  const box = mediaBox(card, kind);
  pendingBox(box, hash);
  if (visible(card)) {
    queueRequest(hash);
    const fallbackDelay = kind === 'video' ? VIDEO_FALLBACK_DELAY : IMAGE_FALLBACK_DELAY;
    if (now - state.missingSince >= fallbackDelay) queueFallback(recordFor(card, kind), kind);
  }

  if (!retryTimers.has(hash)) {
    const elapsed = now - state.missingSince;
    const delay = elapsed < 15_000 ? 500 : elapsed < 60_000 ? 1500 : 5000;
    retryTimers.set(hash, setTimeout(() => {
      retryTimers.delete(hash);
      retryHash(hash);
    }, delay));
  }
}

function canonicalLoaded(hash, image) {
  const state = states.get(hash) || {};
  state.ready = true;
  state.loading = false;
  state.missing = false;
  state.missingSince = 0;
  states.set(hash, state);
  clearRetry(hash);
  requestTimes.delete(hash);
  applyDimensions(hash, image.naturalWidth, image.naturalHeight);

  for (const card of cardsFor(hash)) {
    const box = card.querySelector('.media-thumb');
    if (!box) continue;
    box.classList.remove('thumb-failed');
    box.removeAttribute('title');
  }
}

function loadCanonical(card, force = false) {
  const hash = card.dataset.hash;
  const kind = kindForCard(card);
  if (!hash || !kind) return;
  const state = states.get(hash) || {};
  if (state.ready && !force) return;

  const box = mediaBox(card, kind);
  if (!box) return;
  let image = box.querySelector('img.server-thumb');
  if (image && image.dataset.bound === '1') return;

  if (!image) {
    image = document.createElement('img');
    image.className = 'cached-thumb server-thumb';
    image.decoding = 'async';
    image.alt = filenameFor(card);
    const old = box.querySelector('img,video,.video-thumb-pending');
    if (old) old.replaceWith(image);
    else box.prepend(image);
  }

  image.dataset.bound = '1';
  image.addEventListener('load', () => canonicalLoaded(hash, image), { once: true });
  image.addEventListener('error', () => {
    image.remove();
    handleMissing(card, kind);
  }, { once: true });
  state.loading = true;
  states.set(hash, state);
  image.src = thumbUrl(hash);
}

function retryHash(hash) {
  const state = states.get(hash);
  if (state?.ready) return;
  for (const card of cardsFor(hash)) loadCanonical(card, true);
}

function scan() {
  scanFrame = 0;
  if (document.hidden) return;
  for (const card of files.querySelectorAll('[data-hash]')) {
    const kind = kindForCard(card);
    if (!kind) continue;
    const state = states.get(card.dataset.hash);
    if (state?.ready) {
      if (!card.querySelector('.cached-thumb')) loadCanonical(card, true);
      continue;
    }
    if (!state?.loading) loadCanonical(card);
    if (state?.missing && visible(card)) {
      queueRequest(card.dataset.hash);
      const elapsed = performance.now() - (state.missingSince || performance.now());
      const fallbackDelay = kind === 'video' ? VIDEO_FALLBACK_DELAY : IMAGE_FALLBACK_DELAY;
      if (elapsed >= fallbackDelay) queueFallback(recordFor(card, kind), kind);
    }
  }
}

function scheduleScan() {
  if (!scanFrame) scanFrame = requestAnimationFrame(scan);
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
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
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
  try {
    const response = await fetch(thumbUrl(hash), { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

async function runFallback(job) {
  const { record, kind } = job;
  const state = states.get(record.hash) || {};
  if (state.ready) return;
  if (await canonicalExists(record.hash)) {
    retryHash(record.hash);
    return;
  }

  try {
    const result = kind === 'image' ? await imageFallback(record) : await videoFallback(record);
    if (states.get(record.hash)?.ready) return;
    if (await canonicalExists(record.hash)) {
      retryHash(record.hash);
      return;
    }
    await uploadFallback(record, result);
    applyFallbackBlob(record.hash, result.blob, result.width, result.height);
    states.set(record.hash, { ready: true });
    clearRetry(record.hash);
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
  if (fallbackActive || !fallbackQueue.length || document.hidden) return;
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

new MutationObserver(scheduleScan).observe(files, { childList: true, subtree: true });
window.addEventListener('scroll', scheduleScan, { passive: true });
window.addEventListener('resize', scheduleScan, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { scheduleScan(); pumpFallback(); }
});
const rescan = setInterval(scheduleScan, 3000);
scheduleScan();

window.addEventListener('beforeunload', () => {
  clearInterval(rescan);
  clearTimeout(requestTimer);
  for (const timer of retryTimers.values()) clearTimeout(timer);
  for (const url of fallbackUrls.values()) URL.revokeObjectURL(url);
});
