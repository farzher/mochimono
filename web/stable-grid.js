const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
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

const ROW_GAP = 4;
const RENDER_AHEAD = 10;
const RENDER_BEHIND = 8;
const PREFETCH_AHEAD = 18;
const PREFETCH_BEHIND = 12;
const IDLE_KEEP_AHEAD = 12;
const IDLE_KEEP_BEHIND = 10;
const ROW_CACHE_LIMIT = 1400;
const SUPPORTED_SORTS = new Set(['date-desc','date-added','date-asc','size-desc']);
const SUPPORTED_TYPES = new Set(['media','image','video']);
const SUPPORTED_LOCATIONS = new Set(['','server','backup','unbacked']);

const worker = typeof Worker === 'function' ? new Worker('/grid-layout-worker.js') : null;
let library = null;
let nativeState = null;
let nativeExtend = null;
let nativeEnsureIndex = null;
let nativeRemove = null;
let generation = 0;
let layout = null;
let rowData = new Map();
let renderedRows = new Map();
let plane = null;
let rowLayer = null;
let headerLayer = null;
let dayLayer = null;
let owned = false;
let activating = false;
let forceBuild = false;
let buildTimer = 0;
let renderFrame = 0;
let trimTimer = 0;
let requestId = 0;
let requestWaiters = new Map();
let fetchRunning = false;
let fetchAgain = false;
let lastScrollY = scrollY;
let lastScrollAt = 0;
let scrollDirection = 1;
let filesDocumentTop = 0;
let viewportTop = 0;
let viewportHeight = Math.max(240, innerHeight);
let allowFilesMutation = false;
let railScrub = false;
let lastRailScrubAt = 0;
let pendingCatalogRefresh = false;

const style = document.createElement('style');
style.textContent = `
html.stable-grid-owned{overflow-anchor:none}
html.stable-grid-owned #top-scroll-sentinel,html.stable-grid-owned #scroll-sentinel{display:none!important}
html.stable-grid-owned #files{position:relative!important;display:block!important;min-height:0!important;overflow:visible!important}
html.stable-grid-owned #files>:not(.stable-media-plane){display:none!important}
.stable-media-plane{position:absolute;inset:0;contain:layout style}
.stable-grid-rows,.stable-grid-headings,.stable-grid-days{position:absolute;inset:0;pointer-events:none}
.stable-grid-row{position:absolute;left:0;right:0;overflow:hidden;contain:layout paint style;pointer-events:auto}
.stable-grid-row>.file-card{position:absolute!important;top:0!important;margin:0!important;min-width:0!important;max-width:none!important;flex:none!important}
.stable-grid-heading{position:absolute;left:2px;right:0;margin:0!important;pointer-events:none}
.stable-grid-heading.year-heading{height:31px;display:flex;align-items:center;color:#f1e9e5;font-size:19px;font-weight:760;letter-spacing:-.025em}
.stable-grid-heading.date-heading{height:27px;display:flex;align-items:flex-start;padding-top:2px;color:#cfc5c1;font-size:13px!important;font-weight:700}
.stable-grid-days>.day-group-control{position:absolute;z-index:5;pointer-events:auto}
.stable-grid-row .geometry-pending{visibility:visible!important}
.stable-grid-row .media-thumb.thumb-decoding::after{display:none!important}
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
  return config ? [config.type,config.sort,config.sourceId,config.locationFilter,config.width,config.target].join('|') : '';
}

function interactionActive() {
  return Boolean(window.mochimonoGridInteraction?.active?.()) || performance.now() - lastScrollAt < 260;
}

function measureViewport() {
  viewportTop = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  viewportHeight = Math.max(240, innerHeight - viewportTop);
  filesDocumentTop = files ? files.getBoundingClientRect().top + scrollY : 0;
}

function localYForScroll(scrollTop = scrollY) {
  return Math.max(0, Number(scrollTop) + viewportTop - filesDocumentTop);
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

function rowsForScroll(targetLayout, scrollTop, aheadScreens, behindScreens) {
  const top = localYForScroll(scrollTop);
  const forward = viewportHeight * aheadScreens;
  const backward = viewportHeight * behindScreens;
  const start = scrollDirection >= 0 ? top - backward : top - forward;
  const end = scrollDirection >= 0 ? top + viewportHeight + forward : top + viewportHeight + backward;
  const range = {
    start:Math.max(0, start),
    end:Math.min(targetLayout?.totalHeight || 0, end)
  };
  return { range, rows:rowRange(targetLayout, range.start, range.end) };
}

function internalFilesMutation(callback) {
  allowFilesMutation = true;
  try { return callback(); }
  finally { allowFilesMutation = false; }
}

function installMutationFirewall() {
  if (!files || files.dataset.stableMutationFirewall) return;
  files.dataset.stableMutationFirewall = '1';
  const inner = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (inner?.get && inner?.set) {
    Object.defineProperty(files, 'innerHTML', {
      configurable:true,
      get() { return inner.get.call(files); },
      set(value) {
        if (owned && !allowFilesMutation) return;
        inner.set.call(files, value);
      }
    });
  }
  const replaceChildren = files.replaceChildren.bind(files);
  files.replaceChildren = (...nodes) => {
    if (owned && !allowFilesMutation) return;
    return replaceChildren(...nodes);
  };
  const insertAdjacentHTML = files.insertAdjacentHTML.bind(files);
  files.insertAdjacentHTML = (...args) => {
    if (owned && !allowFilesMutation) return;
    return insertAdjacentHTML(...args);
  };
}

function workerRequest(type, detail = {}, targetLayout = layout) {
  if (!worker || !targetLayout) return Promise.resolve(null);
  const id = ++requestId;
  return new Promise(resolve => {
    requestWaiters.set(id, resolve);
    worker.postMessage({ type, generation:targetLayout.generation, requestId:id, ...detail });
    setTimeout(() => {
      const pending = requestWaiters.get(id);
      if (!pending) return;
      requestWaiters.delete(id);
      pending(null);
    }, 1600);
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
    const next = Number(sibling.dataset.stableRow);
    if (Number.isInteger(next) && next > id) {
      rowLayer.insertBefore(row, sibling);
      return;
    }
  }
  rowLayer.append(row);
}

function renderRows(rows) {
  if (!rowLayer || !rows?.length) return;
  for (const data of [...rows].sort((a, b) => Number(a.row) - Number(b.row))) {
    const id = Number(data?.row);
    if (!data || renderedRows.has(id)) continue;
    const row = createRow(data);
    renderedRows.set(id, row);
    insertRow(row, id);
  }
}

function renderCached(rowIds) {
  renderRows(rowIds.map(row => rowData.get(row)).filter(Boolean));
}

function trimRows() {
  trimTimer = 0;
  if (!owned || !layout || interactionActive()) {
    scheduleTrim();
    return;
  }
  const keep = new Set(rowsForScroll(layout, scrollY, IDLE_KEEP_AHEAD, IDLE_KEEP_BEHIND).rows);
  for (const [row, element] of renderedRows) {
    if (keep.has(row)) continue;
    element.remove();
    renderedRows.delete(row);
  }
  if (rowData.size > ROW_CACHE_LIMIT) {
    for (const row of [...rowData.keys()]) {
      if (rowData.size <= ROW_CACHE_LIMIT) break;
      if (!keep.has(row)) rowData.delete(row);
    }
  }
}

function scheduleTrim() {
  clearTimeout(trimTimer);
  trimTimer = setTimeout(trimRows, 650);
}

function buildHeaderLayer(targetLayout) {
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

function syncDayButtons(range) {
  if (!dayLayer || !layout || interactionActive()) return;
  const wanted = new Set();
  for (const day of layout.dayStarts || []) {
    if (day.top < range.start - 30 || day.top > range.end + 30) continue;
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

function updateRail() {
  if (!layout?.rowStarts?.length || !rail || rail.hidden) return;
  const state = rawState();
  const thumb = document.querySelector('#railThumb');
  if (!state?.filtered || !thumb) return;
  const row = findFirstRow(layout, localYForScroll());
  const index = Number(layout.rowStarts[Math.max(0, row)]) || 0;
  const safe = Math.max(0, Math.min(state.filtered - 1, index));
  thumb.style.top = `${(state.filtered === 1 ? 0 : safe / (state.filtered - 1)) * 100}%`;
}

async function updateRows() {
  renderFrame = 0;
  if (!owned || !layout || !plane?.isConnected) return;
  if (fetchRunning) {
    fetchAgain = true;
    return;
  }
  fetchRunning = true;
  try {
    do {
      fetchAgain = false;
      const visible = rowsForScroll(layout, scrollY, RENDER_AHEAD, RENDER_BEHIND);
      renderCached(visible.rows);
      updateRail();

      const prefetch = rowsForScroll(layout, scrollY, PREFETCH_AHEAD, PREFETCH_BEHIND);
      await fetchRows(prefetch.rows);
      if (!owned || !layout || !plane?.isConnected) break;

      const latest = rowsForScroll(layout, scrollY, RENDER_AHEAD, RENDER_BEHIND);
      renderCached(latest.rows);
      syncDayButtons(latest.range);
      updateRail();
    } while (fetchAgain);
  } finally {
    fetchRunning = false;
    if (fetchAgain) scheduleRows();
    scheduleTrim();
  }
}

function scheduleRows() {
  if (fetchRunning) {
    fetchAgain = true;
    return;
  }
  if (!renderFrame) renderFrame = requestAnimationFrame(updateRows);
}

function makePlane(targetLayout, initialRows) {
  const nextPlane = document.createElement('div');
  nextPlane.className = 'stable-media-plane';
  const nextRows = document.createElement('div');
  nextRows.className = 'stable-grid-rows';
  const nextHeaders = buildHeaderLayer(targetLayout);
  const nextDays = document.createElement('div');
  nextDays.className = 'stable-grid-days';
  nextPlane.append(nextRows, nextHeaders, nextDays);

  const oldLayer = rowLayer;
  const oldRows = renderedRows;
  rowLayer = nextRows;
  renderedRows = new Map();
  renderRows(initialRows);
  const nextRendered = renderedRows;
  rowLayer = oldLayer;
  renderedRows = oldRows;
  return { plane:nextPlane, rows:nextRows, headers:nextHeaders, days:nextDays, rendered:nextRendered };
}

function showLegacy() {
  if (!owned) return;
  owned = false;
  document.documentElement.classList.remove('stable-grid-owned');
  files.style.removeProperty('height');
  plane = null;
  rowLayer = null;
  headerLayer = null;
  dayLayer = null;
  renderedRows.clear();
  rowData.clear();
}

async function activate(nextLayout) {
  if (!nextLayout || activating || interactionActive()) {
    if (nextLayout) setTimeout(() => activate(nextLayout), 300);
    return;
  }
  const config = currentConfig();
  if (!config || nextLayout.key !== geometryKey(config)) return;
  activating = true;
  measureViewport();

  const targetRows = rowsForScroll(nextLayout, scrollY, RENDER_AHEAD, RENDER_BEHIND).rows;
  const nextCache = new Map();
  const initialRows = await fetchRows(targetRows, nextLayout, nextCache);
  const latest = currentConfig();
  if (!latest || nextLayout.key !== geometryKey(latest)) {
    activating = false;
    return;
  }
  if (interactionActive()) {
    activating = false;
    setTimeout(() => activate(nextLayout), 300);
    return;
  }

  const built = makePlane(nextLayout, initialRows);
  layout = nextLayout;
  rowData = nextCache;
  plane = built.plane;
  rowLayer = built.rows;
  headerLayer = built.headers;
  dayLayer = built.days;
  renderedRows = built.rendered;
  owned = true;
  document.documentElement.classList.add('stable-grid-owned');
  files.className = 'files grid stable-grid-files';
  files.style.height = `${Math.ceil(layout.totalHeight)}px`;
  internalFilesMutation(() => files.replaceChildren(plane));
  document.querySelector('#top-scroll-sentinel')?.setAttribute('hidden','');
  document.querySelector('#scroll-sentinel')?.setAttribute('hidden','');
  measureViewport();
  activating = false;
  scheduleRows();
}

function scheduleBuild(delay = 100, force = false) {
  if (force) forceBuild = true;
  clearTimeout(buildTimer);
  buildTimer = setTimeout(build, delay);
}

function build() {
  buildTimer = 0;
  if (!worker || !library || activating) return;
  const config = currentConfig();
  if (!config || !config.expectedCount) {
    showLegacy();
    return;
  }
  const key = geometryKey(config);
  if (owned && layout?.key === key && !forceBuild) return;
  if (interactionActive()) {
    scheduleBuild(320, forceBuild);
    return;
  }
  forceBuild = false;
  const nextGeneration = ++generation;
  worker.postMessage({ type:'build', generation:nextGeneration, config });
}

function rowForIndex(index) {
  if (!layout || !Number.isInteger(index) || index < 0 || index >= layout.itemRows.length) return -1;
  return Number(layout.itemRows[index]);
}

function ensureIndex(index) {
  if (!owned || !layout) return false;
  const row = rowForIndex(Number(index));
  if (row < 0) return false;
  const data = rowData.get(row);
  if (data) renderRows([data]);
  else fetchRows([row]).then(rows => renderRows(rows));
  return true;
}

async function scrollToIndex(index, block = 'center') {
  if (!owned || !layout) return false;
  const row = rowForIndex(Number(index));
  if (row < 0) return false;
  const rows = await fetchRows([row]);
  if (!owned || !rows.length) return false;
  renderRows(rows);
  measureViewport();
  const top = filesDocumentTop + Number(layout.rowTops[row] || 0);
  const height = Number(layout.rowHeights[row] || 0);
  let target = top - viewportTop;
  if (block === 'center') target -= Math.max(0, (viewportHeight - height) / 2);
  else if (block === 'end') target -= Math.max(0, viewportHeight - height);
  scrollTo({ top:Math.max(0, target), left:0, behavior:'auto' });
  scheduleRows();
  return true;
}

async function warmViewport(scrollTop) {
  if (!owned || !layout) return;
  const local = localYForScroll(scrollTop);
  const rows = rowRange(layout, Math.max(0, local - viewportHeight * 2), Math.min(layout.totalHeight, local + viewportHeight * 4));
  const data = await fetchRows(rows);
  if (!owned) return;
  renderRows(data);
  const cards = [];
  for (const row of rows) {
    const element = renderedRows.get(row);
    if (element) cards.push(...element.querySelectorAll('[data-hash]'));
  }
  if (cards.length) window.mochimonoThumbnails?.prioritize?.(cards);
}

function installRail() {
  if (!rail || rail.dataset.stableRail) return;
  rail.dataset.stableRail = '1';
  const indexFromEvent = event => {
    const state = rawState();
    if (!state?.filtered) return 0;
    const rect = rail.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) * (state.filtered - 1));
  };
  const move = (event, final = false) => {
    const index = indexFromEvent(event);
    const now = performance.now();
    if (final || now - lastRailScrubAt > 45) {
      lastRailScrubAt = now;
      scrollToIndex(index, 'center');
    }
  };
  rail.addEventListener('pointerdown', event => {
    if (!owned || rail.hidden) return;
    railScrub = true;
    rail.classList.add('dragging');
    try { rail.setPointerCapture(event.pointerId); } catch {}
    move(event);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  rail.addEventListener('pointermove', event => {
    if (!owned || !railScrub) return;
    move(event);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  rail.addEventListener('pointerup', event => {
    if (!owned || !railScrub) return;
    railScrub = false;
    rail.classList.remove('dragging');
    move(event, true);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  rail.addEventListener('pointercancel', () => {
    railScrub = false;
    rail.classList.remove('dragging');
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
  nativeRemove = library.remove?.bind(library);

  library.state = () => {
    const state = nativeState();
    return owned ? { ...state, offset:0, loaded:state.filtered, hasMore:false, hasPrevious:false, stableGrid:true } : state;
  };
  library.extend = direction => owned ? false : nativeExtend(direction);
  library.ensureIndex = index => owned ? ensureIndex(Number(index)) : nativeEnsureIndex(index);
  if (nativeRemove) library.remove = hashes => {
    const result = nativeRemove(hashes);
    scheduleBuild(80, true);
    return result;
  };
  installRail();
  scheduleBuild(0, true);
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
    scheduleBuild(500, true);
    return;
  }
  if (message.type !== 'ready') return;
  const config = currentConfig();
  if (!config || message.version !== config.version) {
    scheduleBuild(500, true);
    return;
  }
  activate({
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
  });
});

function releaseBeforeUnsupportedChange() {
  if (!owned) return;
  showLegacy();
}

searchInput?.addEventListener('input', () => {
  if (String(searchInput.value || '').trim()) releaseBeforeUnsupportedChange();
  else scheduleBuild(80, true);
}, true);
collectionSelect?.addEventListener('change', () => {
  if (String(collectionSelect.value || '')) releaseBeforeUnsupportedChange();
  else scheduleBuild(30, true);
}, true);
views?.addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button?.dataset.view && button.dataset.view !== 'grid') releaseBeforeUnsupportedChange();
  else if (button?.dataset.view === 'grid') setTimeout(() => scheduleBuild(20, true), 0);
}, true);
for (const control of [typeSelect,sortSelect,sourceSelect,locationSelect]) {
  control?.addEventListener('change', () => setTimeout(() => scheduleBuild(20, true), 0));
}

window.addEventListener('mochimono:media-size', () => scheduleBuild(70, true));
window.addEventListener('mochimono:catalog-cache-restored', () => scheduleBuild(30, true));
window.addEventListener('mochimono:catalog-updated', () => {
  pendingCatalogRefresh = true;
  measureViewport();
  if (localYForScroll() < viewportHeight * .65 && !interactionActive()) {
    pendingCatalogRefresh = false;
    scheduleBuild(180, true);
  }
});
window.addEventListener('mochimono:folder-changed', () => {
  const config = currentConfig();
  if (!config) showLegacy();
  else scheduleBuild(50, true);
});
window.addEventListener('mochimono:grid-interaction-end', () => {
  scheduleRows();
  scheduleTrim();
  if (pendingCatalogRefresh && localYForScroll() < viewportHeight * .65) {
    pendingCatalogRefresh = false;
    scheduleBuild(120, true);
  }
});
window.addEventListener('scroll', () => {
  const y = scrollY;
  if (Math.abs(y - lastScrollY) > 1) scrollDirection = y > lastScrollY ? 1 : -1;
  lastScrollY = y;
  lastScrollAt = performance.now();
  if (owned) scheduleRows();
}, { passive:true });
window.addEventListener('resize', () => {
  measureViewport();
  scheduleBuild(180, true);
}, { passive:true });

window.mochimonoStableGrid = {
  active:() => owned,
  owns:() => owned,
  state:() => ({
    active:owned,
    generation,
    rows:layout?.rowTops?.length || 0,
    rendered:renderedRows.size,
    cached:rowData.size,
    fetching:fetchRunning,
    key:layout?.key || ''
  }),
  ensureIndex,
  scrollToIndex,
  warmViewport
};

installMutationFirewall();
measureViewport();
installLibrary();
