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
const MOUNT_AHEAD = 8;
const MOUNT_BEHIND = 6;
const KEEP_AHEAD = 13;
const KEEP_BEHIND = 11;
const THUMB_AHEAD = 3.5;
const THUMB_BEHIND = 2.5;
const HARD_ROW_LIMIT = 900;
const SUPPORTED_SORTS = new Set(['date-desc','date-added','date-asc','size-desc']);
const SUPPORTED_TYPES = new Set(['media','image','video']);
const SUPPORTED_LOCATIONS = new Set(['','server','backup','unbacked']);

const worker = typeof Worker === 'function' ? new Worker('/grid-layout-worker.js') : null;
const nativeScrollBy = window.scrollBy.bind(window);
let library = null;
let nativeState = null;
let nativeExtend = null;
let nativeEnsureIndex = null;
let nativeRemove = null;
let nativeFilteredHashes = null;
let generation = 0;
let layout = null;
let pendingLayout = null;
let plane = null;
let rowLayer = null;
let headerLayer = null;
let dayLayer = null;
let renderedRows = new Map();
let owned = false;
let buildTimer = 0;
let renderFrame = 0;
let trimTimer = 0;
let thumbWarmTimer = 0;
let thumbClearTimer = 0;
let lastWarmKey = '';
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
const dayLabelCache = new Map();

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

function rawState() {
  try { return nativeState?.() || library?.state?.() || null; }
  catch { return null; }
}

function currentConfig() {
  const state = rawState();
  if (!state || state.view !== 'grid' || !files) return null;
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
    version:String(state.version || ''),
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
  return Boolean(window.mochimonoGridInteraction?.active?.()) || performance.now() - lastScrollAt < 220;
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

function rowsForScroll(targetLayout, scrollTop, aheadScreens, behindScreens, directional = true) {
  const top = Math.max(0, Number(scrollTop) + viewportTop - filesDocumentTop);
  const ahead = viewportHeight * aheadScreens;
  const behind = viewportHeight * behindScreens;
  const start = directional && scrollDirection < 0 ? top - ahead : top - behind;
  const end = directional && scrollDirection < 0 ? top + viewportHeight + behind : top + viewportHeight + ahead;
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

// The old virtual grid still schedules anchor repairs after background upserts.
// Once this grid owns a fixed-height plane those repairs are always wrong. Native
// wheel/touch scrolling does not call window.scrollBy, so suppress only scripted
// repairs while owned.
window.scrollBy = (...args) => owned ? undefined : nativeScrollBy(...args);

function dayInfo(ms) {
  const date = new Date(Number(ms) || 0);
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  let label = dayLabelCache.get(key);
  if (!label) {
    label = date.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
    dayLabelCache.set(key, label);
  }
  return { key, label };
}

function cardMarkup(targetLayout, index, rowHeight) {
  const item = targetLayout.items[index];
  if (!item) return '';
  const [hash, filename, video, sourceWidth, sourceHeight, dateMs] = item;
  const width = Number(targetLayout.itemW[index]) || 1;
  const x = Number(targetLayout.itemX[index]) || 0;
  const dataWidth = Number(sourceWidth) || Math.max(1, width);
  const dataHeight = Number(sourceHeight) || Math.max(1, rowHeight);
  const ratio = Math.max(.65, Math.min(2.1, dataWidth / dataHeight));
  const day = dayInfo(dateMs);
  return `<button class="file-card media-card ${video ? 'video-card' : ''}" data-hash="${escapeHtml(hash)}" data-filename="${escapeHtml(filename)}" data-day="${day.key}" data-day-label="${escapeHtml(day.label)}" data-width="${dataWidth}" data-height="${dataHeight}" style="left:${x.toFixed(2)}px;width:${width.toFixed(2)}px;height:${Number(rowHeight).toFixed(2)}px;flex-basis:${width.toFixed(2)}px;--ratio:${ratio}" title="${escapeHtml(filename)}"><div class="thumb media-thumb"><span class="video-thumb-pending" data-video-thumb="${escapeHtml(hash)}"></span>${video ? '<span class="play-badge">▶</span>' : ''}</div></button>`;
}

function createRow(targetLayout, rowId) {
  const start = Number(targetLayout.rowStarts[rowId]);
  const count = Number(targetLayout.rowCounts[rowId]);
  const height = Number(targetLayout.rowHeights[rowId]) || 1;
  const row = document.createElement('div');
  row.className = 'stable-grid-row';
  row.dataset.stableRow = String(rowId);
  row.style.top = `${Number(targetLayout.rowTops[rowId]).toFixed(2)}px`;
  row.style.height = `${height.toFixed(2)}px`;
  let html = '';
  for (let index = start; index < start + count; index++) html += cardMarkup(targetLayout, index, height);
  row.innerHTML = html;
  return row;
}

function insertRow(layer, row, id) {
  for (const sibling of layer.children) {
    const next = Number(sibling.dataset.stableRow);
    if (Number.isInteger(next) && next > id) {
      layer.insertBefore(row, sibling);
      return;
    }
  }
  layer.append(row);
}

function materializeRows(rowIds, targetLayout = layout, layer = rowLayer, mounted = renderedRows) {
  if (!targetLayout || !layer) return;
  for (const id of rowIds) {
    if (!Number.isInteger(id) || id < 0 || id >= targetLayout.rowTops.length || mounted.has(id)) continue;
    const row = createRow(targetLayout, id);
    mounted.set(id, row);
    insertRow(layer, row, id);
  }
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
  const thumb = document.querySelector('#railThumb');
  if (!thumb || !layout.count) return;
  const row = findFirstRow(layout, localYForScroll());
  const index = Number(layout.rowStarts[Math.max(0, row)]) || 0;
  thumb.style.top = `${(layout.count === 1 ? 0 : index / (layout.count - 1)) * 100}%`;
}

function cardsForRows(rows) {
  const cards = [];
  for (const row of rows) {
    const element = renderedRows.get(row);
    if (element) cards.push(...element.querySelectorAll('[data-hash]'));
  }
  return cards;
}

function warmRows(scrollTop) {
  if (!owned || !layout || !window.mochimonoThumbnails?.prioritize) return;
  const rows = rowsForScroll(layout, scrollTop, THUMB_AHEAD, THUMB_BEHIND).rows;
  if (!rows.length) return;
  const key = `${rows[0]}:${rows.at(-1)}`;
  if (key === lastWarmKey) return;
  lastWarmKey = key;
  clearTimeout(thumbWarmTimer);
  thumbWarmTimer = setTimeout(() => {
    thumbWarmTimer = 0;
    if (!owned || !layout) return;
    const current = rowsForScroll(layout, scrollTop, THUMB_AHEAD, THUMB_BEHIND).rows;
    materializeRows(current);
    const cards = cardsForRows(current);
    if (cards.length) window.mochimonoThumbnails?.prioritize?.(cards);
    clearTimeout(thumbClearTimer);
    thumbClearTimer = setTimeout(() => window.mochimonoThumbnails?.clearPriority?.(), 180);
  }, 0);
}

function trimRows(force = false) {
  trimTimer = 0;
  if (!owned || !layout) return;
  if (!force && interactionActive() && renderedRows.size < HARD_ROW_LIMIT) {
    scheduleTrim();
    return;
  }
  const keep = new Set(rowsForScroll(layout, scrollY, KEEP_AHEAD, KEEP_BEHIND).rows);
  for (const [row, element] of renderedRows) {
    if (keep.has(row)) continue;
    element.remove();
    renderedRows.delete(row);
  }
}

function scheduleTrim() {
  clearTimeout(trimTimer);
  trimTimer = setTimeout(() => trimRows(renderedRows.size >= HARD_ROW_LIMIT), 520);
}

function renderCurrent() {
  renderFrame = 0;
  if (!owned || !layout || !plane?.isConnected) return;
  measureViewport();
  const windowRows = rowsForScroll(layout, scrollY, MOUNT_AHEAD, MOUNT_BEHIND);
  materializeRows(windowRows.rows);
  updateRail();
  syncDayButtons(windowRows.range);
  warmRows(scrollY);
  scheduleTrim();
}

function scheduleRows() {
  if (!renderFrame) renderFrame = requestAnimationFrame(renderCurrent);
}

function prepareViewport(scrollTop) {
  if (!owned || !layout) return false;
  measureViewport();
  const target = rowsForScroll(layout, scrollTop, 2.5, 2.5, false);
  materializeRows(target.rows);
  const cards = cardsForRows(target.rows);
  if (cards.length) {
    window.mochimonoThumbnails?.prioritize?.(cards);
    clearTimeout(thumbClearTimer);
    thumbClearTimer = setTimeout(() => window.mochimonoThumbnails?.clearPriority?.(), 180);
  }
  return true;
}

function makePlane(targetLayout, scrollTop) {
  const nextPlane = document.createElement('div');
  nextPlane.className = 'stable-media-plane';
  const nextRows = document.createElement('div');
  nextRows.className = 'stable-grid-rows';
  const nextHeaders = buildHeaderLayer(targetLayout);
  const nextDays = document.createElement('div');
  nextDays.className = 'stable-grid-days';
  nextPlane.append(nextRows, nextHeaders, nextDays);
  const nextRendered = new Map();
  const rows = rowsForScroll(targetLayout, scrollTop, MOUNT_AHEAD, MOUNT_BEHIND).rows;
  materializeRows(rows, targetLayout, nextRows, nextRendered);
  return { plane:nextPlane, rows:nextRows, headers:nextHeaders, days:nextDays, rendered:nextRendered };
}

function showLegacy() {
  if (!owned) return;
  owned = false;
  pendingLayout = null;
  document.documentElement.classList.remove('stable-grid-owned');
  files.style.removeProperty('height');
  clearTimeout(trimTimer);
  clearTimeout(thumbWarmTimer);
  clearTimeout(thumbClearTimer);
  window.mochimonoThumbnails?.clearPriority?.();
  plane = null;
  rowLayer = null;
  headerLayer = null;
  dayLayer = null;
  renderedRows.clear();
}

function installLayout(nextLayout) {
  const config = currentConfig();
  if (!config || nextLayout.key !== geometryKey(config)) return;
  if (owned && interactionActive()) {
    pendingLayout = nextLayout;
    return;
  }

  measureViewport();
  const savedY = scrollY;
  const built = makePlane(nextLayout, savedY);
  layout = nextLayout;
  plane = built.plane;
  rowLayer = built.rows;
  headerLayer = built.headers;
  dayLayer = built.days;
  renderedRows = built.rendered;
  owned = true;
  pendingLayout = null;
  document.documentElement.classList.add('stable-grid-owned');
  files.className = 'files grid stable-grid-files';
  // Set the final document height before replacing children. There is never an
  // intermediate short document that could clamp scrollY upward.
  files.style.height = `${Math.ceil(layout.totalHeight)}px`;
  internalFilesMutation(() => files.replaceChildren(plane));
  document.querySelector('#top-scroll-sentinel')?.setAttribute('hidden','');
  document.querySelector('#scroll-sentinel')?.setAttribute('hidden','');
  measureViewport();
  prepareViewport(savedY);
  scheduleRows();
}

function scheduleBuild(delay = 80) {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(build, delay);
}

function build() {
  buildTimer = 0;
  if (!worker || !library) return;
  const config = currentConfig();
  if (!config || !config.expectedCount) {
    if (!config) showLegacy();
    return;
  }
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
  materializeRows([row]);
  return true;
}

function scrollToIndex(index, block = 'center') {
  if (!owned || !layout) return false;
  const row = rowForIndex(Number(index));
  if (row < 0) return false;
  measureViewport();
  const top = filesDocumentTop + Number(layout.rowTops[row] || 0);
  const height = Number(layout.rowHeights[row] || 0);
  let target = top - viewportTop;
  if (block === 'center') target -= Math.max(0, (viewportHeight - height) / 2);
  else if (block === 'end') target -= Math.max(0, viewportHeight - height);
  target = Math.max(0, target);
  prepareViewport(target);
  scrollTo({ top:target, left:0, behavior:'auto' });
  scheduleRows();
  return true;
}

function installRail() {
  if (!rail || rail.dataset.stableRail) return;
  rail.dataset.stableRail = '1';
  const indexFromEvent = event => {
    if (!layout?.count) return 0;
    const rect = rail.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) * (layout.count - 1));
  };
  const move = (event, final = false) => {
    const index = indexFromEvent(event);
    const now = performance.now();
    if (final || now - lastRailScrubAt > 35) {
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
  nativeFilteredHashes = library.filteredHashes?.bind(library);

  library.state = () => {
    const state = nativeState();
    return owned && layout
      ? { ...state, offset:0, loaded:layout.count, filtered:layout.count, hasMore:false, hasPrevious:false, stableGrid:true }
      : state;
  };
  library.extend = direction => owned ? false : nativeExtend(direction);
  library.ensureIndex = index => owned ? ensureIndex(Number(index)) : nativeEnsureIndex(index);
  if (nativeFilteredHashes) library.filteredHashes = () => owned && layout ? layout.items.map(item => item[0]) : nativeFilteredHashes();
  if (nativeRemove) library.remove = hashes => {
    const result = nativeRemove(hashes);
    scheduleBuild(60);
    return result;
  };
  installRail();
  scheduleBuild(0);
}

worker?.addEventListener('message', event => {
  const message = event.data || {};
  if (Number(message.generation) !== generation) return;
  if (message.type === 'error') {
    console.warn('Stable grid geometry build failed.', message.message || 'unknown error');
    return;
  }
  if (message.type !== 'ready') return;
  const config = currentConfig();
  if (!config) return;
  const nextLayout = {
    generation:Number(message.generation),
    key:geometryKey(config),
    version:String(message.version || ''),
    count:Number(message.count) || 0,
    totalHeight:Number(message.totalHeight) || 1,
    rowStarts:message.rowStarts,
    rowCounts:message.rowCounts,
    rowTops:message.rowTops,
    rowHeights:message.rowHeights,
    itemRows:message.itemRows,
    itemX:message.itemX,
    itemW:message.itemW,
    headers:message.headers || [],
    dayStarts:message.dayStarts || [],
    items:message.items || []
  };

  // First ownership is installed immediately even if the user is already
  // scrolling. Waiting for an "idle" gap meant holding PageDown could prevent
  // the stable grid from ever activating. Refresh swaps can wait until idle.
  if (!owned) installLayout(nextLayout);
  else if (interactionActive()) pendingLayout = nextLayout;
  else installLayout(nextLayout);
});

function releaseBeforeUnsupportedChange() {
  if (owned) showLegacy();
}

searchInput?.addEventListener('input', () => {
  if (String(searchInput.value || '').trim()) releaseBeforeUnsupportedChange();
  else scheduleBuild(60);
}, true);
collectionSelect?.addEventListener('change', () => {
  if (String(collectionSelect.value || '')) releaseBeforeUnsupportedChange();
  else scheduleBuild(30);
}, true);
views?.addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button?.dataset.view && button.dataset.view !== 'grid') releaseBeforeUnsupportedChange();
  else if (button?.dataset.view === 'grid') setTimeout(() => scheduleBuild(10), 0);
}, true);
for (const control of [typeSelect,sortSelect,sourceSelect,locationSelect]) {
  control?.addEventListener('change', () => setTimeout(() => scheduleBuild(10), 0));
}

window.addEventListener('mochimono:media-size', () => scheduleBuild(40));
window.addEventListener('mochimono:catalog-cache-restored', () => scheduleBuild(10));
window.addEventListener('mochimono:catalog-updated', () => {
  pendingCatalogRefresh = true;
  measureViewport();
  if (!owned || (localYForScroll() < viewportHeight * .65 && !interactionActive())) {
    pendingCatalogRefresh = false;
    scheduleBuild(100);
  }
});
window.addEventListener('mochimono:folder-changed', () => {
  const config = currentConfig();
  if (!config) showLegacy();
  else scheduleBuild(30);
});
window.addEventListener('mochimono:grid-interaction-end', () => {
  if (pendingLayout) installLayout(pendingLayout);
  scheduleRows();
  scheduleTrim();
  if (pendingCatalogRefresh && localYForScroll() < viewportHeight * .65) {
    pendingCatalogRefresh = false;
    scheduleBuild(80);
  }
});
window.addEventListener('wheel', event => {
  if (!owned || !event.deltaY || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? viewportHeight : 1;
  const predicted = Math.max(0, scrollY + event.deltaY * unit);
  prepareViewport(predicted);
}, { passive:true, capture:true });
window.addEventListener('scroll', () => {
  const y = scrollY;
  if (Math.abs(y - lastScrollY) > 1) scrollDirection = y > lastScrollY ? 1 : -1;
  lastScrollY = y;
  lastScrollAt = performance.now();
  if (owned) scheduleRows();
}, { passive:true });
window.addEventListener('resize', () => {
  measureViewport();
  scheduleBuild(120);
}, { passive:true });

window.mochimonoStableGrid = {
  active:() => owned,
  owns:() => owned,
  count:() => layout?.count || 0,
  state:() => ({
    active:owned,
    generation,
    rows:layout?.rowTops?.length || 0,
    rendered:renderedRows.size,
    key:layout?.key || ''
  }),
  ensureIndex,
  scrollToIndex,
  prepareViewport,
  warmViewport:prepareViewport
};

installMutationFirewall();
measureViewport();
installLibrary();