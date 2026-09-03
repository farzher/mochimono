const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const commandbar = document.querySelector('.commandbar');
const pageKeys = new Set(['PageUp', 'PageDown', 'Home', 'End']);
const EDGE_MARGIN = 240;

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
let motionGeneration = 0;

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

function finishPage(generation) {
  if (generation !== motionGeneration) return;
  pageBusy = false;
  const next = queuedDirection;
  queuedDirection = 0;
  if (next) runPage(next);
}

function doScroll(direction, distance, generation) {
  if (generation !== motionGeneration) return;
  const before = window.scrollY;
  window.scrollBy({ top: direction * distance, left: 0, behavior: 'auto' });
  requestAnimationFrame(() => {
    if (generation !== motionGeneration) return;
    const moved = Math.abs(window.scrollY - before);
    if (moved < distance * .65 && canExtend(direction) && extend(direction)) {
      const remaining = Math.max(0, distance - moved);
      afterAnchorRestore(() => {
        if (generation !== motionGeneration) return;
        if (remaining) window.scrollBy({ top: direction * remaining, left: 0, behavior: 'auto' });
        requestAnimationFrame(() => finishPage(generation));
      });
      return;
    }
    finishPage(generation);
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

  if (!shouldPreExtend(direction, distance) || !extend(direction)) {
    doScroll(direction, distance, generation);
    return;
  }
  afterAnchorRestore(() => doScroll(direction, distance, generation));
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
      if (generation === motionGeneration) window.mochimonoGridInteraction?.release?.();
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
