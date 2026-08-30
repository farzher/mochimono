const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const login = $('#login');
const app = $('#app');
const logout = $('#logout');
const PAGE = 180;
const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 1;

let searchTimer;
let catalog = [];
let filtered = [];
let loaded = [];
let imports = [];
let sourceNames = new Map();
let searchIndex = new Map();
let renderOffset = 0;
let renderLimit = PAGE;
let hasMore = false;
let type = '';
let importId = '';
let inboxOnly = false;
let noBackupOnly = false;
let view = 'grid';
let sort = 'date-desc';
let selected = null;
let folderImportId = '';
let folderPath = '';
let folderData = null;
let dateScrollFrame = 0;
let cacheMeta = null;
let cacheDbPromise;

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
  if (!db) return;
  const transaction = db.transaction('files', 'readwrite');
  const done = idbDone(transaction);
  transaction.objectStore('files').put(file);
  await done;
}

async function cacheDelete(hash) {
  const db = await openCache();
  if (!db) return;
  const transaction = db.transaction('files', 'readwrite');
  const done = idbDone(transaction);
  transaction.objectStore('files').delete(hash);
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

function kind(file) {
  return file.mime?.split('/')[0] || 'other';
}

function typeLabel(file) {
  const value = kind(file);
  if (value === 'application' || value === 'text') return 'document';
  return value === 'other' ? 'file' : value;
}

function matchesType(file) {
  if (!type) return true;
  const value = kind(file);
  if (type === 'application') return value === 'application' || value === 'text';
  if (type === 'other') return !['image', 'video', 'audio', 'text', 'application'].includes(value);
  return value === type;
}

function preview(file, large = false) {
  const url = `/api/objects/${file.hash}`;
  if (kind(file) === 'image') return `<img ${large ? '' : 'loading="lazy"'} src="${url}" alt="${escapeHtml(file.filename)}">`;
  const icon = kind(file) === 'video' ? '▶' : kind(file) === 'audio' ? '♪' : typeLabel(file) === 'document' ? '▤' : '·';
  return `<div class="file-icon ${escapeHtml(kind(file))}">${icon}</div>`;
}

function normalizeFile(file) {
  const importIds = Array.isArray(file.importIds)
    ? file.importIds.map(Number).filter(Boolean)
    : String(file.importIds || '').split(',').map(Number).filter(Boolean);
  const date = new Date(file.fileDate || file.createdAt || 0);
  return {
    ...file,
    size: Number(file.size) || 0,
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
    if (key !== previous) result.push({ key, label: monthLabel(key), index });
    previous = key;
  });
  return result;
}

function gridCard(file) {
  const image = kind(file) === 'image';
  return `
    <button class="file-card ${image ? 'photo-card' : ''}" data-hash="${file.hash}" title="${escapeHtml(file.filename)}">
      <div class="thumb ${image ? 'photo-thumb' : ''}">${preview(file)}${file.reviewed ? '' : '<span class="inbox-badge">Inbox</span>'}</div>
      ${image ? '' : `<div class="card-copy"><strong>${escapeHtml(file.filename)}</strong><span>${formatBytes(file.size)}</span></div>`}
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

function renderDateRail() {
  const rail = $('#dateRail');
  const groups = sort.startsWith('date-') && view !== 'folders' ? timelineGroups() : [];
  rail.hidden = !groups.length;
  if (rail.hidden) return;
  rail.innerHTML = groups.map(group => `<button data-date-jump="${group.key}" data-index="${group.index}">${escapeHtml(group.label.replace(' ', ' '))}</button>`).join('');
  updateDateRailActive();
}

function updateDateRailActive() {
  const rail = $('#dateRail');
  if (rail.hidden) return;
  const groups = $$('.date-group');
  if (!groups.length) return;
  let active = groups[0];
  const line = window.innerHeight * .28;
  for (const group of groups) {
    if (group.getBoundingClientRect().top <= line) active = group;
    else break;
  }
  $$('[data-date-jump]').forEach(button => button.classList.toggle('active', button.dataset.dateJump === active.dataset.dateGroup));
}

function renderImports() {
  const source = $('#source');
  source.innerHTML = '<option value="">All sources</option>' + imports.map(item => `<option value="${item.id}">${escapeHtml(item.sourceName)}</option>`).join('');
  source.value = importId;
  if (view === 'folders' && !folderImportId) renderFolder();
}

function sortFiles(files) {
  if (sort === 'date-asc') return files.sort((a, b) => a.dateMs - b.dateMs || a.hash.localeCompare(b.hash));
  if (sort === 'name') return files.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }) || a.hash.localeCompare(b.hash));
  if (sort === 'size-desc') return files.sort((a, b) => b.size - a.size || a.filename.localeCompare(b.filename));
  return files.sort((a, b) => b.dateMs - a.dateMs || a.hash.localeCompare(b.hash));
}

function updateWindow() {
  loaded = filtered.slice(renderOffset, renderOffset + renderLimit);
  hasMore = renderOffset + renderLimit < filtered.length;
}

function applyFilters(reset = true) {
  if (view === 'folders') return loadFolder();
  const query = $('#search').value.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const sourceId = Number(importId) || 0;

  filtered = sortFiles(catalog.filter(file => {
    if (!matchesType(file)) return false;
    if (inboxOnly && file.reviewed) return false;
    if (noBackupOnly && file.backupCount > 0) return false;
    if (sourceId && !file.importIds.includes(sourceId)) return false;
    if (terms.length) {
      const haystack = searchIndex.get(file.hash) || '';
      if (!terms.every(term => haystack.includes(term))) return false;
    }
    return true;
  }));

  if (reset) {
    renderOffset = 0;
    renderLimit = PAGE;
  }
  updateWindow();
  renderFiles();
}

function showMore() {
  if (!hasMore || view === 'folders') return;
  renderLimit += PAGE;
  updateWindow();
  renderFiles();
}

function renderFiles() {
  if (view === 'folders') return renderFolder();
  const element = $('#files');
  element.className = `files ${view}`;
  $('#folderbar').hidden = true;
  $('#scroll-sentinel').hidden = !hasMore;

  if (!loaded.length) {
    const message = inboxOnly ? 'Inbox empty.' : noBackupOnly ? 'All backed up.' : 'No files.';
    element.innerHTML = `<div class="empty">${message}</div>`;
    renderDateRail();
    return;
  }

  if (sort.startsWith('date-')) {
    element.innerHTML = dateGroups(loaded).map(group => `
      <section class="date-group" data-date-group="${group.key}">
        <h3 class="date-heading">${escapeHtml(group.label)}</h3>
        <div class="${view === 'grid' ? 'date-grid' : 'date-list'}">${group.files.map(file => view === 'grid' ? gridCard(file) : listRow(file)).join('')}</div>
      </section>`).join('');
  } else {
    element.innerHTML = view === 'grid'
      ? `<div class="date-grid flat-grid">${loaded.map(gridCard).join('')}</div>`
      : loaded.map(listRow).join('');
  }
  renderDateRail();
}

function jumpToMonth(key, index) {
  if (index < renderOffset || index >= renderOffset + renderLimit) {
    renderOffset = Math.max(0, index - 12);
    renderLimit = PAGE;
    updateWindow();
    renderFiles();
  }
  requestAnimationFrame(() => document.querySelector(`[data-date-group="${CSS.escape(key)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function loadStats() {
  const s = await request('/api/stats');
  const percent = s.capacityBytes ? Math.min(100, s.bytes / s.capacityBytes * 100) : 0;
  const width = s.bytes ? `max(2px, ${percent}%)` : '0';
  $('#stats').innerHTML = `<span>${formatBytes(s.bytes)} <small>of ${formatBytes(s.capacityBytes)}</small></span><i><b style="width:${width}"></b></i>`;
  $('#inbox').textContent = s.unreviewed ? `Inbox ${s.unreviewed.toLocaleString()}` : 'Inbox';
  $('#unbacked').textContent = s.unbacked ? `Unbacked ${s.unbacked.toLocaleString()}` : 'Unbacked';
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
  const fresh = await fetchCatalog();
  catalog = fresh.files;
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
  $('#scroll-sentinel').hidden = true;
  $('#dateRail').hidden = true;
  folderBreadcrumb();

  if (!folderImportId) {
    element.innerHTML = imports.length ? `
      <div class="folder-list-head"><span>Name</span><span>Files</span><span>Imported</span></div>
      ${imports.map(item => `
        <button class="folder-row source-row" data-folder-source="${item.id}">
          <span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(item.sourceName)}</strong></span>
          <span>${item.files.toLocaleString()} · ${formatBytes(item.referencedBytes)}</span>
          <span>${escapeHtml(new Date(item.createdAt).toLocaleDateString())}</span>
        </button>`).join('')}` : '<div class="empty">No sources.</div>';
    return;
  }

  if (!folderData) {
    element.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }

  const rows = [];
  for (const folder of folderData.folders) {
    rows.push(`<button class="folder-row" data-folder-name="${escapeHtml(folder.name)}"><span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(folder.name)}</strong></span><span>${folder.files.toLocaleString()}</span><span>Folder</span></button>`);
  }
  for (const file of folderData.files) {
    rows.push(`<button class="folder-row file-folder-row" data-hash="${file.hash}"><span class="folder-name"><i class="document-icon"></i><strong>${escapeHtml(file.filename)}</strong>${file.reviewed ? '' : '<em>Inbox</em>'}</span><span>${formatBytes(file.size)}</span><span>${escapeHtml(typeLabel(file))}</span></button>`);
  }
  element.innerHTML = rows.length
    ? `<div class="folder-list-head"><span>Name</span><span>Size</span><span>Type</span></div>${rows.join('')}`
    : '<div class="empty">Empty.</div>';
}

async function loadFolder() {
  folderData = null;
  renderFolder();
  if (!folderImportId) return;
  folderData = await request(`/api/folders?import=${encodeURIComponent(folderImportId)}&path=${encodeURIComponent(folderPath)}`);
  renderFolder();
}

function setView(next) {
  view = next;
  $('#sort').hidden = view === 'folders';
  $('#typeFilter').hidden = view === 'folders';
  $$('#views button').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  if (view === 'folders') {
    folderImportId = importId;
    folderPath = '';
    loadFolder().catch(console.error);
  } else {
    folderImportId = '';
    folderPath = '';
    $('#folderbar').hidden = true;
    applyFilters(true);
  }
}

function renderReviewState() {
  const reviewed = Boolean(selected?.reviewed);
  $('#review-status').textContent = reviewed ? 'Kept' : 'Inbox';
  $('#review-toggle').textContent = reviewed ? 'Inbox' : 'Keep';
  $('#review-toggle').className = reviewed ? 'text-button' : '';
}

function detailItems() {
  return view === 'folders' ? folderData?.files || [] : filtered;
}

function updateDetailNav() {
  const items = detailItems();
  const index = items.findIndex(file => file.hash === selected?.hash);
  $('#detail-prev').disabled = index <= 0;
  $('#detail-next').disabled = index < 0 || index >= items.length - 1;
}

async function navigateDetails(step) {
  const items = detailItems();
  const index = items.findIndex(file => file.hash === selected?.hash);
  const next = items[index + step];
  if (next) await openDetails(next.hash, next);
}

async function openDetails(hash, fallback = null) {
  selected = catalog.find(file => file.hash === hash) || folderData?.files?.find(file => file.hash === hash) || fallback;
  if (!selected) return;

  $('#detail-name').textContent = selected.filename;
  $('#detail-meta').textContent = `${shortDate(normalizeFile(selected))} · ${formatBytes(selected.size)}`;
  $('#detail-open').href = `/api/objects/${selected.hash}`;
  $('#detail-preview').innerHTML = preview(selected, true);
  $('#detail-sources').innerHTML = '<div class="empty small-empty">Loading…</div>';
  $('#detail-backups').innerHTML = '<div class="empty small-empty">Loading…</div>';
  renderReviewState();
  updateDetailNav();
  if (!$('#details').open) $('#details').showModal();

  try {
    const data = await request(`/api/files/${selected.hash}/details`);
    selected.reviewed = Boolean(data.object.reviewed);
    renderReviewState();
    $('#detail-sources').innerHTML = data.sources.length ? data.sources.map(source => `
      <article><strong>${escapeHtml(source.sourceName)}</strong><span>${escapeHtml(source.path)}</span><small>${source.mtime ? new Date(source.mtime).toLocaleString() : ''}</small></article>`).join('') : '<div class="empty small-empty">None.</div>';
    $('#detail-backups').innerHTML = data.backups.length ? data.backups.map(backup => `
      <article><strong>${escapeHtml(backup.name)}</strong><small>${backup.verifiedAt ? new Date(backup.verifiedAt).toLocaleString() : new Date(backup.lastSeen).toLocaleString()}</small></article>`).join('') : '<div class="empty small-empty">None.</div>';
  } catch (error) {
    const html = `<div class="error">${escapeHtml(error.message)}</div>`;
    $('#detail-sources').innerHTML = html;
    $('#detail-backups').innerHTML = html;
  }
}

async function toggleReviewed() {
  if (!selected) return;
  const reviewed = !Boolean(selected.reviewed);
  await request(`/api/objects/${selected.hash}/review`, { method: 'POST', body: { reviewed } });
  selected.reviewed = reviewed;
  const cached = catalog.find(file => file.hash === selected.hash);
  if (cached) cached.reviewed = reviewed;
  cachePut(cached || selected).catch(console.warn);
  $('#details').close();
  selected = null;
  await loadStats();
  if (view === 'folders') await loadFolder();
  else applyFilters(true);
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
  $('#details').close();
  selected = null;
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
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
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
  if (view === 'folders') {
    folderImportId = importId;
    folderPath = '';
    loadFolder().catch(console.error);
  } else applyFilters(true);
});

$('#typeFilter').addEventListener('change', event => {
  type = event.target.value;
  applyFilters(true);
});

$('#sort').addEventListener('change', event => {
  sort = event.target.value;
  applyFilters(true);
});

$('#inbox').addEventListener('click', () => {
  inboxOnly = !inboxOnly;
  $('#inbox').classList.toggle('active', inboxOnly);
  applyFilters(true);
});

$('#unbacked').addEventListener('click', () => {
  noBackupOnly = !noBackupOnly;
  $('#unbacked').classList.toggle('active', noBackupOnly);
  applyFilters(true);
});

$('#views').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});

$('#dateRail').addEventListener('click', event => {
  const button = event.target.closest('[data-date-jump]');
  if (button) jumpToMonth(button.dataset.dateJump, Number(button.dataset.index));
});

$('#folderbar').addEventListener('click', event => {
  if (event.target.closest('[data-folder-home]')) {
    folderImportId = '';
    folderPath = '';
    importId = '';
    $('#source').value = '';
    loadFolder().catch(console.error);
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
  if (item) openDetails(item.dataset.hash).catch(console.error);
});

new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) showMore();
}, { rootMargin: '700px 0px' }).observe($('#scroll-sentinel'));

window.addEventListener('scroll', () => {
  if (dateScrollFrame) return;
  dateScrollFrame = requestAnimationFrame(() => {
    dateScrollFrame = 0;
    updateDateRailActive();
  });
}, { passive: true });

document.addEventListener('keydown', event => {
  if (!$('#details').open) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigateDetails(-1).catch(console.error); }
  if (event.key === 'ArrowRight') { event.preventDefault(); navigateDetails(1).catch(console.error); }
});

$('#close-details').onclick = () => $('#details').close();
$('#detail-prev').onclick = () => navigateDetails(-1).catch(console.error);
$('#detail-next').onclick = () => navigateDetails(1).catch(console.error);
$('#review-toggle').onclick = () => toggleReviewed().catch(console.error);
$('#delete').onclick = () => removeSelected(false).catch(console.error);
$('#delete-ignore').onclick = () => removeSelected(true).catch(console.error);

boot().catch(error => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${escapeHtml(error.stack || error.message)}</pre>`);
});
