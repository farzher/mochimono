const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');
const viewerClose = document.querySelector('#viewer-close');
const viewerMenu = document.querySelector('#viewer-menu > div');
const viewerInfoButton = document.querySelector('#viewer-info-button');
const fileCount = document.querySelector('#fileCount');
const views = document.querySelector('#views');
const rail = document.querySelector('#dateRail');

const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const ROBUST_VERSION = 'phash32-dct16-v1';
const COLOR_VERSION = 'oklab-grid4-v2';
const THUMB_VERSION = 3;
const MAX_RESULTS = 500;
const MIN_SHORTLIST = 1200;
const SHORTLIST_MULTIPLIER = 4;
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const POPCOUNT16 = new Uint8Array(1 << 16);
for (let value = 1; value < POPCOUNT16.length; value++) POPCOUNT16[value] = POPCOUNT16[value >> 1] + (value & 1);

let active = false;
let indexing = false;
let generation = 0;
let controller = null;
let targetHash = '';
let targetName = '';
let resultFiles = new Map();
let resultOrder = [];
let scores = new Map();
let baseScrollY = 0;
let installingModel = false;
let resultModel = null;
let resetResultsScroll = false;
let wrappedGrid = null;
let originalSetModel = null;

const style = document.createElement('style');
style.textContent = `
.similarity-bar{margin:10px 0 6px;padding:9px 10px;display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:#171518;color:#d8cfcb}
.similarity-bar[hidden]{display:none!important}.similarity-bar img{width:42px;height:42px;flex:0 0 auto;object-fit:cover;border-radius:7px;background:#0b0a0c}.similarity-copy{min-width:0;flex:1;display:grid;gap:3px}.similarity-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.similarity-copy span{color:#8e8582;font-size:10px}.similarity-progress{height:3px;overflow:hidden;border-radius:99px;background:#282429}.similarity-progress i{display:block;height:100%;width:0;background:#efa09a;transition:width .12s linear}.similarity-close{width:30px;height:30px;padding:0;display:grid;place-items:center;background:transparent;color:#9b9290;font-size:18px;font-weight:400}.similarity-close:hover{background:#29252a;color:#fff}
html.similarity-indexing #files{visibility:hidden!important}.similarity-score{position:absolute;z-index:8;right:6px;top:6px;min-width:27px;height:19px;padding:0 6px;display:grid;place-items:center;border-radius:999px;background:rgba(13,12,14,.76);box-shadow:0 1px 6px rgba(0,0,0,.35);color:#f2eae6;font-size:9px;font-weight:800;line-height:1;pointer-events:none;backdrop-filter:blur(6px)}
html.similarity-active .date-rail{display:none!important}
`;
document.head.append(style);

const bar = document.createElement('div');
bar.className = 'similarity-bar';
bar.hidden = true;
bar.innerHTML = `<img alt=""><div class="similarity-copy"><strong></strong><span></span><div class="similarity-progress"><i></i></div></div><button class="similarity-close" type="button" title="Close similar images" aria-label="Close similar images">×</button>`;
files?.before(bar);
const barImage = bar.querySelector('img');
const barTitle = bar.querySelector('strong');
const barStatus = bar.querySelector('span');
const barProgress = bar.querySelector('i');

const findButton = document.createElement('button');
findButton.type = 'button';
findButton.className = 'viewer-menu-action';
findButton.textContent = 'Find similar';
findButton.title = 'Find visually similar images';
findButton.hidden = true;
if (viewerMenu) viewerMenu.insertBefore(findButton, viewerInfoButton || viewerMenu.firstChild);

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath:'hash' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function all(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function loadDescriptorRows() {
  const db = await openDb();
  try {
    const rows = await all(db.transaction(STORE, 'readonly').objectStore(STORE));
    return new Map(rows.map(row => [String(row.hash || ''), row]));
  } finally { db.close(); }
}

function extension(name) {
  return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
}

function isImage(file) {
  const mime = String(file?.mime || '').toLowerCase();
  return mime.startsWith('image/') || IMAGE_EXTENSIONS.has(extension(file?.filename || file?.originalPath));
}

async function browserFiles() {
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('mochimono-browser-folders', 1);
      request.onupgradeneeded = () => {
        const next = request.result;
        if (!next.objectStoreNames.contains('sources')) next.createObjectStore('sources', { keyPath:'id' });
        if (!next.objectStoreNames.contains('files')) next.createObjectStore('files', { keyPath:'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['sources','files'], 'readonly');
    const [sources, rows] = await Promise.all([all(tx.objectStore('sources')), all(tx.objectStore('files'))]);
    const byId = new Map(sources.map(source => [String(source.id || ''), source]));
    const result = [];
    for (const row of rows) {
      const hash = String(row.hash || '');
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      const separator = String(row.key || '').indexOf('\u0000');
      const source = byId.get(separator >= 0 ? String(row.key).slice(0, separator) : '');
      const filename = String(row.path || '').split('/').at(-1) || row.path || hash;
      const file = {
        hash,
        filename,
        originalPath:row.path || '',
        rootPath:source?.rootPath || source?.name || '',
        mime:row.mime || '',
        size:Number(row.size) || 0,
        width:Number(row.width) || 0,
        height:Number(row.height) || 0,
        fileDate:new Date(Number(row.lastModified) || Date.now()).toISOString(),
        createdAt:source?.createdAt || '',
        addedAt:source?.createdAt || '',
        browserSourceId:source?.id || ''
      };
      if (isImage(file)) result.push(file);
    }
    return result;
  } catch { return []; }
  finally { db?.close(); }
}

function gridImages() {
  const items = window.mochimonoGridModel?.items || [];
  return items.filter(item => item?.[2] === 'image').map(item => ({
    hash:String(item[0] || ''), filename:String(item[1] || ''), mime:'image/*',
    width:Number(item[3]) || 0, height:Number(item[4]) || 0,
    fileDate:new Date(Number(item[5]) || Date.now()).toISOString(), size:Number(item[6]) || 0
  }));
}

async function candidateImages() {
  const result = new Map();
  const cached = await window.mochimonoCatalogCache?.load?.().catch?.(() => null);
  for (const file of cached?.files || []) if (isImage(file) && /^[a-f0-9]{64}$/.test(String(file.hash || ''))) result.set(String(file.hash), file);
  for (const file of await browserFiles()) result.set(file.hash, { ...(result.get(file.hash) || {}), ...file });
  for (const file of gridImages()) if (!result.has(file.hash)) result.set(file.hash, file);
  return result;
}

function workerMedia(file) {
  return {
    hash:String(file.hash || ''),
    filename:String(file.filename || file.hash || ''),
    type:'image',
    width:Number(file.width) || 0,
    height:Number(file.height) || 0,
    dateMs:Date.parse(file.fileDate || file.createdAt || 0) || Number(file.dateMs) || 0,
    size:Number(file.size) || 0
  };
}

function indexDescriptors(media, mode, signal, label) {
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
    const abort = () => finish(reject, signal?.reason || new DOMException('Aborted','AbortError'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once:true });
    worker.onerror = event => finish(reject, new Error(event.message || 'Visual descriptor worker failed'));
    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'error') return finish(reject, new Error(data.error || 'Could not index visual descriptors'));
      if (data.type === 'progress') {
        const done = Number(data.done) || 0;
        const total = Number(data.total) || media.length;
        if (data.stage === 'ordering') return finish(resolve);
        setProgress(done, total, `${label} · ${done.toLocaleString()} / ${total.toLocaleString()}`);
        return;
      }
      if (data.type === 'result') finish(resolve);
    };
    worker.postMessage({ media, mode });
  });
}

function validRobust(row) {
  return row?.robustVersion === ROBUST_VERSION && /^[0-9a-f]{64}$/.test(String(row.robust || ''));
}

function validColor(row) {
  const value = row?.visualColor;
  return row?.visualColorVersion === COLOR_VERSION && Boolean(value) &&
    Array.isArray(value.grid) && value.grid.length === 15 && value.grid.every(Number.isFinite) &&
    ['meanChroma','colorFraction','meanSpread','dominantHue','dominantStrength'].every(key => Number.isFinite(value[key]));
}

function robustWords(value) {
  return Array.from({ length:16 }, (_, index) => parseInt(value.slice(index * 4, index * 4 + 4), 16));
}

function hamming(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index++) total += POPCOUNT16[left[index] ^ right[index]];
  return total;
}

function aspectFor(file) {
  return Math.max(1e-6, (Number(file?.width) || 1) / (Number(file?.height) || 1));
}

function aspectDistance(left, right) {
  return Math.abs(Math.log2(left / right));
}

function colorDistance(left, right) {
  if (!left || !right) return 0;
  let spatial = 0;
  for (let block = 0; block < 5; block++) {
    const offset = block * 3;
    const dL = left.grid[offset] - right.grid[offset];
    const da = left.grid[offset + 1] - right.grid[offset + 1];
    const db = left.grid[offset + 2] - right.grid[offset + 2];
    const distance = Math.sqrt(dL * dL * 1.15 + da * da * 1.8 + db * db * 1.8);
    spatial += block ? distance : distance * 2.2;
  }
  return Math.min(128, spatial / 6.2 * 220);
}

function roughDistance(target, candidate) {
  const structure = hamming(target.words, candidate.words);
  const aspect = Math.min(3, aspectDistance(target.aspect, candidate.aspect));
  return structure + aspect * 4;
}

function flowDistance(target, candidate) {
  const structure = hamming(target.words, candidate.words);
  const aspect = Math.min(3, aspectDistance(target.aspect, candidate.aspect));
  const color = colorDistance(target.color, candidate.color);
  return structure * .72 + color * .28 + aspect * 2.5;
}

function similarityScore(distance) {
  return Math.max(0, Math.min(100, Math.round(100 - Math.min(128, distance) * 100 / 128)));
}

function descriptor(file, row, needColor = false) {
  if (!validRobust(row) || (needColor && !validColor(row))) return null;
  return {
    file,
    words:robustWords(String(row.robust)),
    aspect:aspectFor(file),
    color:needColor ? row.visualColor : null
  };
}

async function rankCandidates(candidates, signal) {
  const media = [...candidates.values()].map(workerMedia);
  await indexDescriptors(media, 'structure', signal, 'Indexing structure');
  if (signal.aborted) throw signal.reason || new DOMException('Aborted','AbortError');

  let rows = await loadDescriptorRows();
  const targetFile = candidates.get(targetHash);
  const target = descriptor(targetFile, rows.get(targetHash));
  if (!target) throw new Error('This image has no usable thumbnail yet.');

  const rough = [];
  for (const file of candidates.values()) {
    if (file.hash === targetHash) continue;
    const value = descriptor(file, rows.get(file.hash));
    if (!value) continue;
    rough.push({ file, distance:roughDistance(target, value) });
  }
  rough.sort((a, b) => a.distance - b.distance || String(a.file.hash).localeCompare(String(b.file.hash)));

  const shortlistSize = Math.min(rough.length, Math.max(MIN_SHORTLIST, MAX_RESULTS * SHORTLIST_MULTIPLIER));
  const shortlist = rough.slice(0, shortlistSize).map(item => item.file);
  const colorMedia = [targetFile, ...shortlist].map(workerMedia);
  await indexDescriptors(colorMedia, 'flow', signal, 'Refining color');
  if (signal.aborted) throw signal.reason || new DOMException('Aborted','AbortError');

  rows = await loadDescriptorRows();
  const refinedTarget = descriptor(targetFile, rows.get(targetHash), true);
  if (!refinedTarget) throw new Error('This image has no usable visual descriptor yet.');

  const ranked = [];
  for (const file of shortlist) {
    const value = descriptor(file, rows.get(file.hash), true);
    if (!value) continue;
    const distance = flowDistance(refinedTarget, value);
    ranked.push({ file, distance, score:similarityScore(distance) });
  }
  ranked.sort((a, b) => a.distance - b.distance || String(a.file.hash).localeCompare(String(b.file.hash)));
  return { ranked:ranked.slice(0, MAX_RESULTS), indexed:rough.length };
}

function setProgress(done, total, text) {
  if (barStatus) barStatus.textContent = text;
  if (barProgress) barProgress.style.width = `${total ? Math.max(2, Math.min(100, done / total * 100)) : 0}%`;
}

function fileTuple(file) {
  const date = Date.parse(file.fileDate || file.createdAt || 0) || Number(file.dateMs) || 0;
  return [file.hash, file.filename || file.hash, 'image', Number(file.width) || 0, Number(file.height) || 0, date, Number(file.size) || 0];
}

function modelForResults() {
  return {
    version:`similarity-find:${targetHash}:${generation}`,
    sort:`similarity-find:${targetHash}`,
    items:resultOrder.map(hash => fileTuple(resultFiles.get(hash)))
  };
}

function installResultsModel() {
  if (!active || indexing) return;
  resultModel = modelForResults();
  installingModel = true;
  window.mochimonoGridModel = resultModel;
  window.mochimonoStableGrid?.setModel?.(resultModel);
  installingModel = false;
  resetResultsScroll = true;
  if (rail) rail.hidden = true;
  if (fileCount) {
    fileCount.hidden = false;
    fileCount.textContent = `${resultOrder.length.toLocaleString()} similar images`;
    fileCount.title = `Closest visual matches to ${targetName}`;
  }
  requestAnimationFrame(() => decorateScores(files));
}

function decorateScores(root) {
  if (!active || !root) return;
  const cards = [];
  if (root instanceof Element && root.matches?.('.file-card[data-hash]')) cards.push(root);
  root.querySelectorAll?.('.file-card[data-hash]').forEach(card => cards.push(card));
  for (const card of cards) {
    const value = scores.get(card.dataset.hash);
    if (value == null || card.querySelector(':scope > .similarity-score')) continue;
    const badge = document.createElement('span');
    badge.className = 'similarity-score';
    badge.textContent = String(value);
    badge.title = `Visual similarity ${value}`;
    card.append(badge);
  }
}

function updateFindButton() {
  findButton.hidden = !viewerMedia?.querySelector('img') || viewer?.hidden !== false;
}

function showBar(hash, name) {
  bar.hidden = false;
  barTitle.textContent = `Similar to ${name || hash}`;
  barImage.src = `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
}

function restoreNormalGrid() {
  document.querySelector('#sort')?.dispatchEvent(new Event('change', { bubbles:true }));
}

function exitSimilarity(restore = true) {
  generation++;
  controller?.abort();
  controller = null;
  active = false;
  indexing = false;
  targetHash = '';
  targetName = '';
  resultFiles.clear();
  resultOrder = [];
  scores.clear();
  resultModel = null;
  resetResultsScroll = false;
  document.documentElement.classList.remove('similarity-active','similarity-indexing');
  bar.hidden = true;
  window.mochimonoSelection?.clear?.();
  if (restore) {
    restoreNormalGrid();
    const y = baseScrollY;
    requestAnimationFrame(() => requestAnimationFrame(() => scrollTo({ top:y, left:0, behavior:'auto' })));
  }
}

async function startSimilarity(hash, name) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return;
  const mine = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  if (!active) baseScrollY = scrollY;
  active = true;
  indexing = true;
  targetHash = hash;
  targetName = name || hash;
  resultFiles.clear();
  resultOrder = [];
  scores.clear();
  resultModel = null;
  resetResultsScroll = false;
  document.documentElement.classList.add('similarity-active','similarity-indexing');
  showBar(hash, targetName);
  setProgress(0, 1, 'Reading image catalog…');
  viewerClose?.click();

  try {
    const candidates = await candidateImages();
    if (mine !== generation || signal.aborted) return;
    if (!candidates.has(hash)) candidates.set(hash, { hash, filename:targetName, mime:'image/*' });
    const result = await rankCandidates(candidates, signal);
    if (mine !== generation || signal.aborted) return;

    resultFiles = new Map(result.ranked.map(item => [item.file.hash, item.file]));
    resultOrder = result.ranked.map(item => item.file.hash);
    scores = new Map(result.ranked.map(item => [item.file.hash, item.score]));
    indexing = false;
    document.documentElement.classList.remove('similarity-indexing');
    setProgress(result.indexed, result.indexed, `${result.indexed.toLocaleString()} indexed · showing closest ${resultOrder.length.toLocaleString()}`);
    installResultsModel();
  } catch (error) {
    if (mine !== generation || signal.aborted) return;
    indexing = false;
    document.documentElement.classList.remove('similarity-indexing');
    setProgress(0, 1, error.message || 'Could not find similar images');
  } finally {
    if (mine === generation) controller = null;
  }
}

function navigateSimilarity(step) {
  if (!active || viewer?.hidden !== false) return false;
  const hash = viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const index = resultOrder.indexOf(hash);
  const nextHash = resultOrder[index + step];
  if (!nextHash) return false;
  window.mochimonoOpenViewer?.(nextHash, resultFiles.get(nextHash));
  requestAnimationFrame(syncViewerNav);
  return true;
}

function syncViewerNav() {
  if (!active || viewer?.hidden !== false) return;
  const hash = viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const index = resultOrder.indexOf(hash);
  const previous = document.querySelector('#viewer-prev');
  const next = document.querySelector('#viewer-next');
  if (previous) previous.disabled = index <= 0;
  if (next) next.disabled = index < 0 || index >= resultOrder.length - 1;
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
    const own = String(snapshot?.sort || '').startsWith('similarity-find');
    if (active && !installingModel && !own) {
      if (resultModel) window.mochimonoGridModel = resultModel;
      return true;
    }
    return originalSetModel(snapshot);
  };
}

findButton.addEventListener('click', event => {
  event.preventDefault();
  event.stopImmediatePropagation();
  const hash = viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const name = document.querySelector('#viewer-name')?.textContent || hash;
  document.querySelector('#viewer-menu')?.removeAttribute('open');
  startSimilarity(hash, name);
}, true);

bar.querySelector('.similarity-close').addEventListener('click', () => exitSimilarity(true));

for (const button of [document.querySelector('#viewer-prev'), document.querySelector('#viewer-next')]) {
  button?.addEventListener('click', event => {
    if (!active || viewer?.hidden !== false) return;
    const step = button.id === 'viewer-prev' ? -1 : 1;
    if (!navigateSimilarity(step)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

document.addEventListener('keydown', event => {
  if (!active || viewer?.hidden !== false || !['ArrowLeft','ArrowRight'].includes(event.key)) return;
  if (event.target.closest?.('#viewer video,#viewer input,#viewer textarea,#viewer select')) return;
  if (!navigateSimilarity(event.key === 'ArrowLeft' ? -1 : 1)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

files?.addEventListener('click', event => {
  if (!active || indexing || document.documentElement.classList.contains('selection-active') || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const card = event.target.closest('.file-card[data-hash]');
  if (!card || !resultFiles.has(card.dataset.hash)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.mochimonoOpenViewer?.(card.dataset.hash, resultFiles.get(card.dataset.hash));
}, true);

document.querySelector('#selectAll')?.addEventListener('click', event => {
  if (!active || indexing) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  window.mochimonoSelection?.add?.(resultOrder);
}, true);

new MutationObserver(records => {
  if (!active) return;
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) decorateScores(node);
}).observe(files, { childList:true, subtree:true });

viewerMedia && new MutationObserver(updateFindButton).observe(viewerMedia, { childList:true, subtree:true });
viewer && new MutationObserver(() => {
  updateFindButton();
  if (!active || viewer.hidden) return;
  requestAnimationFrame(syncViewerNav);
}).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
viewerOpen && new MutationObserver(() => requestAnimationFrame(syncViewerNav)).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });

window.addEventListener('mochimono:stable-grid-installed', () => {
  if (!active) return;
  requestAnimationFrame(() => {
    decorateScores(files);
    if (!resetResultsScroll) return;
    resetResultsScroll = false;
    window.mochimonoStableGrid?.scrollToIndex?.(0, 'start');
  });
});

for (const control of ['#source','#collectionFilter','#locationFilter','#typeFilter','#sort']) {
  document.querySelector(control)?.addEventListener('change', () => { if (active) exitSimilarity(false); }, true);
}
document.querySelector('#search')?.addEventListener('input', () => { if (active) exitSimilarity(false); }, true);
views?.addEventListener('click', event => {
  if (active && event.target.closest('[data-view]')?.dataset.view !== 'grid') exitSimilarity(false);
}, true);

window.mochimonoVisualSimilarity = {
  active:() => active,
  close:() => exitSimilarity(true),
  find:(hash, name = '') => startSimilarity(String(hash || ''), String(name || ''))
};

wrapStableGrid();
updateFindButton();
