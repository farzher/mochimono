const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const commandbar = document.querySelector('.commandbar');
const topSentinel = document.querySelector('#top-scroll-sentinel');
const bottomSentinel = document.querySelector('#scroll-sentinel');
const PAGE_KEYS = new Set(['PageUp', 'PageDown']);
const EDGE_MARGIN = 240;

// thumbs.js already decides which cards are close enough to load with its own
// IntersectionObserver. Native lazy-loading on the image itself adds a second,
// independent gate: a card can enter Mochimono's preload margin without ever
// crossing another observer threshold when it reaches the viewport. Once our
// observer has chosen a card, let that image load immediately.
function promoteThumbs(root = files) {
  if (!root) return;
  const images = root.matches?.('img.cached-thumb') ? [root] : [...root.querySelectorAll?.('img.cached-thumb') || []];
  for (const image of images) if (image.loading === 'lazy') image.loading = 'eager';
}

promoteThumbs();
if (files) {
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) promoteThumbs(node);
    }
  }).observe(files, { childList: true, subtree: true });
  window.addEventListener('mochimono:grid-interaction-end', () => promoteThumbs(), { passive: true });
}

// Preserve the exact grid position when closing the viewer. The library's
// normal return path still makes sure a viewer-navigated file is rendered; after
// that settles, restore the pre-viewer scroll position and only move enough to
// reveal the returned card if it would otherwise be completely off screen.
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

function restoreViewerPosition(hash, savedY) {
  requestAnimationFrame(() => requestAnimationFrame(() => revealOnlyIfNeeded(hash, savedY)));
}

if (viewer && viewerOpen) {
  lastViewerHash = viewerHash();
  new MutationObserver(() => {
    const open = !viewer.hidden;
    const hash = viewerHash();
    if (hash) lastViewerHash = hash;
    if (open && !viewerWasOpen) viewerScrollY = window.scrollY;
    else if (!open && viewerWasOpen) restoreViewerPosition(lastViewerHash, viewerScrollY);
    viewerWasOpen = open;
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  new MutationObserver(() => {
    const hash = viewerHash();
    if (hash) lastViewerHash = hash;
  }).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
}

// Page keys can jump completely across a 1px infinite-scroll sentinel between
// animation frames. Pre-extend the virtual window when the next page would cross
// an edge, then wait for its anchor restoration before performing the page
// scroll. This avoids both missed loads and delayed anchor callbacks fighting a
// held Page Up/Page Down key.
let pageBusy = false;
let queuedDirection = 0;
let releaseTimer = 0;

function pageDistance() {
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return Math.max(160, innerHeight - top - 36);
}

function editingControl(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function canExtend(direction) {
  const state = window.mochimonoLibrary?.state?.();
  return direction < 0 ? Boolean(state?.hasPrevious) : Boolean(state?.hasMore);
}

function shouldPreExtend(direction, distance) {
  if (!canExtend(direction)) return false;
  if (direction < 0) {
    const rect = topSentinel?.getBoundingClientRect();
    const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
    return Boolean(rect && rect.bottom >= top - EDGE_MARGIN - distance);
  }
  const rect = bottomSentinel?.getBoundingClientRect();
  return Boolean(rect && rect.top <= innerHeight + EDGE_MARGIN + distance);
}

function extend(direction) {
  const changed = Boolean(window.mochimonoLibrary?.extend?.(direction));
  if (changed) window.mochimonoGallery?.layoutNow?.();
  return changed;
}

function armRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releasePageKeys, 220);
}

function finishPage() {
  pageBusy = false;
  const next = queuedDirection;
  queuedDirection = 0;
  if (next) runPage(next);
}

function doScroll(direction, distance) {
  const before = window.scrollY;
  window.scrollBy({ top: direction * distance, left: 0, behavior: 'auto' });
  requestAnimationFrame(() => {
    const moved = Math.abs(window.scrollY - before);
    // Correctness fallback for unusual layouts: if the browser clamped the page
    // before an edge observer could run, expose another virtual page now.
    if (moved < distance * .65 && canExtend(direction)) extend(direction);
    finishPage();
  });
}

function runPage(direction) {
  if (pageBusy) {
    queuedDirection = direction;
    return;
  }
  pageBusy = true;
  const distance = pageDistance();
  window.mochimonoGridInteraction?.pulse?.(220);
  armRelease();

  if (!shouldPreExtend(direction, distance) || !extend(direction)) {
    doScroll(direction, distance);
    return;
  }

  // library-app restores the prepend/trim anchor over two animation frames.
  // Scroll only after that restoration has completed so repeated Page Up/Down
  // cannot be undone by an older delayed callback.
  requestAnimationFrame(() => requestAnimationFrame(() => doScroll(direction, distance)));
}

function pressPageKey(key) {
  if (!PAGE_KEYS.has(key) || (viewer && !viewer.hidden)) return false;
  runPage(key === 'PageUp' ? -1 : 1);
  return true;
}

function releasePageKeys() {
  clearTimeout(releaseTimer);
  releaseTimer = 0;
  queuedDirection = 0;
  window.mochimonoGridInteraction?.release?.();
}

window.mochimonoPageKeys = { press: pressPageKey, release: releasePageKeys };

window.addEventListener('keydown', event => {
  if (!PAGE_KEYS.has(event.key) || editingControl(event.target) || !pressPageKey(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

window.addEventListener('keyup', event => {
  if (!PAGE_KEYS.has(event.key)) return;
  releasePageKeys();
}, true);
window.addEventListener('blur', releasePageKeys);
