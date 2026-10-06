const grid = window.mochimonoStableGrid;
const cache = window.mochimonoCatalogCache;
const setModel = grid?.setModel?.bind(grid);
const rememberDimensions = cache?.rememberDimensions?.bind(cache);
const geometry = new Map();
const queued = new Set();
const checked = new Set();
let current = null;
let missing = new Set();
let checking = false;
let timer = 0;
let pending = false;
let installed = false;

function enrich(snapshot) {
  let items = null;
  for (let i = 0; i < snapshot.items.length; i++) {
    const item = snapshot.items[i];
    if (Number(item[3]) > 0 && Number(item[4]) > 0) continue;
    const known = geometry.get(String(item[0]));
    if (!known) continue;
    items ||= snapshot.items.slice();
    items[i] = [...item];
    items[i][3] = known.width;
    items[i][4] = known.height;
  }
  return items ? { ...snapshot, items } : snapshot;
}

function apply() {
  if (!current || !setModel) return false;
  const next = enrich(current);
  missing = new Set(next.items.filter(item =>
    (item[2] === 'image' || item[2] === 'video') && !(item[3] > 0 && item[4] > 0)
  ).map(item => String(item[0])));
  window.mochimonoGridModel = next;
  installed = true;
  return setModel(next);
}

function refresh() {
  timer = 0;
  if (!pending) return;
  if (checking || window.mochimonoGridInteraction?.active?.() || document.querySelector('#viewer')?.hidden === false) return;
  pending = false;
  if (current) current = { ...current, preserveAnchor:true };
  apply();
}

function scheduleRefresh() {
  pending = true;
  if (!timer) timer = setTimeout(refresh, 55);
}

function remember(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!hash || width <= 0 || height <= 0) return;
  const old = geometry.get(hash);
  if (old?.width === width && old?.height === height) return;
  geometry.set(hash, { width, height });
  if (missing.delete(hash) && installed) scheduleRefresh();
}

// Read geometry from existing previews for the entire model, not only images
// that happen to be decoded on screen. Never wait for preview generation.
async function checkGeometry() {
  if (checking) return;
  checking = true;
  try {
    while (queued.size) {
      const hashes = [...queued].slice(0, 500);
      for (const hash of hashes) queued.delete(hash);
      try {
        const response = await fetch('/api/thumbs/check', {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ hashes, cachedOnly:true })
        });
        if (!response.ok) throw new Error(`Geometry check ${response.status}`);
        const data = await response.json();
        for (const item of data.thumbnails || []) {
          remember(item.hash, item.width, item.height);
          rememberDimensions?.(item.hash, item.width, item.height);
        }
      } catch {
        // A failed lookup must not prevent the library from opening.
      }
    }
  } finally {
    checking = false;
    pending = false;
    clearTimeout(timer);
    timer = 0;
    if (current) apply();
  }
}

if (grid && setModel) grid.setModel = snapshot => {
  current = snapshot;
  pending = false;
  clearTimeout(timer);
  timer = 0;
  const next = enrich(snapshot);
  missing = new Set(next.items.filter(item =>
    (item[2] === 'image' || item[2] === 'video') && !(item[3] > 0 && item[4] > 0)
  ).map(item => String(item[0])));
  for (const hash of missing) {
    if (checked.has(hash)) continue;
    checked.add(hash);
    queued.add(hash);
  }
  // Never replace a correctly shaped grid with default-size placeholders for
  // previews that already exist. Keep the old model usable during discovery.
  if (!missing.size || (!checking && !queued.size)) apply();
  if (queued.size) void checkGeometry();
  return true;
};

if (cache && rememberDimensions) cache.rememberDimensions = (hash, width, height) => {
  rememberDimensions(hash, width, height);
  remember(hash, width, height);
};

window.addEventListener('mochimono:grid-interaction-end', () => {
  if (pending) { clearTimeout(timer); timer = setTimeout(refresh, 0); }
});
const viewer = document.querySelector('#viewer');
if (viewer) new MutationObserver(() => {
  if (viewer.hidden && pending) scheduleRefresh();
}).observe(viewer, { attributes:true, attributeFilter:['hidden'] });

window.mochimonoGeometryBootstrap = {
  state:() => ({ known:geometry.size, checking, queued:queued.size, unresolved:missing.size, pending })
};
