const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');
const files = document.querySelector('#files');

const objectHash = value => String(value || '').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentHash = () => objectHash(viewerOpen?.getAttribute('href'));
const hasLocalCopy = hash => Boolean(hash && (
  window.mochimonoFastLocalHashes?.has?.(hash) ||
  window.mochimonoLocations?.forHash?.(hash)?.length
));

const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
const decoded = new Map();
const preloads = new Map();
const hoverWarm = new Map();
const MAX_DECODED = 4;
const MAX_DECODED_PIXELS = 50_000_000;
const MAX_PRELOADS = 2;
let decodedPixels = 0;
let currentLoad = null;
let hoverTimer = 0;
let navPending = 0;
let navTimer = 0;
let lastNavAt = 0;

function nativeSet(image, value) {
  descriptor?.set?.call(image, value);
}

function abortImage(image) {
  if (!image) return;
  preloads.delete(image);
  if (currentLoad === image) currentLoad = null;
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
  }, { once:true });
  image.addEventListener('error', () => {
    preloads.delete(image);
    if (currentLoad === image) currentLoad = null;
  }, { once:true });
}

function clearStalePreloads() {
  for (const image of [...preloads.keys()]) abortImage(image);
}

function trackObjectImage(image, value) {
  const hash = objectHash(value);
  if (!hash || !viewer || viewer.hidden || image.isConnected) return;
  const current = currentHash();
  if (!current) return;

  retainAfterLoad(hash, image);
  if (hash === current) {
    if (currentLoad && currentLoad !== image) abortImage(currentLoad);
    clearStalePreloads();
    currentLoad = image;
    try { image.fetchPriority = 'high'; } catch {}
    return;
  }

  try { image.fetchPriority = 'low'; } catch {}
  preloads.set(image, hash);
  while (preloads.size > MAX_PRELOADS) abortImage(preloads.keys().next().value);
}

if (descriptor?.get && descriptor?.set) {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable:true,
    enumerable:descriptor.enumerable,
    get:descriptor.get,
    set(value) {
      trackObjectImage(this, value);
      descriptor.set.call(this, value);
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
  const delay = Math.max(0, 34 - (performance.now() - lastNavAt));
  navTimer = setTimeout(flushNavigation, delay);
}

function queueNavigation(direction) {
  if (navPending && Math.sign(navPending) !== direction) navPending = 0;
  navPending = Math.max(-4, Math.min(4, navPending + direction));
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

if (viewer) {
  new MutationObserver(() => {
    if (!viewer.hidden) return;
    navPending = 0;
    clearTimeout(navTimer);
    navTimer = 0;
    clearStalePreloads();
    abortImage(currentLoad);
  }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
}
