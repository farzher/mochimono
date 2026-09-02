const EDGE = 768;
const VERSION = 3;
const queue = new Map();
let timer = 0;
let busy = false;

const MIME = new Map([
  ['jpg','image/jpeg'],['jpeg','image/jpeg'],['png','image/png'],['gif','image/gif'],['webp','image/webp'],['heic','image/heic'],['heif','image/heic'],['avif','image/avif'],['bmp','image/bmp'],['tif','image/tiff'],['tiff','image/tiff'],
  ['mp4','video/mp4'],['m4v','video/mp4'],['mov','video/quicktime'],['mkv','video/x-matroska'],['webm','video/webm'],['avi','video/x-msvideo'],['mpg','video/mpeg'],['mpeg','video/mpeg'],['m2v','video/mpeg'],['mts','video/mp2t'],['m2ts','video/mp2t'],['3gp','video/3gpp']
]);

const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const sourceMime = record => MIME.get(extension(record.filename)) || 'application/octet-stream';
const visibleCard = hash => {
  const card = document.querySelector(`#files [data-hash="${CSS.escape(hash)}"]`);
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  return rect.bottom >= -200 && rect.top <= innerHeight + 200 ? card : null;
};

function waitFor(target, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Timed out waiting for ${event}`)), timeout);
    const done = error => {
      clearTimeout(timer);
      target.removeEventListener(event, loaded);
      target.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const loaded = () => done();
    const failed = () => done(new Error('Media could not be decoded'));
    target.addEventListener(event, loaded, { once: true });
    target.addEventListener('error', failed, { once: true });
  });
}

const canvasFor = (width, height) => typeof OffscreenCanvas !== 'undefined'
  ? new OffscreenCanvas(width, height)
  : Object.assign(document.createElement('canvas'), { width, height });

async function canvasBlob(canvas) {
  const blob = 'convertToBlob' in canvas
    ? await canvas.convertToBlob({ type: 'image/webp', quality: .82 })
    : await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
  if (!blob) throw new Error('Could not encode preview');
  return blob;
}

async function decodeImage(blob) {
  if ('createImageBitmap' in window) return createImageBitmap(blob, { imageOrientation: 'from-image' });
  const image = new Image();
  const url = URL.createObjectURL(blob);
  try {
    image.src = url;
    if (!image.complete) await waitFor(image, 'load');
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageResult(hash) {
  const response = await fetch(`/api/objects/${hash}`);
  if (!response.ok) throw new Error('Image unavailable');
  const image = await decodeImage(await response.blob());
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  const scale = Math.min(1, EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = canvasFor(width, height);
  canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, width, height);
  image.close?.();
  return { blob: await canvasBlob(canvas), width, height, duration: null };
}

async function videoResult(hash) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = `/api/objects/${hash}`;
  try {
    if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
    if (!video.videoWidth || !video.videoHeight) throw new Error('Video has no frame size');
    if (video.duration > .2) {
      video.currentTime = Math.min(Math.max(0, video.duration - .02), 1);
      await waitFor(video, 'seeked');
    }
    if (video.readyState < 2) await waitFor(video, 'loadeddata');
    const scale = Math.min(1, EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = canvasFor(width, height);
    canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, width, height);
    return { blob: await canvasBlob(canvas), width, height, duration: Number.isFinite(video.duration) ? video.duration : null };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

async function generate(record) {
  const existing = await fetch(`/api/thumbs/${record.hash}?v=${VERSION}`, { method: 'HEAD' }).catch(() => null);
  if (existing?.ok) return null;
  const result = record.kind === 'video' ? await videoResult(record.hash) : await imageResult(record.hash);
  const response = await fetch(`/api/thumbs/${record.hash}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/webp',
      'x-mochimono-thumb-version': String(VERSION),
      'x-mochimono-width': String(result.width),
      'x-mochimono-height': String(result.height),
      ...(result.duration == null ? {} : { 'x-mochimono-duration': String(result.duration) }),
      'x-mochimono-source-mime': sourceMime(record)
    },
    body: result.blob
  });
  if (!response.ok) throw new Error('Could not save preview');
  return result;
}

function schedule(delay = 4000) {
  if (timer || busy || !queue.size) return;
  timer = setTimeout(pump, delay);
}

function pump() {
  timer = 0;
  if (busy || document.hidden) return schedule(1000);
  let record = null;
  for (const [hash, candidate] of queue) {
    queue.delete(hash);
    if (visibleCard(hash)) {
      record = candidate;
      break;
    }
  }
  if (!record) return;
  busy = true;
  const run = () => generate(record).then(result => {
    window.dispatchEvent(new CustomEvent('mochimono:browser-thumbnail-ready', { detail: { hash: record.hash, ...(result || {}) } }));
  }).catch(() => {}).finally(() => {
    busy = false;
    schedule(250);
  });
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 20);
}

export function queueBrowserThumbnail(record) {
  if (!record?.hash || !record.kind) return;
  queue.set(record.hash, record);
  schedule();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(100); });
