const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');
const fileCount = document.querySelector('#fileCount');
const commandbar = document.querySelector('.commandbar');

const MODE_KEY = 'mochimono-visual-order-mode';
const MODES = {
  flow:{ label:'Flow', description:'Shape + color' },
  structure:{ label:'Structure', description:'Shape and composition' },
  color:{ label:'Color', description:'Color wheel' }
};

let mode = (() => {
  const saved = localStorage.getItem(MODE_KEY);
  return MODES[saved] ? saved : 'flow';
})();
let wanted = false;
let active = false;
let indexing = false;
let generation = 0;
let controller = null;
let rerunTimer = 0;
let sourceModel = null;
let visualModel = null;
let ordered = [];
let orderedFiles = new Map();
let originalFilteredHashes = null;
let wrappedGrid = null;
let originalSetModel = null;
let resetScrollNext = false;
let pendingScrollAnchor = null;

const option = document.createElement('option');
option.value = 'visual';
option.textContent = 'Visual';
option.title = 'Arrange all media into a continuous visual flow';
if (sort && !sort.querySelector('option[value="visual"]')) {
  const similar = sort.querySelector('option[value="similar"]');
  similar ? similar.after(option) : sort.append(option);
}

const style = document.createElement('style');
style.textContent = `
.visual-sort-bar{margin:10px 0 6px;padding:9px 10px;display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:#171518;color:#d8cfcb}
.visual-sort-bar[hidden]{display:none!important}.visual-sort-copy{min-width:0;flex:1;display:grid;gap:5px}.visual-sort-head{display:flex;align-items:center;gap:9px;min-width:0}.visual-sort-head strong{font-size:11px;white-space:nowrap}.visual-sort-modes{display:flex;gap:3px;min-width:0}.visual-sort-modes button{height:25px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#8e8582;font-size:10px;font-weight:650}.visual-sort-modes button:hover{background:#252126;color:#ddd5d1}.visual-sort-modes button.active{background:#eee8e4;color:#171416}.visual-sort-copy>span{color:#8e8582;font-size:10px}.visual-sort-progress{height:3px;overflow:hidden;border-radius:99px;background:#282429}.visual-sort-progress i{display:block;height:100%;width:0;background:#efa09a;transition:width .12s linear}.visual-sort-close{width:30px;height:30px;padding:0;display:grid;place-items:center;background:transparent;color:#9b9290;font-size:18px}.visual-sort-close:hover{background:#29252a;color:#fff}
html.visual-sort-indexing:not(.visual-sort-active) #files{visibility:hidden!important}
html.visual-sort-active #dateRail,html.visual-sort-indexing #dateRail{display:none!important}
`;
document.head.append(style);

const bar = document.createElement('div');
bar.className = 'visual-sort-bar';
bar.hidden = true;
bar.innerHTML = `<div class="visual-sort-copy"><div class="visual-sort-head"><strong>Visual order</strong><div class="visual-sort-modes">${Object.entries(MODES).map(([key, value]) => `<button type="button" data-visual-mode="${key}">${value.label}</button>`).join('')}</div></div><span></span><div class="visual-sort-progress"><i></i></div></div><button class="visual-sort-close" type="button" title="Return to newest" aria-label="Return to newest">×</button>`;
files?.before(bar);
const status = bar.querySelector('.visual-sort-copy > span');
const progress = bar.querySelector('.visual-sort-progress > i');

function syncModeButtons() {
  for (const button of bar.querySelectorAll('[data-visual-mode]')) button.classList.toggle('active', button.dataset.visualMode === mode);
}
syncModeButtons();

function updateProgress(done, total, text) {
  status.textContent = text;
  progress.style.width = `${total ? Math.max(2, Math.min(100, done / total * 100)) : 0}%`;
}

function sourceItems() {
  return Array.isArray(sourceModel?.items) ? sourceModel.items : [];
}

function modelMedia() {
  return sourceItems().filter(item => item?.[2] === 'image' || item?.[2] === 'video').map(item => ({
    hash:String(item[0] || ''),
    filename:String(item[1] || ''),
    type:String(item[2] || 'image'),
    width:Number(item[3]) || 0,
    height:Number(item[4]) || 0,
    dateMs:Number(item[5]) || 0,
    size:Number(item[6]) || 0
  })).filter(file => /^[a-f0-9]{64}$/.test(file.hash));
}

function otherItems(mediaHashes) {
  return sourceItems().filter(item => !mediaHashes.has(String(item?.[0] || '')));
}

function runWorker(media, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./visual-order-worker.js', import.meta.url), { type:'module' });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      callback(value);
    };
    const abort = () => finish(reject, signal?.reason || new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once:true });
    worker.onerror = event => finish(reject, new Error(event.message || 'Visual ordering worker failed'));
    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'progress') {
        const done = Number(data.done) || 0;
        const total = Number(data.total) || media.length;
        updateProgress(done, total, data.stage === 'ordering'
          ? `Arranging ${total.toLocaleString()} media…`
          : `Reading visual descriptors · ${done.toLocaleString()} / ${total.toLocaleString()}`);
        return;
      }
      if (data.type === 'error') return finish(reject, new Error(data.error || 'Could not build visual order'));
      if (data.type !== 'result' || !data.result) return;
      finish(resolve, data.result);
    };
    worker.postMessage({ media, mode });
  });
}

function tuple(file) {
  return [file.hash, file.filename || file.hash, file.type || 'image', file.width || 0, file.height || 0, file.dateMs || 0, file.size || 0];
}

function patchFilteredHashes() {
  const library = window.mochimonoLibrary;
  if (!library || originalFilteredHashes) return;
  originalFilteredHashes = library.filteredHashes;
  library.filteredHashes = () => active ? [...ordered] : originalFilteredHashes.call(library);
}

function restoreFilteredHashes() {
  const library = window.mochimonoLibrary;
  if (library && originalFilteredHashes) library.filteredHashes = originalFilteredHashes;
  originalFilteredHashes = null;
}

function captureSourceModel(snapshot) {
  const modelSort = String(snapshot?.sort || '');
  if (!snapshot || !Array.isArray(snapshot.items) || modelSort.startsWith('visual-flow') || modelSort.startsWith('similarity')) return;
  sourceModel = snapshot;
  if (wanted && !document.documentElement.classList.contains('similarity-active')) scheduleActivate(active ? 90 : 20, false);
}

function wrapStableGrid() {
  const grid = window.mochimonoStableGrid;
  if (!grid) {
    requestAnimationFrame(wrapStableGrid);
    return;
  }
  if (wrappedGrid === grid) return;
  wrappedGrid = grid;
  originalSetModel = grid.setModel.bind(grid);
  grid.setModel = snapshot => {
    if (document.documentElement.classList.contains('similarity-active')) return originalSetModel(snapshot);
    if (wanted && !String(snapshot?.sort || '').startsWith('visual-flow')) {
      captureSourceModel(snapshot);
      if (visualModel) window.mochimonoGridModel = visualModel;
      return true;
    }
    return originalSetModel(snapshot);
  };
}

function captureScrollAnchor() {
  if (!active || !files) return null;
  const viewportTop = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  let best = null;
  for (const card of files.querySelectorAll('.file-card[data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= viewportTop || rect.top >= innerHeight) continue;
    const distance = Math.abs(rect.top - viewportTop);
    if (best && best.distance <= distance) continue;
    best = { preserve:true, hash:String(card.dataset.hash || ''), offset:rect.top - viewportTop, y:scrollY, distance };
  }
  if (!best?.hash) return null;
  delete best.distance;
  return best;
}

function refreshPendingScrollAnchor() {
  if (!pendingScrollAnchor?.preserve) return;
  const next = captureScrollAnchor();
  if (next) pendingScrollAnchor = next;
}

function restorePendingScrollAnchor() {
  const anchor = pendingScrollAnchor;
  pendingScrollAnchor = null;
  if (!anchor) return;
  if (anchor.reset) {
    scrollTo({ top:0, left:0, behavior:'auto' });
    return;
  }
  const index = ordered.indexOf(anchor.hash);
  if (index < 0 || !window.mochimonoStableGrid?.scrollToIndex?.(index, 'start')) {
    scrollTo({ top:Math.max(0, Number(anchor.y) || 0), left:0, behavior:'auto' });
    return;
  }
  requestAnimationFrame(() => {
    const card = files.querySelector(`.file-card[data-hash="${anchor.hash}"]`);
    if (!card) return;
    const viewportTop = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
    const targetTop = viewportTop + (Number(anchor.offset) || 0);
    const correction = card.getBoundingClientRect().top - targetTop;
    if (Math.abs(correction) > 1) scrollBy({ top:correction, left:0, behavior:'auto' });
  });
}

function install(result, media, resetScroll) {
  pendingScrollAnchor = resetScroll
    ? { reset:true }
    : captureScrollAnchor() || { preserve:true, hash:'', offset:0, y:scrollY };

  const orderedMedia = Array.isArray(result.order) ? result.order : [];
  const mediaHashes = new Set(orderedMedia.map(file => file.hash));
  const others = otherItems(mediaHashes);
  orderedFiles = new Map(orderedMedia.map(file => [file.hash, file]));
  ordered = [...orderedMedia.map(file => file.hash), ...others.map(item => String(item?.[0] || '')).filter(Boolean)];
  active = true;
  indexing = false;
  document.documentElement.classList.add('visual-sort-active');
  document.documentElement.classList.remove('visual-sort-indexing');
  patchFilteredHashes();

  visualModel = {
    version:`visual-flow:${mode}:${generation}:${ordered.length}`,
    sort:`visual-flow:${mode}:${generation}`,
    items:[...orderedMedia.map(tuple), ...others]
  };
  window.mochimonoGridModel = visualModel;
  originalSetModel?.(visualModel);

  bar.hidden = false;
  syncModeButtons();
  const unavailable = Number(result.unavailable) || 0;
  const description = MODES[mode].description;
  updateProgress(media.length, media.length, `${description} · ${(Number(result.indexed) || 0).toLocaleString()} media${unavailable ? ` · ${unavailable.toLocaleString()} without thumbnails` : ''}`);
  if (fileCount) {
    fileCount.hidden = false;
    fileCount.textContent = `${ordered.length.toLocaleString()} files`;
    fileCount.title = `Visual order: ${description}`;
  }
}

function deactivate() {
  generation++;
  clearTimeout(rerunTimer);
  controller?.abort();
  controller = null;
  active = false;
  indexing = false;
  visualModel = null;
  ordered = [];
  orderedFiles.clear();
  pendingScrollAnchor = null;
  restoreFilteredHashes();
  document.documentElement.classList.remove('visual-sort-active','visual-sort-indexing');
  bar.hidden = true;
}

async function activate() {
  if (!wanted || sort?.value !== 'visual' || document.documentElement.classList.contains('similarity-active')) return;
  const gridButton = views?.querySelector('[data-view="grid"]');
  if (!gridButton?.classList.contains('active')) {
    gridButton?.click();
    scheduleActivate(20, resetScrollNext);
    return;
  }

  if (!sourceModel) {
    const current = window.mochimonoGridModel;
    if (current && !String(current.sort || '').startsWith('visual-flow') && !String(current.sort || '').startsWith('similarity')) sourceModel = current;
  }
  const media = modelMedia();
  const resetScroll = resetScrollNext || !active;
  resetScrollNext = false;
  if (!media.length) {
    indexing = false;
    document.documentElement.classList.remove('visual-sort-indexing');
    bar.hidden = false;
    updateProgress(0, 1, 'No images or videos in this view.');
    return;
  }

  const mine = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  indexing = true;
  bar.hidden = false;
  syncModeButtons();
  document.documentElement.classList.add('visual-sort-indexing');
  updateProgress(0, media.length, 'Reading visual descriptors…');

  try {
    const result = await runWorker(media, signal);
    if (mine !== generation || signal.aborted || !wanted) return;
    install(result, media, resetScroll);
  } catch (error) {
    if (mine !== generation || signal.aborted) return;
    indexing = false;
    document.documentElement.classList.remove('visual-sort-indexing');
    updateProgress(0, 1, error.message || 'Could not build visual order');
  }
}

function scheduleActivate(delay = 0, resetScroll = false) {
  clearTimeout(rerunTimer);
  if (!wanted || sort?.value !== 'visual') return;
  resetScrollNext ||= resetScroll;
  bar.hidden = false;
  if (!active) document.documentElement.classList.add('visual-sort-indexing');
  rerunTimer = setTimeout(activate, Math.max(0, delay));
}

function currentViewerHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function navigateViewer(step) {
  if (!active || viewer?.hidden !== false) return false;
  const mediaOrder = ordered.filter(hash => orderedFiles.has(hash));
  const index = mediaOrder.indexOf(currentViewerHash());
  const hash = mediaOrder[index + step];
  if (!hash) return false;
  window.mochimonoOpenViewer?.(hash, orderedFiles.get(hash));
  requestAnimationFrame(syncViewerNav);
  return true;
}

function syncViewerNav() {
  if (!active || viewer?.hidden !== false) return;
  const mediaOrder = ordered.filter(hash => orderedFiles.has(hash));
  const index = mediaOrder.indexOf(currentViewerHash());
  const previous = document.querySelector('#viewer-prev');
  const next = document.querySelector('#viewer-next');
  if (previous) previous.disabled = index <= 0;
  if (next) next.disabled = index < 0 || index >= mediaOrder.length - 1;
}

sort?.addEventListener('change', () => {
  if (sort.value === 'visual') {
    wanted = true;
    const current = window.mochimonoGridModel;
    if (current && !String(current.sort || '').startsWith('visual-flow') && !String(current.sort || '').startsWith('similarity')) sourceModel = current;
    scheduleActivate(30, true);
  } else {
    wanted = false;
    deactivate();
  }
}, true);

bar.addEventListener('click', event => {
  const button = event.target.closest('[data-visual-mode]');
  if (!button || !MODES[button.dataset.visualMode] || button.dataset.visualMode === mode) return;
  mode = button.dataset.visualMode;
  localStorage.setItem(MODE_KEY, mode);
  syncModeButtons();
  scheduleActivate(0, true);
});

views?.addEventListener('click', event => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (wanted && view && view !== 'grid') {
    wanted = false;
    window.mochimonoSimilaritySortLock?.release?.();
    sort.value = 'date-desc';
    sort.dispatchEvent(new Event('change', { bubbles:true }));
  }
}, true);

for (const button of [document.querySelector('#viewer-prev'), document.querySelector('#viewer-next')]) {
  button?.addEventListener('click', event => {
    if (!active || viewer?.hidden !== false) return;
    if (!navigateViewer(button.id === 'viewer-prev' ? -1 : 1)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

document.addEventListener('keydown', event => {
  if (!active || viewer?.hidden !== false || !['ArrowLeft','ArrowRight'].includes(event.key)) return;
  if (event.target.closest?.('#viewer video,#viewer input,#viewer textarea,#viewer select')) return;
  if (!navigateViewer(event.key === 'ArrowLeft' ? -1 : 1)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

files?.addEventListener('click', event => {
  if (!active || indexing || document.documentElement.classList.contains('selection-active') || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const card = event.target.closest('.file-card[data-hash]');
  if (!card || !orderedFiles.has(card.dataset.hash)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.mochimonoOpenViewer?.(card.dataset.hash, orderedFiles.get(card.dataset.hash));
}, true);

bar.querySelector('.visual-sort-close').addEventListener('click', () => {
  wanted = false;
  window.mochimonoSimilaritySortLock?.release?.();
  if (!sort) return;
  sort.value = 'date-desc';
  sort.dispatchEvent(new Event('change', { bubbles:true }));
});

window.addEventListener('scroll', refreshPendingScrollAnchor, { passive:true });
window.addEventListener('mochimono:stable-grid-installed', () => {
  if (!active) return;
  requestAnimationFrame(restorePendingScrollAnchor);
});
viewer && new MutationObserver(() => { if (active && !viewer.hidden) requestAnimationFrame(syncViewerNav); }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
viewerOpen && new MutationObserver(() => { if (active) requestAnimationFrame(syncViewerNav); }).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });

window.mochimonoVisualSort = {
  active:() => active,
  mode:() => mode,
  orderedHashes:() => active ? [...ordered] : null,
  refresh:() => scheduleActivate(0, false)
};

wrapStableGrid();