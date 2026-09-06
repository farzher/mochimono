const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const commandbar = document.querySelector('.commandbar');
const search = document.querySelector('#search');

const VIEWPORT_PREFILL = 180;
const REFRESH_RETRY_MS = 120;
const REFRESH_PASSES = 3;
const VIEWER_DWELL_MS = 900;
const VIEWER_DWELL_RADIUS = 24;

let refreshTimer = 0;
let refreshGeneration = 0;
let dwellTimer = 0;
let dwellHash = '';

function onScreen(card) {
  if (!card?.isConnected) return false;
  const rect = card.getBoundingClientRect();
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return rect.bottom > top && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
}

function currentViewerHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function materializeCurrentWindow(grid) {
  const center = Number(grid.visibleIndex?.());
  const count = Number(grid.count?.()) || 0;
  if (!Number.isInteger(center) || center < 0 || !count) return;
  const start = Math.max(0, center - VIEWPORT_PREFILL);
  const end = Math.min(count - 1, center + VIEWPORT_PREFILL);
  for (let index = start; index <= end; index++) grid.ensureIndex?.(index);
}

function cardsAroundViewport() {
  if (!files) return [];
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  const marginBefore = innerHeight * .65;
  const marginAfter = innerHeight * 1.5;
  const start = top - marginBefore;
  const end = innerHeight + marginAfter;
  return [...files.querySelectorAll('.media-card[data-hash]')].filter(card => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > start && rect.top < end && rect.right > 0 && rect.left < innerWidth;
  });
}

function refreshPass(generation, pass = 0) {
  if (generation !== refreshGeneration || !viewer?.hidden || !files?.classList.contains('grid')) return;
  const grid = window.mochimonoStableGrid;
  if (!grid?.active?.()) {
    if (pass < REFRESH_PASSES) refreshTimer = setTimeout(() => refreshPass(generation, pass + 1), REFRESH_RETRY_MS);
    return;
  }

  const state = grid.state?.() || {};
  if (state.building || window.mochimonoGridInteraction?.rapid?.()) {
    if (pass < REFRESH_PASSES) refreshTimer = setTimeout(() => refreshPass(generation, pass + 1), REFRESH_RETRY_MS);
    return;
  }

  materializeCurrentWindow(grid);
  requestAnimationFrame(() => {
    if (generation !== refreshGeneration || !viewer?.hidden) return;
    const cards = cardsAroundViewport();
    const thumbnails = window.mochimonoThumbnails;
    thumbnails?.prioritize?.(cards);
    grid.syncThumbnails?.();
    const hashes = cards.map(card => card.dataset.hash).filter(Boolean);
    if (hashes.length) thumbnails?.ensureHashes?.(hashes, { background:false }).catch?.(() => {});
  });

  if (pass < REFRESH_PASSES) {
    refreshTimer = setTimeout(() => refreshPass(generation, pass + 1), REFRESH_RETRY_MS * (pass + 1));
  }
}

function scheduleViewportRefresh(delay = 0) {
  clearTimeout(refreshTimer);
  const generation = ++refreshGeneration;
  refreshTimer = setTimeout(() => refreshPass(generation, 0), Math.max(0, delay));
}

function positionReturnedHash(hash) {
  const grid = window.mochimonoStableGrid;
  if (!hash || !grid?.active?.()) return;
  const card = files?.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  if (card && onScreen(card)) return;

  const hashes = window.mochimonoLibrary?.filteredHashes?.();
  const index = Array.isArray(hashes) ? hashes.indexOf(hash) : -1;
  if (index >= 0 && grid.scrollToIndex?.(index, 'center')) return;
  card?.scrollIntoView({ behavior:'auto', block:'center', inline:'nearest' });
}

function scheduleViewerDwell() {
  clearTimeout(dwellTimer);
  dwellTimer = 0;
  const hash = currentViewerHash();
  dwellHash = hash;
  if (!hash || viewer?.hidden) return;
  dwellTimer = setTimeout(() => warmViewerNeighborhood(hash), VIEWER_DWELL_MS);
}

function warmViewerNeighborhood(hash) {
  dwellTimer = 0;
  if (!hash || viewer?.hidden || currentViewerHash() !== hash || dwellHash !== hash) return;
  if (window.mochimonoViewerPerformance?.rapid?.()) {
    dwellTimer = setTimeout(() => warmViewerNeighborhood(hash), REFRESH_RETRY_MS);
    return;
  }

  const hashes = window.mochimonoLibrary?.filteredHashes?.();
  if (!Array.isArray(hashes) || !hashes.length) return;
  const index = hashes.indexOf(hash);
  if (index < 0) return;
  const nearby = hashes.slice(
    Math.max(0, index - VIEWER_DWELL_RADIUS),
    Math.min(hashes.length, index + VIEWER_DWELL_RADIUS + 1)
  );
  window.mochimonoThumbnails?.ensureHashes?.(nearby, { background:true }).catch?.(() => {});
}

window.addEventListener('mochimono-viewer-return', event => {
  if (!files?.classList.contains('grid')) return;
  positionReturnedHash(String(event.detail?.hash || ''));
  scheduleViewportRefresh();
});

window.addEventListener('mochimono:stable-grid-installed', () => {
  if (viewer?.hidden) scheduleViewportRefresh();
});

window.addEventListener('mochimono:grid-fast-scroll-end', () => {
  if (viewer?.hidden) scheduleViewportRefresh();
});

window.addEventListener('mochimono:grid-interaction-end', () => {
  if (viewer?.hidden) scheduleViewportRefresh(20);
});

search?.addEventListener('input', () => {
  if (viewer?.hidden) scheduleViewportRefresh(90);
}, { passive:true });

if (viewer && viewerOpen && typeof MutationObserver === 'function') {
  const observer = new MutationObserver(() => {
    if (viewer.hidden) {
      clearTimeout(dwellTimer);
      dwellTimer = 0;
      dwellHash = '';
      scheduleViewportRefresh();
    } else scheduleViewerDwell();
  });
  observer.observe(viewer, { attributes:true, attributeFilter:['hidden'] });
  observer.observe(viewerOpen, { attributes:true, attributeFilter:['href'] });
}

addEventListener('beforeunload', () => {
  clearTimeout(refreshTimer);
  clearTimeout(dwellTimer);
}, { once:true });
