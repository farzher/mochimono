const folders = document.querySelector('#folders');
const storagePane = document.querySelector('#storagePane');
const toastNode = document.querySelector('#toast');
const CACHE_STATS_PATH = '@mochimono:cache';

let cacheStats = null;
let cacheLoadedAt = 0;
let cacheLoading = null;
let decorateTimer = 0;

const style = document.createElement('style');
style.textContent = `
  #storagePane .folder-item .storage-modes.storage-mode-group{
    display:flex;align-items:center;gap:5px;flex-wrap:wrap;
    padding:0;border:0;background:transparent;color:inherit;border-radius:0
  }
  #storagePane .folder-item .storage-mode-chip{
    display:inline-flex;align-items:center;min-height:20px;padding:3px 7px;
    border:1px solid rgba(224,159,151,.13);border-radius:999px;
    background:#2a2023;color:#dfaaa4;font-size:9px;font-weight:760;line-height:1.25;white-space:nowrap
  }
  #storagePane .folder-item .storage-mode-chip.kind,
  #storagePane .folder-item .storage-mode-chip.local{
    border-color:rgba(255,255,255,.08);background:#1c1a1d;color:#a7a09d
  }
`;
document.head.append(style);

function toast(text) {
  if (!toastNode) return;
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
}

function bytes(number) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let value = Math.max(0, Number(number) || 0), unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    cache:'no-store',
    ...options,
    headers:{ 'content-type':'application/json', ...(options.headers || {}) },
    body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

function setChips(node, chips, title = '') {
  if (!node) return;
  const key = chips.map(chip => `${chip.label}:${chip.className || ''}`).join('|');
  if (node.dataset.chipKey !== key) {
    node.dataset.chipKey = key;
    node.className = 'storage-modes storage-mode-group';
    node.replaceChildren(...chips.map(chip => {
      const span = document.createElement('span');
      span.className = `storage-mode-chip ${chip.className || ''}`.trim();
      span.textContent = chip.label;
      return span;
    }));
  }
  node.title = title;
}

function nativeScopeLabel(row) {
  const badge = row.querySelector('.storage-modes');
  return /everything/i.test(badge?.textContent || '') ? 'Everything' : 'Media';
}

function decorateNativeSource(row) {
  const badge = row.querySelector('.storage-modes');
  if (!badge) return;
  const cloud = row.classList.contains('cloud-folder');
  const scope = nativeScopeLabel(row);
  const chips = [
    { label:'Local', className:'local' },
    ...(cloud ? [{ label:'Cloud', className:'cloud' }] : []),
    { label:scope, className:'scope' }
  ];
  setChips(badge, chips, cloud
    ? `${scope === 'Everything' ? 'All files' : 'Photos and videos'} · local original + Cloud copy`
    : `${scope === 'Everything' ? 'All files' : 'Photos and videos'} · local only`);
}

function decorateBrowserSource(row) {
  const badge = row.querySelector('.storage-modes');
  if (!badge) return;
  const scope = String(row.querySelector('[data-browser-scope]')?.textContent || '').trim() === 'Everything' ? 'Everything' : 'Media';
  const cloud = String(row.querySelector('[data-browser-cloud]')?.textContent || '').trim() === 'Local';
  const chips = [
    { label:'Browser', className:'kind' },
    { label:'Local', className:'local' },
    ...(cloud ? [{ label:'Cloud', className:'cloud' }] : []),
    { label:scope, className:'scope' }
  ];
  setChips(badge, chips, cloud ? 'Browser-style folder · local original + Cloud copy' : 'Browser-style folder · local only');
  const preview = row.querySelector('.storage-folder-samples');
  if (preview) preview.title = 'View browser folder in Library';
}

function decorateSources() {
  for (const row of folders?.querySelectorAll(':scope > [data-folder-path]:not([data-browser-folder])') || []) decorateNativeSource(row);
  for (const row of folders?.querySelectorAll(':scope > [data-browser-folder]') || []) decorateBrowserSource(row);
}

async function loadCacheStats(force = false) {
  if (!force && cacheStats && Date.now() - cacheLoadedAt < 5 * 60_000) return cacheStats;
  if (cacheLoading) return cacheLoading;
  cacheLoading = request(`/api/client/local-catalog?limit=1&path=${encodeURIComponent(CACHE_STATS_PATH)}`)
    .then(data => {
      cacheStats = data.cacheStats || null;
      cacheLoadedAt = Date.now();
      return cacheStats;
    })
    .finally(() => { cacheLoading = null; });
  return cacheLoading;
}

function decorateCacheCard() {
  const card = document.querySelector('[data-location-id="local-cache"]');
  if (!card || !cacheStats) return;
  const indexed = Math.max(0, Number(cacheStats.indexedFiles) || 0);
  const path = String(cacheStats.path || '');
  const meta = card.querySelector('.managed-storage-meta');
  setText(meta, `${indexed.toLocaleString()} files indexed${path ? ` · ${path}` : ''}`);
  if (meta) meta.title = path;
  const used = card.querySelector('.managed-storage-space > span:first-child');
  setText(used, `${bytes(cacheStats.bytes)} cache`);
  const free = card.querySelector('.managed-storage-space .free');
  if (free && Number(cacheStats.freeBytes) > 0) setText(free, `${bytes(cacheStats.freeBytes)} free`);
  card.title = path ? `Open ${path} in Explorer` : 'Open Local cache in Explorer';
}

function scheduleDecorate() {
  clearTimeout(decorateTimer);
  decorateTimer = setTimeout(() => {
    decorateSources();
    decorateCacheCard();
  }, 0);
}

async function refreshCache(force = false) {
  if (!storagePane || storagePane.hidden) return;
  try {
    await loadCacheStats(force);
    decorateCacheCard();
  } catch {}
}

window.addEventListener('click', event => {
  const card = event.target.closest?.('[data-location-id="local-cache"]');
  if (!card) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  (async () => {
    const stats = await loadCacheStats();
    if (!stats?.path) throw new Error('Local cache path is unavailable.');
    await request('/api/open-folder', { method:'POST', body:{ path:stats.path } });
  })().catch(error => toast(error.message));
}, true);

if (storagePane) {
  new MutationObserver(() => {
    scheduleDecorate();
    if (!storagePane.hidden) refreshCache().catch(() => {});
  }).observe(storagePane, { childList:true, subtree:true, attributes:true, attributeFilter:['class','hidden'] });
}

window.addEventListener('focus', () => {
  scheduleDecorate();
  refreshCache().catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  scheduleDecorate();
  refreshCache().catch(() => {});
});

scheduleDecorate();
setTimeout(() => refreshCache().catch(() => {}), 250);
