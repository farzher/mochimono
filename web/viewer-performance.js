const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');
const viewerMedia = document.querySelector('#viewer-media');

const objectHash = value => String(value || '').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentHash = () => objectHash(viewerOpen?.getAttribute('href'));

const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
const mediaDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
const nativeFetch = window.fetch.bind(window);
const decoded = new Map();
const preloads = new Map();
const MAX_DECODED = 4;
const MAX_DECODED_PIXELS = 50_000_000;
const MAX_PRELOADS = 2;
const RAPID_SETTLE_MS = 90;
let decodedPixels = 0;
let currentLoad = null;
let navPending = 0;
let navFrame = 0;
let rapidUntil = 0;
let deferredCurrent = null;
let deferredVideo = null;
let deferredTimer = 0;
let settlePromise = null;
let settleResolve = null;
let settleTimer = 0;

function nativeSet(image, value) {
  descriptor?.set?.call(image, value);
}

function clearDeferred(image = null) {
  if (image && deferredCurrent?.image !== image) return;
  deferredCurrent = null;
  if (!image) deferredVideo = null;
  clearTimeout(deferredTimer);
  deferredTimer = 0;
}

function abortImage(image) {
  if (!image) return;
  preloads.delete(image);
  if (currentLoad === image) currentLoad = null;
  clearDeferred(image);
  image.onload = null;
  image.onerror = null;
  try { nativeSet(image, ''); } catch {}
}

function retain(hash, image) {
  if (!hash || !image?.naturalWidth || !image?.naturalHeight) return;
  const pixels = image.naturalWidth * image.naturalHeight;
  const previous = decoded.get(hash);
  if (previous) decodedPixels -= previous.pixels;
  decoded.delete(hash);
  decoded.set(hash, { image, pixels });
  decodedPixels += pixels;
  while (decoded.size > MAX_DECODED || decodedPixels > MAX_DECODED_PIXELS) {
    const [oldHash, old] = decoded.entries().next().value;
    decoded.delete(oldHash);
    decodedPixels -= old.pixels;
  }
}

function useDecoded(hash) {
  const cached = decoded.get(hash);
  const shown = viewerMedia?.querySelector('img[data-full-src]');
  if (!cached?.image?.naturalWidth || !shown) return false;
  decoded.delete(hash);
  decoded.set(hash, cached);
  if (currentLoad && currentLoad !== cached.image) abortImage(currentLoad);
  clearDeferred();
  cached.image.alt = shown.alt || '';
  shown.replaceWith(cached.image);
  currentLoad = null;
  return true;
}

function retainAfterLoad(hash, image) {
  image.addEventListener('load', async () => {
    try { await image.decode(); } catch {}
    if (image.naturalWidth && image.naturalHeight) retain(hash, image);
    preloads.delete(image);
    if (currentLoad === image) currentLoad = null;
    clearDeferred(image);
  }, { once:true });
  image.addEventListener('error', () => {
    preloads.delete(image);
    if (currentLoad === image) currentLoad = null;
    clearDeferred(image);
  }, { once:true });
}

function clearStalePreloads() {
  for (const image of [...preloads.keys()]) abortImage(image);
}

function rapidNavigation() {
  return performance.now() < rapidUntil;
}

window.mochimonoViewerPerformance = { rapid: rapidNavigation };

function viewerSecondaryHash(input, init) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET') return '';

  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
  catch { return ''; }

  if (url.pathname === '/api/client/locations') {
    const hash = String(url.searchParams.get('hash') || '');
    return /^[a-f0-9]{64}$/.test(hash) ? hash : '';
  }

  for (const pattern of [
    /^\/api\/provenance\/([a-f0-9]{64})$/,
    /^\/api\/collections\/file\/([a-f0-9]{64})$/,
    /^\/api\/files\/([a-f0-9]{64})\/details$/,
    /^\/api\/protection\/objects\/([a-f0-9]{64})$/,
    /^\/api\/drives\/[^/]+\/files\/([a-f0-9]{64})$/
  ]) {
    const match = url.pathname.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function settleCheck() {
  settleTimer = 0;
  const wait = rapidUntil - performance.now();
  if (wait > 0) {
    settleTimer = setTimeout(settleCheck, wait + 3);
    return;
  }
  const resolve = settleResolve;
  settlePromise = null;
  settleResolve = null;
  resolve?.();
}

function waitForRapidSettle() {
  if (!settlePromise) settlePromise = new Promise(resolve => { settleResolve = resolve; });
  if (!settleTimer) settleTimer = setTimeout(settleCheck, Math.max(0, rapidUntil - performance.now()) + 3);
  return settlePromise;
}

function finishRapidSettle() {
  clearTimeout(settleTimer);
  settleTimer = 0;
  const resolve = settleResolve;
  settlePromise = null;
  settleResolve = null;
  resolve?.();
}

window.fetch = function(input, init) {
  const hash = viewerSecondaryHash(input, init);
  if (!hash || viewer?.hidden || !rapidNavigation()) return nativeFetch(input, init);
  return waitForRapidSettle().then(() => {
    if (!viewer.hidden && currentHash() === hash) return nativeFetch(input, init);
    return new Response('{}', { status:200, headers:{ 'content-type':'application/json' } });
  });
};

function scheduleDeferredFlush(delay = RAPID_SETTLE_MS + 4) {
  clearTimeout(deferredTimer);
  deferredTimer = setTimeout(flushDeferredMedia, delay);
}

function flushDeferredMedia() {
  deferredTimer = 0;
  if (!deferredCurrent && !deferredVideo) return;
  const wait = rapidUntil - performance.now();
  if (wait > 0) {
    scheduleDeferredFlush(wait + 4);
    return;
  }

  const image = deferredCurrent;
  deferredCurrent = null;
  if (image && !viewer.hidden && currentHash() === image.hash && currentLoad === image.image) {
    nativeSet(image.image, image.value);
  }

  const video = deferredVideo;
  deferredVideo = null;
  if (video && !viewer.hidden && currentHash() === video.hash && video.element.isConnected) {
    video.element.src = video.value;
    video.element.autoplay = true;
    video.element.play().catch(() => {});
  }
}

function deferCurrentLoad(image, value, hash) {
  deferredCurrent = { image, value, hash };
  scheduleDeferredFlush();
}

function deferRapidVideo() {
  const video = viewerMedia?.querySelector('video[src]');
  const hash = currentHash();
  if (!video || !hash || !rapidNavigation()) return;
  const value = video.getAttribute('src');
  if (!value) return;

  video.pause();
  video.autoplay = false;
  video.poster = `/api/thumbs/${hash}?v=3`;
  video.removeAttribute('src');
  video.load();
  deferredVideo = { element: video, value, hash };
  scheduleDeferredFlush();
}

function handleRapidMedia() {
  if (!rapidNavigation() || viewer?.hidden) return;
  if (!viewerMedia?.querySelector('img[data-full-src]') && currentLoad) abortImage(currentLoad);
  clearStalePreloads();
  deferRapidVideo();
}

function trackObjectImage(image, value) {
  const hash = objectHash(value);
  if (!hash || !viewer || viewer.hidden || image.isConnected) return false;
  const current = currentHash();
  if (!current) return false;

  if (hash === current) {
    clearStalePreloads();
    if (useDecoded(hash)) return true;
    if (currentLoad && currentLoad !== image) abortImage(currentLoad);
    currentLoad = image;
    try { image.fetchPriority = 'high'; } catch {}
    retainAfterLoad(hash, image);

    if (rapidNavigation()) {
      deferCurrentLoad(image, value, hash);
      return true;
    }
    return false;
  }

  if (rapidNavigation()) return true;

  retainAfterLoad(hash, image);
  try { image.fetchPriority = 'low'; } catch {}
  preloads.set(image, hash);
  while (preloads.size > MAX_PRELOADS) abortImage(preloads.keys().next().value);
  return false;
}

if (descriptor?.get && descriptor?.set) {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable:true,
    enumerable:descriptor.enumerable,
    get:descriptor.get,
    set(value) {
      if (trackObjectImage(this, value)) return;
      descriptor.set.call(this, value);
    }
  });
}

if (mediaDescriptor?.get && mediaDescriptor?.set) {
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable:true,
    enumerable:mediaDescriptor.enumerable,
    get:mediaDescriptor.get,
    set(value) {
      if (this instanceof HTMLVideoElement && !this.isConnected && objectHash(value) && rapidNavigation()) return;
      mediaDescriptor.set.call(this, value);
    }
  });
}

function navigateOne(direction) {
  const button = direction < 0 ? viewerPrev : viewerNext;
  if (!button || button.disabled || viewer.hidden) return false;
  if (typeof button.onclick === 'function') button.onclick.call(button);
  else button.click();
  handleRapidMedia();
  return true;
}

function flushNavigation() {
  navFrame = 0;
  if (!navPending || viewer.hidden) {
    navPending = 0;
    return;
  }
  const direction = Math.sign(navPending);
  navPending -= direction;
  if (!navigateOne(direction)) {
    navPending = 0;
    return;
  }
  if (navPending) navFrame = requestAnimationFrame(flushNavigation);
}

function queueNavigation(direction) {
  rapidUntil = performance.now() + RAPID_SETTLE_MS;
  if (deferredCurrent || deferredVideo) scheduleDeferredFlush();
  if (navPending && Math.sign(navPending) !== direction) navPending = 0;
  navPending = Math.max(-6, Math.min(6, navPending + direction));
  if (navFrame) return;

  const first = Math.sign(navPending);
  navPending -= first;
  if (!navigateOne(first)) {
    navPending = 0;
    return;
  }
  // Hold the rest of this display frame. Any repeated key events that arrive
  // before the next paint collapse into the pending count instead of causing
  // multiple viewer DOM rebuilds inside one frame.
  navFrame = requestAnimationFrame(flushNavigation);
}

document.addEventListener('keydown', event => {
  if (!viewer || viewer.hidden || !['ArrowLeft','ArrowRight','ArrowDown','ArrowUp'].includes(event.key)) return;
  const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  event.preventDefault();
  event.stopImmediatePropagation();
  queueNavigation(direction);
}, true);

document.addEventListener('keyup', event => {
  if (!['ArrowLeft','ArrowRight','ArrowDown','ArrowUp'].includes(event.key)) return;
  navPending = 0;
  cancelAnimationFrame(navFrame);
  navFrame = 0;
  if (deferredCurrent || deferredVideo) {
    rapidUntil = Math.min(rapidUntil, performance.now() + 24);
    scheduleDeferredFlush(28);
  }
}, true);

if (viewerMedia) new MutationObserver(handleRapidMedia).observe(viewerMedia, { childList:true });

if (viewer) {
  new MutationObserver(() => {
    if (!viewer.hidden) return;
    navPending = 0;
    cancelAnimationFrame(navFrame);
    navFrame = 0;
    rapidUntil = 0;
    finishRapidSettle();
    clearDeferred();
    clearStalePreloads();
    abortImage(currentLoad);
  }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
}
