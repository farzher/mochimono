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
const folderbar = document.querySelector('#folderbar');
const folderStrip = document.querySelector('#gridFolderStrip');

const RENDER_AHEAD_SCREENS = 4.5;
const RENDER_BEHIND_SCREENS = 3;
const PREFETCH_AHEAD_SCREENS = 10;
const PREFETCH_BEHIND_SCREENS = 6;
const ROW_CACHE_LIMIT = 520;
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
let owned = false;
let activating = false;
let layout = null;
let plane = null;
let rowLayer = null;
let dayLayer = null;
let rowData = new Map();
let renderedRows = new Map();
let requestId = 0;
let requestWaiters = new Map();
let renderFrame = 0;
let visibleUpdateRunning = false;
let visibleUpdateQueued = false;
let queuedLayout = null;
let railScrub = false;
let lastRailScrubAt = 0;
let lastScrollY = scrollY;
let lastScrollAt = 0;
let scrollDirection = 1;
let filesDocumentTop = 0;
let viewportTop = 0;
let viewportPixels = Math.max(240, innerHeight);

const style = document.createElement('style');
style.textContent = `
html.stable-grid-owned #top-scroll-sentinel,html.stable-grid-owned #scroll-sentinel{display:none!important}
html.stable-grid-owned #files{position:relative!important;display:block!important;min-height:0!important;overflow:visible!important}
html.stable-grid-owned #files>:not(.stable-media-plane){display:none!important}
.files.stable-grid-files{display:block!important}
.stable-media-plane{position:absolute;left:0;right:0;top:0;height:100%;contain:layout style}
.stable-grid-rows,.stable-grid-headings,.stable-grid-days{position:absolute;inset:0;pointer-events:none}
.stable-grid-row{position:absolute;left:0;right:0;margin:0;padding:0;overflow:hidden;contain:layout paint style;pointer-events:auto}
.stable-grid-row>.file-card{position:absolute!important;top:0!important;margin:0!important;min-width:0!important;max-width:none!important;flex:none!important}
.stable-grid-row>.file-card.media-card{border-radius:3px}
.stable-grid-heading{position:absolute;left:2px;right:0;margin:0!important;pointer-events:none}
.stable-grid-heading.year-heading{height:31px;display:flex;align-items:center;color:#f1e9e5;font-size:19px;font-weight:760;letter-spacing:-.025em}
.stable-grid-heading.date-heading{height:27px;display:flex;align-items:flex-start;padding-top:2px;color:#cfc5c1;font-size:13px!important;font-weight:700}
.stable-grid-days>.day-group-control{position:absolute;z-index:5;pointer-events:auto}
.stable-grid-files .geometry-pending{visibility:visible!important}
.stable-grid-files .media-thumb.thumb-decoding::after{display:none!important}
`;
document.head.append(style);

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const extension = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
const videoExtensions = new Set(['m4v','mp4','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
const isVideo = file => String(file.kind || '').toLowerCase() === 'video' || String(file.mime || '').startsWith('video/') || videoExtensions.has(extension(file.filename));

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
    version:String(state.version),
    expectedCount:Number(state.filtered) || 0,
    type,
    sort,
    sourceId,
    locationFilter,
    width,
    target:Number(mediaSize?.value) || 170,
    gap:ROW_GAP
  };
}

function geometryKey(config) {
  return config
    ? [config.expectedCount,config.type,config.sort,config.sourceId,config.locationFilter,config.width,config.target].join('|')
    : '';
}

function interactionActive() {
  return Boolean(window.mochimonoGridInteraction?.active?.()) || performance.now() - lastScrollAt < 220;
}

function measureViewport() {
  viewportTop = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  viewportPixels = Math.max(240, innerHeight - viewportTop);
  filesDocumentTop = files ? files.getBoundingClientRect().top + scrollY : 0;
}

function localViewportY() {
  return Math.max(0, scrollY + viewportTop - filesDocumentTop);
}

function findFirstRow(targetLayout, y) {
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

function rowRange(targetLayout, startY, endY) {
  if (!targetLayout?.rowTops?.length) return [];
  const first = findFirstRow(targetLayout, Math.max(0, startY));
  const result = [];
  for (let row = first; row < targetLayout.rowTops.length && targetLayout.rowTops[row] <= endY; row++) result.push(row);
  return result;
}

function windowRows(targetLayout, aheadScreens, behindScreens) {
  const top = localViewportY();
  const ahead = viewportPixels * aheadScreens;
  const behind = viewportPixels * behindScreens;
  const start = scrollDirection >= 0 ? top - behind : top - ahead;
  const end = scrollDirection >= 0 ? top + viewportPixels + ahead : top + viewportPixels + behind;
  const range = {
    start:Math.max(0, start),
    end:Math.min(targetLayout?.totalHeight || 0, end)
  };
  return { range, rows:rowRange(targetLayout, range.start, range.end) };
}

function workerRequest(type, detail = {}, targetLayout = layout) {
  if (!worker || !targetLayout) return Promise.resolve(null);
  const id = ++requestId;
  return new Promise(resolve => {
    requestWaiters.set(id, { resolve, generation:targetLayout.generation });
    worker.postMessage({ type, generation:targetLayout.generation, requestId:id, ...detail });
    setTimeout(() => {
      const pending = requestWaiters.get(id);
      if (!pending) return;
      requestWaiters.delete(id);
      pending.resolve(null);
    }, 1800);
  });
}

async function fetchRows(rows, targetLayout = layout, cache = rowData) {
  const wanted = [...new Set(rows)].filter(row => Number.isInteger(row) && row >= 0 && row < (targetLayout?.rowTops?.length || 0));
  const missing = wanted.filter(row => !cache.has(row));
  if (missing.length) {
    const result = await workerRequest('rows', { rows:missing }, targetLayout);
    if (Number(result?.generation) === Number(targetLayout?.generation)) {
      for (const item of result?.rows || []) cache.set(Number(item.row), item);
    }
  }
  return wanted.map(row => cache.get(row)).filter(Boolean);
}

function cardMarkup(file, rowHeight) {
  const video = isVideo(file);
  const date = new Date(Number(file.dateMs) || 0);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const dayLabel = date.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
  const sourceWidth = Number(file.sourceWidth) || 0;
  const sourceHeight = Number(file.sourceHeight) || 0;
  const dataWidth = sourceWidth || Math.max(1, Number(file.width) || rowHeight * 4 / 3);
  const dataHeight = sourceHeight || Math.max(1, rowHeight);
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

function insertRow(row, id) {
  if (!rowLayer) return;
  for (const sibling of rowLayer.children) {
    const nextId = Number(sibling.dataset.stableRow);
    if (Number.isInteger(nextId) && nextId > id) {
      rowLayer.insertBefore(row, sibling);
      return;
    }
  }
  rowLayer.append(row);
}

function renderRows(data) {
  if (!rowLayer || !data?.length) return;
  for (const item of [...data].sort((a, b) => Number(a.row) - Number(b.row))) {
    const id = Number(item.row);
    if (!item || renderedRows.has(id)) continue;
    const row = createRow(item);
    renderedRows.set(id, row);
    insertRow(row, id);
  }
}

function pruneRows(wanted) {
  for (const [row, element] of renderedRows) {
    if (wanted.has(row)) continue;
    element.remove();
    renderedRows.delete(row);
  }
}

function trimCache(keep) {
  if (rowData.size <= ROW_CACHE_LIMIT) return;
  for (const row of [...rowData.keys()]) {
    if (rowData.size <= ROW_CACHE_LIMIT) break;
    if (!keep.has(row)) rowData.delete(row);
  }
}

function headerLayerFor(targetLayout) {
  const layer = document.createElement('div');
  layer.className = 'stable-grid-headings';
  const fragment = document.createDocumentFragment();
  for (const header of targetLayout.headers || []) {
    const element = document.createElement(header.kind === 'year' ? 'h2' : 'h3');
    element.className = `stable-grid-heading ${header.kind === 'year' ? 'year-heading' : 'date-heading'}`;
    element.style.top = `${Number(header.top).toFixed(2)}px`;
    element.textContent = header.kind === 'year'
      ? String(header.year)
      : new Date(Number(header.year), Number(header.month), 1).toLocaleDateString(undefined, { month:'long' });
    fragment.append(element);
  }
  layer.append(fragment);
  return layer;
}

function syncDayButtons(startY, endY) {
  if (!dayLayer || !layout) return;
  const wanted = new Set();
  for (const day of layout.dayStarts || []) {
    if (day.top < startY - 30 || day.top > endY + 30) continue;
    const key = `${day.year}-${String(day.month + 1).padStart(2,'0')}-${String(day.day).padStart(2,'0')}`;
    wanted.add(key);
    let button = dayLayer.querySelector(`[data-period-key="${CSS.escape(key)}"]`);
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
      dayLayer.append(button);
    }
    button.style.left = `${Number(day.x).toFixed(2)}px`;
    button.style.top = `${(Number(day.top) - 19).toFixed(2)}px`;
  }
  for (const button of dayLayer.querySelectorAll('[data-period-key]')) {
    if (!wanted.has(button.dataset.periodKey || '')) button.remove();
  }
}

function makePlane(targetLayout, initialRows) {
  const nextPlane = document.createElement('div');
  nextPlane.className = 'stable-media-plane';
  const nextRows = document.createElement('div');
  nextRows.className = 'stable-grid-rows';
  const nextDays = document.createElement('div');
  nextDays.className = 'stable-grid-days';
  nextPlane.append(nextRows, headerLayerFor(targetLayout), nextDays);

  const previousRowLayer = rowLayer;
  const previousRendered = renderedRows;
  rowLayer = nextRows;
  renderedRows = new Map();
  renderRows(initialRows);
  const nextRendered = renderedRows;
  rowLayer = previousRowLayer;
  renderedRows = previousRendered;
  return { plane:nextPlane, rowLayer:nextRows, dayLayer:nextDays, renderedRows:nextRendered };
}

function ensurePlaneConnected() {
  if (!owned || !plane || plane.isConnected || !files) return;
  files.className = 'files grid stable-grid-files';
  files.style.height = `${Math.ceil(layout?.totalHeight || 1)}px`;
  files.replaceChildren(plane);
  measureViewport();
}

function updateRailFromScroll() {
  if (!layout?.rowStarts?.length || !rail || rail.hidden) return;
  const state = rawState();
  const thumb = document.querySelector('#railThumb');
  if (!state?.filtered || !thumb) return;
  const row = findFirstRow(layout, localViewportY());
  const index = Number(layout.rowStarts[Math.max(0, row)]) || 0;
  const safe = Math.max(0, Math.min(state.filtered - 1, index));
  thumb.style.top = `${(state.filtered === 1 ? 0 : safe / (state.filtered - 1)) * 100}%`;
}

async function updateVisibleRows() {
  renderFrame = 0;
  if (!owned || !plane?.isConnected || !layout) return;
  if (visibleUpdateRunning) {
    visibleUpdateQueued = true;
    return;
  }

  visibleUpdateRunning = true;
  try {
    do {
      visibleUpdateQueued = false;
      if (!owned || !plane?.isConnected || !layout) break;

      const visible = windowRows(layout, RENDER_AHEAD_SCREENS, RENDER_BEHIND_SCREENS);
      renderRows(visible.rows.map(row => rowData.get(row)).filter(Boolean));
      updateRailFromScroll();

      const prefetch = windowRows(layout, PREFETCH_AHEAD_SCREENS, PREFETCH_BEHIND_SCREENS);
      await fetchRows(prefetch.rows);
      if (!owned || !plane?.isConnected || !layout) break;

      const latest = windowRows(layout, RENDER_AHEAD_SCREENS, RENDER_BEHIND_SCREENS);
      const wanted = new Set(latest.rows);
      renderRows(latest.rows.map(row => rowData.get(row)).filter(Boolean));
      pruneRows(wanted);
      syncDayButtons(latest.range.start, latest.range.end);
      trimCache(new Set(windowRows(layout, PREFETCH_AHEAD_SCREENS, PREFETCH_BEHIND_SCREENS).rows));
      updateRailFromScroll();
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

async function activate(nextLayout) {
  if (!nextLayout || activating) {
    if (nextLayout) queuedLayout = nextLayout;
    return;
  }
  if (interactionActive()) {
    queuedLayout = nextLayout;
    setTimeout(runQueuedLayout, 260);
    return;
  }

  const config = currentConfig();
  if (!config || nextLayout.key !== geometryKey(config) || nextLayout.count !== config.expectedCount) return;
  activating = true;
  measureViewport();

  const localTop = localViewportY();
  const anchorRow = Math.max(0, Math.min(nextLayout.rowTops.length - 1, findFirstRow(nextLayout, localTop)));
  const margin = viewportPixels * RENDER_AHEAD_SCREENS;
  const initialIds = rowRange(nextLayout, Math.max(0, Number(nextLayout.rowTops[anchorRow] || 0) - margin), Number(nextLayout.rowTops[anchorRow] || 0) + viewportPixels + margin);
  const nextCache = new Map();
  const initialRows = await fetchRows(initialIds, nextLayout, nextCache);

  const latest = currentConfig();
  if (!latest || nextLayout.key !== geometryKey(latest) || nextLayout.count !== latest.expectedCount) {
    activating = false;
    runQueuedLayout();
    return;
  }
  if (interactionActive()) {
    activating = false;
    queuedLayout = nextLayout;
    setTimeout(runQueuedLayout, 260);
    return;
  }

  const built = makePlane(nextLayout, initialRows);
  layout = nextLayout;
  rowData = nextCache;
  plane = built.plane;
  rowLayer = built.rowLayer;
  dayLayer = built.dayLayer;
  renderedRows = built.renderedRows;
  owned = true;
  document.documentElement.classList.add('stable-grid-owned');
  files.className = 'files grid stable-grid-files';
  files.style.height = `${Math.ceil(layout.totalHeight)}px`;
  files.replaceChildren(plane);
  const topSentinel = document.querySelector('#top-scroll-sentinel');
  const bottomSentinel = document.querySelector('#scroll-sentinel');
  if (topSentinel) topSentinel.hidden = true;
  if (bottomSentinel) bottomSentinel.hidden = true;
  measureViewport();
  activating = false;
  scheduleVisibleRows();
  runQueuedLayout();
}

function runQueuedLayout() {
  if (activating || interactionActive()) {
    if (queuedLayout) setTimeout(runQueuedLayout, 260);
    return;
  }
  const next = queuedLayout;
  queuedLayout = null;
  if (next) activate(next);
}

function release() {
  owned = false;
  activating = false;
  queuedLayout = null;
  visibleUpdateQueued = false;
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  document.documentElement.classList.remove('stable-grid-owned');
  files?.style.removeProperty('height');
  files?.classList.remove('stable-grid-files');
  if (plane?.isConnected) plane.remove();
  plane = null;
  rowLayer = null;
  dayLayer = null;
  renderedRows.clear();
}

function scheduleBuild(delay = 120) {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(build, delay);
}

function build() {
  buildTimer = 0;
  if (!worker || !library) return;
  const config = currentConfig();
  if (!config || !config.expectedCount) {
    if (owned) release();
    return;
  }

  // Geometry is immutable for the life of a layout. Metadata/thumbnail updates
  // with the same item count never get to move rows underneath the user.
  const key = geometryKey(config);
  if (owned && layout?.key === key) {
    ensurePlaneConnected();
    return;
  }

  if (interactionActive()) {
    scheduleBuild(320);
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
  if (!owned || row < 0) return false;
  const data = rowData.get(row);
  if (!data) return false;
  renderRows([data]);
  return true;
}

function ensureIndex(index) {
  if (!owned || !layout) return false;
  const row = rowForIndex(Number(index));
  if (row < 0) return false;
  if (!materializeCachedRow(row)) fetchRows([row]).then(() => materializeCachedRow(row));
  return true;
}

async function scrollToIndex(index, block = 'center') {
  if (!owned || !layout) return false;
  const row = rowForIndex(Number(index));
  if (row < 0) return false;
  await fetchRows([row]);
  if (!owned) return false;
  materializeCachedRow(row);
  const top = filesDocumentTop + Number(layout.rowTops[row] || 0);
  const height = Number(layout.rowHeights[row] || 0);
  let target = top - viewportTop;
  if (block === 'center') target -= Math.max(0, (viewportPixels - height) / 2);
  else if (block === 'end') target -= Math.max(0, viewportPixels - height);
  scrollTo({ top:Math.max(0, target), left:0, behavior:'auto' });
  scheduleVisibleRows();
  return true;
}

function railIndex(event) {
  const state = rawState();
  if (!rail || !state?.filtered) return 0;
  const rect = rail.getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) * (state.filtered - 1));
}

function setRailThumb(index) {
  const state = rawState();
  const thumb = document.querySelector('#railThumb');
  if (!thumb || !state?.filtered) return;
  const safe = Math.max(0, Math.min(state.filtered - 1, Number(index) || 0));
  thumb.style.top = `${(state.filtered === 1 ? 0 : safe / (state.filtered - 1)) * 100}%`;
}

function handleRailPointer(event, final = false) {
  const index = railIndex(event);
  setRailThumb(index);
  const now = performance.now();
  if (final || now - lastRailScrubAt > 55) {
    lastRailScrubAt = now;
    scrollToIndex(index, 'center');
  }
}

function installRail() {
  if (!rail) return;
  rail.addEventListener('pointerdown', event => {
    if (!owned || rail.hidden) return;
    railScrub = true;
    try { rail.setPointerCapture(event.pointerId); } catch {}
    rail.classList.add('dragging');
    handleRailPointer(event);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  rail.addEventListener('pointermove', event => {
    if (!owned || !railScrub) return;
    handleRailPointer(event);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  rail.addEventListener('pointerup', event => {
    if (!owned || !railScrub) return;
    railScrub = false;
    rail.classList.remove('dragging');
    handleRailPointer(event, true);
    try { rail.releasePointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  rail.addEventListener('pointercancel', () => {
    railScrub = false;
    rail.classList.remove('dragging');
  }, true);
  rail.addEventListener('click', event => {
    if (!owned) return;
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
  if (nativeState) return;
  nativeState = library.state.bind(library);
  nativeExtend = library.extend.bind(library);
  nativeEnsureIndex = library.ensureIndex.bind(library);
  library.state = () => {
    const state = nativeState();
    return owned ? { ...state, offset:0, loaded:state.filtered, hasMore:false, hasPrevious:false, stableGrid:true } : state;
  };
  library.extend = direction => owned ? false : nativeExtend(direction);
  library.ensureIndex = index => owned ? ensureIndex(Number(index)) : nativeEnsureIndex(index);
  installRail();
  scheduleBuild(0);
}

worker?.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'rows' || message.type === 'located') {
    const pending = requestWaiters.get(Number(message.requestId));
    if (pending) {
      requestWaiters.delete(Number(message.requestId));
      pending.resolve(message);
    }
    return;
  }
  if (Number(message.generation) !== generation) return;
  if (message.type === 'unavailable' || message.type === 'error') {
    scheduleBuild(450);
    return;
  }
  if (message.type !== 'ready') return;

  const config = currentConfig();
  if (!config || Number(message.count) !== config.expectedCount) return;
  const nextLayout = {
    generation:Number(message.generation),
    key:geometryKey(config),
    version:String(message.version),
    count:Number(message.count),
    totalHeight:Number(message.totalHeight) || 1,
    rowStarts:message.rowStarts,
    rowCounts:message.rowCounts,
    rowTops:message.rowTops,
    rowHeights:message.rowHeights,
    itemRows:message.itemRows,
    headers:message.headers || [],
    dayStarts:message.dayStarts || []
  };
  activate(nextLayout);
});

function respondToConfigurationChange() {
  setTimeout(() => {
    const config = currentConfig();
    if (!config) {
      if (owned) release();
      return;
    }
    scheduleBuild(20);
  }, 0);
}

for (const control of [typeSelect,sortSelect,sourceSelect,locationSelect,collectionSelect]) {
  control?.addEventListener('change', respondToConfigurationChange);
}
searchInput?.addEventListener('input', () => {
  if (String(searchInput.value || '').trim()) {
    if (owned) release();
    return;
  }
  scheduleBuild(100);
});
views?.addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button?.dataset.view !== 'grid') {
    if (owned) release();
    return;
  }
  setTimeout(() => scheduleBuild(20), 0);
});

window.addEventListener('mochimono:media-size', () => scheduleBuild(80));
window.addEventListener('mochimono:catalog-updated', () => scheduleBuild(420));
window.addEventListener('mochimono:catalog-cache-restored', () => scheduleBuild(30));
window.addEventListener('mochimono:folder-changed', respondToConfigurationChange);
window.addEventListener('mochimono:grid-interaction-end', () => {
  if (queuedLayout) runQueuedLayout();
  if (buildTimer) scheduleBuild(40);
});
window.addEventListener('scroll', () => {
  const y = scrollY;
  if (Math.abs(y - lastScrollY) > 1) scrollDirection = y > lastScrollY ? 1 : -1;
  lastScrollY = y;
  lastScrollAt = performance.now();
  if (owned) scheduleVisibleRows();
}, { passive:true });
window.addEventListener('resize', () => {
  measureViewport();
  scheduleBuild(180);
}, { passive:true });

for (const element of [commandbar,folderbar,folderStrip]) {
  if (element && typeof ResizeObserver === 'function') new ResizeObserver(() => {
    measureViewport();
    if (owned) scheduleVisibleRows();
  }).observe(element);
}

new MutationObserver(() => {
  if (!owned) {
    scheduleBuild(90);
    return;
  }
  const config = currentConfig();
  if (!config) {
    release();
    return;
  }
  if (!plane?.isConnected) ensurePlaneConnected();
  if (geometryKey(config) !== layout?.key) scheduleBuild(260);
}).observe(files, { childList:true });

if (viewer && viewerOpen) {
  new MutationObserver(() => {
    if (!viewer.hidden || !owned) return;
    const hash = viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
    const state = rawState();
    if (!hash || !state?.filtered) return;
  }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
}

window.mochimonoStableGrid = {
  active:() => owned,
  owns:() => owned,
  state:() => ({
    active:owned,
    activating,
    generation,
    rows:layout?.rowTops?.length || 0,
    rendered:renderedRows.size,
    cached:rowData.size,
    fetching:visibleUpdateRunning,
    key:layout?.key || ''
  }),
  ensureIndex,
  scrollToIndex
};

measureViewport();
installLibrary();
