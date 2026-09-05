const BATCH_SIZE = 500;
const CHECK_WORKERS = 2;
const RETRY_DELAY_MS = 180;
const MAX_RETRIES = 5;

const geometry = new Map();
const grid = window.mochimonoStableGrid;
const catalogCache = window.mochimonoCatalogCache;
const originalSetModel = grid?.setModel?.bind(grid);
const originalRememberDimensions = catalogCache?.rememberDimensions?.bind(catalogCache);

let generation = 0;
let currentSnapshot = null;
let lastApplied = null;
let retryTimer = 0;
let checking = 0;
let checked = 0;
let learned = 0;
let failedChecks = 0;
let unresolved = 0;

function mediaItem(item) {
  const type = String(item?.[2] || '');
  return type === 'image' || type === 'video';
}

function hasGeometry(width, height) {
  return Number(width) > 0 && Number(height) > 0;
}

function remember(hash, width, height, persist = true) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!hash || width <= 0 || height <= 0) return false;
  const previous = geometry.get(hash);
  if (previous?.width === width && previous?.height === height) return false;
  geometry.set(hash, { width, height });
  learned++;
  if (persist) {
    try { originalRememberDimensions?.(hash, width, height); } catch {}
  }
  return true;
}

function enrich(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items) || !geometry.size) return snapshot;
  let items = null;
  for (let index = 0; index < snapshot.items.length; index++) {
    const item = snapshot.items[index];
    if (!mediaItem(item) || hasGeometry(item?.[3], item?.[4])) continue;
    const known = geometry.get(String(item?.[0] || ''));
    if (!known) continue;
    items ||= snapshot.items.slice();
    const copy = [...item];
    copy[3] = known.width;
    copy[4] = known.height;
    items[index] = copy;
  }
  return items ? { ...snapshot, items } : snapshot;
}

function missingHashes(snapshot) {
  const hashes = [];
  const seen = new Set();
  for (const item of snapshot?.items || []) {
    if (!mediaItem(item) || hasGeometry(item?.[3], item?.[4])) continue;
    const hash = String(item?.[0] || '');
    if (!hash || geometry.has(hash) || seen.has(hash)) continue;
    seen.add(hash);
    hashes.push(hash);
  }
  return hashes;
}

async function checkBatch(hashes) {
  checking++;
  try {
    const response = await fetch('/api/thumbs/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ hashes, background:true })
    });
    if (!response.ok) throw new Error(`geometry check ${response.status}`);
    const data = await response.json();
    checked += hashes.length;
    for (const item of data.thumbnails || []) remember(item.hash, item.width, item.height, true);
  } catch {
    failedChecks++;
  } finally {
    checking = Math.max(0, checking - 1);
  }
}

async function checkAll(hashes) {
  const batches = [];
  for (let offset = 0; offset < hashes.length; offset += BATCH_SIZE) batches.push(hashes.slice(offset, offset + BATCH_SIZE));
  let cursor = 0;
  const workers = Array.from({ length:Math.min(CHECK_WORKERS, batches.length) }, async () => {
    while (cursor < batches.length) await checkBatch(batches[cursor++]);
  });
  await Promise.all(workers);
}

function apply(snapshot) {
  const next = enrich(snapshot);
  lastApplied = next;
  window.mochimonoGridModel = next;
  return originalSetModel?.(next) ?? false;
}

function scheduleRetry(snapshot, token, attempt) {
  clearTimeout(retryTimer);
  if (attempt >= MAX_RETRIES) return;
  retryTimer = setTimeout(async () => {
    if (token !== generation || snapshot !== currentSnapshot) return;
    const missing = missingHashes(enrich(snapshot));
    unresolved = missing.length;
    if (!missing.length) return apply(snapshot);
    await checkAll(missing);
    if (token !== generation || snapshot !== currentSnapshot) return;
    apply(snapshot);
    const remaining = missingHashes(enrich(snapshot));
    unresolved = remaining.length;
    if (remaining.length) scheduleRetry(snapshot, token, attempt + 1);
  }, RETRY_DELAY_MS * (attempt + 1));
}

async function prime(snapshot, token) {
  const first = enrich(snapshot);
  const missing = missingHashes(first);
  unresolved = missing.length;
  if (!missing.length) {
    if (token === generation && snapshot === currentSnapshot) apply(snapshot);
    return;
  }

  // Migration path for old catalogs: one status pass happens before layout so
  // already-generated local/server previews never enter the worker with fake geometry.
  await checkAll(missing);
  if (token !== generation || snapshot !== currentSnapshot) return;
  apply(snapshot);

  const remaining = missingHashes(enrich(snapshot));
  unresolved = remaining.length;
  if (remaining.length) scheduleRetry(snapshot, token, 0);
}

function refreshFromLearnedGeometry() {
  if (!currentSnapshot || !originalSetModel) return;
  const next = enrich(currentSnapshot);
  if (next === currentSnapshot && lastApplied === currentSnapshot) return;
  apply(currentSnapshot);
}

if (catalogCache && originalRememberDimensions) {
  catalogCache.rememberDimensions = (hash, width, height) => {
    originalRememberDimensions(hash, width, height);
    if (remember(hash, width, height, false)) queueMicrotask(refreshFromLearnedGeometry);
  };
}

if (grid && originalSetModel) {
  grid.setModel = snapshot => {
    currentSnapshot = snapshot;
    clearTimeout(retryTimer);
    retryTimer = 0;
    const token = ++generation;
    const first = enrich(snapshot);
    const missing = missingHashes(first);
    unresolved = missing.length;
    if (!missing.length) return apply(snapshot);
    prime(snapshot, token).catch(() => {
      if (token === generation && snapshot === currentSnapshot) apply(snapshot);
    });
    return true;
  };
}

window.mochimonoGeometryBootstrap = {
  state:() => ({ known:geometry.size, checking, checked, learned, failedChecks, unresolved, generation })
};
