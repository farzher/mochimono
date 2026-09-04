const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const commandbar = document.querySelector('.commandbar');
const pageKeys = new Set(['PageUp', 'PageDown', 'Home', 'End']);

let viewerWasOpen = Boolean(viewer && !viewer.hidden);
let viewerScrollY = window.scrollY;
let lastViewerHash = '';
let releaseTimer = 0;

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
    else if (!open && viewerWasOpen) requestAnimationFrame(() => revealOnlyIfNeeded(lastViewerHash, viewerScrollY));
    viewerWasOpen = open;
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  new MutationObserver(() => {
    const hash = viewerHash();
    if (hash) lastViewerHash = hash;
  }).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
}

function editingControl(target) {
  return Boolean(target?.closest?.('input,select,textarea,[contenteditable="true"]'));
}

function pageDistance() {
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return Math.max(160, innerHeight - top - 36);
}

function release() {
  clearTimeout(releaseTimer);
  releaseTimer = 0;
  window.mochimonoGridInteraction?.release?.();
}

function armRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, 180);
}

function jumpEdge(key) {
  const library = window.mochimonoLibrary;
  const hashes = library?.filteredHashes?.();
  if (!Array.isArray(hashes) || !hashes.length) return false;
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
  armRelease();
  return true;
}

function press(key) {
  if (!pageKeys.has(key) || (viewer && !viewer.hidden)) return false;
  if (key === 'Home' || key === 'End') return jumpEdge(key);
  const direction = key === 'PageUp' ? -1 : 1;
  window.mochimonoGridInteraction?.pulse?.(180);
  window.scrollBy({ top: direction * pageDistance(), left: 0, behavior: 'auto' });
  armRelease();
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
