const files = document.querySelector('#files');
const THUMB_VERSION = 3;
const PRELOAD_MARGIN = Math.max(1100, Math.round(innerHeight * 2.6));
const liveDimensions = new Map();
const modelIndexes = new WeakMap();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

let geometryTimer = 0;
let geometryDirty = false;
let dirtySince = 0;
let lastScrollAt = 0;
let restoreAnchor = null;

function modelIndex(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return null;
  let index = modelIndexes.get(snapshot);
  if (!index) {
    index = new Map(snapshot.items.map((item, position) => [String(item?.[0] || ''), position]));
    modelIndexes.set(snapshot, index);
  }
  return index;
}

function applyKnownDimensions(snapshot) {
  const index = modelIndex(snapshot);
  if (!index) return 0;
  let changed = 0;
  for (const [hash, geometry] of liveDimensions) {
    const position = index.get(hash);
    if (!Number.isInteger(position)) continue;
    const item = snapshot.items[position];
    if (!item || (Number(item[3]) === geometry.width && Number(item[4]) === geometry.height)) continue;
    item[3] = geometry.width;
    item[4] = geometry.height;
    changed++;
  }
  return changed;
}

function captureAnchor() {
  if (!files || !window.mochimonoStableGrid?.active?.()) return null;
  const top = (document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0) + 2;
  let best = null;
  let distance = Infinity;
  for (const card of files.querySelectorAll('.stable-grid-row [data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= top || rect.top >= innerHeight) continue;
    const next = Math.abs(rect.top - top);
    if (next >= distance) continue;
    distance = next;
    best = { hash:String(card.dataset.hash || ''), top:rect.top };
  }
  return best;
}

function interactionActive() {
  return Boolean(window.mochimonoGridInteraction?.active?.()) ||
    document.querySelector('#dateRail')?.classList.contains('dragging') ||
    performance.now() - lastScrollAt < 420;
}

function scheduleGeometry(delay = 150) {
  if (!geometryDirty) return;
  if (!dirtySince) dirtySince = performance.now();
  clearTimeout(geometryTimer);
  const age = performance.now() - dirtySince;
  geometryTimer = setTimeout(flushGeometry, Math.max(35, Math.min(delay, Math.max(35, 900 - age))));
}

function flushGeometry() {
  geometryTimer = 0;
  if (!geometryDirty) return;
  if (interactionActive()) {
    scheduleGeometry(300);
    return;
  }

  const snapshot = window.mochimonoGridModel;
  const stable = window.mochimonoStableGrid;
  if (!snapshot?.items?.length || !stable?.setModel) {
    scheduleGeometry(250);
    return;
  }

  applyKnownDimensions(snapshot);
  geometryDirty = false;
  dirtySince = 0;
  restoreAnchor = captureAnchor();
  stable.setModel(snapshot);
}

function rememberDimensions(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!hash || width <= 0 || height <= 0) return;

  const previous = liveDimensions.get(hash);
  if (previous?.width === width && previous?.height === height) return;
  liveDimensions.set(hash, { width, height });
  try { window.mochimonoCatalogCache?.rememberDimensions?.(hash, width, height); } catch {}

  const snapshot = window.mochimonoGridModel;
  const index = modelIndex(snapshot);
  const position = index?.get(hash);
  if (!Number.isInteger(position)) return;
  const item = snapshot.items[position];
  if (!item || (Number(item[3]) === width && Number(item[4]) === height)) return;
  item[3] = width;
  item[4] = height;
  geometryDirty = true;
  scheduleGeometry();
}

function reveal(card, image) {
  if (image.dataset.mochimonoRevealed === '1') return;
  image.dataset.mochimonoRevealed = '1';
  if (reduceMotion.matches || typeof image.animate !== 'function') return;
  const rect = card.getBoundingClientRect();
  if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return;
  image.animate([{ opacity:.18 }, { opacity:1 }], { duration:80, easing:'ease-out' });
}

function bindImage(card, image, hash, owned = false) {
  if (!(image instanceof HTMLImageElement) || image.dataset.mochimonoWarmBound === '1') return;
  image.dataset.mochimonoWarmBound = '1';
  const ready = () => {
    if (!image.isConnected || image.dataset.thumbHash !== hash || !image.naturalWidth || !image.naturalHeight) return;
    card.querySelector('.video-thumb-pending')?.remove();
    rememberDimensions(hash, image.naturalWidth, image.naturalHeight);
    reveal(card, image);
  };
  image.addEventListener('load', ready, { once:true });
  if (owned) image.addEventListener('error', () => {
    if (image.isConnected && image.dataset.thumbHash === hash) image.remove();
  }, { once:true });
  if (image.complete) {
    if (image.naturalWidth && image.naturalHeight) ready();
    else if (owned) image.remove();
  }
}

function primeCard(card) {
  if (!card?.isConnected || !card.classList.contains('media-card')) return;
  const hash = String(card.dataset.hash || '');
  const box = card.querySelector('.media-thumb');
  if (!hash || !box) return;

  const current = box.querySelector('img.cached-thumb');
  if (current) {
    bindImage(card, current, hash, false);
    return;
  }

  const image = document.createElement('img');
  image.className = 'cached-thumb';
  image.alt = '';
  image.hidden = false;
  image.decoding = 'async';
  image.loading = 'eager';
  image.style.objectFit = 'cover';
  image.dataset.thumbHash = hash;
  try { image.fetchPriority = 'auto'; } catch {}
  bindImage(card, image, hash, true);
  box.prepend(image);
  image.src = `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
  image.decode?.().catch(() => {});
}

function primeRow(row) {
  if (!(row instanceof Element) || !row.isConnected) return;
  for (const card of row.querySelectorAll('.media-card[data-hash]')) primeCard(card);
}

const rowObserver = files && typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) primeRow(entry.target);
    }, { rootMargin:`${PRELOAD_MARGIN}px 0px` })
  : null;

function rowsIn(node) {
  if (!(node instanceof Element)) return [];
  const rows = [];
  if (node.matches('.stable-grid-row')) rows.push(node);
  rows.push(...node.querySelectorAll?.('.stable-grid-row') || []);
  return rows;
}

function observeTree(node) {
  for (const row of rowsIn(node)) {
    if (row.dataset.mochimonoWarmObserved === '1') continue;
    row.dataset.mochimonoWarmObserved = '1';
    if (rowObserver) rowObserver.observe(row);
    else primeRow(row);
  }
}

function forgetTree(node) {
  if (!rowObserver) return;
  for (const row of rowsIn(node)) rowObserver.unobserve(row);
}

const stable = window.mochimonoStableGrid;
if (stable?.setModel && stable.__mochimonoRatioSync !== true) {
  const originalSetModel = stable.setModel.bind(stable);
  stable.setModel = snapshot => {
    applyKnownDimensions(snapshot);
    return originalSetModel(snapshot);
  };
  stable.__mochimonoRatioSync = true;
}

if (files) {
  observeTree(files);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.removedNodes) forgetTree(node);
    for (const record of records) for (const node of record.addedNodes) observeTree(node);
  }).observe(files, { childList:true, subtree:true });

  window.addEventListener('scroll', () => {
    lastScrollAt = performance.now();
    if (restoreAnchor) restoreAnchor = captureAnchor() || restoreAnchor;
    if (geometryDirty) scheduleGeometry(460);
  }, { passive:true });

  window.addEventListener('mochimono:grid-interaction-end', () => {
    if (geometryDirty) scheduleGeometry(220);
  });

  window.addEventListener('mochimono:stable-grid-installed', () => {
    observeTree(files);
    const anchor = restoreAnchor;
    restoreAnchor = null;
    if (!anchor?.hash) return;
    const snapshot = window.mochimonoGridModel;
    const index = modelIndex(snapshot)?.get(anchor.hash);
    if (!Number.isInteger(index)) return;
    requestAnimationFrame(() => {
      window.mochimonoStableGrid?.ensureIndex?.(index);
      const card = files.querySelector(`[data-hash="${CSS.escape(anchor.hash)}"]`);
      if (!card) return;
      const delta = card.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) > .5) scrollBy(0, delta);
    });
  });
}
