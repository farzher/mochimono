const files = document.querySelector('#files');
const THUMB_VERSION = 3;
const THUMB_EDGE = 768;
const queue = [];
const queued = new Set();
let working = false;

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement('canvas'), { width, height });
}

function canvasBlob(canvas) {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/webp', quality: .82 });
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
}

function scaled(width, height) {
  const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
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

async function imagePreview(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const [width, height] = scaled(bitmap.width, bitmap.height);
    const canvas = makeCanvas(width, height);
    canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, width, height);
    return { blob: await canvasBlob(canvas), width, height, duration: null };
  } finally {
    bitmap.close?.();
  }
}

async function videoPreview(blob) {
  const video = document.createElement('video');
  const url = URL.createObjectURL(blob);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;
  try {
    if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
    if (!video.videoWidth || !video.videoHeight) throw new Error('Video has no frame size');
    const [width, height] = scaled(video.videoWidth, video.videoHeight);
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

async function canonicalExists(hash) {
  try { return (await fetch(`/api/thumbs/${hash}`, { method: 'HEAD' })).ok; }
  catch { return false; }
}

async function repair(job) {
  if (await canonicalExists(job.hash)) return;
  const source = await fetch(`/api/objects/${job.hash}`);
  if (!source.ok) throw new Error('Object unavailable');
  const blob = await source.blob();
  const mime = blob.type || job.mime || 'application/octet-stream';
  const kind = mime.startsWith('video/') || job.video ? 'video' : 'image';
  const result = kind === 'video' ? await videoPreview(blob) : await imagePreview(blob);
  if (await canonicalExists(job.hash)) return;
  const response = await fetch(`/api/thumbs/${job.hash}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/webp',
      'x-mochimono-thumb-version': String(THUMB_VERSION),
      'x-mochimono-width': String(result.width || 0),
      'x-mochimono-height': String(result.height || 0),
      ...(result.duration == null ? {} : { 'x-mochimono-duration': String(result.duration) }),
      'x-mochimono-source-mime': mime
    },
    body: result.blob
  });
  if (!response.ok) throw new Error('Could not save preview');
}

function pump() {
  if (working || !queue.length || document.hidden) return;
  working = true;
  const job = queue.shift();
  repair(job).catch(() => {}).finally(() => {
    queued.delete(job.hash);
    working = false;
    pump();
  });
}

function enqueue(card) {
  const hash = card?.dataset.hash;
  if (!hash || queued.has(hash)) return;
  queued.add(hash);
  queue.push({
    hash,
    video: card.classList.contains('video-card'),
    mime: card.classList.contains('video-card') ? 'video/unknown' : 'image/unknown'
  });
  pump();
}

function watch(image) {
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('server-thumb') || image.dataset.clientRepair === '1') return;
  image.dataset.clientRepair = '1';
  const card = image.closest('.file-card[data-hash]');
  image.addEventListener('error', () => enqueue(card), { once: true });
}

if (files) {
  files.querySelectorAll('img.server-thumb').forEach(watch);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.('img.server-thumb')) watch(node);
      node.querySelectorAll?.('img.server-thumb').forEach(watch);
    }
  }).observe(files, { childList: true, subtree: true });
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });
