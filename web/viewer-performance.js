const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');
const viewerMedia = document.querySelector('#viewer-media');
const files = document.querySelector('#files');

const objectHash = value => String(value || '').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentHash = () => objectHash(viewerOpen?.getAttribute('href'));
const hasLocalCopy = hash => Boolean(hash && (
  window.mochimonoFastLocalHashes?.has?.(hash) ||
  window.mochimonoLocations?.forHash?.(hash)?.length
));

const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
const mediaDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
const decoded = new Map();
const preloads = new Map();
const hoverWarm = new Map();
const MAX_DECODED = 4;
const MAX_DECODED_PIXELS = 50_000_000;
const MAX_PRELOADS = 2;
const RAPID_SETTLE_MS = 90;
const NAV_INTERVAL_MS = 16;
let decodedPixels = 0;
let currentLoad = null;
let hoverTimer = 0;
let navPending = 0;
let navTimer = 0;
let lastNavAt = 0;
let rapidUntil = 0;
let deferredCurrent = null;
let deferredVideo = null;
let deferredTimer = 0;

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
  // A video/document does not need the full image decode started for the image
  // we just left. New images abort the previous load in trackObjectImage().
  if (!viewerMedia?.querySelector('img[data-full-src]') && currentLoad) abortImage(currentLoad);
  clearStalePreloads();
  deferRapidVideo();
}

// Returns true when the caller should suppress the immediate native src set.
function trackObjectImage(image, value) {
  const hash = objectHash(value);
  if (!hash || !viewer || viewer.hidden || image.isConnected) return false;
  const current = currentHash();
  if (!current) return false;

  if (hash === current) {
    if (currentLoad && currentLoad !== image) abortImage(currentLoad);
    clearStalePreloads();
    currentLoad = image;
    try { image.fetchPriority = 'high'; } catch {}
    retainAfterLoad(hash, image);

    // While flipping quickly, the visible viewer already has the cached
    // thumbnail. Do not start/decode a full original that will be abandoned on
    // the next key repeat. Load only the final image after navigation settles.
    if (rapidNavigation()) {
      deferCurrentLoad(image, value, hash);
      return true;
    }
    return false;
  }

  // Adjacent full-resolution preloads are useful while resting on an image but
  // are pure churn during rapid navigation. Skip them until the user settles.
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
      // library-app's adjacent video preloads are detached elements. They add
      // disk/network work on every rapid key step but cannot improve what is
      // currently visible, so simply do not start them while scrubbing.
      if (this instanceof HTMLVideoElement && !this.isConnected && objectHash(value) && rapidNavigation()) return;
      mediaDescriptor.set.call(this, value);
    }
  });
}

function warmGridCard(card) {
  if (!card?.matches?.('.file-card.media-card[data-hash]') || card.classList.contains('video-card')) return;
  const hash = String(card.dataset.hash || '');
  if (!hash || !hasLocalCopy(hash) || decoded.has(hash) || hoverWarm.has(hash)) return;

  const image = new Image();
  image.decoding = 'async';
  try { image.fetchPriority = 'low'; } catch {}
  hoverWarm.set(hash, image);
  while (hoverWarm.size > 2) {
    const [oldHash, oldImage] = hoverWarm.entries().next().value;
    hoverWarm.delete(oldHash);
    abortImage(oldImage);
  }
  image.onload = async () => {
    try { await image.decode(); } catch {}
    hoverWarm.delete(hash);
    retain(hash, image);
  };
  image.onerror = () => hoverWarm.delete(hash);
  nativeSet(image, `/api/objects/${hash}`);
}

function navigateOne(direction) {
  const button = direction < 0 ? viewerPrev : viewerNext;
  if (!button || button.disabled || viewer.hidden) return false;
  button.click();
  handleRapidMedia();
  lastNavAt = performance.now();
  return true;
}

function flushNavigation() {
  navTimer = 0;
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
  if (!navPending) return;
  const delay = Math.max(0, NAV_INTERVAL_MS - (performance.now() - lastNavAt));
  navTimer = setTimeout(flushNavigation, delay);
}

function queueNavigation(direction) {
  rapidUntil = performance.now() + RAPID_SETTLE_MS;
  if (deferredCurrent || deferredVideo) scheduleDeferredFlush();
  if (navPending && Math.sign(navPending) !== direction) navPending = 0;
  navPending = Math.max(-6, Math.min(6, navPending + direction));
  if (!navTimer) flushNavigation();
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
  clearTimeout(navTimer);
  navTimer = 0;
  if (deferredCurrent || deferredVideo) {
    rapidUntil = Math.min(rapidUntil, performance.now() + 24);
    scheduleDeferredFlush(28);
  }
}, true);

if (files) {
  files.addEventListener('pointerover', event => {
    const card = event.target.closest?.('.file-card.media-card[data-hash]');
    if (!card) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => warmGridCard(card), 90);
  }, { passive:true });
  files.addEventListener('pointerout', () => clearTimeout(hoverTimer), { passive:true });
  files.addEventListener('pointerdown', event => {
    clearTimeout(hoverTimer);
    warmGridCard(event.target.closest?.('.file-card.media-card[data-hash]'));
  }, { passive:true });
  files.addEventListener('focusin', event => warmGridCard(event.target.closest?.('.file-card.media-card[data-hash]')));
}

if (viewerMedia) new MutationObserver(handleRapidMedia).observe(viewerMedia, { childList:true });

if (viewer) {
  new MutationObserver(() => {
    if (!viewer.hidden) return;
    navPending = 0;
    clearTimeout(navTimer);
    navTimer = 0;
    rapidUntil = 0;
    clearDeferred();
    clearStalePreloads();
    abortImage(currentLoad);
  }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
}
