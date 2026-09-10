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
const PHASH_VERSION = 'phash16-dct8-v1';
const THUMB_VERSION = 3;
const SAMPLE = 16;
const LOW = 8;
const BATCH = 16;
const MAX_RESULTS = 500;
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const POPCOUNT = [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];
const COS = Array.from({ length:LOW }, (_, u) => Array.from({ length:SAMPLE }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / (2 * SAMPLE))));
const SCALE = Array.from({ length:LOW }, (_, u) => u === 0 ? Math.sqrt(1 / SAMPLE) : Math.sqrt(2 / SAMPLE));

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
findButton.title = 'Find visually similar images using thumbnail perceptual hashes';
findButton.hidden = true;
if (viewerMenu) viewerMenu.insertBefore(findButton, viewerInfoButton || viewerMenu.firstChild);

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath:'hash' });
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

async function loadFingerprints() {
  const db = await openDb();
  try {
    const rows = await all(db.transaction(STORE, 'readonly').objectStore(STORE));
    return new Map(rows.filter(row => row.version === PHASH_VERSION && /^[0-9a-f]{16}$/.test(String(row.value || ''))).map(row => [row.hash, row.value]));
  } finally { db.close(); }
}

async function saveFingerprints(rows) {
  if (!rows.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows) store.put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Could not save visual fingerprints'));
  }).finally(() => db.close());
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

async function pixels(hash, signal) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache', signal });
  if (!response.ok) return null;
  const blob = await response.blob();
  let image = null;
  let objectUrl = '';
  try {
    if ('createImageBitmap' in window) image = await createImageBitmap(blob);
    else {
      objectUrl = URL.createObjectURL(blob);
      image = new Image();
      image.src = objectUrl;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        signal?.addEventListener('abort', () => reject(signal.reason || new DOMException('Aborted','AbortError')), { once:true });
      });
    }
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SAMPLE, SAMPLE) : Object.assign(document.createElement('canvas'), { width:SAMPLE, height:SAMPLE });
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    return context.getImageData(0, 0, SAMPLE, SAMPLE).data;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally {
    image?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function pHash(data) {
  const gray = new Float64Array(SAMPLE * SAMPLE);
  for (let pixel = 0, index = 0; index < gray.length; index++, pixel += 4) gray[index] = data[pixel] * .299 + data[pixel + 1] * .587 + data[pixel + 2] * .114;

  const horizontal = new Float64Array(SAMPLE * LOW);
  for (let y = 0; y < SAMPLE; y++) {
    for (let u = 0; u < LOW; u++) {
      let sum = 0;
      for (let x = 0; x < SAMPLE; x++) sum += gray[y * SAMPLE + x] * COS[u][x];
      horizontal[y * LOW + u] = sum * SCALE[u];
    }
  }

  const low = new Float64Array(LOW * LOW);
  for (let v = 0; v < LOW; v++) {
    for (let u = 0; u < LOW; u++) {
      let sum = 0;
      for (let y = 0; y < SAMPLE; y++) sum += horizontal[y * LOW + u] * COS[v][y];
      low[v * LOW + u] = sum * SCALE[v];
    }
  }

  const medianValues = [...low.slice(1)].sort((a, b) => a - b);
  const median = medianValues[Math.floor(medianValues.length / 2)];
  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) {
      const index = nibble * 4 + bit;
      if (index && low[index] > median) value |= 1 << (3 - bit);
    }
    hex += value.toString(16);
  }
  return hex;
}

async function fingerprint(hash, signal) {
  const data = await pixels(hash, signal);
  return data ? pHash(data) : '';
}

function distance(left, right) {
  let total = 0;
  for (let index = 0; index < 16; index++) total += POPCOUNT[parseInt(left[index], 16) ^ parseInt(right[index], 16)];
  return total;
}

function score(distance) {
  return Math.max(0, Math.round(100 - distance * 4));
}

function setProgress(done, total, text) {
  if (barStatus) barStatus.textContent = text;
  if (barProgress) barProgress.style.width = `${total ? Math.max(2, Math.min(100, done / total * 100)) : 0}%`;
}

function fileTuple(file) {
  const date = Date.parse(file.fileDate || file.createdAt || 0) || 0;
  return [file.hash, file.filename || file.hash, 'image', Number(file.width) || 0, Number(file.height) || 0, date, Number(file.size) || 0];
}

function modelForResults() {
  return {
    version:`similarity:${targetHash}:${generation}`,
    sort:'similarity',
    items:resultOrder.map(hash => fileTuple(resultFiles.get(hash)))
  };
}

function installResultsModel() {
  if (!active || indexing) return;
  const model = modelForResults();
  installingModel = true;
  window.mochimonoGridModel = model;
  window.mochimonoStableGrid?.setModel?.(model);
  installingModel = false;
  if (rail) rail.hidden = true;
  if (fileCount) {
    fileCount.hidden = false;
    fileCount.textContent = `${resultOrder.length.toLocaleString()} similar images`;
    fileCount.title = `Closest perceptual matches to ${targetName}`;
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
    const rawDistance = Math.round((100 - value) / 4);
    badge.title = `Similarity ${value} · pHash distance ${rawDistance}`;
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
  document.documentElement.classList.add('similarity-active','similarity-indexing');
  showBar(hash, targetName);
  setProgress(0, 1, 'Reading image catalog…');
  viewerClose?.click();
  window.scrollTo({ top:Math.max(0, bar.getBoundingClientRect().top + scrollY - 70), behavior:'auto' });

  try {
    const candidates = await candidateImages();
    if (mine !== generation || signal.aborted) return;
    if (!candidates.has(hash)) candidates.set(hash, { hash, filename:targetName, mime:'image/*' });
    const fingerprints = await loadFingerprints();
    if (mine !== generation || signal.aborted) return;

    const hashes = [...candidates.keys()];
    let completed = hashes.reduce((count, value) => count + Number(fingerprints.has(value)), 0);
    let unavailable = 0;
    setProgress(completed, hashes.length, `Indexing thumbnails · ${completed.toLocaleString()} / ${hashes.length.toLocaleString()}`);

    if (!fingerprints.has(hash)) {
      const value = await fingerprint(hash, signal);
      if (!value) throw new Error('This image has no usable thumbnail yet.');
      fingerprints.set(hash, value);
      await saveFingerprints([{ hash, value, version:PHASH_VERSION, updatedAt:Date.now() }]);
      completed++;
      setProgress(completed, hashes.length, `Indexing thumbnails · ${completed.toLocaleString()} / ${hashes.length.toLocaleString()}`);
    }

    const missing = hashes.filter(value => value !== hash && !fingerprints.has(value));
    for (let offset = 0; offset < missing.length; offset += BATCH) {
      if (mine !== generation || signal.aborted) return;
      const chunk = missing.slice(offset, offset + BATCH);
      const values = await Promise.all(chunk.map(async itemHash => {
        const value = await fingerprint(itemHash, signal);
        return value ? { hash:itemHash, value, version:PHASH_VERSION, updatedAt:Date.now() } : null;
      }));
      const good = values.filter(Boolean);
      for (const row of good) fingerprints.set(row.hash, row.value);
      unavailable += values.length - good.length;
      await saveFingerprints(good);
      completed += chunk.length;
      setProgress(completed, hashes.length, `Indexing thumbnails · ${completed.toLocaleString()} / ${hashes.length.toLocaleString()}${unavailable ? ` · ${unavailable.toLocaleString()} unavailable` : ''}`);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }

    if (mine !== generation || signal.aborted) return;
    const target = fingerprints.get(hash);
    const ranked = [];
    for (const [candidateHash, file] of candidates) {
      if (candidateHash === hash) continue;
      const value = fingerprints.get(candidateHash);
      if (!value) continue;
      const delta = distance(target, value);
      ranked.push({ hash:candidateHash, file, distance:delta, score:score(delta) });
    }
    ranked.sort((a, b) => a.distance - b.distance || a.hash.localeCompare(b.hash));
    const shown = ranked.slice(0, MAX_RESULTS);
    resultFiles = new Map(shown.map(item => [item.hash, item.file]));
    resultOrder = shown.map(item => item.hash);
    scores = new Map(shown.map(item => [item.hash, item.score]));
    indexing = false;
    document.documentElement.classList.remove('similarity-indexing');
    setProgress(hashes.length, hashes.length, `${ranked.length.toLocaleString()} indexed matches${ranked.length > shown.length ? ` · showing closest ${shown.length.toLocaleString()}` : ''}${unavailable ? ` · ${unavailable.toLocaleString()} without thumbnails` : ''}`);
    installResultsModel();
    window.scrollTo({ top:Math.max(0, bar.getBoundingClientRect().top + scrollY - 70), behavior:'auto' });
  } catch (error) {
    if (mine !== generation || signal.aborted) return;
    indexing = false;
    document.documentElement.classList.remove('similarity-indexing');
    setProgress(0, 1, error.message || 'Could not find similar images');
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

window.addEventListener('mochimono:grid-model', () => {
  if (!active || indexing || installingModel) return;
  requestAnimationFrame(installResultsModel);
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
  find:hash => startSimilarity(String(hash || ''), '')
};

updateFindButton();
