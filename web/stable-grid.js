const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const commandbar = document.querySelector('.commandbar');
const rail = document.querySelector('#dateRail');
const typeSelect = document.querySelector('#typeFilter');
const sortSelect = document.querySelector('#sort');
const sourceSelect = document.querySelector('#source');
const locationSelect = document.querySelector('#locationFilter');
const collectionSelect = document.querySelector('#collectionFilter');
const searchInput = document.querySelector('#search');
const mediaSize = document.querySelector('#mediaSize');
const views = document.querySelector('#views');

const RENDER_AHEAD_SCREENS = 4.5;
const RENDER_BEHIND_SCREENS = 2;
const PREFETCH_AHEAD_SCREENS = 8;
const PREFETCH_BEHIND_SCREENS = 4;
const ROW_CACHE_LIMIT = 360;
const ROW_GAP = 4;
const SUPPORTED_SORTS = new Set(['date-desc','date-added','date-asc','size-desc']);
const SUPPORTED_TYPES = new Set(['media','image','video']);
const SUPPORTED_LOCATIONS = new Set(['','server','backup','unbacked']);

const worker = typeof Worker === 'function' ? new Worker('/grid-layout-worker.js') : null;
let library = null;
let nativeState = null;
let nativeExtend = null;
let nativeEnsureIndex = null;
let generation = 0;
let buildTimer = 0;
let active = false;
let activating = false;
let layout = null;
let plane = null;
let rowData = new Map();
let renderedRows = new Map();
let requestId = 0;
let requestWaiters = new Map();
let renderFrame = 0;
let visibleUpdateRunning = false;
let visibleUpdateQueued = false;
let railScrub = false;
let lastRailScrubAt = 0;
let reattachHash = '';
let queuedActivation = null;
let lastScrollY = scrollY;
let scrollDirection = 1;

const style = document.createElement('style');
style.textContent = `
html.stable-grid-owned #top-scroll-sentinel,html.stable-grid-owned #scroll-sentinel{display:none!important}
.files.grid.stable-grid-files{position:relative;display:block!important;min-height:0!important}
.stable-media-plane{position:relative;width:100%;contain:layout style}
.stable-grid-row{position:absolute;left:0;right:0;margin:0;padding:0;contain:layout style}
.stable-grid-row>.file-card{position:absolute!important;top:0;margin:0!important;flex:none!important}
.stable-grid-heading{position:absolute;left:2px;right:0;margin:0!important;pointer-events:none}
.stable-grid-heading.year-heading{height:31px;display:flex;align-items:center;color:#f1e9e5;font-size:19px;font-weight:760;letter-spacing:-.025em}
.stable-grid-heading.date-heading{height:27px;display:flex;align-items:flex-start;padding-top:2px;color:#cfc5c1;font-size:13px!important;font-weight:700}
.stable-media-plane>.day-group-control{position:absolute;z-index:5}
.stable-grid-files .geometry-pending{visibility:visible!important}
.stable-grid-files .media-thumb.thumb-decoding::after{display:none!important}
`;
document.head.append(style);

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const videoExtensions = new Set(['m4v','mp4','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
const isVideo = file => String(file.kind || '').toLowerCase() === 'video' || String(file.mime || '').startsWith('video/') || videoExtensions.has(extension(file.filename));

function pageTop() {
  return Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
}

function viewportHeight() {
  return Math.max(240, innerHeight - pageTop());
}

function interacting() {
  return Boolean(window.mochimonoGridInteraction?.active?.());
}

function rawState() {
  try { return nativeState?.() || library?.state?.() || null; }
  catch { return null; }
}

function currentConfig() {
  const state = rawState();
  if (!state || state.view !== 'grid' || !state.version || !files) return null;
  const type = String(typeSelect?.value || '');
  const sort = String(sortSelect?.value || state.sort || 'date-desc');
  const sourceId = Number(sourceSelect?.value) || 0;
  const locationFilter = String(locationSelect?.value || state.locationFilter || '');
  const collection = String(collectionSelect?.value || '');
  const folder = library?.folderState?.() || {};
  if (!SUPPORTED_TYPES.has(type) || !SUPPORTED_SORTS.has(sort) || !SUPPORTED_LOCATIONS.has(locationFilter)) return null;
  if (String(searchInput?.value || '').trim() || collection || folder.path) return null;
  const width = Math.round(files.clientWidth || files.getBoundingClientRect().width || 0);
  if (width < 200) return null;
  return {
    version: String(state.version),
    expectedCount: Number(state.filtered) || 0,
    type,
    sort,
    sourceId,
    locationFilter,
    width,
    target: Number(mediaSize?.value) || 170,
    gap: ROW_GAP
  };
}

function configKey(config) {
  return config ? [config.version,config.expectedCount,config.type,config.sort,config.sourceId,config.locationFilter,config.width,config.target].join('|') : '';
}

function topVisibleCard() {
  if (!files || !files.querySelector('[data-hash]')) return null;
  const top = pageTop();
  const bounds = files.getBoundingClientRect();
  const xs = [bounds.left + 8, (bounds.left + bounds.right) / 2, bounds.right - 8]
    .map(x => Math.max(1, Math.min(innerWidth - 2, x)));
  for (const y of [top + 2, top + 40, top + 80, top + 120]) {
    if (y >= innerHeight) break;
    for (const x of xs) {
      const card = document.elementFromPoint(x, y)?.closest?.('#files [data-hash]');
      if (card) return { hash: String(card.dataset.hash || ''), top: card.getBoundingClientRect().top };
    }
  }
  return null;
}

function findFirstRowFor(targetLayout, y) {
  const tops = targetLayout?.rowTops;
  const heights = targetLayout?.rowHeights;
  if (!tops?.length) return 0;
  let lo = 0;
  let hi = tops.length - 1;
  let answer = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] + heights[mid] >= y) {
      answer = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return answer;
}

function rowRangeFor(targetLayout, startY, endY) {
  if (!targetLayout?.rowTops?.length) return [];
  const first = findFirstRowFor(targetLayout, Math.max(0, startY));
  const result = [];
  for (let row = first; row < targetLayout.rowTops.length && targetLayout.rowTops[row] <= endY; row++) result.push(row);
  return result;
}

function rowsAroundRowForLayout(targetLayout, row, screens = RENDER_AHEAD_SCREENS) {
  if (!targetLayout?.rowTops?.length) return [];
  const top = targetLayout.rowTops[Math.max(0, row)] || 0;
  const height = targetLayout.rowHeights[Math.max(0, row)] || viewportHeight();
  const margin = viewportHeight() * screens;
  return rowRangeFor(targetLayout, top - margin, top + height + margin);
}

function workerRequest(type, detail = {}, targetLayout = layout) {
  if (!worker || !targetLayout) return Promise.resolve(null);
  const id = ++requestId;
  return new Promise(resolve => {
    requestWaiters.set(id, resolve);
    worker.postMessage({ type, generation:targetLayout.generation, requestId:id, ...detail });
    setTimeout(() => {
      const waiter = requestWaiters.get(id);
      if (!waiter) return;
      requestWaiters.delete(id);
      waiter(null);
    }, 2500);
  });
}

async function fetchRows(rows, targetLayout = layout, cache = rowData) {
  const wanted = [...new Set(rows)]
    .filter(row => Number.isInteger(row) && row >= 0 && row < (targetLayout?.rowTops?.length || 0));
  const missing = wanted.filter(row => !cache.has(row));
  if (missing.length) {
    const result = await workerRequest('rows', { rows:missing }, targetLayout);
    for (const item of result?.rows || []) cache.set(Number(item.row), item);
  }
  return wanted.map(row => cache.get(row)).filter(Boolean);
}

async function locate(hash, targetLayout = layout) {
  if (!hash || !targetLayout) return -1;
  const result = await workerRequest('locate', { hash }, targetLayout);
  return Number(result?.index ?? -1);
}

function cardMarkup(file, rowHeight) {
  const video = isVideo(file);
  const date = new Date(Number(file.dateMs) || 0);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const dayLabel = date.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  const sw = Number(file.sourceWidth) || 0;
  const sh = Number(file.sourceHeight) || 0;
  const fallbackWidth = Math.max(1, Number(file.width) || rowHeight * 4 / 3);
  const fallbackHeight = Math.max(1, Number(rowHeight) || 1);
  const dataWidth = sw || fallbackWidth;
  const dataHeight = sh || fallbackHeight;
  const ratio = Math.max(.65, Math.min(2.1, dataWidth / dataHeight));
  return `<button class="file-card media-card ${video ? 'video-card' : ''}" data-hash="${escapeHtml(file.hash)}" data-filename="${escapeHtml(file.filename)}" data-day="${day}" data-day-label="${escapeHtml(dayLabel)}" data-width="${Number(dataWidth).toFixed(2)}" data-height="${Number(dataHeight).toFixed(2)}" style="left:${Number(file.x).toFixed(2)}px;width:${Number(file.width).toFixed(2)}px;height:${Number(rowHeight).toFixed(2)}px;flex-basis:${Number(file.width).toFixed(2)}px;--ratio:${ratio}" title="${escapeHtml(file.filename)}"><div class="thumb media-thumb"><span class="video-thumb-pending" data-video-thumb="${escapeHtml(file.hash)}"></span>${video ? '<span class="play-badge">▶</span>' : ''}</div></button>`;
}

function createRow(data) {
  const row = document.createElement('div');
  row.className = 'stable-grid-row';
  row.dataset.stableRow = String(data.row);
  row.style.top = `${Number(data.top).toFixed(2)}px`;
  row.style.height = `${Number(data.height).toFixed(2)}px`;
  row.innerHTML = data.items.map(item => cardMarkup(item, data.height)).join('');
  return row;
}

function renderRows(data) {
  if (!plane || !data?.length) return;
  const fragment = document.createDocumentFragment();
  for (const item of data) {
    if (!item || renderedRows.has(item.row)) continue;
    const row = createRow(item);
    renderedRows.set(item.row, row);
    fragment.append(row);
  }
  if (fragment.childNodes.length) plane.append(fragment);
}

function renderRow(data) {
  renderRows(data ? [data] : []);
}

function renderHeaders() {
  if (!plane || !layout) return;
  const fragment = document.createDocumentFragment();
  for (const header of layout.headers || []) {
    const element = document.createElement(header.kind === 'year' ? 'h2' : 'h3');
    element.className = `stable-grid-heading ${header.kind === 'year' ? 'year-heading' : 'date-heading'}`;
    element.style.top = `${Number(header.top).toFixed(2)}px`;
    element.textContent = header.kind === 'year'
      ? String(header.year)
      : new Date(Number(header.year), Number(header.month), 1).toLocaleDateString(undefined, { month:'long' });
    fragment.append(element);
  }
  plane.append(fragment);
}

function syncDayButtons(startY, endY) {
  if (!plane || !layout) return;
  const wanted = new Set();
  for (const day of layout.dayStarts || []) {
    if (day.top < startY - 30 || day.top > endY + 30) continue;
    const key = `${day.year}-${String(day.month + 1).padStart(2,'0')}-${String(day.day).padStart(2,'0')}`;
    wanted.add(key);
    let button = plane.querySelector(`:scope > .day-group-control[data-period-key="${CSS.escape(key)}"]`);
    if (!button) {
      const date = new Date(Number(day.year), Number(day.month), Number(day.day));
      const label = date.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'timeline-group-select day-group-control';
      button.dataset.selectPeriod = 'day';
      button.dataset.periodKey = key;
      button.dataset.periodLabel = label;
      button.setAttribute('aria-label', `Select ${label}`);
      button.innerHTML = `<span class="timeline-check" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
      plane.append(button);
    }
    button.style.left = `${Number(day.x).toFixed(2)}px`;
    button.style.top = `${(Number(day.top) - 19).toFixed(2)}px`;
  }
  for (const button of plane.querySelectorAll(':scope > .day-group-control[data-period-key]')) {
    if (!wanted.has(button.dataset.periodKey || '')) button.remove();
  }
}

function planeDocumentTop() {
  return files.getBoundingClientRect().top + scrollY;
}

function localViewportTop() {
  return scrollY + pageTop() - planeDocumentTop();
}

function localRange(aheadScreens, behindScreens) {
  const top = localViewportTop();
  const height = viewportHeight();
  const ahead = height * aheadScreens;
  const behind = height * behindScreens;
  const start = scrollDirection >= 0 ? top - behind : top - ahead;
  const end = scrollDirection >= 0 ? top + height + ahead : top + height + behind;
  return {
    start: Math.max(0, start),
    end: Math.min(layout?.totalHeight || 0, end)
  };
}

function visibleWindow() {
  const range = localRange(RENDER_AHEAD_SCREENS, RENDER_BEHIND_SCREENS);
  return { range, rows:rowRangeFor(layout, range.start, range.end) };
}

function prefetchWindow() {
  const range = localRange(PREFETCH_AHEAD_SCREENS, PREFETCH_BEHIND_SCREENS);
  return { range, rows:rowRangeFor(layout, range.start, range.end) };
}

function renderCachedRows(rows) {
  const data = [];
  for (const row of rows) {
    const item = rowData.get(row);
    if (item && !renderedRows.has(row)) data.push(item);
  }
  renderRows(data);
}

function pruneRenderedRows(wanted) {
  for (const [row, element] of renderedRows) {
    if (wanted.has(row)) continue;
    element.remove();
    renderedRows.delete(row);
  }
}

function trimRowCache(keep) {
  if (rowData.size <= ROW_CACHE_LIMIT) return;
  for (const row of [...rowData.keys()]) {
    if (rowData.size <= ROW_CACHE_LIMIT) break;
    if (keep.has(row)) continue;
    rowData.delete(row);
  }
}

async function updateVisibleRows() {
  renderFrame = 0;
  if (!active || !plane?.isConnected || !layout) return;
  if (visibleUpdateRunning) {
    visibleUpdateQueued = true;
    return;
  }

  visibleUpdateRunning = true;
  try {
    do {
      visibleUpdateQueued = false;
      if (!active || !plane?.isConnected || !layout) break;

      // First paint anything already cached. Scrolling never waits for the worker.
      const firstVisible = visibleWindow();
      renderCachedRows(firstVisible.rows);

      // Fetch a much larger directional guard band into lightweight JS memory.
      // Only the smaller visible guard band is mounted in the DOM.
      const prefetch = prefetchWindow();
      await fetchRows(prefetch.rows);
      if (!active || !plane?.isConnected || !layout) break;

      // The user may have moved while that request was in flight. Always render
      // the latest viewport instead of throwing the response away.
      const latest = visibleWindow();
      const latestWanted = new Set(latest.rows);
      renderCachedRows(latest.rows);
      pruneRenderedRows(latestWanted);
      syncDayButtons(latest.range.start, latest.range.end);
      trimRowCache(new Set(prefetchWindow().rows));

      // If a scroll happened while awaiting rows, loop once with the newest
      // position. This serializes worker traffic instead of creating one request
      // per high-refresh-rate scroll frame.
    } while (visibleUpdateQueued);
  } finally {
    visibleUpdateRunning = false;
    if (visibleUpdateQueued) scheduleVisibleRows();
  }
}

function scheduleVisibleRows() {
  if (visibleUpdateRunning) {
    visibleUpdateQueued = true;
    return;
  }
  if (!renderFrame) renderFrame = requestAnimationFrame(updateVisibleRows);
}

function installPlane(initialRows) {
  const nextPlane = document.createElement('div');
  nextPlane.className = 'stable-media-plane';
  nextPlane.style.height = `${Math.ceil(layout.totalHeight)}px`;
  files.className = 'files grid stable-grid-files';
  files.replaceChildren(nextPlane);
  plane = nextPlane;
  renderedRows.clear();
  document.documentElement.classList.add('stable-grid-owned');
  const topSentinel = document.querySelector('#top-scroll-sentinel');
  const bottomSentinel = document.querySelector('#scroll-sentinel');
  if (topSentinel) topSentinel.hidden = true;
  if (bottomSentinel) bottomSentinel.hidden = true;
  renderHeaders();
  renderRows(initialRows);
  active = true;
}

async function activate(nextLayout, preferredHash = '') {
  if (!nextLayout) return;
  if (activating) {
    queuedActivation = { layout:nextLayout, hash:preferredHash };
    return;
  }
  if (interacting()) {
    queuedActivation = { layout:nextLayout, hash:preferredHash };
    setTimeout(runQueuedActivation, 160);
    return;
  }

  const config = currentConfig();
  const state = rawState();
  if (!config || !state || nextLayout.version !== config.version || nextLayout.count !== state.filtered || nextLayout.key !== configKey(config)) return;

  activating = true;
  const anchor = preferredHash ? { hash:preferredHash, top:pageTop() + 2 } : topVisibleCard();
  const anchorIndex = anchor?.hash ? await locate(anchor.hash, nextLayout) : -1;
  const nextRowData = nextLayout === layout ? rowData : new Map();
  const localTop = Math.max(0, scrollY + pageTop() - (files.getBoundingClientRect().top + scrollY));
  const fallbackRow = Math.max(0, Math.min(nextLayout.rowTops.length - 1, findFirstRowFor(nextLayout, localTop)));
  const anchorRow = anchorIndex >= 0 ? Number(nextLayout.itemRows[anchorIndex]) : fallbackRow;
  const rows = [...new Set([
    ...rowsAroundRowForLayout(nextLayout, anchorRow, RENDER_AHEAD_SCREENS),
    0,
    Math.max(0, nextLayout.rowTops.length - 1)
  ])];
  const initialRows = await fetchRows(rows, nextLayout, nextRowData);

  const latest = currentConfig();
  if (!latest || nextLayout.key !== configKey(latest)) {
    activating = false;
    runQueuedActivation();
    return;
  }
  if (interacting()) {
    activating = false;
    queuedActivation = { layout:nextLayout, hash:preferredHash };
    setTimeout(runQueuedActivation, 160);
    return;
  }

  const oldFilesTop = files.getBoundingClientRect().top + scrollY;
  layout = nextLayout;
  rowData = nextRowData;
  installPlane(initialRows);
  const newFilesTop = files.getBoundingClientRect().top + scrollY;

  if (anchorIndex >= 0 && anchor?.top != null) {
    const row = Number(layout.itemRows[anchorIndex]);
    const target = newFilesTop + Number(layout.rowTops[row] || 0) - anchor.top;
    scrollTo({ top:Math.max(0, target), left:0, behavior:'auto' });
  } else if (Math.abs(newFilesTop - oldFilesTop) > .5) {
    scrollBy({ top:newFilesTop - oldFilesTop, left:0, behavior:'auto' });
  }

  activating = false;
  scheduleVisibleRows();
  runQueuedActivation();
}

function runQueuedActivation() {
  if (activating) return;
  const next = queuedActivation;
  queuedActivation = null;
  if (next) queueMicrotask(() => activate(next.layout, next.hash));
}

function deactivate() {
  active = false;
  activating = false;
  plane = null;
  renderedRows.clear();
  visibleUpdateQueued = false;
  document.documentElement.classList.remove('stable-grid-owned');
}

function persistLearned(items) {
  if (!items?.length) return;
  let offset = 0;
  const run = () => {
    const end = Math.min(items.length, offset + 250);
    for (; offset < end; offset++) {
      const [hash, width, height] = items[offset];
      try { window.mochimonoCatalogCache?.rememberDimensions?.(hash, width, height); } catch {}
    }
    if (offset >= items.length) return;
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout:500 });
    else setTimeout(run, 0);
  };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout:500 });
  else setTimeout(run, 0);
}

function scheduleBuild(delay = 80) {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(build, delay);
}

function build() {
  buildTimer = 0;
  if (!worker || !library) return;

  // Catalog/index churn is allowed to continue in the background, but rebuilding
  // the whole grid competes with row delivery. Keep the current fixed plane solid
  // until scrolling/keyboard interaction has actually stopped.
  if (interacting()) {
    scheduleBuild(180);
    return;
  }

  const config = currentConfig();
  if (!config || !config.expectedCount) {
    deactivate();
    return;
  }
  const nextGeneration = ++generation;
  worker.postMessage({ type:'build', generation:nextGeneration, config });
}

function rowForIndex(index) {
  if (!layout || !Number.isInteger(index) || index < 0 || index >= layout.itemRows.length) return -1;
  return Number(layout.itemRows[index]);
}

function materializeCachedRow(row) {
  if (!active || row < 0) return false;
  const data = rowData.get(row);
  if (!data) return false;
  renderRow(data);
  return true;
}

async function scrollToIndex(index, block = 'center') {
  if (!active || !layout) return false;
  const row = rowForIndex(index);
  if (row < 0) return false;
  await fetchRows([row]);
  if (!active) return false;
  materializeCachedRow(row);
  const top = planeDocumentTop() + Number(layout.rowTops[row] || 0);
  const height = Number(layout.rowHeights[row] || 0);
  let target = top - pageTop();
  if (block === 'center') target -= Math.max(0, (viewportHeight() - height) / 2);
  else if (block === 'end') target -= Math.max(0, viewportHeight() - height);
  scrollTo({ top:Math.max(0, target), left:0, behavior:'auto' });
  scheduleVisibleRows();
  return true;
}

function ensureIndex(index) {
  if (!active || !layout) return false;
  const row = rowForIndex(Number(index));
  if (row < 0) return false;
  if (!materializeCachedRow(row)) fetchRows([row]).then(() => materializeCachedRow(row));
  return true;
}

function updateRailThumb(index) {
  const state = rawState();
  const thumb = document.querySelector('#railThumb');
  if (!thumb || !state?.filtered) return;
  const safe = Math.max(0, Math.min(state.filtered - 1, Number(index) || 0));
  thumb.style.top = `${(state.filtered === 1 ? 0 : safe / (state.filtered - 1)) * 100}%`;
  const ticks = [...rail.querySelectorAll('[data-index]')];
  let nearest = null;
  let distance = Infinity;
  for (const tick of ticks) {
    const next = Math.abs(Number(tick.dataset.index) - safe);
    if (next < distance) {
      distance = next;
      nearest = tick;
    }
  }
  const label = nearest?.getAttribute('title') || nearest?.textContent?.trim() || '';
  const span = thumb.querySelector('span');
  if (span && label) span.textContent = label;
}

function railIndex(event) {
  const state = rawState();
  if (!rail || !state?.filtered) return 0;
  const rect = rail.getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) * (state.filtered - 1));
}

function handleRailPointer(event, final = false) {
  const index = railIndex(event);
  updateRailThumb(index);
  const now = performance.now();
  if (final || now - lastRailScrubAt > 55) {
    lastRailScrubAt = now;
    scrollToIndex(index, 'center');
  }
}

function installRailInterception() {
  if (!rail) return;
  rail.addEventListener('pointerdown', event => {
    if (!active || rail.hidden) return;
    railScrub = true;
    try { rail.setPointerCapture(event.pointerId); } catch {}
    rail.classList.add('dragging');
    handleRailPointer(event);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  rail.addEventListener('pointermove', event => {
    if (!active || !railScrub) return;
    handleRailPointer(event);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  rail.addEventListener('pointerup', event => {
    if (!active || !railScrub) return;
    railScrub = false;
    rail.classList.remove('dragging');
    handleRailPointer(event, true);
    try { rail.releasePointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  rail.addEventListener('pointercancel', event => {
    if (!active || !railScrub) return;
    railScrub = false;
    rail.classList.remove('dragging');
    event.stopImmediatePropagation();
  }, true);

  rail.addEventListener('click', event => {
    if (!active) return;
    const tick = event.target.closest('[data-index]');
    if (!tick) return;
    scrollToIndex(Number(tick.dataset.index), 'center');
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function installLibrary() {
  library = window.mochimonoLibrary;
  if (!library) {
    requestAnimationFrame(installLibrary);
    return;
  }
  nativeState = library.state.bind(library);
  nativeExtend = library.extend.bind(library);
  nativeEnsureIndex = library.ensureIndex.bind(library);
  library.state = () => {
    const state = nativeState();
    return active ? { ...state, offset:0, loaded:state.filtered, hasMore:false, hasPrevious:false, stableGrid:true } : state;
  };
  library.extend = direction => active ? false : nativeExtend(direction);
  library.ensureIndex = index => active ? ensureIndex(Number(index)) : nativeEnsureIndex(index);
  installRailInterception();
  scheduleBuild(0);
}

worker?.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'rows' || message.type === 'located') {
    const resolve = requestWaiters.get(Number(message.requestId));
    if (resolve) {
      requestWaiters.delete(Number(message.requestId));
      resolve(message);
    }
    return;
  }

  if (Number(message.generation) !== generation) return;
  if (message.type === 'unavailable' || message.type === 'error') {
    scheduleBuild(500);
    return;
  }
  if (message.type !== 'ready') return;

  const config = currentConfig();
  const state = rawState();
  if (!config || !state || message.version !== config.version || Number(message.count) !== Number(state.filtered)) return;

  const nextLayout = {
    generation:Number(message.generation),
    key:configKey(config),
    config,
    version:String(message.version),
    count:Number(message.count),
    unresolved:Number(message.unresolved) || 0,
    totalHeight:Number(message.totalHeight) || 1,
    rowStarts:message.rowStarts,
    rowCounts:message.rowCounts,
    rowTops:message.rowTops,
    rowHeights:message.rowHeights,
    itemRows:message.itemRows,
    headers:message.headers || [],
    dayStarts:message.dayStarts || []
  };

  persistLearned(message.learned || []);
  const preferred = reattachHash;
  reattachHash = '';
  activate(nextLayout, preferred);
});

for (const control of [typeSelect,sortSelect,sourceSelect,locationSelect,collectionSelect]) {
  control?.addEventListener('change', () => {
    if (active) deactivate();
    setTimeout(() => scheduleBuild(20), 0);
  }, true);
}

searchInput?.addEventListener('input', () => {
  if (active) deactivate();
  scheduleBuild(100);
}, true);

views?.addEventListener('click', () => {
  if (active) deactivate();
  setTimeout(() => scheduleBuild(20), 0);
}, true);

window.addEventListener('mochimono:media-size', () => scheduleBuild(60));
window.addEventListener('mochimono:catalog-updated', () => scheduleBuild(240));
window.addEventListener('mochimono:catalog-cache-restored', () => scheduleBuild(30));
window.addEventListener('mochimono:folder-changed', () => scheduleBuild(60));
window.addEventListener('mochimono:grid-interaction-end', () => {
  if (queuedActivation) runQueuedActivation();
  if (buildTimer) scheduleBuild(30);
});

window.addEventListener('scroll', () => {
  const y = scrollY;
  if (Math.abs(y - lastScrollY) > 1) scrollDirection = y > lastScrollY ? 1 : -1;
  lastScrollY = y;
  scheduleVisibleRows();
}, { passive:true });

window.addEventListener('resize', () => scheduleBuild(160), { passive:true });

new MutationObserver(() => {
  if (active && plane && !plane.isConnected) {
    const hash = topVisibleCard()?.hash || reattachHash;
    deactivate();
    reattachHash = hash || '';
    const config = currentConfig();
    if (layout && config && layout.key === configKey(config)) activate(layout, reattachHash);
    else scheduleBuild(20);
  }
}).observe(files, { childList:true });

if (viewer && viewerOpen) {
  new MutationObserver(() => {
    if (!viewer.hidden) return;
    const hash = viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
    if (hash) reattachHash = hash;
    const config = currentConfig();
    if (!active && layout && config && layout.key === configKey(config)) activate(layout, hash);
  }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
}

window.mochimonoStableGrid = {
  active:() => active,
  state:() => ({
    active,
    activating,
    generation,
    rows:layout?.rowTops?.length || 0,
    rendered:renderedRows.size,
    cached:rowData.size,
    unresolved:layout?.unresolved || 0,
    fetching:visibleUpdateRunning
  }),
  ensureIndex,
  scrollToIndex
};

installLibrary();