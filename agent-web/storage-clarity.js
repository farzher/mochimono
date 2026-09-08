const folders = document.querySelector('#folders');
const storagePane = document.querySelector('#storagePane');
const toastNode = document.querySelector('#toast');
const CACHE_STATS_PATH = '@mochimono:cache';

let cacheStats = null;
let cacheLoadedAt = 0;
let cacheLoading = null;
let decorateTimer = 0;

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

function nativeScopeLabel(row) {
  const badge = row.querySelector('.storage-modes');
  return /everything/i.test(badge?.textContent || '') ? 'Everything' : 'Media';
}

function decorateNativeSource(row) {
  const badge = row.querySelector('.storage-modes');
  if (!badge) return;
  const cloud = row.classList.contains('cloud-folder');
  const scope = nativeScopeLabel(row);
  const destination = cloud ? 'Local + Cloud' : 'Local only';
  setText(badge, `${destination} · ${scope}`);
  badge.title = cloud
    ? `${scope === 'Everything' ? 'All files' : 'Photos and videos'} · original stays local · Cloud copy enabled`
    : `${scope === 'Everything' ? 'All files' : 'Photos and videos'} · local only`;
}

function decorateBrowserSource(row) {
  const badge = row.querySelector('.storage-modes');
  if (!badge) return;
  const scope = String(row.querySelector('[data-browser-scope]')?.textContent || '').trim() === 'Everything' ? 'Everything' : 'Media';
  const cloud = String(row.querySelector('[data-browser-cloud]')?.textContent || '').trim() === 'Local';
  const destination = cloud ? 'Local + Cloud' : 'Local only';
  setText(badge, `Browser · ${destination} · ${scope}`);
  badge.title = cloud
    ? 'Browser-style folder · local original + Cloud copy'
    : 'Browser-style folder · local only';
  const preview = row.querySelector('.storage-folder-samples');
  if (preview) preview.title = 'Open browser folder in Mochimono';
}

function decorateSources() {
  for (const row of folders?.querySelectorAll(':scope > [data-folder-path]:not([data-browser-folder])') || []) decorateNativeSource(row);
  for (const row of folders?.querySelectorAll(':scope > [data-browser-folder]') || []) decorateBrowserSource(row);
}

async function loadCacheStats(force = false) {
  if (!force && cacheStats && Date.now() - cacheLoadedAt < 60_000) return cacheStats;
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
  new MutationObserver(scheduleDecorate).observe(storagePane, { childList:true, subtree:true, attributes:true, attributeFilter:['class','hidden'] });
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

setInterval(() => refreshCache(true).catch(() => {}), 60_000);
scheduleDecorate();
setTimeout(() => refreshCache().catch(() => {}), 250);
