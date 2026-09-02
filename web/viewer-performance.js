const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerClose = document.querySelector('#viewer-close');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');
const viewerMedia = document.querySelector('#viewer-media');
const viewerInfo = document.querySelector('#viewerInfo');
const files = document.querySelector('#files');

const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
const mediaSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
const arrows = new Set(['ArrowLeft','ArrowRight','ArrowDown','ArrowUp']);
const objectHash = value => String(value || '').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentHash = () => objectHash(viewerOpen?.getAttribute('href'));
const RAPID_MS = 90;

let rapidUntil = 0;
let settleTimer = 0;
let deferredImage = null;
let deferredVideo = null;
let queuedDirection = 0;
let navFrame = 0;
const settleCallbacks = new Set();

const rapid = () => performance.now() < rapidUntil;

function nativeImageSrc(image, value) {
  imageSrc?.set?.call(image, value);
}

function clearDeferred() {
  deferredImage = null;
  deferredVideo = null;
}

function scheduleSettle() {
  if (settleTimer) return;
  settleTimer = setTimeout(settle, Math.max(0, rapidUntil - performance.now()) + 3);
}

function settle() {
  settleTimer = 0;
  const wait = rapidUntil - performance.now();
  if (wait > 0) {
    settleTimer = setTimeout(settle, wait + 3);
    return;
  }

  const image = deferredImage;
  deferredImage = null;
  if (image && !viewer.hidden && currentHash() === image.hash) nativeImageSrc(image.element, image.src);

  const video = deferredVideo;
  deferredVideo = null;
  if (video && !viewer.hidden && currentHash() === video.hash && video.element.isConnected) {
    video.element.src = video.src;
    video.element.autoplay = true;
    video.element.play().catch(() => {});
  }

  const callbacks = [...settleCallbacks];
  settleCallbacks.clear();
  for (const callback of callbacks) callback();
}

function defer(callback) {
  if (typeof callback !== 'function' || !rapid()) return false;
  settleCallbacks.add(callback);
  scheduleSettle();
  return true;
}

window.mochimonoViewerPerformance = { rapid, defer };

function interceptImage(image, value) {
  const hash = objectHash(value);
  if (!hash || !viewer || viewer.hidden || image.isConnected || !rapid()) return false;
  if (hash === currentHash()) deferredImage = { element: image, src: value, hash };
  return true;
}

if (imageSrc?.get && imageSrc?.set) {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    enumerable: imageSrc.enumerable,
    get: imageSrc.get,
    set(value) {
      if (!interceptImage(this, value)) imageSrc.set.call(this, value);
    }
  });
}

if (mediaSrc?.get && mediaSrc?.set) {
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    enumerable: mediaSrc.enumerable,
    get: mediaSrc.get,
    set(value) {
      if (this instanceof HTMLVideoElement && !this.isConnected && objectHash(value) && rapid()) return;
      mediaSrc.set.call(this, value);
    }
  });
}

function deferVisibleVideo() {
  if (!rapid() || viewer?.hidden) return;
  const video = viewerMedia?.querySelector('video[src]');
  const hash = currentHash();
  const src = video?.getAttribute('src');
  if (!video || !hash || !src) return;
  video.pause();
  video.autoplay = false;
  video.poster = `/api/thumbs/${hash}?v=3`;
  video.removeAttribute('src');
  video.load();
  deferredVideo = { element: video, src, hash };
  scheduleSettle();
}

function navigateOne(direction) {
  const button = direction < 0 ? viewerPrev : viewerNext;
  if (!button || button.disabled || viewer.hidden) return false;
  if (typeof button.onclick === 'function') button.onclick.call(button);
  else button.click();
  deferVisibleVideo();
  return true;
}

function flushNavigation() {
  navFrame = 0;
  const direction = queuedDirection;
  queuedDirection = 0;
  if (!direction || viewer.hidden) return;
  if (navigateOne(direction) && queuedDirection) navFrame = requestAnimationFrame(flushNavigation);
}

function queueNavigation(direction) {
  rapidUntil = performance.now() + RAPID_MS;
  queuedDirection = direction;
  scheduleSettle();
  if (navFrame) return;
  queuedDirection = 0;
  if (!navigateOne(direction)) return;
  navFrame = requestAnimationFrame(flushNavigation);
}

function prepareGridReturn() {
  if (!files || viewer?.hidden) return;
  const hash = currentHash();
  files.querySelector(`[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
}

document.addEventListener('keydown', event => {
  if (!viewer || viewer.hidden) return;
  if (event.key === 'Escape') {
    if (!document.querySelector('dialog[open]') && (!viewerInfo || viewerInfo.hidden)) prepareGridReturn();
    return;
  }
  if (!arrows.has(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  queueNavigation(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1);
}, true);

document.addEventListener('keyup', event => {
  if (!arrows.has(event.key)) return;
  queuedDirection = 0;
  cancelAnimationFrame(navFrame);
  navFrame = 0;
  rapidUntil = Math.min(rapidUntil, performance.now() + 24);
  clearTimeout(settleTimer);
  settleTimer = 0;
  scheduleSettle();
}, true);

viewerClose?.addEventListener('click', prepareGridReturn, true);
viewerMedia && new MutationObserver(deferVisibleVideo).observe(viewerMedia, { childList: true });

if (viewer) new MutationObserver(() => {
  if (!viewer.hidden) return;
  queuedDirection = 0;
  cancelAnimationFrame(navFrame);
  navFrame = 0;
  rapidUntil = 0;
  clearTimeout(settleTimer);
  settleTimer = 0;
  settleCallbacks.clear();
  clearDeferred();
}).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
