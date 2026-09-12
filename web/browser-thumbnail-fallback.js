const EDGE = 768;
const VERSION = 3;
const HEIC_CACHE_REV = 2;
const queue = new Map();
const inflight = new Map();
const viewInflight = new Map();
const repairedHeic = new Set();
let timer = 0;
let busy = false;

const MIME = new Map([
  ['jpg','image/jpeg'],['jpeg','image/jpeg'],['png','image/png'],['gif','image/gif'],['webp','image/webp'],['heic','image/heic'],['heif','image/heif'],['avif','image/avif'],['bmp','image/bmp'],['tif','image/tiff'],['tiff','image/tiff'],
  ['mp4','video/mp4'],['m4v','video/mp4'],['mov','video/quicktime'],['mkv','video/x-matroska'],['webm','video/webm'],['avi','video/x-msvideo'],['mpg','video/mpeg'],['mpeg','video/mpeg'],['m2v','video/mpeg'],['mts','video/mp2t'],['m2ts','video/mp2t'],['3gp','video/3gpp']
]);

const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const sourceMime = record => MIME.get(extension(record.filename)) || 'application/octet-stream';
export const isHeicRecord = record => ['heic','heif'].includes(extension(record?.filename)) || ['image/heic','image/heif'].includes(String(record?.mime || '').toLowerCase());
export const heicThumbUrl = hash => `/api/thumbs/${encodeURIComponent(hash)}?v=${VERSION}&heic=${HEIC_CACHE_REV}`;
const visibleCard = hash => {
  const card = document.querySelector(`#files [data-hash="${CSS.escape(hash)}"]`);
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  return rect.bottom >= -300 && rect.top <= innerHeight + 300 ? card : null;
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

async function mediaSource(record) {
  const local = await window.mochimonoBrowserFolders?.fileForHash?.(record.hash).catch?.(() => null);
  if (local) return { blob:local, local:true };
  const response = await fetch(`/api/objects/${encodeURIComponent(record.hash)}`, { cache:'force-cache' });
  if (!response.ok) throw new Error('Media source is unavailable');
  return { blob:await response.blob(), local:false };
}

async function imageResult(record) {
  const source = await mediaSource(record);
  const image = await decodeImage(source.blob);
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  const scale = Math.min(1, EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = canvasFor(width, height);
  canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, width, height);
  image.close?.();
  return { blob: await canvasBlob(canvas), width, height, duration: null, local:source.local };
}

async function videoResult(record) {
  const source = await mediaSource(record);
  const video = document.createElement('video');
  const url = URL.createObjectURL(source.blob);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;
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
    return { blob: await canvasBlob(canvas), width, height, duration: Number.isFinite(video.duration) ? video.duration : null, local:source.local };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function heicSource(record) {
  const local = await window.mochimonoBrowserFolders?.fileForHash?.(record.hash).catch?.(() => null);
  if (local) return local;
  const response = await fetch(`/api/objects/${encodeURIComponent(record.hash)}`, { cache:'force-cache' });
  if (!response.ok) throw new Error('HEIC source is unavailable');
  return response.blob();
}

async function heicResult(record) {
  const file = await heicSource(record);
  const response = await fetch(`/api/client/browser-heic-thumb/${record.hash}`, {
    method:'PUT',
    headers:{ 'content-type':file.type || sourceMime(record) || 'image/heic' },
    body:file
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Could not decode HEIC preview');
  return { width:Number(result.width) || 0, height:Number(result.height) || 0, duration:null, saved:true, heic:true, local:true };
}

export function heicViewBlob(record, edge = 4096) {
  if (!record?.hash || !isHeicRecord(record)) return Promise.reject(new Error('Not a HEIC image'));
  edge = Math.max(1024, Math.min(4096, Math.round(Number(edge) || 4096)));
  const key = `${record.hash}:${edge}`;
  let pending = viewInflight.get(key);
  if (!pending) {
    pending = (async () => {
      const file = await heicSource(record);
      const response = await fetch(`/api/client/browser-heic-thumb/${record.hash}?view=1&edge=${edge}`, {
        method:'PUT',
        headers:{ 'content-type':file.type || sourceMime(record) || 'image/heic' },
        body:file
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not decode HEIC image');
      }
      return {
        blob:await response.blob(),
        width:Number(response.headers.get('x-mochimono-width')) || 0,
        height:Number(response.headers.get('x-mochimono-height')) || 0,
        edge
      };
    })().finally(() => { if (viewInflight.get(key) === pending) viewInflight.delete(key); });
    viewInflight.set(key, pending);
  }
  return pending;
}

async function generate(record) {
  if (isHeicRecord(record)) return heicResult(record);
  const existing = await fetch(`/api/thumbs/${record.hash}?v=${VERSION}`, { method: 'HEAD' }).catch(() => null);
  if (existing?.ok) return null;
  const result = record.kind === 'video' ? await videoResult(record) : await imageResult(record);
  const endpoint = result.local ? `/api/client/browser-thumb/${record.hash}` : `/api/thumbs/${record.hash}`;
  const headers = result.local ? {
    'content-type':'image/webp',
    'x-mochimono-width':String(result.width),
    'x-mochimono-height':String(result.height)
  } : {
    'content-type': 'image/webp',
    'x-mochimono-thumb-version': String(VERSION),
    'x-mochimono-width': String(result.width),
    'x-mochimono-height': String(result.height),
    ...(result.duration == null ? {} : { 'x-mochimono-duration': String(result.duration) }),
    'x-mochimono-source-mime': sourceMime(record)
  };
  const response = await fetch(endpoint, { method:'PUT', headers, body:result.blob });
  if (!response.ok) throw new Error('Could not save preview');
  return result;
}

export function ensureBrowserThumbnail(record) {
  if (!record?.hash || !record.kind) return Promise.resolve(null);
  const hash = String(record.hash);
  if (isHeicRecord(record) && repairedHeic.has(hash)) return Promise.resolve(null);
  let pending = inflight.get(hash);
  if (!pending) {
    pending = generate(record).then(result => {
      if (isHeicRecord(record)) repairedHeic.add(hash);
      return result;
    }).finally(() => {
      if (inflight.get(hash) === pending) inflight.delete(hash);
    });
    inflight.set(hash, pending);
  }
  return pending;
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
    if (candidate.urgent || visibleCard(hash)) {
      record = candidate;
      break;
    }
  }
  if (!record) return;
  busy = true;
  const run = () => ensureBrowserThumbnail(record).then(result => {
    if (result) window.dispatchEvent(new CustomEvent('mochimono:browser-thumbnail-ready', { detail: { hash: record.hash, ...result } }));
  }).catch(() => {}).finally(() => {
    busy = false;
    schedule(250);
  });
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
  else setTimeout(run, 20);
}

export function queueBrowserThumbnail(record) {
  if (!record?.hash || !record.kind) return;
  const queued = isHeicRecord(record) ? { ...record, urgent:true } : record;
  queue.set(record.hash, queued);
  schedule(queued.urgent ? 0 : 4000);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(100); });
