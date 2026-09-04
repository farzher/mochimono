const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const commandbar = document.querySelector('.commandbar');
const pageKeys = new Set(['PageUp', 'PageDown', 'Home', 'End']);
const EDGE_MARGIN = 240;
const MAX_PREPARE_PASSES = 8;

// Keep the exact pre-viewer grid position unless viewer navigation moved to a
// file that would otherwise be entirely offscreen.
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
    else if (!open && viewerWasOpen) {
      requestAnimationFrame(() => requestAnimationFrame(() => revealOnlyIfNeeded(lastViewerHash, viewerScrollY)));
    }
    viewerWasOpen = open;
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  new MutationObserver(() => {
    const hash = viewerHash();
    if (hash) lastViewerHash = hash;
  }).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
}

// Page movement is measured only after the virtual window is fully prepared.
// That keeps a page press equal to one viewport step even when older/newer rows
// have to be inserted before the movement can happen.
let pageBusy = false;
let queuedDirection = 0;
let releaseTimer = 0;
let motionGeneration = 0;

function editingControl(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function viewportTop() {
  return Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
}

function pageDistance() {
  return Math.max(160, innerHeight - viewportTop() - 36);
}

function warmDestination(direction, distance) {
  const thumbnails = window.mochimonoThumbnails;
  if (!files || !thumbnails?.prioritize) return;

  // Warm three viewports centered on the destination: one behind, the page
  // being revealed, and one ahead. The stable grid already keeps these cards in
  // DOM overscan, so this starts fetch/decode before the page jump can paint a
  // placeholder. It also makes rapid repeated PageUp/PageDown presses warm the
  // following page before it becomes visible.
  const shift = direction * distance;
  const start = viewportTop() + shift - distance;
  const end = innerHeight + shift + distance;
  const cards = [];
  for (const card of files.querySelectorAll('[data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= start || rect.top >= end) continue;
    cards.push(card);
  }
  if (cards.length) thumbnails.prioritize(cards);
}

function canExtend(direction) {
  const state = window.mochimonoLibrary?.state?.();
  return direction < 0 ? Boolean(state?.hasPrevious) : Boolean(state?.hasMore);
}

function shouldPreExtend(direction, distance) {
  if (!canExtend(direction)) return false;
  if (direction < 0) {
    const rect = document.querySelector('#top-scroll-sentinel')?.getBoundingClientRect();
    const top = viewportTop();
    return Boolean(rect && rect.bottom >= top - EDGE_MARGIN - distance);
  }
  const rect = document.querySelector('#scroll-sentinel')?.getBoundingClientRect();
  return Boolean(rect && rect.top <= innerHeight + EDGE_MARGIN + distance);
}

function visibleAnchor() {
  if (!files) return null;
  const top = viewportTop();
  const bounds = files.getBoundingClientRect();
  const xs = [bounds.left + 8, (bounds.left + bounds.right) / 2, bounds.right - 8]
    .map(x => Math.max(1, Math.min(innerWidth - 2, x)));
  for (const y of [top + 2, top + 40, top + 80, top + 120]) {
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
  // library-app has a defensive two-frame anchor restore. Let it finish before
  // deciding whether another virtual batch is needed. No intentional page motion
  // happens until every anchor correction is complete.
  afterAnchorRestore(() => preparePage(direction, distance, generation, callback, pass + 1));
}

function release() {
  clearTimeout(releaseTimer);
  releaseTimer = 0;
  queuedDirection = 0;
  window.mochimonoThumbnails?.clearPriority?.();
  window.mochimonoGridInteraction?.release?.();
}

function armRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, 220);
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
  warmDestination(direction, distance);
  // Give the browser one paint cycle to dispatch the eager image requests and
  // begin decode before those cards can become visible. This is one frame, not a
  // wait for I/O, so PageUp/PageDown remains immediate even with a cold cache.
  requestAnimationFrame(() => {
    if (generation !== motionGeneration) return;
    const start = window.scrollY;
    window.scrollTo({ top: start + direction * distance, left: 0, behavior: 'auto' });
    requestAnimationFrame(() => finishPage(generation));
  });
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

  // Usually the stable grid already has the destination in its 3.25-screen DOM
  // overscan. Start those thumbnails now, before any edge-extension work, to
  // maximize lead time. doExactScroll repeats this after extension in case rows
  // had to be materialized first.
  warmDestination(direction, distance);
  preparePage(direction, distance, generation, () => doExactScroll(direction, distance, generation));
}

function jumpEdge(key) {
  const library = window.mochimonoLibrary;
  const hashes = library?.filteredHashes?.();
  if (!Array.isArray(hashes) || !hashes.length) return false;

  motionGeneration++;
  pageBusy = false;
  queuedDirection = 0;
  clearTimeout(releaseTimer);
  releaseTimer = 0;
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
      if (generation !== motionGeneration) return;
      window.mochimonoThumbnails?.clearPriority?.();
      window.mochimonoGridInteraction?.release?.();
    }, 70);
  });
  return true;
}

function press(key) {
  if (!pageKeys.has(key) || (viewer && !viewer.hidden)) return false;
  if (key === 'Home' || key === 'End') return jumpEdge(key);
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
