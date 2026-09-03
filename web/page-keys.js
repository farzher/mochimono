const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const commandbar = document.querySelector('.commandbar');
const pageKeys = new Set(['PageUp', 'PageDown']);
const EDGE_MARGIN = 240;

// thumbs.js already bounds loading to cards near the viewport. Once it creates
// an image, native lazy-loading is a redundant second gate that can strand a
// thumbnail until hover/keyboard interaction promotes it.
function promoteThumbs(root = files) {
  if (!root) return;
  const images = root.matches?.('img.cached-thumb')
    ? [root]
    : [...(root.querySelectorAll?.('img.cached-thumb') || [])];
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

// A full Page Up/Down can skip across the 1px virtualization sentinel between
// IntersectionObserver samples. Extend before crossing an edge and wait for the
// library's prepend anchor restoration before applying the page movement.
let pageBusy = false;
let queuedDirection = 0;
let releaseTimer = 0;

function editingControl(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function pageDistance() {
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return Math.max(160, innerHeight - top - 36);
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

function extend(direction) {
  const changed = Boolean(window.mochimonoLibrary?.extend?.(direction));
  if (changed) window.mochimonoGallery?.layoutNow?.();
  return changed;
}

function afterAnchorRestore(callback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function release() {
  clearTimeout(releaseTimer);
  releaseTimer = 0;
  queuedDirection = 0;
  window.mochimonoGridInteraction?.release?.();
}

function armRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, 220);
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
    if (moved < distance * .65 && canExtend(direction) && extend(direction)) {
      const remaining = Math.max(0, distance - moved);
      afterAnchorRestore(() => {
        if (remaining) window.scrollBy({ top: direction * remaining, left: 0, behavior: 'auto' });
        requestAnimationFrame(finishPage);
      });
      return;
    }
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

  if (!shouldPreExtend(direction, distance) || !extend(direction)) {
    doScroll(direction, distance);
    return;
  }
  afterAnchorRestore(() => doScroll(direction, distance));
}

function press(key) {
  if (!pageKeys.has(key) || (viewer && !viewer.hidden)) return false;
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
