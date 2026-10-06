// Catalog pages already carry cached-preview geometry. Do not sweep the entire
// library through /thumbs/check before installing a model: disconnected sources
// can contain hundreds of thousands of legitimately missing previews.
const grid = window.mochimonoStableGrid;
const cache = window.mochimonoCatalogCache;
const setModel = grid?.setModel?.bind(grid);
const rememberDimensions = cache?.rememberDimensions?.bind(cache);
const geometry = new Map();
let current = null;
let missing = new Set();
let timer = 0;
let pending = false;

function enrich(snapshot) {
  let items;
  missing.clear();
  for (let i = 0; i < snapshot.items.length; i++) {
    const item = snapshot.items[i];
    if (item[3] > 0 && item[4] > 0) continue;
    const known = geometry.get(String(item[0]));
    if (known) {
      items ||= snapshot.items.slice();
      items[i] = [...item];
      items[i][3] = known.width;
      items[i][4] = known.height;
    } else if (item[2] === 'image' || item[2] === 'video') missing.add(String(item[0]));
  }
  return items ? { ...snapshot, items } : snapshot;
}

function refresh() {
  timer = 0;
  if (!pending || !current) return;
  if (window.mochimonoGridInteraction?.active?.() || document.querySelector('#viewer')?.hidden === false) return;
  pending = false;
  const next = enrich({ ...current, preserveAnchor:true });
  window.mochimonoGridModel = next;
  setModel(next);
}

if (grid && setModel) grid.setModel = snapshot => {
  current = snapshot;
  pending = false;
  clearTimeout(timer);
  timer = 0;
  const next = enrich(snapshot);
  window.mochimonoGridModel = next;
  return setModel(next);
};
if (cache && rememberDimensions) cache.rememberDimensions = (hash, width, height) => {
  rememberDimensions(hash, width, height);
  if (!(width > 0 && height > 0)) return;
  geometry.set(String(hash), { width, height });
  if (!missing.delete(String(hash))) return;
  pending = true;
  if (!timer) timer = setTimeout(refresh, 1000);
};
addEventListener('mochimono:grid-interaction-end', () => {
  if (pending && !timer) timer = setTimeout(refresh, 500);
});
const viewer = document.querySelector('#viewer');
if (viewer) new MutationObserver(() => {
  if (viewer.hidden && pending && !timer) timer = setTimeout(refresh, 500);
}).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
window.mochimonoGeometryBootstrap = { state:() => ({ known:geometry.size, unresolved:missing.size, pending }) };
