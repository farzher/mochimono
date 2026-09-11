const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');
const fileCount = document.querySelector('#fileCount');
const dateRail = document.querySelector('#dateRail');

const MODE_KEY = 'mochimono-ai-global-sort-mode';
const CACHE_LIMIT = 3;
const MODES = {
  flow:{ label:'Flow', description:'DINO visual continuum', index:'Visual' },
  families:{ label:'Families', description:'DINO visual families', index:'Visual' },
  color:{ label:'Color', description:'Color spectrum + DINO similarity', index:'Visual' },
  structure:{ label:'Structure', description:'Composition + DINO similarity', index:'Visual' },
  meaning:{ label:'Meaning', description:'SigLIP semantic continuum', index:'Semantic' },
  topics:{ label:'Topics', description:'SigLIP semantic families', index:'Semantic' },
  hybrid:{ label:'Hybrid', description:'DINO appearance + SigLIP meaning', index:'Visual + Semantic' },
  moments:{ label:'Moments', description:'Chronology + DINO visual flow', index:'Visual' }
};

let mode = MODES[localStorage.getItem(MODE_KEY)] ? localStorage.getItem(MODE_KEY) : 'flow';
let wanted = false;
let active = false;
let indexing = false;
let generation = 0;
let rerunTimer = 0;
let worker = null;
let sourceModel = null;
let aiModel = null;
let ordered = [];
let orderedFiles = new Map();
let originalFilteredHashes = null;
let wrappedGrid = null;
let originalSetModel = null;
let installedKey = '';
let runningKey = '';
let resetScrollNext = false;
let railEntries = [];
const cache = new Map();
const pauseReasons = new Set();

const option = document.createElement('option');
option.value = 'ai-global';
option.textContent = 'AI sort';
option.title = 'Arrange the whole media library using persistent AI embeddings';
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

function hashText(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619) >>> 0; }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function mediaIdentity(media) {
  const tokens = media.map(file => `${file.hash}:${file.type}:${file.width}x${file.height}`).sort();
  let left = 2166136261, right = 2246822507;
  for (const token of tokens) { left = hashText(token, left); right = hashText(token, right ^ 0x9e3779b9); }
  return `${media.length}:${left.toString(36)}:${right.toString(36)}`;
}

function runKeyFor(media) { return `${mode}:${mediaIdentity(media)}`; }

function cacheResult(key, result) {
  cache.delete(key);
  cache.set(key, {
    ...result,
    order:[...(result.order || [])],
    rail:Array.isArray(result.rail) ? result.rail.map(entry => ({ ...entry })) : []
  });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function cachedResult(key, media) {
  const value = cache.get(key);
  if (!value) return null;
  const allowed = new Set(media.map(file => file.hash));
  if (value.order.length !== media.length || value.order.some(hash => !allowed.has(hash))) { cache.delete(key); return null; }
  cache.delete(key); cache.set(key, value);
  return { ...value, order:[...value.order], rail:value.rail.map(entry => ({ ...entry })) };
}

function runWorker(media) {
  return new Promise((resolve, reject) => {
    const target = new Worker(new URL('./ai-global-sort-worker.js', import.meta.url), { type:'module' });
    worker = target;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (worker === target) worker = null;
      try { target.terminate(); } catch {}
      callback(value);
    };
    target.onerror = event => finish(reject, new Error(event.message || 'AI global sorting worker failed'));
    target.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'progress') {
        updateProgress(Number(data.done) || 0, Number(data.total) || media.length, data.detail || 'Arranging AI order…');
        return;
      }
      if (data.type === 'error') {
        const error = new Error(data.error || 'Could not build AI order');
        if (data.aborted) error.name = 'AbortError';
        return finish(reject, error);
      }
      if (data.type === 'result') finish(resolve, data.result || {});
    };
    target.postMessage({ action:'sort', payload:{ mode, media } });
  });
}

function abortWorker() {
  if (!worker) return;
  try { worker.terminate(); } catch {}
  worker = null;
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

function captureSourceModel(snapshot) {
  const modelSort = String(snapshot?.sort || '');
  if (!snapshot || !Array.isArray(snapshot.items) || modelSort.startsWith('ai-global-result') || modelSort.startsWith('visual-flow') || modelSort.startsWith('similarity')) return;
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
    if (wanted && !String(snapshot?.sort || '').startsWith('ai-global-result')) {
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
  rail.innerHTML = `<div class="rail-track"></div>${source.map((entry, i) => `<button data-index="${entry.index}" class="rail-tick major" style="top:${(entry.index / Math.max(1, ordered.length - 1) * 100).toFixed(3)}%" title="${entry.label}"><span>${i % 2 === 0 || source.length < 12 ? entry.label : ''}</span></button>`).join('')}`;
}

function install(result, media, resetScroll, key) {
  const byHash = new Map(media.map(file => [file.hash, file]));
  const orderedMedia = (result.order || []).map(hash => byHash.get(hash)).filter(Boolean);
  if (orderedMedia.length !== media.length) throw new Error(`AI order returned ${orderedMedia.length.toLocaleString()} / ${media.length.toLocaleString()} media`);
  orderedFiles = new Map(orderedMedia.map(file => [file.hash, file]));
  ordered = orderedMedia.map(file => file.hash);
  railEntries = Array.isArray(result.rail) ? result.rail.map(entry => ({ ...entry })) : [];
  active = true;
  indexing = false;
  installedKey = key;
  runningKey = '';
  document.documentElement.classList.add('ai-global-sort-active');
  document.documentElement.classList.remove('ai-global-sort-indexing');
  patchFilteredHashes();

  aiModel = { version:`ai-global-result:${mode}:${generation}:${ordered.length}`, sort:`ai-global-result:${mode}:${generation}`, items:orderedMedia.map(tuple) };
  window.mochimonoGridModel = aiModel;
  originalSetModel?.(aiModel);
  bar.hidden = false;
  syncModeButtons();
  buildRail();
  const unavailable = Number(result.unavailable) || 0;
  const families = Number(result.families) || 0;
  const familyText = families ? ` · ${families.toLocaleString()} groups` : '';
  updateProgress(media.length, media.length, `${MODES[mode].description} · ${(Number(result.indexed) || 0).toLocaleString()} indexed${familyText}${unavailable ? ` · ${unavailable.toLocaleString()} appended without required embedding` : ''}`);
  if (fileCount) {
    fileCount.hidden = false;
    fileCount.textContent = `${ordered.length.toLocaleString()} media`;
    fileCount.title = `AI order: ${MODES[mode].description}`;
  }
  if (resetScroll) requestAnimationFrame(() => scrollTo({ top:0, left:0, behavior:'auto' }));
}

function pause(reason = 'external') {
  reason = String(reason || 'external');
  if (pauseReasons.has(reason)) return;
  pauseReasons.add(reason);
  clearTimeout(rerunTimer);
  if (indexing) {
    generation++;
    abortWorker();
    indexing = false;
    runningKey = '';
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
  abortWorker();
  active = false;
  indexing = false;
  aiModel = null;
  ordered = [];
  orderedFiles.clear();
  railEntries = [];
  installedKey = '';
  runningKey = '';
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
    if (current && !String(current.sort || '').startsWith('ai-global-result') && !String(current.sort || '').startsWith('visual-flow') && !String(current.sort || '').startsWith('similarity')) sourceModel = current;
  }
  const media = modelMedia();
  const resetScroll = resetScrollNext || !active;
  resetScrollNext = false;
  if (!media.length) {
    indexing = false;
    document.documentElement.classList.remove('ai-global-sort-indexing');
    bar.hidden = false;
    updateProgress(0, 1, 'No images or videos in this view.');
    return;
  }
  const key = runKeyFor(media);
  if (active && installedKey === key) return;
  if (indexing && runningKey === key) return;
  const cached = cachedResult(key, media);
  if (cached) {
    generation++;
    abortWorker();
    install(cached, media, resetScroll, key);
    return;
  }

  const mine = ++generation;
  abortWorker();
  runningKey = key;
  indexing = true;
  bar.hidden = false;
  syncModeButtons();
  document.documentElement.classList.add('ai-global-sort-indexing');
  updateProgress(0, media.length, `Opening ${MODES[mode].label} · requires ${MODES[mode].index} index…`);
  try {
    const result = await runWorker(media);
    if (mine !== generation || !wanted || pauseReasons.size || document.documentElement.classList.contains('similarity-active')) return;
    cacheResult(key, result);
    install(result, media, resetScroll, key);
  } catch (error) {
    if (mine !== generation || error.name === 'AbortError') return;
    indexing = false;
    runningKey = '';
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
    if (current && !String(current.sort || '').startsWith('ai-global-result') && !String(current.sort || '').startsWith('visual-flow') && !String(current.sort || '').startsWith('similarity')) sourceModel = current;
    scheduleActivate(30, true);
  } else {
    wanted = false;
    deactivate();
  }
}, true);

bar.addEventListener('click', event => {
  const button = event.target.closest('[data-ai-global-mode]');
  if (!button || !MODES[button.dataset.aiGlobalMode] || button.dataset.aiGlobalMode === mode) return;
  mode = button.dataset.aiGlobalMode;
  localStorage.setItem(MODE_KEY, mode);
  syncModeButtons();
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
  if (!active || indexing || document.documentElement.classList.contains('selection-active') || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const card = event.target.closest('.file-card[data-hash]');
  if (!card || !orderedFiles.has(card.dataset.hash)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.mochimonoOpenViewer?.(card.dataset.hash, orderedFiles.get(card.dataset.hash));
}, true);

window.addEventListener('mochimono:visual-similarity-start', () => pause('find-similar'));
window.addEventListener('mochimono:visual-similarity-end', () => resume('find-similar'));
window.addEventListener('mochimono:ai-work-start', () => { if (indexing) pause('ai-work'); });
window.addEventListener('mochimono:ai-work-end', () => { cache.clear(); resume('ai-work'); });

window.mochimonoAIGlobalSort = {
  active:() => active,
  mode:() => mode,
  modes:() => Object.keys(MODES),
  orderedHashes:() => active ? [...ordered] : null,
  refresh:() => { cache.clear(); scheduleActivate(0, false); },
  pause,
  resume,
  paused:() => [...pauseReasons],
  cache:() => ({ entries:cache.size, runningKey, installedKey })
};

wrapStableGrid();
