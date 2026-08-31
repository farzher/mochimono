const files = document.querySelector('#files');
const nativeFetch = window.fetch.bind(window);
const THUMB_VERSION = 3;
const THUMB_EDGE = 768;
const queue = [];
let working = false;

const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);

function extension(path) {
  return String(path || '').toLowerCase().match(/\.([^.\/]+)$/)?.[1] || '';
}

function kind(file, path) {
  const base = String(file?.type || '').split('/')[0];
  if (base === 'image' || base === 'video') return base;
  const ext = extension(path || file?.name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return '';
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement('canvas'), { width, height });
}

function canvasBlob(canvas) {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/webp', quality: .82 });
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
}

function dimensions(width, height) {
  const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function imagePreview(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const [width, height] = dimensions(bitmap.width, bitmap.height);
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, width, height);
    return { blob: await canvasBlob(canvas), width, height, duration: null };
  } finally {
    bitmap.close?.();
  }
}

function waitFor(target, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)); }, timeout);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Media could not be decoded')); };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', fail);
    };
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}

async function videoPreview(file) {
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;
  try {
    if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
    if (!video.videoWidth || !video.videoHeight) throw new Error('Video has no frame size');
    const [width, height] = dimensions(video.videoWidth, video.videoHeight);
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - .02) : .2;
    const seek = Math.min(.5, end);
    if (seek > 0) {
      video.currentTime = seek;
      await waitFor(video, 'seeked');
    }
    if (video.readyState < 2) await waitFor(video, 'loadeddata');
    await new Promise(resolve => video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => resolve()) : setTimeout(resolve, 60));
    context.drawImage(video, 0, 0, width, height);
    return { blob: await canvasBlob(canvas), width, height, duration: Number.isFinite(video.duration) ? video.duration : null };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function savePreview(job) {
  const result = job.kind === 'image' ? await imagePreview(job.file) : await videoPreview(job.file);
  if (!result.blob) return;
  const response = await nativeFetch(`/api/thumbs/${job.hash}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/webp',
      'x-mochimono-thumb-version': String(THUMB_VERSION),
      'x-mochimono-width': String(result.width || 0),
      'x-mochimono-height': String(result.height || 0),
      ...(result.duration == null ? {} : { 'x-mochimono-duration': String(result.duration) }),
      'x-mochimono-source-mime': job.file.type || `${job.kind}/unknown`
    },
    body: result.blob
  });
  if (!response.ok) throw new Error('Could not save preview');
}

function pump() {
  if (working || !queue.length) return;
  working = true;
  const job = queue.shift();
  savePreview(job).catch(() => {}).finally(() => {
    working = false;
    pump();
  });
}

function enqueue(file, hash, path) {
  const type = kind(file, path);
  if (!type || !hash) return;
  queue.push({ file, hash, path, kind: type });
  pump();
}

window.fetch = async function(input, init = {}) {
  const response = await nativeFetch(input, init);
  try {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname === '/api/client/import/file' && String(init.method || 'GET').toUpperCase() === 'PUT' && init.body instanceof Blob && response.ok) {
      const file = init.body;
      const path = url.searchParams.get('path') || file.name;
      response.clone().json().then(data => {
        if (!data.ignored) enqueue(file, data.hash, path);
      }).catch(() => {});
    }
  } catch {}
  return response;
};

function stabilize(image) {
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('server-thumb') || image.dataset.stableProbe === '1') return;
  image.dataset.stableProbe = '1';
  const box = image.closest('.media-thumb');
  if (!box) return;
  let pending = box.querySelector('.video-thumb-pending');
  if (!pending) {
    pending = document.createElement('span');
    pending.className = 'video-thumb-pending';
    pending.dataset.videoThumb = image.closest('[data-hash]')?.dataset.hash || '';
    image.before(pending);
  }
  image.style.visibility = 'hidden';
  const ready = () => {
    image.style.visibility = '';
    pending?.remove();
  };
  image.addEventListener('load', ready, { once: true });
  if (image.complete && image.naturalWidth) ready();
}

if (files) {
  files.querySelectorAll('img.server-thumb').forEach(stabilize);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.('img.server-thumb')) stabilize(node);
      node.querySelectorAll?.('img.server-thumb').forEach(stabilize);
    }
  }).observe(files, { childList: true, subtree: true });
}
