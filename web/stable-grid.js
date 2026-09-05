const files = document.querySelector('#files');
const commandbar = document.querySelector('.commandbar');
const rail = document.querySelector('#dateRail');
const mediaSize = document.querySelector('#mediaSize');

const ROW_GAP = 4;
const MOUNT_AHEAD = 4.5;
const MOUNT_BEHIND = 3.5;
const KEEP_AHEAD = 8;
const KEEP_BEHIND = 7;
const RENDER_MARGIN = 1.35;

const worker = typeof Worker === 'function'
  ? new Worker(new URL('./grid-layout-worker.js', import.meta.url))
  : null;

let model = null;
let generation = 0;
let building = false;
let buildConfig = null;
let layout = null;
let pendingLayout = null;
let owned = false;
let plane = null;
let rowLayer = null;
let headerLayer = null;
let dayLayer = null;
let renderedRows = new Map();
let renderFrame = 0;
let pendingTimer = 0;
let resizeTimer = 0;
let lastScrollY = scrollY;
let lastScrollAt = 0;
let scrollDirection = 1;
let viewportTop = 0;
let viewportHeight = Math.max(240, innerHeight);
let filesDocumentTop = 0;
let mountedStart = 0;
let mountedEnd = 0;
let railScrub = false;
let lastRailMove = 0;
let railKey = '';
let observedWidth = 0;

const metrics = {
  modelBuilds:0,
  workerReady:0,
  layoutInstalls:0,
  rowMounts:0,
  rowUnmounts:0,
  scrollFrames:0,
  scrollCorrections:0,
  maxRenderedRows:0,
  lastWorkerBuildMs:0,
  lastMaterializeMs:0
};

const style = document.createElement('style');
style.textContent = `
html.stable-grid-owned{overflow-anchor:none}
html.stable-grid-owned #top-scroll-sentinel,html.stable-grid-owned #scroll-sentinel{display:none!important}
html.stable-grid-owned #files{position:relative!important;display:block!important;min-height:0!important;overflow:visible!important}
.stable-media-plane{position:absolute;inset:0;contain:layout style}
.stable-grid-rows,.stable-grid-headings,.stable-grid-days{position:absolute;inset:0;pointer-events:none}
.stable-grid-row{position:absolute;left:0;right:0;overflow:hidden;contain:layout paint style;pointer-events:auto}
.stable-grid-row>.file-card{position:absolute!important;top:0!important;margin:0!important;min-width:0!important;max-width:none!important;flex:none!important}
.stable-grid-row>.file-card>.thumb{height:100%!important}
.stable-grid-row>.file-card:not(.media-card)>.card-copy{display:none}
.stable-grid-heading{position:absolute;left:2px;right:0;margin:0!important;pointer-events:none}
.stable-grid-heading>.timeline-group-select{pointer-events:auto}
.stable-grid-heading.year-heading{height:31px;display:flex;align-items:center;color:#f1e9e5;font-size:19px;font-weight:760;letter-spacing:-.025em}
.stable-grid-heading.date-heading{height:27px;display:flex;align-items:flex-start;padding-top:2px;color:#cfc5c1;font-size:13px!important;font-weight:700}
.stable-grid-days>.day-group-control{position:absolute;z-index:5;pointer-events:auto}
`;
document.head.append(style);

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function interactionActive() {
  return Boolean(window.mochimonoGridInteraction?.active?.()) || performance.now() - lastScrollAt < 180;
}

function currentWidth() {
  return Math.round(files?.clientWidth || 0);
}

function currentTarget() {
  return Number(mediaSize?.value) || 170;
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

function itemType(item) {
  return String(item?.[2] || 'other');
}

function iconFor(type) {
  return type === 'audio' ? '♪' : type === 'application' || type === 'text' ? '▤' : '·';
}

function formatBytes(bytes) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function dayInfo(ms) {
  const date = new Date(Number(ms) || 0);
  return {
    key:`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`,
    label:date.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })
  };
}

function cardMarkup(index, rowHeight) {
  const item = model?.items?.[index];
  if (!item) return '';
  const [hash, filename, type, sourceWidth, sourceHeight, dateMs] = item;
  const width = Number(layout.itemW[index]) || 1;
  const x = Number(layout.itemX[index]) || 0;
  const media = type === 'image' || type === 'video';
  const video = type === 'video';
  const dataWidth = Number(sourceWidth) || Math.max(1, width);
  const dataHeight = Number(sourceHeight) || Math.max(1, rowHeight);
  const ratio = Math.max(.65, Math.min(2.1, dataWidth / dataHeight));
  const day = dayInfo(dateMs);
  const common = `data-hash="${escapeHtml(hash)}" data-filename="${escapeHtml(filename)}" data-day="${day.key}" data-day-label="${escapeHtml(day.label)}" style="left:${x.toFixed(2)}px;width:${width.toFixed(2)}px;height:${Number(rowHeight).toFixed(2)}px;flex-basis:${width.toFixed(2)}px;--ratio:${ratio}" title="${escapeHtml(filename)}"`;

  if (media) {
    return `<button class="file-card media-card ${video ? 'video-card' : ''}" ${common} data-width="${dataWidth}" data-height="${dataHeight}"><div class="thumb media-thumb"><span class="video-thumb-pending" data-video-thumb="${escapeHtml(hash)}"></span>${video ? '<span class="play-badge">▶</span>' : ''}</div></button>`;
  }
  return `<button class="file-card" ${common}><div class="thumb"><div class="file-icon ${escapeHtml(itemType(item))}">${iconFor(itemType(item))}</div></div></button>`;
}

function createRow(rowId) {
  const start = Number(layout.rowStarts[rowId]);
  const count = Number(layout.rowCounts[rowId]);
  const height = Number(layout.rowHeights[rowId]) || 1;
  const row = document.createElement('div');
  row.className = 'stable-grid-row';
  row.dataset.stableRow = String(rowId);
  row.style.top = `${Number(layout.rowTops[rowId]).toFixed(2)}px`;
  row.style.height = `${height.toFixed(2)}px`;
  let html = '';
  for (let index = start; index < start + count; index++) html += cardMarkup(index, height);
  row.innerHTML = html;
  return row;
}

function insertRow(row, id) {
  for (const sibling of rowLayer.children) {
    const next = Number(sibling.dataset.stableRow);
    if (Number.isInteger(next) && next > id) {
      rowLayer.insertBefore(row, sibling);
      return;
    }
  }
  rowLayer.append(row);
}

function materializeRows(rowIds) {
  if (!layout || !rowLayer) return;
  const started = performance.now();
  let mounted = 0;
  for (const id of rowIds) {
    if (!Number.isInteger(id) || id < 0 || id >= layout.rowTops.length || renderedRows.has(id)) continue;
    const row = createRow(id);
    renderedRows.set(id, row);
    insertRow(row, id);
    mounted++;
  }
  if (mounted) {
    metrics.rowMounts += mounted;
    metrics.lastMaterializeMs = performance.now() - started;
    metrics.maxRenderedRows = Math.max(metrics.maxRenderedRows, renderedRows.size);
  }
}

function trimRows(scrollTop = scrollY) {
  if (!owned || !layout) return;
  const keep = new Set(rowsForScroll(layout, scrollTop, KEEP_AHEAD, KEEP_BEHIND).rows);
  for (const [row, element] of renderedRows) {
    if (keep.has(row)) continue;
    element.remove();
    renderedRows.delete(row);
    metrics.rowUnmounts++;
  }
}

function groupButton(period, key, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'timeline-group-select';
  button.dataset.selectPeriod = period;
  button.dataset.periodKey = key;
  button.dataset.periodLabel = label;
  button.setAttribute('aria-label', `Select ${label}`);
  button.innerHTML = `<span class="timeline-check" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
  return button;
}

function buildHeaderLayer() {
  const layer = document.createElement('div');
  layer.className = 'stable-grid-headings';
  const fragment = document.createDocumentFragment();
  for (const header of layout.headers || []) {
    const year = Number(header.year);
    const month = Number(header.month);
    const yearHeader = header.kind === 'year';
    const element = document.createElement(yearHeader ? 'h2' : 'h3');
    element.className = `stable-grid-heading ${yearHeader ? 'year-heading' : 'date-heading'}`;
    element.style.top = `${Number(header.top).toFixed(2)}px`;
    const label = yearHeader
      ? String(year)
      : new Date(year, month, 1).toLocaleDateString(undefined, { month:'long' });
    const key = yearHeader ? String(year) : `${year}-${String(month + 1).padStart(2,'0')}`;
    element.append(groupButton(yearHeader ? 'year' : 'month', key, label));
    fragment.append(element);
  }
  layer.append(fragment);
  return layer;
}

function firstDayAt(y) {
  const days = layout?.dayStarts || [];
  let lo = 0;
  let hi = days.length - 1;
  let answer = days.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(days[mid].top) >= y) {
      answer = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return Math.max(0, answer - 1);
}

function syncDayButtons(range) {
  if (!dayLayer || !layout) return;
  const wanted = new Set();
  const days = layout.dayStarts || [];
  for (let index = firstDayAt(range.start - 30); index < days.length; index++) {
    const day = days[index];
    if (day.top > range.end + 30) break;
    if (day.top < range.start - 30) continue;
    const key = `${day.year}-${String(day.month + 1).padStart(2,'0')}-${String(day.day).padStart(2,'0')}`;
    wanted.add(key);
    let button = dayLayer.querySelector(`[data-period-key="${CSS.escape(key)}"]`);
    if (!button) {
      const date = new Date(Number(day.year), Number(day.month), Number(day.day));
      const label = date.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
      button = groupButton('day', key, label);
      button.classList.add('day-group-control');
      dayLayer.append(button);
    }
    button.style.left = `${Number(day.x).toFixed(2)}px`;
    button.style.top = `${(Number(day.top) - 19).toFixed(2)}px`;
  }
  for (const button of dayLayer.querySelectorAll('[data-period-key]')) {
    if (!wanted.has(button.dataset.periodKey || '')) button.remove();
  }
}

function rowForIndex(index) {
  if (!layout || !Number.isInteger(index) || index < 0 || index >= layout.itemRows.length) return -1;
  return Number(layout.itemRows[index]);
}

function visibleIndex() {
  if (!layout?.rowStarts?.length) return 0;
  const row = findFirstRow(layout, localYForScroll());
  return Number(layout.rowStarts[Math.max(0, row)]) || 0;
}

function railLabel(index) {
  const item = model?.items?.[Math.max(0, Math.min((model?.items?.length || 1) - 1, index))];
  if (!item) return '';
  if (model?.sort === 'size-desc') return formatBytes(item[6]);
  const date = new Date(Number(item[5]) || 0);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year:'numeric', month:'long' });
}

function railEntries() {
  const items = model?.items || [];
  if (!items.length) return [];
  if (model?.sort === 'size-desc') {
    const count = Math.min(18, items.length);
    const indexes = [...new Set(Array.from({ length:count }, (_, i) => Math.round(i * (items.length - 1) / Math.max(1, count - 1))))];
    return indexes.map((index, i) => ({
      index,
      label:formatBytes(items[index]?.[6]),
      short:formatBytes(items[index]?.[6]),
      position:items.length === 1 ? 0 : index / (items.length - 1),
      major:i % 3 === 0 || i === indexes.length - 1
    }));
  }

  const groups = [];
  let previous = '';
  for (let index = 0; index < items.length; index++) {
    const date = new Date(Number(items[index]?.[5]) || 0);
    if (Number.isNaN(date.getTime())) continue;
    const year = date.getFullYear();
    const key = `${year}-${date.getMonth()}`;
    if (key === previous) continue;
    previous = key;
    groups.push({
      index,
      year,
      label:date.toLocaleDateString(undefined, { year:'numeric', month:'long' })
    });
  }
  const compact = groups.length > 18;
  let lastYear = null;
  return groups.map(group => {
    const major = !compact || group.year !== lastYear;
    lastYear = group.year;
    return {
      ...group,
      short:compact && major ? String(group.year) : group.label,
      position:items.length === 1 ? 0 : group.index / (items.length - 1),
      major
    };
  });
}

function ensureRailShell() {
  if (!rail) return;
  rail.hidden = !layout?.count;
  document.documentElement.classList.toggle('library-scroll', Boolean(layout?.count));
  if (!layout?.count) {
    railKey = '';
    rail.replaceChildren();
    return;
  }

  const entries = railEntries();
  const nextKey = entries.map(entry => `${entry.index}:${entry.short}:${entry.major ? 1 : 0}`).join('|');
  if (nextKey !== railKey || !rail.querySelector('#railThumb')) {
    railKey = nextKey;
    rail.innerHTML = `<div class="rail-track"></div>${entries.map(entry => `<button data-index="${entry.index}" class="rail-tick ${entry.major ? 'major' : ''}" style="top:${(entry.position * 100).toFixed(3)}%" title="${escapeHtml(entry.label)}"><span>${escapeHtml(entry.short)}</span><i></i></button>`).join('')}<div id="railThumb" class="rail-thumb"><span></span><i></i></div>`;
  }
}

function updateRail() {
  if (!owned || !layout?.count || !rail || rail.hidden) return;
  const index = visibleIndex();
  const thumb = rail.querySelector('#railThumb');
  if (thumb) {
    thumb.style.top = `${(layout.count === 1 ? 0 : index / (layout.count - 1)) * 100}%`;
    const label = thumb.querySelector('span');
    if (label) label.textContent = railLabel(index);
  }

  let active = null;
  let distance = Infinity;
  for (const tick of rail.querySelectorAll('[data-index]')) {
    const next = Math.abs(Number(tick.dataset.index) - index);
    if (next < distance) {
      distance = next;
      active = tick;
    }
  }
  for (const tick of rail.querySelectorAll('[data-index]')) tick.classList.toggle('active', tick === active);
}

function renderCurrent() {
  renderFrame = 0;
  if (!owned || !layout || !plane?.isConnected) return;
  metrics.scrollFrames++;
  const windowRows = rowsForScroll(layout, scrollY, MOUNT_AHEAD, MOUNT_BEHIND);
  materializeRows(windowRows.rows);
  mountedStart = windowRows.range.start;
  mountedEnd = windowRows.range.end;
  trimRows(scrollY);
  syncDayButtons(windowRows.range);
  updateRail();
}

function scheduleRows(force = false) {
  if (!owned || !layout) return;
  if (!force) {
    const top = localYForScroll();
    const margin = viewportHeight * RENDER_MARGIN;
    if (top >= mountedStart + margin && top + viewportHeight <= mountedEnd - margin) return;
  }
  if (!renderFrame) renderFrame = requestAnimationFrame(renderCurrent);
}

function makePlane() {
  const nextPlane = document.createElement('div');
  nextPlane.className = 'stable-media-plane';
  const nextRows = document.createElement('div');
  nextRows.className = 'stable-grid-rows';
  const nextHeaders = buildHeaderLayer();
  const nextDays = document.createElement('div');
  nextDays.className = 'stable-grid-days';
  nextPlane.append(nextRows, nextHeaders, nextDays);
  return { plane:nextPlane, rows:nextRows, headers:nextHeaders, days:nextDays };
}

function installEmpty() {
  owned = true;
  layout = { count:0, totalHeight:1, rowTops:new Float32Array(), rowHeights:new Float32Array(), rowStarts:new Uint32Array(), itemRows:new Uint32Array(), headers:[], dayStarts:[] };
  renderedRows.clear();
  document.documentElement.classList.add('stable-grid-owned');
  files.className = 'files grid stable-grid-files';
  files.style.height = '1px';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = 'No files.';
  files.replaceChildren(empty);
  railKey = '';
  rail?.replaceChildren();
  if (rail) rail.hidden = true;
}

function installLayout(nextLayout) {
  if (!model || nextLayout.generation !== generation) return;
  if (owned && interactionActive()) {
    pendingLayout = nextLayout;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(applyPendingLayout, 220);
    return;
  }

  layout = nextLayout;
  pendingLayout = null;
  renderedRows = new Map();
  owned = true;
  metrics.layoutInstalls++;
  document.documentElement.classList.add('stable-grid-owned');
  files.className = 'files grid stable-grid-files';
  files.style.height = `${Math.ceil(layout.totalHeight)}px`;

  const built = makePlane();
  plane = built.plane;
  rowLayer = built.rows;
  headerLayer = built.headers;
  dayLayer = built.days;
  files.replaceChildren(plane);
  document.querySelector('#top-scroll-sentinel')?.setAttribute('hidden','');
  document.querySelector('#scroll-sentinel')?.setAttribute('hidden','');
  measureViewport();
  mountedStart = 0;
  mountedEnd = 0;
  ensureRailShell();
  scheduleRows(true);
  window.dispatchEvent(new CustomEvent('mochimono:stable-grid-installed'));
}

function applyPendingLayout() {
  pendingTimer = 0;
  if (!pendingLayout) return;
  if (interactionActive()) {
    pendingTimer = setTimeout(applyPendingLayout, 120);
    return;
  }
  const next = pendingLayout;
  pendingLayout = null;
  installLayout(next);
}

function build() {
  if (!worker || !model) return;
  if (!model.items.length) {
    generation++;
    building = false;
    pendingLayout = null;
    installEmpty();
    return;
  }
  const width = currentWidth();
  if (width < 200) {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(build, 60);
    return;
  }
  const target = currentTarget();
  const nextGeneration = ++generation;
  buildConfig = { generation:nextGeneration, width, target, sort:model.sort, gap:ROW_GAP };
  building = true;
  metrics.modelBuilds++;
  performance.mark?.(`mochimono-grid-build-${nextGeneration}-start`);
  worker.postMessage({
    type:'build',
    generation:nextGeneration,
    config:{ width, target, sort:model.sort, gap:ROW_GAP },
    items:model.items
  });
}

function setModel(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) {
    release();
    return false;
  }
  model = snapshot;
  build();
  return true;
}

function release() {
  generation++;
  building = false;
  model = null;
  layout = null;
  pendingLayout = null;
  clearTimeout(pendingTimer);
  pendingTimer = 0;
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  owned = false;
  plane = null;
  rowLayer = null;
  headerLayer = null;
  dayLayer = null;
  renderedRows.clear();
  railKey = '';
  document.documentElement.classList.remove('stable-grid-owned');
  files?.style.removeProperty('height');
  railScrub = false;
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
  index = Number(index);
  const row = rowForIndex(index);
  if (row < 0) return false;
  const top = filesDocumentTop + Number(layout.rowTops[row] || 0);
  const height = Number(layout.rowHeights[row] || 0);
  let target = top - viewportTop;
  if (block === 'center') target -= Math.max(0, (viewportHeight - height) / 2);
  else if (block === 'end') target -= Math.max(0, viewportHeight - height);
  target = Math.max(0, target);
  const nearby = rowsForScroll(layout, target, 2.5, 2.5, false);
  materializeRows(nearby.rows);
  window.scrollTo({ top:target, left:0, behavior:'auto' });
  scheduleRows(true);
  return true;
}

function installRail() {
  if (!rail || rail.dataset.stableRail === '1') return;
  rail.dataset.stableRail = '1';
  const indexFromEvent = event => {
    if (!layout?.count) return 0;
    const rect = rail.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) * (layout.count - 1));
  };
  const move = (event, final = false) => {
    const now = performance.now();
    if (!final && now - lastRailMove < 32) return;
    lastRailMove = now;
    scrollToIndex(indexFromEvent(event), 'center');
  };
  rail.addEventListener('pointerdown', event => {
    if (!owned || rail.hidden) return;
    railScrub = true;
    rail.classList.add('dragging');
    try { rail.setPointerCapture(event.pointerId); } catch {}
    move(event, true);
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

worker?.addEventListener('message', event => {
  const message = event.data || {};
  if (Number(message.generation) !== generation) return;
  building = false;
  if (message.type === 'error') {
    console.error('Grid geometry build failed.', message.message || 'unknown error');
    return;
  }
  if (message.type !== 'ready' || !model || !buildConfig) return;
  if (currentWidth() !== buildConfig.width || currentTarget() !== buildConfig.target) {
    build();
    return;
  }
  metrics.workerReady++;
  metrics.lastWorkerBuildMs = Number(message.buildMs) || 0;
  try {
    performance.mark?.(`mochimono-grid-build-${generation}-ready`);
    performance.measure?.(`mochimono-grid-build-${generation}`, `mochimono-grid-build-${generation}-start`, `mochimono-grid-build-${generation}-ready`);
  } catch {}
  const nextLayout = {
    generation,
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
    dayStarts:message.dayStarts || []
  };
  if (!owned) installLayout(nextLayout);
  else if (interactionActive()) {
    pendingLayout = nextLayout;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(applyPendingLayout, 220);
  } else installLayout(nextLayout);
});

worker?.addEventListener('error', event => {
  building = false;
  console.error('Grid worker failed to load.', event.message || event);
});

window.addEventListener('scroll', () => {
  if (!owned) return;
  const y = scrollY;
  if (Math.abs(y - lastScrollY) > 1) scrollDirection = y > lastScrollY ? 1 : -1;
  lastScrollY = y;
  lastScrollAt = performance.now();
  scheduleRows(false);
}, { passive:true });

window.addEventListener('resize', () => {
  measureViewport();
  if (!model) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(build, 100);
}, { passive:true });

window.addEventListener('mochimono:media-size', () => {
  if (!model) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(build, 40);
});

window.addEventListener('mochimono:grid-interaction-end', () => {
  if (pendingLayout) {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(applyPendingLayout, 30);
  }
  scheduleRows(false);
});

if (typeof ResizeObserver === 'function' && files) {
  new ResizeObserver(entries => {
    const width = Math.round(entries[0]?.contentRect?.width || currentWidth());
    if (!width || width === observedWidth) return;
    observedWidth = width;
    measureViewport();
    if (!model) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(build, 20);
  }).observe(files);
}

window.mochimonoStableGrid = {
  setModel,
  release,
  active:() => owned,
  owns:() => owned,
  count:() => layout?.count || 0,
  ensureIndex,
  scrollToIndex,
  visibleIndex,
  state:() => ({
    active:owned,
    building,
    generation,
    rows:layout?.rowTops?.length || 0,
    rendered:renderedRows.size,
    totalHeight:layout?.totalHeight || 0,
    width:buildConfig?.width || 0,
    metrics:{ ...metrics }
  })
};

installRail();
measureViewport();
observedWidth = currentWidth();
