const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const login = $('#login');
const app = $('#app');
const logout = $('#logout');
const PAGE = 180;
const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 2;
const THUMB_VERSION = 3;

let searchTimer;
let catalog = [];
let filtered = [];
let filteredIndex = new Map();
let loaded = [];
let imports = [];
let sourceNames = new Map();
let searchIndex = new Map();
let renderOffset = 0;
let renderLimit = PAGE;
let hasMore = false;
let hasPrevious = false;
let type = '';
let importId = '';
let inboxOnly = false;
let unprotectedOnly = false;
let view = 'grid';
let sort = 'date-desc';
let selected = null;
let folderImportId = '';
let folderPath = '';
let folderData = null;
let scrollFrame = 0;
let cacheMeta = null;
let cacheDbPromise;
let viewerScrollY = 0;
let viewerDirty = false;
let viewerPreloads = [];
let viewerImageLoad = null;
let scrubbing = false;
let lastScrubAt = 0;

const topScrollSentinel = document.createElement('div');
topScrollSentinel.id = 'top-scroll-sentinel';
topScrollSentinel.style.height = '1px';
topScrollSentinel.hidden = true;
$('#files').before(topScrollSentinel);

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  if (response.status === 401) throw Object.assign(new Error('Unauthorized'), { unauthorized: true });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}

const idbRequest = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const idbDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

function openCache() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!cacheDbPromise) {
    cacheDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_NAME, CACHE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'hash' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'hash' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      console.warn('IndexedDB unavailable', error);
      return null;
    });
  }
  return cacheDbPromise;
}

async function readCache() {
  const db = await openCache();
  if (!db) return null;
  const transaction = db.transaction(['files', 'meta']);
  const done = idbDone(transaction);
  const [files, meta] = await Promise.all([
    idbRequest(transaction.objectStore('files').getAll()),
    idbRequest(transaction.objectStore('meta').get('catalog'))
  ]);
  await done;
  return meta ? { files, meta } : null;
}

async function writeCache(files, meta) {
  const db = await openCache();
  if (!db) return;
  const transaction = db.transaction(['files', 'meta'], 'readwrite');
  const done = idbDone(transaction);
  const store = transaction.objectStore('files');
  store.clear();
  for (const file of files) store.put(file);
  transaction.objectStore('meta').put({ key: 'catalog', ...meta });
  await done;
}

async function cachePut(file) {
  const db = await openCache();
  if (!db || !file) return;
  const transaction = db.transaction('files', 'readwrite');
  const done = idbDone(transaction);
  transaction.objectStore('files').put(file);
  await done;
}

async function cacheDelete(hash) {
  const db = await openCache();
  if (!db) return;
  const transaction = db.transaction(['files', 'thumbs'], 'readwrite');
  const done = idbDone(transaction);
  transaction.objectStore('files').delete(hash);
  transaction.objectStore('thumbs').delete(hash);
  await done;
}

async function cacheImports(nextImports) {
  if (!cacheMeta) return;
  cacheMeta = { ...cacheMeta, imports: nextImports };
  const db = await openCache();
  if (!db) return;
  const transaction = db.transaction('meta', 'readwrite');
  const done = idbDone(transaction);
  transaction.objectStore('meta').put({ key: 'catalog', ...cacheMeta });
  await done;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['m4v', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'm2v', 'mts', 'm2ts', '3gp']);
function kind(file) {
  const value = file.mime?.split('/')[0] || 'other';
  if (value === 'application' && (!file.mime || file.mime === 'application/octet-stream')) {
    const extension = String(file.filename || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  }
  return value;
}

function typeLabel(file) {
  const value = kind(file);
  if (value === 'application' || value === 'text') return 'document';
  return value === 'other' ? 'file' : value;
}

function matchesType(file) {
  if (!type) return true;
  const value = kind(file);
  if (type === 'media') return value === 'image' || value === 'video';
  if (type === 'application') return value === 'application' || value === 'text';
  if (type === 'other') return !['image', 'video', 'audio', 'text', 'application'].includes(value);
  return value === type;
}

const objectUrl = file => `/api/objects/${file.hash}`;
const thumbUrl = file => `/api/thumbs/${file.hash}?v=${THUMB_VERSION}`;

function preview(file) {
  const value = kind(file);
  if (value === 'image') return `<span class="video-thumb-pending" data-video-thumb="${file.hash}"></span>`;
  if (value === 'video') return `<span class="video-thumb-pending" data-video-thumb="${file.hash}"></span><span class="play-badge">▶</span>`;
  const icon = value === 'audio' ? '♪' : typeLabel(file) === 'document' ? '▤' : '·';
  return `<div class="file-icon ${escapeHtml(value)}">${icon}</div>`;
}

function viewerMedia(file) {
  const url = objectUrl(file);
  if (kind(file) === 'image') return `<img src="${thumbUrl(file)}" data-full-src="${url}" alt="${escapeHtml(file.filename)}">`;
  if (kind(file) === 'video') return `<video src="${url}" controls autoplay playsinline></video>`;
  return `<div class="viewer-file-icon">${preview(file)}</div>`;
}

function normalizeFile(file) {
  const importIds = Array.isArray(file.importIds)
    ? file.importIds.map(Number).filter(Boolean)
    : String(file.importIds || '').split(',').map(Number).filter(Boolean);
  const date = new Date(file.fileDate || file.createdAt || 0);
  return {
    ...file,
    size: Number(file.size) || 0,
    width: Number(file.width) || 0,
    height: Number(file.height) || 0,
    importIds,
    reviewed: Boolean(file.reviewed),
    backupCount: Number(file.backupCount) || 0,
    dateMs: Number.isNaN(date.getTime()) ? 0 : date.getTime()
  };
}

function rebuildIndexes() {
  sourceNames = new Map(imports.map(item => [Number(item.id), String(item.sourceName || '')]));
  searchIndex = new Map(catalog.map(file => {
    const names = file.importIds.map(id => sourceNames.get(id) || '').join(' ');
    return [file.hash, `${file.filename || ''} ${file.originalPath || ''} ${file.searchText || ''} ${names}`.toLowerCase()];
  }));
}

function dateValue(file) {
  return new Date(file.dateMs || 0);
}

function shortDate(file) {
  return dateValue(file).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function monthKey(file) {
  const date = dateValue(file);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

function dateGroups(files) {
  const groups = [];
  for (const file of files) {
    const key = monthKey(file);
    const last = groups.at(-1);
    if (last?.key === key) last.files.push(file);
    else groups.push({ key, label: monthLabel(key), files: [file] });
  }
  return groups;
}

function timelineGroups() {
  const result = [];
  let previous;
  filtered.forEach((file, index) => {
    const key = monthKey(file);
    if (key !== previous) result.push({ key, label: monthLabel(key), index, year: dateValue(file).getFullYear() });
    previous = key;
  });
  return result;
}

function mediaRatio(file) {
  if (!file.width || !file.height) return 4 / 3;
  return Math.max(.65, Math.min(2.1, file.width / file.height));
}

function gridCard(file) {
  const media = ['image', 'video'].includes(kind(file));
  const ratio = mediaRatio(file);
  return `
    <button class="file-card ${media ? 'media-card' : ''} ${kind(file) === 'video' ? 'video-card' : ''}" data-hash="${file.hash}" style="${media ? `--ratio:${ratio}` : ''}" title="${escapeHtml(file.filename)}">
      <div class="thumb ${media ? 'media-thumb' : ''}">${preview(file)}${file.reviewed ? '' : '<span class="inbox-badge">Inbox</span>'}</div>
      ${media ? '' : `<div class="card-copy"><strong>${escapeHtml(file.filename)}</strong><span>${formatBytes(file.size)}</span></div>`}
    </button>`;
}

function listRow(file) {
  return `
    <button class="file-row" data-hash="${file.hash}">
      <span class="type ${file.reviewed ? '' : 'inbox-type'}">${file.reviewed ? escapeHtml(typeLabel(file)) : 'inbox'}</span>
      <div class="file-main"><strong>${escapeHtml(file.filename)}</strong><span>${escapeHtml(file.originalPath || '')}</span></div>
      <span class="refs">${escapeHtml(shortDate(file))}</span>
      <span class="size">${formatBytes(file.size)}</span>
    </button>`;
}

function railEntries() {
  if (view === 'folders' || !filtered.length) return [];
  if (sort === 'size-desc') {
    const count = Math.min(18, filtered.length);
    const indexes = [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * (filtered.length - 1) / Math.max(1, count - 1))))];
    return indexes.map((index, i) => ({
      index,
      label: formatBytes(filtered[index].size),
      position: filtered.length === 1 ? 0 : index / (filtered.length - 1),
      major: i % 3 === 0 || i === indexes.length - 1
    }));
  }
  const groups = timelineGroups();
  const compact = groups.length > 18;
  let lastYear;
  return groups.map(group => {
    const major = !compact || group.year !== lastYear;
    lastYear = group.year;
    return {
      index: group.index,
      label: group.label,
      short: compact && major ? String(group.year) : group.label,
      position: filtered.length === 1 ? 0 : group.index / (filtered.length - 1),
      major
    };
  });
}

function railLabel(index) {
  const file = filtered[Math.max(0, Math.min(filtered.length - 1, index))];
  if (!file) return '';
  return sort === 'size-desc' ? formatBytes(file.size) : monthLabel(monthKey(file));
}

function setRailThumb(index) {
  const thumb = $('#railThumb');
  if (!thumb || !filtered.length) return;
  const safe = Math.max(0, Math.min(filtered.length - 1, index));
  const position = filtered.length === 1 ? 0 : safe / (filtered.length - 1);
  thumb.style.top = `${position * 100}%`;
  thumb.querySelector('span').textContent = railLabel(safe);
}

function renderRail() {
  const rail = $('#dateRail');
  const entries = railEntries();
  rail.hidden = !entries.length;
  document.documentElement.classList.toggle('library-scroll', Boolean(entries.length));
  if (!entries.length) return;
  rail.innerHTML = `<div class="rail-track"></div>${entries.map(entry => `
    <button data-index="${entry.index}" class="rail-tick ${entry.major ? 'major' : ''}" style="top:${(entry.position * 100).toFixed(3)}%" title="${escapeHtml(entry.label)}">
      <span>${escapeHtml(entry.short || entry.label)}</span><i></i>
    </button>`).join('')}<div id="railThumb" class="rail-thumb"><span></span><i></i></div>`;
  updateRailActive();
}

function visibleIndex() {
  const visible = [...$('#files').querySelectorAll('[data-hash]')].find(item => item.getBoundingClientRect().bottom > 90);
  return visible ? filteredIndex.get(visible.dataset.hash) ?? renderOffset : renderOffset;
}

function updateRailActive() {
  const rail = $('#dateRail');
  if (rail.hidden || !filtered.length) return;
  const index = visibleIndex();
  setRailThumb(index);
  const buttons = [...rail.querySelectorAll('[data-index]')];
  let active = buttons[0];
  let distance = Infinity;
  for (const button of buttons) {
    const next = Math.abs(Number(button.dataset.index) - index);
    if (next < distance) { distance = next; active = button; }
  }
  buttons.forEach(button => button.classList.toggle('active', button === active));
}

function renderImports() {
  const source = $('#source');
  source.innerHTML = '<option value="">All sources</option>' + imports.map(item => `<option value="${item.id}">${escapeHtml(item.sourceName)}</option>`).join('');
  source.value = importId;
  if (view === 'folders' && !folderImportId) renderFolder();
}

function sortFiles(files) {
  if (sort === 'date-asc') return files.sort((a, b) => a.dateMs - b.dateMs || a.hash.localeCompare(b.hash));
  if (sort === 'size-desc') return files.sort((a, b) => b.size - a.size || a.filename.localeCompare(b.filename));
  return files.sort((a, b) => b.dateMs - a.dateMs || a.hash.localeCompare(b.hash));
}

function updateWindow() {
  loaded = filtered.slice(renderOffset, renderOffset + renderLimit);
  hasPrevious = renderOffset > 0;
  hasMore = renderOffset + renderLimit < filtered.length;
}

function syncSentinels() {
  topScrollSentinel.hidden = !hasPrevious || view === 'folders';
  $('#scroll-sentinel').hidden = !hasMore || view === 'folders';
}

function renderActiveFilters() {
  $('#filterInbox').checked = inboxOnly;
  $('#filterUnprotected').checked = unprotectedOnly;
  const active = [];
  if (inboxOnly) active.push('<button data-clear-filter="inbox">Inbox ×</button>');
  if (unprotectedOnly) active.push('<button data-clear-filter="unprotected">Unprotected ×</button>');
  $('#activeFilters').innerHTML = active.join('');
}

function applyFilters(reset = true) {
  if (view === 'folders') return loadFolder();
  const query = $('#search').value.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const sourceId = Number(importId) || 0;
  const folderHashes = folderImportId && folderData ? new Set(folderData.files.map(file => file.hash)) : null;
  filtered = sortFiles(catalog.filter(file => {
    if (!matchesType(file)) return false;
    if (inboxOnly && file.reviewed) return false;
    if (unprotectedOnly && file.backupCount > 0) return false;
    if (sourceId && !file.importIds.includes(sourceId)) return false;
    if (folderHashes && !folderHashes.has(file.hash)) return false;
    if (terms.length && !terms.every(term => (searchIndex.get(file.hash) || '').includes(term))) return false;
    return true;
  }));
  filteredIndex = new Map(filtered.map((file, index) => [file.hash, index]));
  if (reset) { renderOffset = 0; renderLimit = PAGE; }
  updateWindow();
  renderActiveFilters();
  renderFiles();
  if (selected) {
    const current = catalog.find(file => file.hash === selected.hash);
    if (current) selected = normalizeFile(current);
    updateViewerNav();
  }
}

function cardsHtml(files) {
  return files.map(file => view === 'grid' ? gridCard(file) : listRow(file)).join('');
}

function groupHtml(group) {
  return `<section class="date-group" data-date-group="${group.key}"><h3 class="date-heading">${escapeHtml(group.label)}</h3><div class="${view === 'grid' ? 'date-grid' : 'date-list'}">${cardsHtml(group.files)}</div></section>`;
}

function renderFiles() {
  if (view === 'folders') return renderFolder();
  const element = $('#files');
  element.className = `files ${view}`;
  if (folderImportId) folderBreadcrumb();
  else $('#folderbar').hidden = true;
  syncSentinels();
  if (!loaded.length) {
    const message = inboxOnly ? 'Inbox empty.' : unprotectedOnly ? 'All protected.' : 'No files.';
    element.innerHTML = `<div class="empty">${message}</div>`;
    renderRail();
    return;
  }
  if (sort.startsWith('date-')) {
    element.innerHTML = dateGroups(loaded).map(groupHtml).join('');
  } else {
    element.innerHTML = view === 'grid'
      ? `<div class="date-grid flat-grid">${cardsHtml(loaded)}</div>`
      : cardsHtml(loaded);
  }
  renderRail();
}

function appendMore() {
  if (!hasMore || view === 'folders') return;
  const start = renderOffset + renderLimit;
  const end = Math.min(filtered.length, start + PAGE);
  const next = filtered.slice(start, end);
  renderLimit += next.length;
  loaded = filtered.slice(renderOffset, renderOffset + renderLimit);
  hasPrevious = renderOffset > 0;
  hasMore = renderOffset + renderLimit < filtered.length;
  syncSentinels();
  if (!next.length) return;

  if (sort.startsWith('date-')) {
    for (const group of dateGroups(next)) {
      const last = $('#files .date-group:last-of-type');
      if (last?.dataset.dateGroup === group.key) {
        last.querySelector(view === 'grid' ? '.date-grid' : '.date-list').insertAdjacentHTML('beforeend', cardsHtml(group.files));
      } else {
        $('#files').insertAdjacentHTML('beforeend', groupHtml(group));
      }
    }
  } else if (view === 'grid') {
    $('#files .flat-grid').insertAdjacentHTML('beforeend', cardsHtml(next));
  } else {
    $('#files').insertAdjacentHTML('beforeend', cardsHtml(next));
  }
  updateRailActive();
}

function prependMore() {
  if (!hasPrevious || view === 'folders') return;
  const element = $('#files');
  const anchor = element.querySelector('[data-hash]');
  const anchorHash = anchor?.dataset.hash;
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
  const oldOffset = renderOffset;
  const start = Math.max(0, oldOffset - PAGE);
  const previous = filtered.slice(start, oldOffset);
  if (!previous.length) return;

  renderOffset = start;
  renderLimit += previous.length;
  loaded = filtered.slice(renderOffset, renderOffset + renderLimit);
  hasPrevious = renderOffset > 0;
  hasMore = renderOffset + renderLimit < filtered.length;
  syncSentinels();

  if (sort.startsWith('date-')) {
    const groups = dateGroups(previous);
    const first = element.querySelector('.date-group:first-of-type');
    const tail = groups.at(-1);
    if (first && tail?.key === first.dataset.dateGroup) {
      groups.pop();
      first.querySelector(view === 'grid' ? '.date-grid' : '.date-list').insertAdjacentHTML('afterbegin', cardsHtml(tail.files));
    }
    if (groups.length) element.insertAdjacentHTML('afterbegin', groups.map(groupHtml).join(''));
  } else if (view === 'grid') {
    element.querySelector('.flat-grid')?.insertAdjacentHTML('afterbegin', cardsHtml(previous));
  } else {
    element.insertAdjacentHTML('afterbegin', cardsHtml(previous));
  }

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (anchorHash) {
      const restored = element.querySelector(`[data-hash="${CSS.escape(anchorHash)}"]`);
      if (restored) window.scrollBy(0, restored.getBoundingClientRect().top - anchorTop);
    }
    updateRailActive();
  }));
}

function jumpToIndex(index, smooth = true) {
  if (!Number.isInteger(index) || !filtered[index]) return;
  if (index < renderOffset || index >= renderOffset + renderLimit) {
    renderOffset = Math.max(0, index - Math.floor(PAGE / 2));
    renderLimit = PAGE * 2;
    updateWindow();
    renderFiles();
  }
  const hash = filtered[index].hash;
  requestAnimationFrame(() => document.querySelector(`#files [data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' }));
}

function scrubFromPointer(event, final = false) {
  if (!filtered.length) return;
  const rail = $('#dateRail');
  const rect = rail.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  const index = Math.round(ratio * (filtered.length - 1));
  setRailThumb(index);
  const now = performance.now();
  if (final || now - lastScrubAt > 80) {
    lastScrubAt = now;
    jumpToIndex(index, false);
  }
}

async function loadStats() {
  const s = await request('/api/stats');
  const percent = s.capacityBytes ? Math.min(100, s.bytes / s.capacityBytes * 100) : 0;
  const width = s.bytes ? `max(2px, ${percent}%)` : '0';
  $('#stats').innerHTML = `<span>${formatBytes(s.bytes)} <small>of ${formatBytes(s.capacityBytes)}</small></span><i><b style="width:${width}"></b></i>`;
  $('#filterInboxLabel').textContent = s.unreviewed ? `Inbox · ${s.unreviewed.toLocaleString()}` : 'Inbox';
  $('#filterUnprotectedLabel').textContent = s.unbacked ? `Unprotected · ${s.unbacked.toLocaleString()}` : 'Unprotected';
}

async function fetchCatalog() {
  let latest;
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = await request('/api/catalog/version');
    const importsPromise = request('/api/imports');
    const files = [];
    let after = '';
    do {
      const page = await request(`/api/catalog?limit=5000&after=${encodeURIComponent(after)}`);
      files.push(...page.files.map(normalizeFile));
      after = page.nextAfter || '';
    } while (after);
    const [importsData, end] = await Promise.all([importsPromise, request('/api/catalog/version')]);
    latest = { version: end.version, imports: importsData.imports, files };
    if (start.version === end.version) break;
  }
  return latest;
}

async function syncCatalog(force = false) {
  const remote = await request('/api/catalog/version');
  if (!force && cacheMeta?.version === remote.version) return;
  const localMedia = new Map(catalog.filter(file => file.width && file.height).map(file => [file.hash, [file.width, file.height]]));
  const fresh = await fetchCatalog();
  catalog = fresh.files.map(file => {
    const dimensions = localMedia.get(file.hash);
    return dimensions ? { ...file, width: dimensions[0], height: dimensions[1] } : file;
  });
  imports = fresh.imports;
  cacheMeta = { version: fresh.version, imports };
  rebuildIndexes();
  renderImports();
  applyFilters(true);
  writeCache(catalog, cacheMeta).catch(console.warn);
}

function currentFolderSource() {
  return imports.find(item => String(item.id) === String(folderImportId));
}

function folderBreadcrumb() {
  const bar = $('#folderbar');
  bar.hidden = false;
  const source = currentFolderSource();
  const parts = folderPath ? folderPath.split('/') : [];
  const crumbs = [`<button data-folder-home>Sources</button>`];
  if (source) {
    crumbs.push(`<span>›</span><button data-folder-depth="0">${escapeHtml(source.sourceName)}</button>`);
    parts.forEach((part, index) => crumbs.push(`<span>›</span><button data-folder-depth="${index + 1}">${escapeHtml(part)}</button>`));
  }
  bar.innerHTML = `<div class="breadcrumbs">${crumbs.join('')}</div>`;
}

function renderFolder() {
  const element = $('#files');
  element.className = 'files folders';
  topScrollSentinel.hidden = true;
  $('#scroll-sentinel').hidden = true;
  $('#dateRail').hidden = true;
  document.documentElement.classList.remove('library-scroll');
  folderBreadcrumb();
  if (!folderImportId) {
    element.innerHTML = imports.length ? `
      <div class="folder-list-head"><span>Name</span><span>Files</span><span>Imported</span></div>
      ${imports.map(item => `<button class="folder-row source-row" data-folder-source="${item.id}"><span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(item.sourceName)}</strong></span><span>${item.files.toLocaleString()} · ${formatBytes(item.referencedBytes)}</span><span>${escapeHtml(new Date(item.createdAt).toLocaleDateString())}</span></button>`).join('')}` : '<div class="empty">No sources.</div>';
    return;
  }
  if (!folderData) { element.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const rows = [];
  for (const folder of folderData.folders) rows.push(`<button class="folder-row" data-folder-name="${escapeHtml(folder.name)}"><span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(folder.name)}</strong></span><span>${folder.files.toLocaleString()}</span><span>Folder</span></button>`);
  for (const file of folderData.files) rows.push(`<button class="folder-row file-folder-row" data-hash="${file.hash}"><span class="folder-name"><i class="document-icon"></i><strong>${escapeHtml(file.filename)}</strong>${file.reviewed ? '' : '<em>Inbox</em>'}</span><span>${formatBytes(file.size)}</span><span>${escapeHtml(typeLabel(file))}</span></button>`);
  element.innerHTML = rows.length ? `<div class="folder-list-head"><span>Name</span><span>Size</span><span>Type</span></div>${rows.join('')}` : '<div class="empty">Empty.</div>';
}

async function loadFolder() {
  folderData = null;
  if (view === 'folders') renderFolder();
  if (!folderImportId) {
    if (view !== 'folders') {
      $('#folderbar').hidden = true;
      applyFilters(true);
    }
    return;
  }
  folderData = await request(`/api/folders?import=${encodeURIComponent(folderImportId)}&path=${encodeURIComponent(folderPath)}`);
  if (view === 'folders') renderFolder();
  else applyFilters(true);
}

function setView(next) {
  view = next;
  const folderMode = view === 'folders';
  $('#sort').hidden = folderMode;
  $('#typeFilter').hidden = folderMode;
  $('#filterMenu').hidden = folderMode;
  $('#activeFilters').hidden = folderMode;
  $('#mediaSizeControl').hidden = view !== 'grid';
  $$('#views button').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  if (folderMode) {
    if (!folderImportId) {
      folderImportId = importId;
      folderPath = '';
    }
    loadFolder().catch(console.error);
  } else {
    applyFilters(true);
  }
}

function viewerItems() {
  return view === 'folders' ? (folderData?.files || []).map(normalizeFile) : filtered;
}

function updateViewerNav() {
  const items = viewerItems();
  const index = items.findIndex(file => file.hash === selected?.hash);
  $('#viewer-prev').disabled = index <= 0;
  $('#viewer-next').disabled = index < 0 || index >= items.length - 1;
}

function loadFullViewerImage(file) {
  const shown = $('#viewer-media img[data-full-src]');
  if (!shown) return;
  const hash = file.hash;
  const fullUrl = shown.dataset.fullSrc;
  const image = new Image();
  viewerImageLoad = image;
  const swap = () => {
    if (selected?.hash !== hash || viewerImageLoad !== image || !shown.isConnected) return;
    shown.src = fullUrl;
    shown.removeAttribute('data-full-src');
    viewerImageLoad = null;
  };
  image.onload = swap;
  image.onerror = () => {
    if (viewerImageLoad === image) viewerImageLoad = null;
  };
  shown.onerror = () => {
    if (selected?.hash === hash && shown.dataset.fullSrc) shown.src = fullUrl;
  };
  image.src = fullUrl;
}

function renderViewerState() {
  if (!selected) return;
  viewerImageLoad = null;
  $('#viewer-name').textContent = selected.filename;
  $('#viewer-meta').textContent = `${shortDate(normalizeFile(selected))} · ${formatBytes(selected.size)}`;
  $('#viewer-open').href = objectUrl(selected);
  $('#viewer-review').textContent = selected.reviewed ? 'Inbox' : 'Keep';
  $('#viewer-media').innerHTML = viewerMedia(selected);
  if (kind(selected) === 'image') loadFullViewerImage(selected);
  updateViewerNav();
  preloadAround();
}

function preloadAround() {
  const items = viewerItems();
  const index = items.findIndex(file => file.hash === selected?.hash);
  viewerPreloads = [-1, 1].map(step => items[index + step]).filter(Boolean).map(file => {
    if (kind(file) === 'image') { const image = new Image(); image.src = objectUrl(file); return image; }
    if (kind(file) === 'video') { const video = document.createElement('video'); video.preload = 'metadata'; video.muted = true; video.src = `${objectUrl(file)}#t=0.1`; return video; }
    return null;
  }).filter(Boolean);
}

function openViewer(hash, fallback = null) {
  selected = catalog.find(file => file.hash === hash) || folderData?.files?.find(file => file.hash === hash) || fallback;
  if (!selected) return false;
  selected = normalizeFile(selected);
  const viewer = $('#viewer');
  if (viewer.hidden) viewerScrollY = window.scrollY;
  viewer.hidden = false;
  renderViewerState();
  return true;
}

window.mochimonoOpenViewer = openViewer;

function closeViewer() {
  if ($('#viewer').hidden) return;
  $('#viewer').hidden = true;
  $('#viewer-menu').open = false;
  $('#viewer-media').innerHTML = '';
  viewerPreloads = [];
  viewerImageLoad = null;
  selected = null;
  if (viewerDirty) {
    viewerDirty = false;
    if (view === 'folders') loadFolder().catch(console.error);
    else applyFilters(false);
  }
  requestAnimationFrame(() => window.scrollTo(0, viewerScrollY));
}

function navigateViewer(step) {
  const items = viewerItems();
  const index = items.findIndex(file => file.hash === selected?.hash);
  const next = items[index + step];
  if (next) { selected = normalizeFile(next); renderViewerState(); }
}

async function toggleReviewed() {
  if (!selected) return;
  const reviewed = !Boolean(selected.reviewed);
  await request(`/api/objects/${selected.hash}/review`, { method: 'POST', body: { reviewed } });
  selected.reviewed = reviewed;
  const cached = catalog.find(file => file.hash === selected.hash);
  if (cached) cached.reviewed = reviewed;
  cachePut(cached || selected).catch(console.warn);
  viewerDirty = true;
  $('#viewer-review').textContent = reviewed ? 'Inbox' : 'Keep';
  await loadStats();
}

async function refreshImports() {
  imports = (await request('/api/imports')).imports;
  rebuildIndexes();
  renderImports();
  cacheImports(imports).catch(console.warn);
}

async function removeSelected(ignore) {
  if (!selected) return;
  const text = ignore ? 'Delete + ignore on future imports?' : 'Delete this file?';
  if (!confirm(text)) return;
  const hash = selected.hash;
  await request(`/api/objects/${hash}/delete`, { method: 'POST', body: { ignore } });
  catalog = catalog.filter(file => file.hash !== hash);
  searchIndex.delete(hash);
  cacheDelete(hash).catch(console.warn);
  viewerDirty = false;
  closeViewer();
  await Promise.all([loadStats(), refreshImports()]);
  if (view === 'folders') await loadFolder();
  else applyFilters(true);
}

async function loadDrives() {
  const data = await request('/api/drives');
  $('#drives').innerHTML = data.drives.map(drive => {
    const ratio = drive.desiredBytes ? Math.min(100, drive.protectedBytes / drive.desiredBytes * 100) : 100;
    const missing = Math.max(0, drive.desiredBytes - drive.protectedBytes);
    return `<article class="drive"><div class="drive-head"><strong>${escapeHtml(drive.name)}</strong><span>${ratio.toFixed(0)}%</span></div><div class="meter"><i style="width:${ratio}%"></i></div><p>${formatBytes(drive.protectedBytes)} / ${formatBytes(drive.desiredBytes)}${missing ? ` · ${formatBytes(missing)} missing` : ''}</p></article>`;
  }).join('') || '<div class="empty">No backups.</div>';
}

async function boot() {
  try {
    await request('/api/health');
    login.hidden = true;
    app.hidden = false;
    logout.hidden = false;
    $('#files').innerHTML = '<div class="empty">Loading…</div>';
    const mediaSize = Math.max(96, Math.min(420, Number(localStorage.getItem('mochimono-media-size')) || 170));
    $('#mediaSize').value = mediaSize;
    document.documentElement.style.setProperty('--media-size', `${mediaSize}px`);

    const cached = await readCache().catch(() => null);
    if (cached) {
      cacheMeta = cached.meta;
      catalog = cached.files.map(normalizeFile);
      imports = cached.meta.imports || [];
      rebuildIndexes();
      renderImports();
      applyFilters(true);
    }
    await Promise.all([loadStats(), loadDrives()]);
    if (cached) syncCatalog(false).catch(console.error);
    else await syncCatalog(true);
  } catch (error) {
    if (error.unauthorized) {
      login.hidden = false;
      app.hidden = true;
      logout.hidden = true;
    } else throw error;
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await request('/api/login', { method: 'POST', body: { token: $('#token').value } });
    $('#token').value = '';
    await boot();
  } catch (error) { $('#login-error').textContent = error.message; }
});

logout.addEventListener('click', async () => {
  await request('/api/logout', { method: 'POST' }).catch(() => {});
  await boot();
});

$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyFilters(true), 70);
});

$('#source').addEventListener('change', event => {
  importId = event.target.value;
  folderImportId = '';
  folderPath = '';
  folderData = null;
  if (view === 'folders') {
    folderImportId = importId;
    loadFolder().catch(console.error);
  } else {
    $('#folderbar').hidden = true;
    applyFilters(true);
  }
});

$('#typeFilter').addEventListener('change', event => { type = event.target.value; applyFilters(true); });
$('#sort').addEventListener('change', event => { sort = event.target.value; applyFilters(true); });
$('#filterInbox').addEventListener('change', event => { inboxOnly = event.target.checked; applyFilters(true); });
$('#filterUnprotected').addEventListener('change', event => { unprotectedOnly = event.target.checked; applyFilters(true); });
$('#activeFilters').addEventListener('click', event => {
  const button = event.target.closest('[data-clear-filter]');
  if (!button) return;
  if (button.dataset.clearFilter === 'inbox') inboxOnly = false;
  if (button.dataset.clearFilter === 'unprotected') unprotectedOnly = false;
  applyFilters(true);
});
$('#mediaSize').addEventListener('input', event => {
  const size = Number(event.target.value);
  document.documentElement.style.setProperty('--media-size', `${size}px`);
  localStorage.setItem('mochimono-media-size', String(size));
});

$('#views').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});

document.addEventListener('click', event => {
  if ($('#filterMenu').open && !event.target.closest('#filterMenu')) $('#filterMenu').open = false;
});

const rail = $('#dateRail');
rail.addEventListener('pointerdown', event => {
  if (rail.hidden) return;
  scrubbing = true;
  rail.setPointerCapture?.(event.pointerId);
  rail.classList.add('dragging');
  scrubFromPointer(event, false);
  event.preventDefault();
});
rail.addEventListener('pointermove', event => {
  if (!scrubbing) return;
  scrubFromPointer(event, false);
  event.preventDefault();
});
rail.addEventListener('pointerup', event => {
  if (!scrubbing) return;
  scrubbing = false;
  rail.classList.remove('dragging');
  scrubFromPointer(event, true);
  rail.releasePointerCapture?.(event.pointerId);
});
rail.addEventListener('pointercancel', () => { scrubbing = false; rail.classList.remove('dragging'); });

$('#folderbar').addEventListener('click', event => {
  if (event.target.closest('[data-folder-home]')) {
    folderImportId = '';
    folderPath = '';
    folderData = null;
    importId = '';
    $('#source').value = '';
    if (view === 'folders') loadFolder().catch(console.error);
    else applyFilters(true);
    return;
  }
  const crumb = event.target.closest('[data-folder-depth]');
  if (!crumb) return;
  const depth = Number(crumb.dataset.folderDepth);
  folderPath = depth ? folderPath.split('/').slice(0, depth).join('/') : '';
  loadFolder().catch(console.error);
});

$('#files').addEventListener('click', event => {
  const sourceRow = event.target.closest('[data-folder-source]');
  if (sourceRow) {
    folderImportId = sourceRow.dataset.folderSource;
    importId = folderImportId;
    $('#source').value = importId;
    folderPath = '';
    loadFolder().catch(console.error);
    return;
  }
  const folderRow = event.target.closest('[data-folder-name]');
  if (folderRow) {
    folderPath = folderPath ? `${folderPath}/${folderRow.dataset.folderName}` : folderRow.dataset.folderName;
    loadFolder().catch(console.error);
    return;
  }
  const item = event.target.closest('[data-hash]');
  if (item) openViewer(item.dataset.hash);
});

new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) prependMore();
}, { rootMargin: '700px 0px' }).observe(topScrollSentinel);

new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) appendMore();
}, { rootMargin: '700px 0px' }).observe($('#scroll-sentinel'));

window.addEventListener('scroll', () => {
  if (scrollFrame || scrubbing) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateRailActive(); });
}, { passive: true });

document.addEventListener('keydown', event => {
  if ($('#viewer').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeViewer(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigateViewer(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); navigateViewer(1); }
});

$('#viewer-close').onclick = closeViewer;
$('#viewer-prev').onclick = () => navigateViewer(-1);
$('#viewer-next').onclick = () => navigateViewer(1);
$('#viewer-review').onclick = () => toggleReviewed().catch(console.error);
$('#delete').onclick = () => removeSelected(false).catch(console.error);
$('#delete-ignore').onclick = () => removeSelected(true).catch(console.error);
$('#viewer').addEventListener('wheel', event => event.preventDefault(), { passive: false });

boot().catch(error => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${escapeHtml(error.stack || error.message)}</pre>`);
});
