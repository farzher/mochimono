const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');
const fileCount = document.querySelector('#fileCount');
const dateRail = document.querySelector('#dateRail');

const MODE_KEY = 'mochimono-ai-global-sort-mode';
const CACHE_LIMIT = 4;
const WORKER_REVISION = Date.now().toString(36);
const WORKER_START_TIMEOUT = 4000;
const MODES = {
  flow:{ label:'Flow', description:'DINO neighborhoods + visual flow' },
  families:{ label:'Families', description:'Strong DINO visual neighborhoods' },
  color:{ label:'Color', description:'Color spectrum + locked DINO neighborhoods' },
  structure:{ label:'Structure', description:'Real composition + locked DINO neighborhoods' },
  meaning:{ label:'Meaning', description:'SigLIP semantic neighborhoods' },
  topics:{ label:'Topics', description:'Named semantic topics + locked DINO neighborhoods' },
  hybrid:{ label:'Hybrid', description:'DINO neighborhoods + SigLIP meaning' },
  moments:{ label:'Moments', description:'Chronology + locked DINO neighborhoods' }
};

let mode = MODES[localStorage.getItem(MODE_KEY)] ? localStorage.getItem(MODE_KEY) : 'flow';
let wanted = false;
let active = false;
let busy = false;
let generation = 0;
let rerunTimer = 0;
let worker = null;
let workerScript = '';
let pendingReject = null;
let pendingWorker = null;
let sourceModel = null;
let aiModel = null;
let ordered = [];
let orderedFiles = new Map();
let originalFilteredHashes = null;
let wrappedGrid = null;
let originalSetModel = null;
let installedKey = '';
let resetScrollNext = false;
let railEntries = [];
const cache = new Map();
const pauseReasons = new Set();

const option = document.createElement('option');
option.value = 'ai-global';
option.textContent = 'AI sort';
option.title = 'Arrange media with saved AI embeddings';
if (sort && !sort.querySelector('option[value="ai-global"]')) {
  const visual = sort.querySelector('option[value="visual"]');
  visual ? visual.after(option) : sort.append(option);
}

const style = document.createElement('style');
style.textContent = `
.ai-global-sort-bar{margin:10px 0 6px;padding:9px 10px;display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:#171518;color:#d8cfcb}
.ai-global-sort-bar[hidden],.ai-global-rail[hidden]{display:none!important}.ai-global-sort-copy{min-width:0;flex:1;display:grid;gap:5px}.ai-global-sort-head{display:flex;align-items:center;gap:9px;min-width:0;flex-wrap:wrap}.ai-global-sort-head strong{font-size:11px;white-space:nowrap}.ai-global-sort-modes{display:flex;gap:3px;min-width:0;flex-wrap:wrap}.ai-global-sort-modes button{height:25px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#8e8582;font-size:10px;font-weight:650}.ai-global-sort-modes button:hover{background:#252126;color:#ddd5d1}.ai-global-sort-modes button.active{background:#eee8e4;color:#171416}.ai-global-sort-copy>span{color:#8e8582;font-size:10px}.ai-global-sort-progress{height:3px;overflow:hidden;border-radius:99px;background:#282429}.ai-global-sort-progress i{display:block;height:100%;width:0;background:#efa09a;transition:width .12s linear}.ai-global-sort-close{width:30px;height:30px;padding:0;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#9b9290;font-size:18px}.ai-global-sort-close:hover{background:#29252a;color:#fff}
html.ai-global-sort-active #dateRail,html.ai-global-sort-indexing #dateRail{display:none!important}
`;
document.head.append(style);

const bar = document.createElement('div');
bar.className = 'ai-global-sort-bar';
bar.hidden = true;
bar.innerHTML = `<div class="ai-global-sort-copy"><div class="ai-global-sort-head"><strong>AI order</strong><div class="ai-global-sort-modes">${Object.entries(MODES).map(([key, value]) => `<button type="button" data-ai-global-mode="${key}" title="${value.description}">${value.label}</button>`).join('')}</div></div><span></span><div class="ai-global-sort-progress"><i></i></div></div><button class="ai-global-sort-close" type="button" title="Return to newest" aria-label="Return to newest">×</button>`;
files?.before(bar);
const status = bar.querySelector('.ai-global-sort-copy > span');
const progressBar = bar.querySelector('.ai-global-sort-progress > i');

const rail = document.createElement('nav');
rail.className = 'date-rail ai-global-rail';
rail.hidden = true;
rail.setAttribute('aria-label', 'Browse AI order');
dateRail?.after(rail);

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function syncModeButtons() {
  for (const button of bar.querySelectorAll('[data-ai-global-mode]')) button.classList.toggle('active', button.dataset.aiGlobalMode === mode);
}
syncModeButtons();

function updateProgress(done, total, text) {
  status.textContent = text;
  progressBar.style.width = `${total ? Math.max(2, Math.min(100, Number(done) / Math.max(1, Number(total)) * 100)) : 0}%`;
}

function sourceItems() { return Array.isArray(sourceModel?.items) ? sourceModel.items : []; }
function modelMedia() {
  return sourceItems().filter(item => item?.[2] === 'image' || item?.[2] === 'video').map(item => ({
    hash:String(item[0] || ''), filename:String(item[1] || ''), type:String(item[2] || 'image'),
    width:Number(item[3]) || 0, height:Number(item[4]) || 0, dateMs:Number(item[5]) || 0, size:Number(item[6]) || 0
  })).filter(file => /^[a-f0-9]{64}$/.test(file.hash));
}

function hashText(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619) >>> 0; }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function mediaIdentity(media) {
  let sum = 0, xor = 0, mix = 0;
  for (const file of media) {
    const value = hashText(`${file.hash}:${file.type}:${file.width}x${file.height}`);
    sum = (sum + value) >>> 0;
    xor ^= value;
    mix = (mix + Math.imul(value ^ 0x9e3779b9, 2654435761)) >>> 0;
  }
  return `${media.length}:${sum.toString(36)}:${(xor >>> 0).toString(36)}:${mix.toString(36)}`;
}

function runKeyFor(media, selectedMode) { return `${selectedMode}:${mediaIdentity(media)}`; }

function cacheResult(key, result) {
  cache.delete(key);
  cache.set(key, { ...result, order:[...(result.order || [])], rail:Array.isArray(result.rail) ? result.rail.map(entry => ({ ...entry })) : [] });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function cachedResult(key, media) {
  const value = cache.get(key);
  if (!value) return null;
  const allowed = new Set(media.map(file => file.hash));
  if (value.order.length !== media.length || value.order.some(hash => !allowed.has(hash))) { cache.delete(key); return null; }
  cache.delete(key);
  cache.set(key, value);
  return { ...value, order:[...value.order], rail:value.rail.map(entry => ({ ...entry })) };
}

function scriptFor() { return './ai-global-sort-worker-v2.js'; }

function abortError() {
  const error = new Error('Canceled');
  error.name = 'AbortError';
  return error;
}

function cancelPending(destroy = true) {
  const reject = pendingReject;
  pendingReject = null;
  pendingWorker = null;
  if (destroy && worker) {
    try { worker.terminate(); } catch {}
    worker = null;
    workerScript = '';
  }
  reject?.(abortError());
}

function ensureWorker(selectedMode) {
  const script = scriptFor(selectedMode);
  if (worker && workerScript === script) return worker;
  if (worker) {
    try { worker.terminate(); } catch {}
    worker = null;
  }
  workerScript = script;
  worker = new Worker(new URL(`${script}?run=${WORKER_REVISION}`, import.meta.url), { type:'module' });
  return worker;
}

function runWorker(media, selectedMode, attempt = 0) {
  return new Promise((resolve, reject) => {
    const target = ensureWorker(selectedMode);
    pendingReject = reject;
    pendingWorker = target;
    let settled = false;
    let heard = false;
    const startupTimer = setTimeout(() => {
      if (settled || heard || pendingWorker !== target) return;
      settled = true;
      if (pendingWorker === target) { pendingReject = null; pendingWorker = null; }
      try { target.terminate(); } catch {}
      if (worker === target) { worker = null; workerScript = ''; }
      if (attempt < 1) runWorker(media, selectedMode, attempt + 1).then(resolve, reject);
      else reject(new Error('AI sort worker did not start. Reload Mochimono and try again.'));
    }, WORKER_START_TIMEOUT);

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (pendingWorker === target) { pendingReject = null; pendingWorker = null; }
      callback(value);
    };

    target.onerror = event => {
      if (worker === target) { try { target.terminate(); } catch {} worker = null; workerScript = ''; }
      finish(reject, new Error(event.message || 'AI global sorting worker failed'));
    };
    target.onmessageerror = () => finish(reject, new Error('AI global sorting worker returned unreadable data'));
    target.onmessage = event => {
      heard = true;
      const data = event.data || {};
      if (data.type === 'progress') {
        updateProgress(Number(data.done) || 0, Number(data.total) || media.length, data.detail || `Arranging ${MODES[selectedMode].label}…`);
        return;
      }
      if (data.type === 'error') {
        const error = new Error(data.error || 'Could not build AI order');
        if (data.aborted) error.name = 'AbortError';
        return finish(reject, error);
      }
      if (data.type === 'result') finish(resolve, data.result || {});
    };
    target.postMessage({ action:'sort', payload:{ mode:selectedMode, media } });
  });
}

function destroyWorker() {
  cancelPending(true);
  if (worker) { try { worker.terminate(); } catch {} }
  worker = null;
  workerScript = '';
}

function tuple(file) { return [file.hash, file.filename || file.hash, file.type || 'image', file.width || 0, file.height || 0, file.dateMs || 0, file.size || 0]; }

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

function isSourceSnapshot(snapshot) {
  const value = String(snapshot?.sort || '');
  return snapshot && Array.isArray(snapshot.items) && !value.startsWith('ai-global-result') && !value.startsWith('visual-flow') && !value.startsWith('similarity');
}

function captureSourceModel(snapshot) {
  if (!isSourceSnapshot(snapshot)) return;
  sourceModel = snapshot;
  if (wanted && !pauseReasons.size && !document.documentElement.classList.contains('similarity-active')) scheduleActivate(active ? 70 : 20, false);
}

function wrapStableGrid() {
  const grid = window.mochimonoStableGrid;
  if (!grid) { requestAnimationFrame(wrapStableGrid); return; }
  if (wrappedGrid === grid) return;
  wrappedGrid = grid;
  originalSetModel = grid.setModel.bind(grid);
  grid.setModel = snapshot => {
    if (document.documentElement.classList.contains('similarity-active')) return originalSetModel(snapshot);
    if (wanted && isSourceSnapshot(snapshot)) {
      captureSourceModel(snapshot);
      if (aiModel) { window.mochimonoGridModel = aiModel; return true; }
    }
    return originalSetModel(snapshot);
  };
}

function compactRailEntries(entries, length) {
  const clean = (entries || []).map(entry => ({ index:Math.max(0, Math.min(length - 1, Number(entry.index) || 0)), label:String(entry.label || '') })).filter(entry => entry.label);
  if (clean.length <= 22) return clean;
  const step = Math.ceil(clean.length / 20);
  return clean.filter((_, index) => index === 0 || index === clean.length - 1 || index % step === 0);
}

function buildRail() {
  if (!active || ordered.length < 2) { rail.hidden = true; rail.replaceChildren(); return; }
  const entries = compactRailEntries(railEntries, ordered.length);
  const source = entries.length ? entries : Array.from({ length:Math.min(17, ordered.length) }, (_, i) => {
    const index = Math.round(i * (ordered.length - 1) / Math.max(1, Math.min(16, ordered.length - 1)));
    return { index, label:`${Math.round(index / Math.max(1, ordered.length - 1) * 100)}%` };
  });
  rail.hidden = false;
  rail.innerHTML = `<div class="rail-track"></div>${source.map((entry, i) => `<button data-index="${entry.index}" class="rail-tick major" style="top:${(entry.index / Math.max(1, ordered.length - 1) * 100).toFixed(3)}%" title="${escapeHtml(entry.label)}"><span>${i % 2 === 0 || source.length < 12 ? escapeHtml(entry.label) : ''}</span></button>`).join('')}`;
}

function install(result, media, resetScroll, key, selectedMode) {
  const byHash = new Map(media.map(file => [file.hash, file]));
  const orderedMedia = (result.order || []).map(hash => byHash.get(hash)).filter(Boolean);
  if (orderedMedia.length !== media.length) throw new Error(`AI order returned ${orderedMedia.length.toLocaleString()} / ${media.length.toLocaleString()} media`);
  orderedFiles = new Map(orderedMedia.map(file => [file.hash, file]));
  ordered = orderedMedia.map(file => file.hash);
  railEntries = Array.isArray(result.rail) ? result.rail.map(entry => ({ ...entry })) : [];
  active = true;
  busy = false;
  installedKey = key;
  document.documentElement.classList.add('ai-global-sort-active');
  document.documentElement.classList.remove('ai-global-sort-indexing');
  patchFilteredHashes();

  aiModel = { version:`ai-global-result:${selectedMode}:${generation}:${ordered.length}`, sort:`ai-global-result:${selectedMode}:${generation}`, items:orderedMedia.map(tuple) };
  window.mochimonoGridModel = aiModel;
  originalSetModel?.(aiModel);
  bar.hidden = false;
  syncModeButtons();
  buildRail();
  const unavailable = Number(result.unavailable) || 0;
  const families = Number(result.families) || 0;
  const familyText = families ? ` · ${families.toLocaleString()} neighborhoods` : '';
  updateProgress(media.length, media.length, `${MODES[selectedMode].description} · ${(Number(result.indexed) || 0).toLocaleString()} indexed${familyText}${unavailable ? ` · ${unavailable.toLocaleString()} appended without required embedding` : ''}`);
  if (fileCount) {
    fileCount.hidden = false;
    fileCount.textContent = `${ordered.length.toLocaleString()} media`;
    fileCount.title = `AI order: ${MODES[selectedMode].description}`;
  }
  if (resetScroll) requestAnimationFrame(() => scrollTo({ top:0, left:0, behavior:'auto' }));
}

function pause(reason = 'external') {
  pauseReasons.add(String(reason || 'external'));
  clearTimeout(rerunTimer);
  if (busy) {
    generation++;
    cancelPending(true);
    busy = false;
    document.documentElement.classList.remove('ai-global-sort-indexing');
  }
}

function resume(reason = 'external') {
  pauseReasons.delete(String(reason || 'external'));
  if (!pauseReasons.size && wanted && sort?.value === 'ai-global') scheduleActivate(30, false);
}

function deactivate() {
  generation++;
  clearTimeout(rerunTimer);
  destroyWorker();
  active = false;
  busy = false;
  aiModel = null;
  ordered = [];
  orderedFiles.clear();
  railEntries = [];
  installedKey = '';
  restoreFilteredHashes();
  document.documentElement.classList.remove('ai-global-sort-active','ai-global-sort-indexing');
  bar.hidden = true;
  rail.hidden = true;
  rail.replaceChildren();
}

async function activate() {
  if (pauseReasons.size || !wanted || sort?.value !== 'ai-global' || document.documentElement.classList.contains('similarity-active')) return;
  const gridButton = views?.querySelector('[data-view="grid"]');
  if (!gridButton?.classList.contains('active')) {
    gridButton?.click();
    scheduleActivate(20, resetScrollNext);
    return;
  }

  if (!sourceModel) {
    const current = window.mochimonoGridModel;
    if (isSourceSnapshot(current)) sourceModel = current;
  }
  const media = modelMedia();
  const selectedMode = mode;
  const resetScroll = resetScrollNext || !active;
  resetScrollNext = false;
  if (!media.length) {
    busy = false;
    document.documentElement.classList.remove('ai-global-sort-indexing');
    bar.hidden = false;
    updateProgress(0, 1, 'No images or videos in this view.');
    return;
  }

  const key = runKeyFor(media, selectedMode);
  if (active && installedKey === key) return;
  const cached = cachedResult(key, media);
  if (cached) {
    generation++;
    if (busy) cancelPending(true);
    install(cached, media, resetScroll, key, selectedMode);
    return;
  }

  if (busy) cancelPending(true);
  const mine = ++generation;
  busy = true;
  bar.hidden = false;
  syncModeButtons();
  document.documentElement.classList.add('ai-global-sort-indexing');
  updateProgress(0, media.length, `Starting ${MODES[selectedMode].label} AI order…`);
  try {
    const result = await runWorker(media, selectedMode);
    if (mine !== generation || selectedMode !== mode || !wanted || pauseReasons.size || document.documentElement.classList.contains('similarity-active')) return;
    cacheResult(key, result);
    install(result, media, resetScroll, key, selectedMode);
  } catch (error) {
    if (mine !== generation || error.name === 'AbortError') return;
    busy = false;
    document.documentElement.classList.remove('ai-global-sort-indexing');
    updateProgress(0, 1, error.message || 'Could not build AI order');
  }
}

function scheduleActivate(delay = 0, resetScroll = false) {
  clearTimeout(rerunTimer);
  resetScrollNext ||= resetScroll;
  if (!wanted || sort?.value !== 'ai-global' || pauseReasons.size) return;
  bar.hidden = false;
  document.documentElement.classList.add('ai-global-sort-indexing');
  rerunTimer = setTimeout(activate, Math.max(0, delay));
}

function currentViewerHash() { return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || ''; }
function navigateViewer(step) {
  if (!active || viewer?.hidden !== false) return false;
  const index = ordered.indexOf(currentViewerHash());
  const hash = ordered[index + step];
  if (!hash) return false;
  window.mochimonoOpenViewer?.(hash, orderedFiles.get(hash));
  return true;
}

sort?.addEventListener('change', () => {
  if (sort.value === 'ai-global') {
    wanted = true;
    const current = window.mochimonoGridModel;
    if (isSourceSnapshot(current)) sourceModel = current;
    scheduleActivate(30, true);
  } else {
    wanted = false;
    deactivate();
  }
}, true);

bar.addEventListener('click', event => {
  const button = event.target.closest('[data-ai-global-mode]');
  const nextMode = button?.dataset.aiGlobalMode;
  if (!MODES[nextMode] || nextMode === mode) return;
  mode = nextMode;
  localStorage.setItem(MODE_KEY, mode);
  syncModeButtons();
  if (busy) {
    generation++;
    cancelPending(true);
    busy = false;
  }
  installedKey = '';
  scheduleActivate(0, true);
});

bar.querySelector('.ai-global-sort-close').addEventListener('click', () => {
  wanted = false;
  if (!sort) return;
  sort.value = 'date-desc';
  sort.dispatchEvent(new Event('change', { bubbles:true }));
});

views?.addEventListener('click', event => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (wanted && view && view !== 'grid') {
    wanted = false;
    sort.value = 'date-desc';
    sort.dispatchEvent(new Event('change', { bubbles:true }));
  }
}, true);

rail.addEventListener('click', event => {
  const tick = event.target.closest('[data-index]');
  if (!active || !tick) return;
  window.mochimonoStableGrid?.scrollToIndex?.(Number(tick.dataset.index), 'center');
  event.preventDefault();
  event.stopImmediatePropagation();
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
  if (!active || busy || document.documentElement.classList.contains('selection-active') || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const card = event.target.closest('.file-card[data-hash]');
  if (!card || !orderedFiles.has(card.dataset.hash)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.mochimonoOpenViewer?.(card.dataset.hash, orderedFiles.get(card.dataset.hash));
}, true);

window.addEventListener('mochimono:visual-similarity-start', () => pause('find-similar'));
window.addEventListener('mochimono:visual-similarity-end', () => resume('find-similar'));
window.addEventListener('mochimono:ai-work-start', () => { if (busy) pause('ai-work'); });
window.addEventListener('mochimono:ai-work-end', () => { cache.clear(); resume('ai-work'); });

window.mochimonoAIGlobalSort = {
  active:() => active,
  busy:() => busy,
  mode:() => mode,
  modes:() => Object.keys(MODES),
  orderedHashes:() => active ? [...ordered] : null,
  refresh:() => { cache.clear(); installedKey = ''; scheduleActivate(0, false); },
  pause,
  resume,
  paused:() => [...pauseReasons],
  cache:() => ({ entries:cache.size, installedKey, worker:workerScript || null })
};

wrapStableGrid();
