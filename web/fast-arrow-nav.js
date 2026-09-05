const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerMedia = document.querySelector('#viewer-media');
const commandbar = document.querySelector('.commandbar');
const arrows = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const ROW_TOLERANCE = 3;
const THUMB_NEIGHBORS = 8;
const VIEWER_FALLBACK_STEP = 5;
const VIEWER_THUMB_RADIUS = 8;
const VIEWER_WARM_RETRY = 120;
const VIEWER_RAPID_MS = 80;
const THUMB_VERSION = 3;

let holding = false;
let verticalAnchorX = null;
let viewerVerticalAnchorX = null;
let viewerExpectedHash = '';
let viewerWarmTimer = 0;
let viewerWarmRunning = false;
let viewerWarmHash = '';
let viewerWarmPasses = 0;
let viewerRapidUntil = 0;
let viewerSettleTimer = 0;
let viewerSettleCallback = null;
const viewerThumbImages = new Map();

const gridActive = () => Boolean(files?.classList.contains('grid'));
const viewerHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const thumbUrl = hash => `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
const viewerRapid = () => performance.now() < viewerRapidUntil;

function editingControl(event) {
  const control = event.target?.closest?.('input,select,textarea,[contenteditable="true"]');
  if (!control) return false;
  return !(control.id === 'search' && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || !control.value));
}

function orderedCards() {
  return [...files.querySelectorAll('[data-hash]')];
}

function cardWalker(current) {
  if (!current?.isConnected) return null;
  const walker = document.createTreeWalker(files, NodeFilter.SHOW_ELEMENT, {
    acceptNode: node => node.hasAttribute?.('data-hash') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
  });
  walker.currentNode = current;
  return walker;
}

function adjacentCard(current, direction) {
  const walker = cardWalker(current);
  return walker ? direction < 0 ? walker.previousNode() : walker.nextNode() : null;
}

function thumbnailNeighborhood(card) {
  const walker = cardWalker(card);
  if (!walker) return [card];
  const result = [card];
  for (let index = 0, item; index < THUMB_NEIGHBORS && (item = walker.previousNode()); index++) result.push(item);
  walker.currentNode = card;
  for (let index = 0, item; index < THUMB_NEIGHBORS && (item = walker.nextNode()); index++) result.push(item);
  return result;
}

function viewportTop() {
  return (commandbar?.getBoundingClientRect().bottom || 0) + 2;
}

function visible(card) {
  if (!card?.isConnected) return false;
  const rect = card.getBoundingClientRect();
  return rect.bottom > viewportTop() && rect.top < innerHeight;
}

function selectedCard() {
  return document.activeElement?.closest?.('#files [data-hash]') || null;
}

function visibleStart(cards = orderedCards()) {
  const active = selectedCard();
  if (visible(active)) return active;

  let best = null;
  let bestTop = Infinity;
  let bestLeft = Infinity;
  const top = viewportTop();
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= top || rect.top >= innerHeight) continue;
    if (rect.top < bestTop - 3 || (Math.abs(rect.top - bestTop) <= 3 && rect.left < bestLeft)) {
      best = card;
      bestTop = rect.top;
      bestLeft = rect.left;
    }
  }
  return best || cards[0] || null;
}

function selectCard(card, scroll = true) {
  if (!card) return false;
  const previous = selectedCard();
  if (previous && previous !== card) previous.classList.remove('keyboard-cursor');
  else if (!previous) files.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
  card.classList.add('keyboard-cursor');
  document.documentElement.classList.add('keyboard-navigation-active');
  card.focus({ preventScroll: true });
  if (scroll) card.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
  window.mochimonoThumbnails?.prioritize?.(thumbnailNeighborhood(card));
  return true;
}

function verticalTarget(current, direction, anchorX) {
  const walker = cardWalker(current);
  if (!walker) return null;
  const currentTop = current.getBoundingClientRect().top;
  const step = direction < 0 ? 'previousNode' : 'nextNode';
  let rowTop = null;
  let best = null;
  let bestHorizontalGap = Infinity;
  let bestCenterDistance = Infinity;

  for (let card = walker[step](); card; card = walker[step]()) {
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const dy = rect.top - currentTop;
    if (direction < 0 ? dy >= -ROW_TOLERANCE : dy <= ROW_TOLERANCE) continue;

    if (rowTop == null) rowTop = rect.top;
    else if (Math.abs(rect.top - rowTop) > ROW_TOLERANCE) break;

    if (anchorX >= rect.left && anchorX <= rect.right) return card;
    const horizontalGap = anchorX < rect.left ? rect.left - anchorX : anchorX - rect.right;
    const centerDistance = Math.abs(rect.left + rect.width / 2 - anchorX);
    if (horizontalGap < bestHorizontalGap ||
        (horizontalGap === bestHorizontalGap && centerDistance < bestCenterDistance)) {
      best = card;
      bestHorizontalGap = horizontalGap;
      bestCenterDistance = centerDistance;
    }
  }
  return best;
}

function restoreWindowAnchor(hash, top) {
  const restore = () => {
    const card = hash ? files.querySelector(`[data-hash="${CSS.escape(hash)}"]`) : null;
    if (!card) return;
    const delta = card.getBoundingClientRect().top - top;
    if (Math.abs(delta) > .5) scrollBy(0, delta);
  };
  restore();
  requestAnimationFrame(() => requestAnimationFrame(restore));
}

function ensureAdjacentWindow(current, direction) {
  const library = window.mochimonoLibrary;
  if (!current?.isConnected || !library?.extend) return false;
  const hash = current.dataset.hash || '';
  const top = current.getBoundingClientRect().top;
  if (!library.extend(direction)) return false;
  window.mochimonoGallery?.layoutNow?.();
  restoreWindowAnchor(hash, top);
  return true;
}

function horizontalTarget(current, direction) {
  const target = adjacentCard(current, direction);
  if (target) return target;

  const currentHash = current.dataset.hash || '';
  if (!ensureAdjacentWindow(current, direction)) return null;
  current = currentHash ? files.querySelector(`[data-hash="${CSS.escape(currentHash)}"]`) : null;
  return current ? adjacentCard(current, direction) : null;
}

function navigate(key) {
  let current = selectedCard();
  if (!current) return selectCard(visibleStart());

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    verticalAnchorX = null;
    return selectCard(horizontalTarget(current, key === 'ArrowLeft' ? -1 : 1)) || true;
  }

  const direction = key === 'ArrowUp' ? -1 : 1;
  if (!Number.isFinite(verticalAnchorX)) {
    const rect = current.getBoundingClientRect();
    verticalAnchorX = rect.left + rect.width / 2;
  }
  let target = verticalTarget(current, direction, verticalAnchorX);
  if (target) return selectCard(target);

  const currentHash = current.dataset.hash || '';
  if (!ensureAdjacentWindow(current, direction)) return true;
  current = currentHash ? files.querySelector(`[data-hash="${CSS.escape(currentHash)}"]`) : null;
  if (!current) return true;
  target = verticalTarget(current, direction, verticalAnchorX);
  return selectCard(target) || selectCard(current);
}

function viewerFallbackTarget(hash, direction) {
  const hashes = window.mochimonoLibrary?.filteredHashes?.();
  if (!Array.isArray(hashes) || !hashes.length) return '';
  const index = hashes.indexOf(hash);
  return index < 0 ? '' : hashes[index + direction * VIEWER_FALLBACK_STEP] || '';
}

function viewerRowTarget(direction) {
  const hash = viewerHash();
  if (!hash || !gridActive()) return '';
  const current = files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  if (current?.isConnected) {
    if (!Number.isFinite(viewerVerticalAnchorX)) {
      const rect = current.getBoundingClientRect();
      viewerVerticalAnchorX = rect.left + rect.width / 2;
    }
    const target = verticalTarget(current, direction, viewerVerticalAnchorX);
    if (target?.dataset.hash) return target.dataset.hash;
  }
  return viewerFallbackTarget(hash, direction);
}

function navigateViewerRow(direction) {
  const hash = viewerRowTarget(direction);
  if (!hash) return false;
  viewerExpectedHash = hash;
  const opened = window.mochimonoOpenViewer?.(hash);
  if (!opened) viewerExpectedHash = '';
  return Boolean(opened);
}

function resetViewerRowNavigation() {
  viewerVerticalAnchorX = null;
  viewerExpectedHash = '';
}

function viewerNeighborhood(hash) {
  const hashes = window.mochimonoLibrary?.filteredHashes?.();
  if (!Array.isArray(hashes) || !hashes.length) return hash ? [hash] : [];
  const index = hashes.indexOf(hash);
  if (index < 0) return hash ? [hash] : [];
  return hashes.slice(Math.max(0, index - VIEWER_THUMB_RADIUS), Math.min(hashes.length, index + VIEWER_THUMB_RADIUS + 1));
}

function viewerVideoBox(hash) {
  const card = hash ? files?.querySelector(`[data-hash="${CSS.escape(hash)}"]`) : null;
  const width = Number(card?.dataset.width) || 0;
  const height = Number(card?.dataset.height) || 0;
  if (!width || !height) return null;
  const scale = Math.min(1, innerWidth / width, innerHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function applyViewerVideoBox(element, box) {
  if (!element || !box?.width || !box?.height) return;
  element.style.width = `${box.width}px`;
  element.style.height = `${box.height}px`;
}

function refreshViewerPreview(hash) {
  if (!hash || viewer?.hidden || viewerHash() !== hash) return;
  const image = viewerMedia?.querySelector('img[data-full-src],img[data-video-preview]');
  if (image) {
    try { image.fetchPriority = 'high'; } catch {}
    image.src = thumbUrl(hash);
  }
  const video = viewerMedia?.querySelector('video[src]');
  if (video) video.poster = thumbUrl(hash);
}

function preloadViewerThumb(hash) {
  if (!hash) return;
  const current = viewerThumbImages.get(hash);
  if (current?.complete && current.naturalWidth) return refreshViewerPreview(hash);
  if (current) return;

  const image = new Image();
  image.decoding = 'async';
  try { image.fetchPriority = 'high'; } catch {}
  viewerThumbImages.set(hash, image);
  while (viewerThumbImages.size > 64) viewerThumbImages.delete(viewerThumbImages.keys().next().value);
  image.onload = () => refreshViewerPreview(hash);
  image.onerror = () => viewerThumbImages.delete(hash);
  image.src = thumbUrl(hash);
}

async function checkViewerThumbs(hashes, background = false) {
  if (!hashes.length) return { ready: [], failed: [] };
  const thumbnails = window.mochimonoThumbnails;
  if (!thumbnails?.ensureHashes) return { ready: [], failed: [] };
  return thumbnails.ensureHashes(hashes, { background });
}

function scheduleViewerWarm(hash, delay = 0) {
  if (!hash || viewer?.hidden) return;
  if (viewerWarmHash !== hash) {
    viewerWarmHash = hash;
    viewerWarmPasses = 0;
  }
  if (viewerWarmRunning || viewerWarmTimer) return;
  viewerWarmTimer = setTimeout(runViewerWarm, delay);
}

async function runViewerWarm() {
  viewerWarmTimer = 0;
  const hash = viewerWarmHash;
  const hashes = viewerNeighborhood(hash);
  if (!hash || viewer?.hidden || viewerWarmRunning || !hashes.length) return;

  viewerWarmRunning = true;
  let retry = false;
  try {
    const background = hashes.filter(item => item !== hash);
    const [current, nearby] = await Promise.all([
      checkViewerThumbs([hash]),
      checkViewerThumbs(background, true)
    ]);
    const ready = new Set([...current.ready, ...nearby.ready]);
    const failed = new Set([...current.failed, ...nearby.failed]);
    for (const readyHash of ready) preloadViewerThumb(readyHash);
    retry = hashes.some(item => !ready.has(item) && !failed.has(item));
  } catch {
    retry = true;
  } finally {
    viewerWarmRunning = false;
    const current = viewerHash();
    if (!viewer?.hidden && current && current !== hash) scheduleViewerWarm(current, 70);
    else if (retry && ++viewerWarmPasses <= 6) scheduleViewerWarm(hash, VIEWER_WARM_RETRY);
  }
}

function activateViewerVideo() {
  const preview = viewerMedia?.querySelector('img[data-video-preview]');
  const hash = viewerHash();
  if (!preview || !hash || preview.dataset.videoPreview !== hash || !preview.isConnected) return;
  if (viewerMedia.querySelector(`video[data-viewer-video-load="${CSS.escape(hash)}"]`)) return;

  const video = document.createElement('video');
  video.dataset.viewerVideoLoad = hash;
  video.poster = thumbUrl(hash);
  video.preload = 'auto';
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.style.visibility = 'hidden';
  video.style.width = preview.style.width;
  video.style.height = preview.style.height;
  viewerMedia.append(video);

  const syncGeometry = () => {
    if (preview.style.width && preview.style.height) return;
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const box = { width: Math.round(rect.width), height: Math.round(rect.height) };
    applyViewerVideoBox(preview, box);
    applyViewerVideoBox(video, box);
  };
  const reveal = () => {
    if (!video.isConnected || !preview.isConnected || viewerHash() !== hash) return;
    syncGeometry();
    preview.remove();
    video.style.visibility = '';
    video.play().catch(() => {});
  };

  video.addEventListener('loadedmetadata', syncGeometry, { once: true });
  video.src = viewerOpen.getAttribute('href') || `/api/objects/${hash}`;
  if (video.readyState >= 2) reveal();
  else video.addEventListener('loadeddata', reveal, { once: true });
  video.addEventListener('error', () => {
    if (video.isConnected) video.remove();
  }, { once: true });
}

function settleViewerRapid() {
  viewerSettleTimer = 0;
  const wait = viewerRapidUntil - performance.now();
  if (wait > 0) {
    viewerSettleTimer = setTimeout(settleViewerRapid, wait + 2);
    return;
  }
  const callback = viewerSettleCallback;
  viewerSettleCallback = null;
  callback?.();
  activateViewerVideo();
}

function scheduleViewerSettle() {
  clearTimeout(viewerSettleTimer);
  viewerSettleTimer = setTimeout(settleViewerRapid, Math.max(0, viewerRapidUntil - performance.now()) + 2);
}

function markViewerRapid() {
  viewerRapidUntil = performance.now() + VIEWER_RAPID_MS;
  if (viewerSettleCallback) scheduleViewerSettle();
}

function releaseViewerRapid() {
  if (!viewerRapidUntil) return;
  viewerRapidUntil = Math.min(viewerRapidUntil, performance.now() + 24);
  if (viewerSettleCallback) scheduleViewerSettle();
}

function deferViewerSettle(callback) {
  if (typeof callback !== 'function' || !viewerRapid()) return false;
  viewerSettleCallback = callback;
  scheduleViewerSettle();
  return true;
}

function prepareViewerMedia(hash) {
  if (!hash || viewer?.hidden || !viewerMedia) return;
  const image = viewerMedia.querySelector('img[data-full-src],img[data-video-preview]');
  if (image) {
    try { image.fetchPriority = 'high'; } catch {}
  }

  const video = viewerMedia.querySelector('video:not([src])');
  if (!video) return;
  const preview = document.createElement('img');
  preview.dataset.videoPreview = hash;
  preview.alt = '';
  preview.decoding = 'async';
  applyViewerVideoBox(preview, viewerVideoBox(hash));
  try { preview.fetchPriority = 'high'; } catch {}
  preview.src = thumbUrl(hash);
  video.replaceWith(preview);
}

function resetViewerReadiness() {
  clearTimeout(viewerWarmTimer);
  viewerWarmTimer = 0;
  viewerWarmHash = '';
  viewerWarmPasses = 0;
  clearTimeout(viewerSettleTimer);
  viewerSettleTimer = 0;
  viewerRapidUntil = 0;
  viewerSettleCallback = null;
}

window.mochimonoViewerPerformance = { rapid: viewerRapid, defer: deferViewerSettle };

function press(key) {
  if (!arrows.has(key) || !viewer?.hidden || !gridActive()) return false;
  window.mochimonoGridInteraction?.pulse?.(180);

  if (!holding) {
    holding = true;
    const current = selectedCard();
    if (!visible(current)) {
      verticalAnchorX = null;
      return selectCard(visibleStart());
    }
  }

  navigate(key);
  return true;
}
function release() {
  holding = false;
  window.mochimonoThumbnails?.clearPriority?.();
  window.mochimonoGridInteraction?.release?.();
}

function reset(clear = false) {
  release();
  if (!clear) return;
  verticalAnchorX = null;
  files.querySelector('.keyboard-cursor')?.classList.remove('keyboard-cursor');
  document.documentElement.classList.remove('keyboard-navigation-active');
}

function returnTo(hash) {
  resetViewerRowNavigation();
  resetViewerReadiness();
  reset(true);
  const value = String(hash || '');
  const card = value ? files.querySelector(`[data-hash="${CSS.escape(value)}"]`) : null;
  if (card && gridActive()) selectCard(card, false);
}

window.mochimonoGridKeyboard = { press, release, reset };

document.addEventListener('keydown', event => {
  if (!arrows.has(event.key) || editingControl(event)) return;
  if (!viewer?.hidden) {
    markViewerRapid();
    if (!gridActive() || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigateViewerRow(event.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (!gridActive()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  press(event.key);
}, true);

document.addEventListener('keyup', event => {
  if (!arrows.has(event.key)) return;
  if (viewer?.hidden) release();
  else releaseViewerRapid();
}, true);

window.addEventListener('blur', () => {
  release();
  releaseViewerRapid();
});
window.addEventListener('mochimono-viewer-return', event => returnTo(event.detail?.hash));
files?.addEventListener('pointermove', event => {
  if (event.pointerType !== 'touch' && document.documentElement.classList.contains('keyboard-navigation-active')) reset(true);
}, true);
files?.addEventListener('pointerdown', () => reset(true), true);

if (viewer && viewerOpen) {
  const viewerObserver = new MutationObserver(() => {
    if (viewer.hidden) {
      resetViewerRowNavigation();
      resetViewerReadiness();
      return;
    }

    const hash = viewerHash();
    prepareViewerMedia(hash);
    scheduleViewerWarm(hash);

    if (viewerExpectedHash && hash === viewerExpectedHash) {
      viewerExpectedHash = '';
      return;
    }
    resetViewerRowNavigation();
  });
  viewerObserver.observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  viewerObserver.observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
}
