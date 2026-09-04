const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const commandbar = document.querySelector('.commandbar');
const pageKeys = new Set(['PageUp', 'PageDown', 'Home', 'End']);
const EDGE_MARGIN = 240;
const MAX_PREPARE_PASSES = 8;

let viewerWasOpen = Boolean(viewer && !viewer.hidden);
let viewerScrollY = window.scrollY;
let lastViewerHash = '';

function viewerHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function revealOnlyIfNeeded(hash, savedY) {
  const card = hash ? files?.querySelector(`[data-hash="${CSS.escape(hash)}"]`) : null;
  if (!card) return;
  window.scrollTo({ top: savedY, left: 0, behavior: 'auto' });
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  const rect = card.getBoundingClientRect();
  if (rect.bottom <= top) window.scrollBy({ top: rect.top - top - 2, left: 0, behavior: 'auto' });
  else if (rect.top >= innerHeight) window.scrollBy({ top: rect.bottom - innerHeight + 2, left: 0, behavior: 'auto' });
}

if (viewer && viewerOpen) {
  lastViewerHash = viewerHash();
  new MutationObserver(() => {
    const open = !viewer.hidden;
    const hash = viewerHash();
    if (hash) lastViewerHash = hash;
    if (open && !viewerWasOpen) viewerScrollY = window.scrollY;
    else if (!open && viewerWasOpen) requestAnimationFrame(() => requestAnimationFrame(() => revealOnlyIfNeeded(lastViewerHash, viewerScrollY)));
    viewerWasOpen = open;
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  new MutationObserver(() => {
    const hash = viewerHash();
    if (hash) lastViewerHash = hash;
  }).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
}

let pageBusy = false;
let queuedDirection = 0;
let releaseTimer = 0;
let motionGeneration = 0;

function editingControl(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function pageDistance() {
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return Math.max(160, innerHeight - top - 36);
}

function stableVirtual() {
  return Boolean(window.mochimonoLibrary?.state?.().virtual);
}

function canExtend(direction) {
  const state = window.mochimonoLibrary?.state?.();
  return direction < 0 ? Boolean(state?.hasPrevious) : Boolean(state?.hasMore);
}

function shouldPreExtend(direction, distance) {
  if (!canExtend(direction)) return false;
  if (direction < 0) {
    const rect = document.querySelector('#top-scroll-sentinel')?.getBoundingClientRect();
    const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
    return Boolean(rect && rect.bottom >= top - EDGE_MARGIN - distance);
  }
  const rect = document.querySelector('#scroll-sentinel')?.getBoundingClientRect();
  return Boolean(rect && rect.top <= innerHeight + EDGE_MARGIN + distance);
}

function visibleAnchor() {
  if (!files) return null;
  const viewportTop = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  const bounds = files.getBoundingClientRect();
  const xs = [bounds.left + 8, (bounds.left + bounds.right) / 2, bounds.right - 8]
    .map(x => Math.max(1, Math.min(innerWidth - 2, x)));
  for (const y of [viewportTop + 2, viewportTop + 40, viewportTop + 80, viewportTop + 120]) {
    if (y >= innerHeight) break;
    for (const x of xs) {
      const card = document.elementFromPoint(x, y)?.closest?.('#files [data-hash]');
      if (!card) continue;
      return { card, hash: card.dataset.hash, top: card.getBoundingClientRect().top };
    }
  }
  return null;
}

function restoreAnchorNow(anchor) {
  if (!anchor) return;
  const card = anchor.card?.isConnected ? anchor.card : files?.querySelector(`[data-hash="${CSS.escape(anchor.hash || '')}"]`);
  if (!card) return;
  const delta = card.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) > .5) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
}

function extend(direction) {
  const anchor = visibleAnchor();
  const changed = Boolean(window.mochimonoLibrary?.extend?.(direction));
  if (!changed) return false;
  window.mochimonoGallery?.layoutNow?.();
  restoreAnchorNow(anchor);
  return true;
}

function afterAnchorRestore(callback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function preparePage(direction, distance, generation, callback, pass = 0) {
  if (generation !== motionGeneration) return;
  if (pass >= MAX_PREPARE_PASSES || !shouldPreExtend(direction, distance) || !extend(direction)) {
    callback();
    return;
  }
  afterAnchorRestore(() => preparePage(direction, distance, generation, callback, pass + 1));
}

function release() {
  clearTimeout(releaseTimer);
  releaseTimer = 0;
  queuedDirection = 0;
  window.mochimonoGridInteraction?.release?.();
}

function armRelease(delay = 220) {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, delay);
}

function finishPage(generation) {
  if (generation !== motionGeneration) return;
  pageBusy = false;
  const next = queuedDirection;
  queuedDirection = 0;
  if (next) runPage(next);
}

function doExactScroll(direction, distance, generation) {
  if (generation !== motionGeneration) return;
  const start = window.scrollY;
  window.scrollTo({ top: start + direction * distance, left: 0, behavior: 'auto' });
  requestAnimationFrame(() => finishPage(generation));
}

function runPage(direction) {
  if (pageBusy) {
    queuedDirection = direction;
    return;
  }
  pageBusy = true;
  const generation = motionGeneration;
  const distance = pageDistance();
  window.mochimonoGridInteraction?.pulse?.(220);
  preparePage(direction, distance, generation, () => doExactScroll(direction, distance, generation));
}

function resetLegacyMotion() {
  motionGeneration++;
  pageBusy = false;
  queuedDirection = 0;
  clearTimeout(releaseTimer);
  releaseTimer = 0;
}

function jumpStableEdge(key) {
  const library = window.mochimonoLibrary;
  const hashes = library?.filteredHashes?.();
  if (!Array.isArray(hashes) || !hashes.length) return false;
  resetLegacyMotion();
  const first = key === 'Home';
  const index = first ? 0 : hashes.length - 1;
  const hash = hashes[index];
  library.ensureIndex?.(index);
  window.mochimonoGridInteraction?.pulse?.(180);
  requestAnimationFrame(() => {
    const card = files?.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
    if (!card) return;
    if (first) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    else card.scrollIntoView({ behavior: 'auto', block: 'end', inline: 'nearest' });
    window.mochimonoThumbnails?.prioritize?.([card]);
  });
  armRelease(180);
  return true;
}

function jumpLegacyEdge(key) {
  const library = window.mochimonoLibrary;
  const hashes = library?.filteredHashes?.();
  if (!Array.isArray(hashes) || !hashes.length) return false;
  resetLegacyMotion();
  const generation = motionGeneration;
  const first = key === 'Home';
  const index = first ? 0 : hashes.length - 1;
  const hash = hashes[index];
  library.ensureIndex?.(index);
  window.mochimonoGallery?.layoutNow?.();
  window.mochimonoGridInteraction?.pulse?.(220);

  afterAnchorRestore(() => {
    if (generation !== motionGeneration) return;
    const card = files?.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
    if (card) {
      if (first) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      else card.scrollIntoView({ behavior: 'auto', block: 'end', inline: 'nearest' });
      window.mochimonoThumbnails?.prioritize?.([card]);
    }
    setTimeout(() => {
      if (generation === motionGeneration) window.mochimonoGridInteraction?.release?.();
    }, 70);
  });
  return true;
}

function press(key) {
  if (!pageKeys.has(key) || (viewer && !viewer.hidden)) return false;
  const stable = stableVirtual();
  if (key === 'Home' || key === 'End') return stable ? jumpStableEdge(key) : jumpLegacyEdge(key);
  if (stable) {
    resetLegacyMotion();
    window.mochimonoGridInteraction?.pulse?.(180);
    window.scrollBy({ top: (key === 'PageUp' ? -1 : 1) * pageDistance(), left: 0, behavior: 'auto' });
    armRelease(180);
    return true;
  }
  armRelease();
  runPage(key === 'PageUp' ? -1 : 1);
  return true;
}

window.mochimonoPageKeys = { press, release };

document.addEventListener('keydown', event => {
  if (!pageKeys.has(event.key) || editingControl(event.target) || !press(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

document.addEventListener('keyup', event => {
  if (pageKeys.has(event.key)) release();
}, true);
window.addEventListener('blur', release);
