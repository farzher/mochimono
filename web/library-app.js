import { buildSearchText, fileKind as kind, matchesDetails, matchesSmart, normalizeText, queryTerms } from './search-query.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const CLIENT = document.documentElement.classList.contains('client-library');
const login = $('#login');
const app = $('#app');
const logout = $('#logout');
const filesElement = $('#files');
const PAGE = 160;
const SCROLL_PAGE = 64;
const JUMP_WINDOW = PAGE * 3;
const THUMB_VERSION = 3;

let searchTimer = 0;
let catalog = [];
let catalogIndex = new Map();
let catalogVersion = '';
let filtered = [];
let filteredIndex = new Map();
let imports = [];
let sourceNames = new Map();
let searchIndex = new Map();
let searchIndexDirty = true;
let locationSearch = new Map();
let renderOffset = 0;
let renderEnd = 0;
let type = '';
let importId = '';
let collectionHashes = null;
let locationFilter = '';
let locationHashes = null;
let view = 'grid';
let sort = 'date-desc';
let selected = null;
let folderImportId = '';
let folderPath = '';
let folderData = null;
let folderLoadGeneration = 0;
let viewerScrollY = 0;
let viewerDirty = false;
let viewerPreloads = [];
let viewerImageLoad = null;
let scrubbing = false;
let lastScrubAt = 0;
let lastRailKey = '';
let bootGeneration = 0;

const fileDates = new Map();
window.mochimonoFileDates = fileDates;

const topScrollSentinel = document.createElement('div');
topScrollSentinel.id = 'top-scroll-sentinel';
topScrollSentinel.style.height = '1px';
topScrollSentinel.hidden = true;
filesElement.before(topScrollSentinel);

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

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
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
  if (type === 'other') return !['image','video','audio','text','application'].includes(value);
  return value === type;
}

function matchesLocation(file) {
  if (!locationFilter || locationFilter === 'server') return true;
  if (locationFilter === 'backup') return file.backupCount > 0;
  if (locationFilter === 'unbacked') return file.backupCount === 0;
  return Boolean(locationHashes?.has(file.hash));
}

window.mochimonoSearch = {
  raw: () => $('#search').value,
  setRaw(text, notify = true) {
    $('#search').value = String(text || '');
    if (notify) $('#search').dispatchEvent(new Event('input', { bubbles: true }));
  },
  normalize: normalizeText,
  matchesDetails,
  matchesSmart
};

const objectUrl = file => `/api/objects/${file.hash}`;
const thumbUrl = file => `/api/thumbs/${file.hash}?v=${THUMB_VERSION}`;

function preview(file) {
  const value = kind(file);
  if (value === 'image') return `<span class="video-thumb-pending" data-video-thumb="${file.hash}"></span>`;
  if (value === 'video') return `<span class="video-thumb-pending" data-video-thumb="${file.hash}"></span><span class="play-badge">▶</span>`;
  return `<div class="file-icon ${escapeHtml(value)}">${value === 'audio' ? '♪' : typeLabel(file) === 'document' ? '▤' : '·'}</div>`;
}

function viewerMedia(file, rapid = false) {
  const url = objectUrl(file);
  if (kind(file) === 'image') return `<img src="${thumbUrl(file)}" data-full-src="${url}" alt="${escapeHtml(file.filename)}">`;
  if (kind(file) === 'video') return rapid
    ? `<video controls playsinline poster="${thumbUrl(file)}"></video>`
    : `<video src="${url}" controls autoplay playsinline></video>`;
  return `<div class="viewer-file-icon">${preview(file)}</div>`;
}

function rememberFileDate(file) {
  fileDates.set(file.hash, { fileDate: file.fileDate || file.createdAt, addedAt: file.addedAt || file.createdAt });
  return file;
}

function normalizeFile(file) {
  const importIds = Array.isArray(file.importIds) ? file.importIds.map(Number).filter(Boolean) : String(file.importIds || '').split(',').map(Number).filter(Boolean);
  const exactImportIds = Array.isArray(file.exactImportIds) ? file.exactImportIds.map(Number).filter(Boolean) : String(file.exactImportIds || '').split(',').map(Number).filter(Boolean);
  const fileDate = new Date(file.fileDate || file.createdAt || 0);
  const addedDate = new Date(file.addedAt || file.createdAt || 0);
  return rememberFileDate({
    ...file,
    size: Number(file.size) || 0,
    width: Number(file.width) || 0,
    height: Number(file.height) || 0,
    importIds,
    exactImportIds,
    reviewed: Boolean(file.reviewed),
    backupCount: Number(file.backupCount) || 0,
    dateMs: Number.isNaN(fileDate.getTime()) ? 0 : fileDate.getTime(),
    addedMs: Number.isNaN(addedDate.getTime()) ? 0 : addedDate.getTime()
  });
}

function adoptCachedFile(file) {
  if (!file || !Array.isArray(file.importIds) || !Array.isArray(file.exactImportIds) ||
      !Number.isFinite(Number(file.dateMs)) || !Number.isFinite(Number(file.addedMs))) return normalizeFile(file || {});
  return rememberFileDate(file);
}

function rebuildSearchIndex() {
  searchIndex = new Map(catalog.map(file => [
    file.hash,
    `${buildSearchText(file, sourceNames)} ${locationSearch.get(file.hash) || ''}`.trim()
  ]));
  searchIndexDirty = false;
}

function ensureSearchIndex() {
  if (searchIndexDirty) rebuildSearchIndex();
}

function rebuildIndexes() {
  catalogIndex = new Map(catalog.map((file, index) => [file.hash, index]));
  sourceNames = new Map(imports.map(item => [Number(item.id), String(item.sourceName || '')]));
  searchIndexDirty = true;
  if (String($('#search')?.value || '').trim()) rebuildSearchIndex();
}

function catalogFile(hash) {
  const index = catalogIndex.get(String(hash || ''));
  return Number.isInteger(index) ? catalog[index] : null;
}

function renderFileCount(count = filtered.length) {
  const element = $('#fileCount');
  if (!element) return;
  element.textContent = `${Number(count).toLocaleString()} / ${catalog.length.toLocaleString()} files`;
  element.title = `${Number(count).toLocaleString()} in this view · ${catalog.length.toLocaleString()} total`;
}

function timelineMs(file) { return sort === 'date-added' ? file.addedMs || file.dateMs || 0 : file.dateMs || 0; }
const timelineDate = file => new Date(timelineMs(file));
const fileDate = file => new Date(file.dateMs || 0);
const shortDate = file => fileDate(file).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const monthKey = file => `${timelineDate(file).getFullYear()}-${String(timelineDate(file).getMonth() + 1).padStart(2, '0')}`;
const monthName = file => timelineDate(file).toLocaleDateString(undefined, { month: 'long' });
const monthRailLabel = file => timelineDate(file).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
const dayKey = file => `${timelineDate(file).getFullYear()}-${String(timelineDate(file).getMonth() + 1).padStart(2, '0')}-${String(timelineDate(file).getDate()).padStart(2, '0')}`;
const dayLabel = file => timelineDate(file).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function gridModel() {
  return {
    version:catalogVersion,
    sort,
    items:filtered.map(file => [
      String(file.hash || ''),
      String(file.filename || ''),
      kind(file),
      Number(file.width) || 0,
      Number(file.height) || 0,
      timelineMs(file),
      Number(file.size) || 0
    ])
  };
}

function publishGridModel() {
  const snapshot = gridModel();
  window.mochimonoGridModel = snapshot;
  window.mochimonoStableGrid?.setModel?.(snapshot);
  window.dispatchEvent(new CustomEvent('mochimono:grid-model', { detail:snapshot }));
}

function dateGroups(items) {
  const groups = [];
  for (const file of items) {
    const key = monthKey(file);
    const last = groups.at(-1);
    if (last?.key === key) last.files.push(file);
    else groups.push({ key, year: timelineDate(file).getFullYear(), month: monthName(file), files: [file] });
  }
  return groups;
}

function timelineGroups() {
  const result = [];
  let previous = '';
  filtered.forEach((file, index) => {
    const key = monthKey(file);
    if (key !== previous) result.push({ key, label: monthRailLabel(file), index, year: timelineDate(file).getFullYear() });
    previous = key;
  });
  return result;
}

function mediaRatio(file) {
  return file.width && file.height ? Math.max(.65, Math.min(2.1, file.width / file.height)) : 4 / 3;
}

function gridCard(file) {
  const media = ['image','video'].includes(kind(file));
  const ratio = media ? mediaRatio(file) : 0;
  return `<button class="file-card ${media ? 'media-card' : ''} ${kind(file) === 'video' ? 'video-card' : ''}" data-hash="${file.hash}" data-filename="${escapeHtml(file.filename)}" data-day="${dayKey(file)}" data-day-label="${escapeHtml(dayLabel(file))}"${media ? ` data-width="${file.width || 0}" data-height="${file.height || 0}" style="--ratio:${ratio}"` : ''} title="${escapeHtml(file.filename)}"><div class="thumb ${media ? 'media-thumb' : ''}">${preview(file)}</div>${media ? '' : `<div class="card-copy"><strong>${escapeHtml(file.filename)}</strong><span>${formatBytes(file.size)}</span></div>`}</button>`;
}

function listRow(file) {
  return `<button class="file-row" data-hash="${file.hash}" data-filename="${escapeHtml(file.filename)}" data-day="${dayKey(file)}" data-day-label="${escapeHtml(dayLabel(file))}"><span class="type">${escapeHtml(typeLabel(file))}</span><div class="file-main"><strong>${escapeHtml(file.filename)}</strong><span>${escapeHtml(file.originalPath || '')}</span></div><span class="refs">${escapeHtml(shortDate(file))}</span><span class="size">${formatBytes(file.size)}</span></button>`;
}

const cardsHtml = items => items.map(file => view === 'grid' ? gridCard(file) : listRow(file)).join('');

function groupHtml(group) {
  return `<section class="date-group" data-date-group="${group.key}" data-year="${group.year}"><h2 class="year-heading"></h2><h3 class="date-heading">${escapeHtml(group.month)}</h3><div class="${view === 'grid' ? 'date-grid' : 'date-list'}">${cardsHtml(group.files)}</div></section>`;
}

function syncYearHeadings() {
  let previousYear = null;
  for (const section of filesElement.querySelectorAll(':scope > .date-group')) {
    const year = Number(section.dataset.year);
    const heading = section.querySelector(':scope > .year-heading');
    if (!heading) continue;
    if (year !== previousYear) {
      heading.textContent = String(year);
      heading.hidden = false;
    } else {
      heading.textContent = '';
      heading.hidden = true;
    }
    previousYear = year;
  }
}

function currentAnchor() {
  if (view === 'grid' || scrollY <= 4 || !$('#viewer').hidden) return null;
  const barBottom = document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0;
  const bounds = filesElement.getBoundingClientRect();
  const xs = [bounds.left + 8, (bounds.left + bounds.right) / 2, bounds.right - 8]
    .map(x => Math.max(1, Math.min(innerWidth - 2, x)));
  for (const y of [barBottom + 2, barBottom + 40, barBottom + 80, barBottom + 120]) {
    if (y >= innerHeight) break;
    for (const x of xs) {
      const card = document.elementFromPoint(x, y)?.closest?.('#files [data-hash]');
      if (!card) continue;
      const rect = card.getBoundingClientRect();
      return { element: card, hash: card.dataset.hash, top: rect.top };
    }
  }
  return null;
}

function restoreAnchor(anchor) {
  if (view === 'grid' || !anchor) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const card = anchor.element?.isConnected ? anchor.element : filesElement.querySelector(`[data-hash="${CSS.escape(anchor.hash)}"]`);
    if (!card) return;
    const delta = card.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > .5) scrollBy(0, delta);
  }));
}

function syncSentinels() {
  const virtual = view !== 'grid' && view !== 'folders';
  topScrollSentinel.hidden = !virtual || renderOffset <= 0;
  $('#scroll-sentinel').hidden = !virtual || renderEnd >= filtered.length;
}

function resetMarkup() {
  filesElement.className = `files ${view}`;
  if (!filtered.length) {
    filesElement.innerHTML = '<div class="empty">No files.</div>';
  } else if (sort.startsWith('date-')) {
    filesElement.innerHTML = dateGroups(filtered.slice(renderOffset, renderEnd)).map(groupHtml).join('');
    syncYearHeadings();
  } else if (view === 'grid') {
    filesElement.innerHTML = `<div class="date-grid flat-grid">${cardsHtml(filtered.slice(renderOffset, renderEnd))}</div>`;
  } else {
    filesElement.innerHTML = cardsHtml(filtered.slice(renderOffset, renderEnd));
  }
  syncSentinels();
}

function appendItems(items) {
  if (!items.length) return;
  if (sort.startsWith('date-')) {
    const groups = dateGroups(items);
    const lastSection = filesElement.querySelector(':scope > .date-group:last-of-type');
    if (groups.length && lastSection?.dataset.dateGroup === groups[0].key) {
      lastSection.querySelector(`:scope > .${view === 'grid' ? 'date-grid' : 'date-list'}`)?.insertAdjacentHTML('beforeend', cardsHtml(groups.shift().files));
    }
    filesElement.insertAdjacentHTML('beforeend', groups.map(groupHtml).join(''));
    syncYearHeadings();
  } else if (view === 'grid') {
    let grid = filesElement.querySelector(':scope > .flat-grid');
    if (!grid) {
      filesElement.innerHTML = '<div class="date-grid flat-grid"></div>';
      grid = filesElement.querySelector(':scope > .flat-grid');
    }
    grid.insertAdjacentHTML('beforeend', cardsHtml(items));
  } else {
    filesElement.insertAdjacentHTML('beforeend', cardsHtml(items));
  }
  syncSentinels();
}

function prependItems(items, anchor) {
  if (!items.length) return;
  if (sort.startsWith('date-')) {
    const groups = dateGroups(items);
    const firstSection = filesElement.querySelector(':scope > .date-group:first-of-type');
    const last = groups.at(-1);
    if (last && firstSection?.dataset.dateGroup === last.key) {
      firstSection.querySelector(`:scope > .${view === 'grid' ? 'date-grid' : 'date-list'}`)?.insertAdjacentHTML('afterbegin', cardsHtml(last.files));
      groups.pop();
    }
    filesElement.insertAdjacentHTML('afterbegin', groups.map(groupHtml).join(''));
    syncYearHeadings();
  } else if (view === 'grid') {
    let grid = filesElement.querySelector(':scope > .flat-grid');
    if (!grid) {
      resetMarkup();
      return;
    }
    grid.insertAdjacentHTML('afterbegin', cardsHtml(items));
  } else {
    filesElement.insertAdjacentHTML('afterbegin', cardsHtml(items));
  }
  syncSentinels();
  restoreAnchor(anchor);
}

function cleanupEmptyDateGroups() {
  if (!sort.startsWith('date-')) return;
  for (const section of filesElement.querySelectorAll(':scope > .date-group')) {
    if (!section.querySelector('[data-hash]')) section.remove();
  }
  syncYearHeadings();
}

function trimRenderedStart(count, anchor) {
  const cards = [...filesElement.querySelectorAll('[data-hash]')].slice(0, count);
  if (!cards.length) return 0;
  for (const card of cards) card.remove();
  cleanupEmptyDateGroups();
  restoreAnchor(anchor);
  return cards.length;
}

function trimRenderedEnd(count) {
  const cards = [...filesElement.querySelectorAll('[data-hash]')].slice(-count);
  if (!cards.length) return 0;
  for (const card of cards) card.remove();
  cleanupEmptyDateGroups();
  return cards.length;
}

function renderFiles(preserve = false) {
  if (view === 'folders') return renderFolder();
  if (folderImportId) folderBreadcrumb();
  else { $('#folderbar').hidden = true; $('#folderbar').replaceChildren(); }

  if (view === 'grid') {
    topScrollSentinel.hidden = true;
    $('#scroll-sentinel').hidden = true;
    publishGridModel();
    return;
  }

  window.mochimonoStableGrid?.release?.();
  const anchor = preserve ? currentAnchor() : null;
  resetMarkup();
  renderRail();
  restoreAnchor(anchor);
}

function sortFiles(items) {
  if (sort === 'date-added') return items.sort((a, b) => timelineMs(b) - timelineMs(a) || a.hash.localeCompare(b.hash));
  if (sort === 'date-asc') return items.sort((a, b) => a.dateMs - b.dateMs || a.hash.localeCompare(b.hash));
  if (sort === 'size-desc') return items.sort((a, b) => b.size - a.size || a.filename.localeCompare(b.filename));
  return items.sort((a, b) => b.dateMs - a.dateMs || a.hash.localeCompare(b.hash));
}

function applyFilters(reset = true, preserve = false, keepHash = '') {
  if (view === 'folders') return loadFolder();
  const terms = queryTerms($('#search').value, $('#source').options);
  if (terms.length) ensureSearchIndex();
  const sourceId = Number(importId) || 0;
  const folderHashes = folderImportId && folderPath && folderData ? new Set(folderData.files.map(file => file.hash)) : null;
  filtered = sortFiles(catalog.filter(file => {
    if (!matchesType(file) || !matchesLocation(file) || (collectionHashes && !collectionHashes.has(file.hash))) return false;
    if (sourceId && !file.importIds.includes(sourceId)) return false;
    if (folderHashes && !folderHashes.has(file.hash)) return false;
    return !terms.length || terms.every(term => (searchIndex.get(file.hash) || '').includes(term));
  }));
  filteredIndex = new Map(filtered.map((file, index) => [file.hash, index]));

  if (reset) {
    renderOffset = 0;
    renderEnd = Math.min(filtered.length, PAGE);
  } else {
    const keepIndex = keepHash ? filteredIndex.get(keepHash) : null;
    const currentSize = Math.max(PAGE, renderEnd - renderOffset);
    if (Number.isInteger(keepIndex) && (keepIndex < renderOffset || keepIndex >= renderEnd)) {
      renderOffset = Math.max(0, keepIndex - Math.floor(currentSize / 2));
      renderEnd = Math.min(filtered.length, renderOffset + currentSize);
    } else {
      renderOffset = Math.min(renderOffset, Math.max(0, filtered.length - 1));
      renderEnd = Math.min(filtered.length, Math.max(renderOffset + Math.min(PAGE, filtered.length), renderEnd));
    }
  }

  renderFileCount();
  renderFiles(preserve);
  if (selected) {
    const current = catalogFile(selected.hash);
    if (current) selected = current;
    updateViewerNav();
  }
}

function extendWindow(direction = 1) {
  if (view === 'grid' || view === 'folders' || !filtered.length) return false;
  if (direction < 0) {
    if (renderOffset <= 0) return false;
    const anchor = currentAnchor();
    const nextOffset = Math.max(0, renderOffset - SCROLL_PAGE);
    const items = filtered.slice(nextOffset, renderOffset);
    renderOffset = nextOffset;
    prependItems(items, anchor);
    const excess = Math.max(0, renderEnd - renderOffset - JUMP_WINDOW);
    if (excess) renderEnd -= trimRenderedEnd(excess);
  } else {
    if (renderEnd >= filtered.length) return false;
    const nextEnd = Math.min(filtered.length, renderEnd + SCROLL_PAGE);
    const excess = Math.max(0, nextEnd - renderOffset - JUMP_WINDOW);
    const anchor = excess ? currentAnchor() : null;
    const items = filtered.slice(renderEnd, nextEnd);
    renderEnd = nextEnd;
    appendItems(items);
    if (excess) renderOffset += trimRenderedStart(excess, anchor);
  }
  syncSentinels();
  return true;
}

function ensureIndexRendered(index) {
  if (!Number.isInteger(index) || !filtered[index]) return false;
  if (view === 'grid') return Boolean(window.mochimonoStableGrid?.ensureIndex?.(index));
  if (index >= renderOffset && index < renderEnd) return false;
  renderOffset = Math.max(0, Math.min(index - PAGE, Math.max(0, filtered.length - JUMP_WINDOW)));
  renderEnd = Math.min(filtered.length, renderOffset + JUMP_WINDOW);
  renderFiles(false);
  return true;
}

function railEntries() {
  if (view === 'grid' || view === 'folders' || !filtered.length) return [];
  if (sort === 'size-desc') {
    const count = Math.min(18, filtered.length);
    const indexes = [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * (filtered.length - 1) / Math.max(1, count - 1))))];
    return indexes.map((index, i) => ({ index, label: formatBytes(filtered[index].size), position: filtered.length === 1 ? 0 : index / (filtered.length - 1), major: i % 3 === 0 || i === indexes.length - 1 }));
  }
  const groups = timelineGroups();
  const compact = groups.length > 18;
  let lastYear;
  return groups.map(group => {
    const major = !compact || group.year !== lastYear;
    lastYear = group.year;
    return { index: group.index, label: group.label, short: compact && major ? String(group.year) : group.label, position: filtered.length === 1 ? 0 : group.index / (filtered.length - 1), major };
  });
}

function railLabel(index) {
  const file = filtered[Math.max(0, Math.min(filtered.length - 1, index))];
  return file ? sort === 'size-desc' ? formatBytes(file.size) : monthRailLabel(file) : '';
}

function setRailThumb(index) {
  const thumb = $('#railThumb');
  if (!thumb || !filtered.length) return;
  const safe = Math.max(0, Math.min(filtered.length - 1, index));
  thumb.style.top = `${(filtered.length === 1 ? 0 : safe / (filtered.length - 1)) * 100}%`;
  thumb.querySelector('span').textContent = railLabel(safe);
}

function visibleIndex() {
  if (view === 'grid') return Number(window.mochimonoStableGrid?.visibleIndex?.()) || 0;
  const visible = currentAnchor()?.element;
  return visible ? filteredIndex.get(visible.dataset.hash) ?? renderOffset : renderOffset;
}

function updateRailActive() {
  if (view === 'grid') return;
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

function renderRail() {
  if (view === 'grid') return;
  const rail = $('#dateRail');
  const entries = railEntries();
  rail.hidden = !entries.length;
  document.documentElement.classList.toggle('library-scroll', Boolean(entries.length));
  if (!entries.length) {
    lastRailKey = '';
    rail.replaceChildren();
    return;
  }
  const key = entries.map(entry => `${entry.index}:${entry.position.toFixed(5)}:${entry.short || entry.label}:${entry.major ? 1 : 0}`).join('|');
  if (key !== lastRailKey) {
    lastRailKey = key;
    rail.innerHTML = `<div class="rail-track"></div>${entries.map(entry => `<button data-index="${entry.index}" class="rail-tick ${entry.major ? 'major' : ''}" style="top:${(entry.position * 100).toFixed(3)}%" title="${escapeHtml(entry.label)}"><span>${escapeHtml(entry.short || entry.label)}</span><i></i></button>`).join('')}<div id="railThumb" class="rail-thumb"><span></span><i></i></div>`;
  }
  updateRailActive();
}

function renderImports() {
  $('#source').innerHTML = '<option value="">All sources</option>' + imports.map(item => `<option value="${item.id}">${escapeHtml(item.sourceName)}</option>`).join('');
  $('#source').value = importId;
  if (view === 'folders' && !folderImportId) renderFolder();
}

function jumpToIndex(index, smooth = true) {
  if (!Number.isInteger(index) || !filtered[index]) return;
  if (view === 'grid') {
    window.mochimonoStableGrid?.scrollToIndex?.(index, 'center');
    return;
  }
  ensureIndexRendered(index);
  const hash = filtered[index].hash;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    filesElement.querySelector(`[data-hash="${CSS.escape(hash)}"]`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
  }));
}

function scrubFromPointer(event, final = false) {
  if (view === 'grid' || !filtered.length) return;
  const rect = $('#dateRail').getBoundingClientRect();
  const index = Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * (filtered.length - 1));
  setRailThumb(index);
  const now = performance.now();
  if (final || now - lastScrubAt > 90) { lastScrubAt = now; jumpToIndex(index, false); }
}

async function loadStats() {
  if (CLIENT) return;
  const stats = await request('/api/stats');
  const percent = stats.capacityBytes ? Math.min(100, stats.bytes / stats.capacityBytes * 100) : 0;
  $('#stats').innerHTML = `<span>${formatBytes(stats.bytes)} <small>of ${formatBytes(stats.capacityBytes)}</small></span><i><b style="width:${stats.bytes ? `max(2px, ${percent}%)` : '0'}"></b></i>`;
}

async function correctFileDates(files) {
  if (CLIENT) return files;
  for (let offset = 0; offset < files.length; offset += 5000) {
    const batch = files.slice(offset, offset + 5000);
    try {
      const data = await request('/api/file-dates', { method: 'POST', body: { hashes: batch.map(file => file.hash) } });
      const byHash = new Map((data.dates || []).map(item => [item.hash, item]));
      for (const file of batch) {
        const date = byHash.get(file.hash);
        if (date) Object.assign(file, { fileDate: date.fileDate, dateSource: date.dateSource, capturedAt: date.capturedAt });
      }
    } catch (error) { console.warn('Could not load canonical file dates.', error); }
  }
  return files;
}

async function fetchCatalog() {
  let latest;
  for (let attempt = 0; attempt < 2; attempt++) {
    const start = await request('/api/catalog/version');
    const importsPromise = request('/api/imports');
    const raw = [];
    let after = '';
    do {
      const page = await request(`/api/catalog?limit=5000&after=${encodeURIComponent(after)}`);
      raw.push(...(page.files || []));
      after = page.nextAfter || '';
    } while (after);
    await correctFileDates(raw);
    const [importsData, end] = await Promise.all([importsPromise, request('/api/catalog/version')]);
    latest = { version: String(end.version || ''), imports: importsData.imports || [], files: raw.map(normalizeFile) };
    if (String(start.version || '') === latest.version) break;
  }
  return latest;
}

function installSnapshot(snapshot, preserve = false) {
  const anchor = preserve ? currentAnchor() : null;
  const keepHash = anchor?.hash || (!$('#viewer').hidden ? selected?.hash : '');
  const learned = new Map(catalog.filter(file => file.width && file.height).map(file => [file.hash, [file.width, file.height]]));
  const cached = snapshot.normalized === true;
  catalog = (snapshot.files || []).map(raw => {
    const file = cached ? adoptCachedFile(raw) : normalizeFile(raw);
    const dimensions = learned.get(file.hash);
    return dimensions && (!file.width || !file.height) ? { ...file, width: dimensions[0], height: dimensions[1] } : file;
  });
  imports = snapshot.imports || [];
  catalogVersion = String(snapshot.version || '');
  rebuildIndexes();
  renderImports();
  applyFilters(!preserve, preserve, keepHash);
}

async function syncCatalog(force = false) {
  const remote = await request('/api/catalog/version');
  const remoteVersion = String(remote.version || '');
  if (!force && catalogVersion && catalogVersion === remoteVersion) return false;
  const fresh = await fetchCatalog();
  installSnapshot(fresh, Boolean(catalog.length));
  window.mochimonoCatalogCache?.save?.(catalog, { version: fresh.version, imports: fresh.imports }).catch(error => console.warn('Could not save local catalog.', error));
  window.dispatchEvent(new CustomEvent('mochimono:catalog-updated', { detail: { version: fresh.version, count: catalog.length } }));
  return true;
}

function currentFolderSource() { return imports.find(item => String(item.id) === String(folderImportId)); }
function folderState() {
  return { importId: String(folderImportId || ''), path: folderPath, sourceName: currentFolderSource()?.sourceName || '' };
}
function notifyFolderChanged() {
  window.dispatchEvent(new CustomEvent('mochimono:folder-changed', { detail: folderState() }));
}

function folderBreadcrumb() {
  const bar = $('#folderbar');
  bar.hidden = false;
  const source = currentFolderSource();
  const parts = folderPath ? folderPath.split('/') : [];
  const crumbs = ['<button data-folder-home>Sources</button>'];
  if (source) {
    crumbs.push(`<span>›</span><button data-folder-depth="0">${escapeHtml(source.sourceName)}</button>`);
    parts.forEach((part, index) => crumbs.push(`<span>›</span><button data-folder-depth="${index + 1}">${escapeHtml(part)}</button>`));
  }
  bar.innerHTML = `<div class="breadcrumbs">${crumbs.join('')}</div>`;
}

function renderFolder() {
  window.mochimonoStableGrid?.release?.();
  filesElement.className = 'files folders';
  topScrollSentinel.hidden = true;
  $('#scroll-sentinel').hidden = true;
  $('#dateRail').hidden = true;
  document.documentElement.classList.remove('library-scroll');
  folderBreadcrumb();
  if (!folderImportId) {
    renderFileCount(catalog.length);
    filesElement.innerHTML = imports.length ? `<div class="folder-list-head"><span>Name</span><span>Files</span><span>Imported</span></div>${imports.map(item => `<button class="folder-row source-row" data-folder-source="${item.id}"><span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(item.sourceName)}</strong></span><span>${Number(item.files || 0).toLocaleString()} · ${formatBytes(item.referencedBytes)}</span><span>${escapeHtml(new Date(item.createdAt).toLocaleDateString())}</span></button>`).join('')}` : '<div class="empty">No sources.</div>';
    return;
  }
  if (!folderData) { renderFileCount(0); filesElement.innerHTML = '<div class="empty">Loading…</div>'; return; }
  renderFileCount(folderData.files.length);
  const rows = [];
  for (const folder of folderData.folders || []) rows.push(`<button class="folder-row" data-folder-name="${escapeHtml(folder.name)}"><span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(folder.name)}</strong></span><span>${Number(folder.files || 0).toLocaleString()}</span><span>Folder</span></button>`);
  for (const file of folderData.files || []) {
    rows.push(`<button class="folder-row file-folder-row" data-hash="${file.hash}" data-filename="${escapeHtml(file.filename)}"><span class="folder-name"><i class="document-icon"></i><strong>${escapeHtml(file.filename)}</strong></span><span>${formatBytes(file.size)}</span><span>${escapeHtml(typeLabel(file))}</span></button>`);
  }
  filesElement.innerHTML = rows.length ? `<div class="folder-list-head"><span>Name</span><span>Size</span><span>Type</span></div>${rows.join('')}` : '<div class="empty">Empty.</div>';
}

async function loadFolder() {
  const generation = ++folderLoadGeneration;
  folderData = null;
  if (view === 'folders') renderFolder();
  if (!folderImportId) {
    if (view !== 'folders') { $('#folderbar').hidden = true; $('#folderbar').replaceChildren(); applyFilters(true); }
    notifyFolderChanged();
    return null;
  }
  const wantedImport = String(folderImportId);
  const wantedPath = folderPath;
  const data = await request(`/api/folders?import=${encodeURIComponent(wantedImport)}&path=${encodeURIComponent(wantedPath)}`);
  if (generation !== folderLoadGeneration || String(folderImportId) !== wantedImport || folderPath !== wantedPath) return null;
  folderData = { ...data, files: (data.files || []).map(normalizeFile) };
  if (view === 'folders') renderFolder(); else applyFilters(true);
  notifyFolderChanged();
  return folderData;
}

function openFolder(nextImportId = '', nextPath = '') {
  folderImportId = String(nextImportId || '');
  importId = folderImportId;
  $('#source').value = importId;
  folderPath = String(nextPath || '').split('/').filter(part => part && part !== '.' && part !== '..').join('/');
  return loadFolder();
}

function setView(next) {
  view = next;
  lastRailKey = '';
  const folderMode = view === 'folders';
  if (view !== 'grid') window.mochimonoStableGrid?.release?.();
  $('#sort').hidden = folderMode;
  $('#typeFilter').hidden = folderMode;
  $('#collectionFilter').hidden = folderMode;
  $('#locationFilter').hidden = folderMode;
  $('#mediaSizeControl').hidden = view !== 'grid';
  $$('#views button').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  if (folderMode) {
    if (!folderImportId) { folderImportId = importId; folderPath = ''; }
    loadFolder().catch(console.error);
  } else applyFilters(true);
}

function setCollectionHashes(hashes) {
  collectionHashes = hashes instanceof Set ? hashes : null;
  if (collectionHashes) {
    folderLoadGeneration++;
    folderImportId = '';
    folderPath = '';
    folderData = null;
    importId = '';
    $('#source').value = '';
    $('#folderbar').hidden = true;
    $('#folderbar').replaceChildren();
    notifyFolderChanged();
    if (view === 'folders') { $('#views [data-view="grid"]')?.click(); return; }
  }
  applyFilters(true);
}
window.mochimonoSetCollectionHashes = setCollectionHashes;

const viewerItems = () => view === 'folders' ? (folderData?.files || []) : filtered;
function viewerIndex(items = viewerItems()) {
  if (view !== 'folders') return filteredIndex.get(selected?.hash) ?? -1;
  return items.findIndex(file => file.hash === selected?.hash);
}
function updateViewerNav() {
  const items = viewerItems();
  const index = viewerIndex(items);
  $('#viewer-prev').disabled = index <= 0;
  $('#viewer-next').disabled = index < 0 || index >= items.length - 1;
}

function viewerMeta(file) {
  const resolution = file.width && file.height ? `${file.width.toLocaleString()}×${file.height.toLocaleString()}` : '';
  return [formatBytes(file.size), resolution, shortDate(file)].filter(Boolean).join(' · ');
}

function loadFullViewerImage(file) {
  const shown = $('#viewer-media img[data-full-src]');
  if (!shown) return;
  const hash = file.hash;
  const fullUrl = shown.dataset.fullSrc;
  const image = new Image();
  image.decoding = 'async';
  viewerImageLoad = image;
  const swap = () => {
    if (selected?.hash !== hash || viewerImageLoad !== image || !shown.isConnected) return;
    shown.src = fullUrl;
    shown.removeAttribute('data-full-src');
    shown.onerror = null;
    viewerImageLoad = null;
  };
  image.onload = async () => {
    try { await image.decode(); } catch {}
    if ((!file.width || !file.height) && image.naturalWidth && image.naturalHeight) {
      file.width = image.naturalWidth;
      file.height = image.naturalHeight;
      if (selected?.hash === hash) $('#viewer-meta').textContent = viewerMeta(file);
    }
    swap();
  };
  image.onerror = () => { if (viewerImageLoad === image) viewerImageLoad = null; };
  shown.onerror = () => {
    if (selected?.hash !== hash || !shown.dataset.fullSrc) return;
    shown.removeAttribute('data-full-src');
    shown.onerror = null;
    shown.src = fullUrl;
  };
  image.src = fullUrl;
}

function preloadAround() {
  const items = viewerItems();
  const index = viewerIndex(items);
  viewerPreloads = [1, -1].map(step => items[index + step]).filter(Boolean).map(file => {
    if (kind(file) === 'image') { const image = new Image(); image.src = objectUrl(file); return image; }
    if (kind(file) === 'video') { const video = document.createElement('video'); video.preload = 'metadata'; video.muted = true; video.src = `${objectUrl(file)}#t=0.1`; return video; }
    return null;
  }).filter(Boolean);
}

function settleViewerMedia(hash) {
  if (!selected || selected.hash !== hash || $('#viewer').hidden) return;
  const value = kind(selected);
  if (value === 'image') loadFullViewerImage(selected);
  else if (value === 'video') {
    const video = $('#viewer-media video:not([src])');
    if (video) {
      video.src = objectUrl(selected);
      video.autoplay = true;
      video.play().catch(() => {});
    }
  }
  preloadAround();
}

function renderViewerState() {
  if (!selected) return;
  const hash = selected.hash;
  const rapid = Boolean(window.mochimonoViewerPerformance?.rapid?.());
  viewerImageLoad = null;
  viewerPreloads = [];
  $('#viewer-name').textContent = selected.filename;
  $('#viewer-meta').textContent = viewerMeta(selected);
  $('#viewer-open').href = objectUrl(selected);
  $('#viewer-media').innerHTML = viewerMedia(selected, rapid);
  updateViewerNav();
  if (rapid && window.mochimonoViewerPerformance?.defer?.(() => settleViewerMedia(hash))) return;
  settleViewerMedia(hash);
}

function openViewer(hash, fallback = null) {
  selected = catalogFile(hash) || folderData?.files?.find(file => file.hash === hash) || fallback;
  if (!selected) return false;
  if (!catalogFile(selected.hash) && !folderData?.files?.includes(selected)) selected = normalizeFile(selected);
  if ($('#viewer').hidden) viewerScrollY = window.scrollY;
  $('#viewer').hidden = false;
  renderViewerState();
  return true;
}
window.mochimonoOpenViewer = openViewer;

function revealViewerHash(hash) {
  if (!hash) return requestAnimationFrame(() => window.scrollTo(0, viewerScrollY));
  if (view === 'grid') {
    const index = filteredIndex.get(hash);
    if (Number.isInteger(index)) window.mochimonoStableGrid?.ensureIndex?.(index);
    requestAnimationFrame(() => {
      window.scrollTo({ top:viewerScrollY, left:0, behavior:'auto' });
      window.mochimonoStableGrid?.ensureIndex?.(Number.isInteger(index) ? index : -1);
      window.dispatchEvent(new CustomEvent('mochimono-viewer-return', { detail: { hash } }));
    });
    return;
  }
  if (view !== 'folders') {
    const index = filteredIndex.get(hash);
    if (Number.isInteger(index)) ensureIndexRendered(index);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const card = filesElement.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
    if (card) card.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
    else window.scrollTo(0, viewerScrollY);
    window.dispatchEvent(new CustomEvent('mochimono-viewer-return', { detail: { hash } }));
  }));
}

function closeViewer() {
  if ($('#viewer').hidden) return;
  const returnHash = selected?.hash || '';
  $('#viewer').hidden = true;
  $('#viewer-menu').open = false;
  $('#viewer-media').innerHTML = '';
  viewerPreloads = [];
  viewerImageLoad = null;
  selected = null;
  if (viewerDirty) {
    viewerDirty = false;
    if (view === 'folders') loadFolder().catch(console.error); else applyFilters(false, true, returnHash);
  }
  revealViewerHash(returnHash);
}

function navigateViewer(step) {
  const items = viewerItems();
  const index = viewerIndex(items);
  const next = items[index + step];
  if (next) { selected = next; renderViewerState(); }
}

async function refreshImports() {
  imports = (await request('/api/imports')).imports;
  rebuildIndexes();
  renderImports();
}

async function removeSelected(ignore) {
  if (!selected || !confirm(ignore ? 'Delete + ignore on future imports?' : 'Delete this file?')) return;
  const hash = selected.hash;
  await request(`/api/objects/${hash}/delete`, { method: 'POST', body: { ignore } });
  catalog = catalog.filter(file => file.hash !== hash);
  searchIndex.delete(hash);
  locationSearch.delete(hash);
  fileDates.delete(hash);
  rebuildIndexes();
  viewerDirty = false;
  closeViewer();
  await Promise.allSettled([loadStats(), refreshImports()]);
  if (view === 'folders') await loadFolder(); else applyFilters(true);
  window.mochimonoCatalogCache?.save?.(catalog, { version: catalogVersion, imports }).catch(() => {});
}

async function loadDrives() {
  if (CLIENT) return;
  const data = await request('/api/drives');
  $('#drives').innerHTML = data.drives.map(drive => {
    const ratio = drive.desiredBytes ? Math.min(100, drive.protectedBytes / drive.desiredBytes * 100) : 100;
    const missing = Math.max(0, drive.desiredBytes - drive.protectedBytes);
    return `<article class="drive"><div class="drive-head"><strong>${escapeHtml(drive.name)}</strong><span>${ratio.toFixed(0)}%</span></div><div class="meter"><i style="width:${ratio}%"></i></div><p>${formatBytes(drive.protectedBytes)} / ${formatBytes(drive.desiredBytes)}${missing ? ` · ${formatBytes(missing)} missing` : ''}</p></article>`;
  }).join('') || '<div class="empty">No backups.</div>';
}

window.mochimonoLibrary = {
  setSort(value) { sort = String(value || 'date-desc'); $('#sort').value = sort; applyFilters(true); },
  setLocationFilter(mode, hashes = null) {
    locationFilter = String(mode || '');
    locationHashes = hashes instanceof Set ? hashes : hashes ? new Set(hashes) : null;
    applyFilters(true);
  },
  setLocationSearch(entries) {
    locationSearch = entries instanceof Map ? entries : new Map(entries || []);
    searchIndexDirty = true;
    if (!String($('#search')?.value || '').trim()) return;
    const anchor = currentAnchor();
    applyFilters(false, true, anchor?.hash || '');
  },
  upsert(file) { this.upsertMany(file ? [file] : []); },
  upsertMany(items) {
    if (!items?.length) return;
    const anchor = currentAnchor();
    const keepHash = anchor?.hash || (!$('#viewer').hidden ? selected?.hash : '');
    let changed = false;
    for (const raw of items) {
      const hash = String(raw?.hash || '');
      if (!hash) continue;
      const index = catalogIndex.get(hash);
      if (Number.isInteger(index)) {
        const current = catalog[index];
        catalog[index] = normalizeFile({ ...current, ...raw, searchText: [current.searchText, raw.searchText].filter(Boolean).join(' ') });
      } else catalog.push(normalizeFile(raw));
      changed = true;
    }
    if (changed) {
      rebuildIndexes();
      applyFilters(false, true, keepHash);
    }
  },
  extend: extendWindow,
  refresh: () => syncCatalog(true),
  ensureIndex: ensureIndexRendered,
  filteredHashes: () => filtered.map(file => file.hash),
  gridModel,
  sources: () => imports.map(item => ({ ...item })),
  folderState,
  folderContents: () => folderData,
  openFolder,
  remove(hashes) {
    const removed = new Set(hashes || []);
    if (!removed.size) return;
    const anchor = currentAnchor();
    catalog = catalog.filter(file => !removed.has(file.hash));
    for (const hash of removed) { searchIndex.delete(hash); locationSearch.delete(hash); fileDates.delete(hash); }
    rebuildIndexes();
    applyFilters(false, true, anchor?.hash || '');
  },
  state: () => ({
    total: catalog.length,
    filtered: filtered.length,
    offset: view === 'grid' ? 0 : renderOffset,
    loaded: view === 'grid' ? filtered.length : Math.max(0, renderEnd - renderOffset),
    hasMore: view === 'grid' ? false : renderEnd < filtered.length,
    hasPrevious: view === 'grid' ? false : renderOffset > 0,
    view,
    sort,
    locationFilter,
    version: catalogVersion,
    searchIndexed:!searchIndexDirty,
    stableGrid:view === 'grid'
  })
};

async function restoreLocalCatalog() {
  const cache = window.mochimonoCatalogCache;
  if (!cache?.load) return false;
  const snapshot = await cache.load().catch(error => {
    console.warn('Could not restore local Mochimono catalog.', error);
    return null;
  });
  if (!snapshot?.files?.length) return false;
  installSnapshot({ ...snapshot, normalized:true }, false);
  window.dispatchEvent(new CustomEvent('mochimono:catalog-cache-restored', { detail: { count: catalog.length, version: catalogVersion } }));
  return true;
}

async function boot() {
  const generation = ++bootGeneration;
  const mediaSize = Math.max(96, Math.min(420, Number(localStorage.getItem('mochimono-media-size')) || 170));
  $('#mediaSize').value = mediaSize;
  document.documentElement.style.setProperty('--media-size', `${mediaSize}px`);

  let restored = false;
  if (CLIENT && !catalog.length) {
    restored = await restoreLocalCatalog();
    if (generation !== bootGeneration) return;
    if (restored) {
      login.hidden = true;
      app.hidden = false;
      logout.hidden = false;
    }
  } else restored = Boolean(catalog.length);

  try {
    await request('/api/health');
    if (generation !== bootGeneration) return;
    login.hidden = true;
    app.hidden = false;
    logout.hidden = false;

    if (!CLIENT && !catalog.length) {
      restored = await restoreLocalCatalog();
      if (generation !== bootGeneration) return;
    }

    if (!restored && !catalog.length) filesElement.innerHTML = '<div class="empty">Loading…</div>';
    loadStats().catch(() => {});
    loadDrives().catch(() => {});

    const fresh = syncCatalog(false);
    if (!restored) await fresh;
    else fresh.catch(error => console.warn('Mochimono server refresh failed; using the local catalog.', error));
  } catch (error) {
    if (error.unauthorized) {
      login.hidden = false;
      app.hidden = true;
      logout.hidden = true;
      return;
    }
    if (catalog.length) {
      console.warn('Mochimono is offline; using the local catalog.', error);
      login.hidden = true;
      app.hidden = false;
      return;
    }
    throw error;
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
logout.addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }).catch(() => {}); catalog = []; catalogVersion = ''; await boot(); });
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => applyFilters(true), 55); });
$('#source').addEventListener('change', event => {
  importId = event.target.value;
  folderLoadGeneration++;
  folderImportId = '';
  folderPath = '';
  folderData = null;
  if (view === 'folders') { folderImportId = importId; loadFolder().catch(console.error); }
  else {
    $('#folderbar').hidden = true;
    $('#folderbar').replaceChildren();
    notifyFolderChanged();
    applyFilters(true);
  }
});
$('#typeFilter').addEventListener('change', event => { type = event.target.value; applyFilters(true); });
$('#sort').addEventListener('change', event => { sort = event.target.value; applyFilters(true); });
$('#mediaSize').addEventListener('input', event => {
  const size = Number(event.target.value);
  document.documentElement.style.setProperty('--media-size', `${size}px`);
  localStorage.setItem('mochimono-media-size', String(size));
  window.dispatchEvent(new CustomEvent('mochimono:media-size'));
});
$('#views').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) setView(button.dataset.view); });

const rail = $('#dateRail');
rail.addEventListener('pointerdown', event => {
  if (view === 'grid') return;
  if (!rail.hidden) {
    scrubbing = true;
    rail.setPointerCapture?.(event.pointerId);
    rail.classList.add('dragging');
    scrubFromPointer(event);
    event.preventDefault();
  }
});
rail.addEventListener('pointermove', event => { if (view !== 'grid' && scrubbing) { scrubFromPointer(event); event.preventDefault(); } });
rail.addEventListener('pointerup', event => {
  if (view !== 'grid' && scrubbing) {
    scrubbing = false;
    rail.classList.remove('dragging');
    scrubFromPointer(event, true);
    rail.releasePointerCapture?.(event.pointerId);
  }
});
rail.addEventListener('pointercancel', () => { scrubbing = false; rail.classList.remove('dragging'); });
rail.addEventListener('click', event => {
  if (view === 'grid') return;
  const tick = event.target.closest('[data-index]');
  if (tick && !scrubbing) jumpToIndex(Number(tick.dataset.index), false);
});

$('#folderbar').addEventListener('click', event => {
  if (event.target.closest('[data-folder-home]')) {
    openFolder('', '').catch(console.error);
    return;
  }
  const crumb = event.target.closest('[data-folder-depth]');
  if (!crumb) return;
  const depth = Number(crumb.dataset.folderDepth);
  const path = depth ? folderPath.split('/').slice(0, depth).join('/') : '';
  openFolder(folderImportId, path).catch(console.error);
});

filesElement.addEventListener('click', event => {
  const sourceRow = event.target.closest('[data-folder-source]');
  if (sourceRow) {
    openFolder(sourceRow.dataset.folderSource, '').catch(console.error);
    return;
  }
  const folderRow = event.target.closest('[data-folder-name]');
  if (folderRow) {
    const path = folderPath ? `${folderPath}/${folderRow.dataset.folderName}` : folderRow.dataset.folderName;
    openFolder(folderImportId, path).catch(console.error);
    return;
  }
  const item = event.target.closest('[data-hash]');
  if (item) openViewer(item.dataset.hash);
});

function observeWindowEdge(target, direction, rootMargin) {
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) extendWindow(direction);
  }, { rootMargin });
  observer.observe(target);
}

observeWindowEdge(topScrollSentinel, -1, '240px 0px');
observeWindowEdge($('#scroll-sentinel'), 1, '240px 0px');

window.addEventListener('mochimono:grid-interaction-end', () => {
  if (view !== 'grid' && !scrubbing) updateRailActive();
});

document.addEventListener('keydown', event => {
  if ($('#viewer').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeViewer(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigateViewer(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); navigateViewer(1); }
});
$('#viewer-close').onclick = closeViewer;
$('#viewer-prev').onclick = () => navigateViewer(-1);
$('#viewer-next').onclick = () => navigateViewer(1);
$('#delete').onclick = () => removeSelected(false).catch(console.error);
$('#delete-ignore').onclick = () => removeSelected(true).catch(console.error);
$('#viewer').addEventListener('wheel', event => event.preventDefault(), { passive: false });

boot().catch(error => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${escapeHtml(error.stack || error.message)}</pre>`);
});
