const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');
const fileCount = document.querySelector('#fileCount');
const dateRail = document.querySelector('#dateRail');
const commandbar = document.querySelector('.commandbar');

const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const PHASH_VERSION = 'phash16-dct8-v1';
const THUMB_VERSION = 3;
const SAMPLE = 16;
const LOW = 8;
const INDEX_BATCH = 32;
const RESULT_CACHE_LIMIT = 4;
const MODE_KEY = 'mochimono-similarity-mode';
const MODES = {
  near:{ label:'Near duplicates', maxDistance:0, expandDistance:0, description:'100-score pHash matches' },
  similar:{ label:'Similar images', maxDistance:9, expandDistance:14, description:'Broader visual groups' }
};
const COS = Array.from({ length:LOW }, (_, u) => Array.from({ length:SAMPLE }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / (2 * SAMPLE))));
const SCALE = Array.from({ length:LOW }, (_, u) => u === 0 ? Math.sqrt(1 / SAMPLE) : Math.sqrt(2 / SAMPLE));

let wanted = false;
let active = false;
let indexing = false;
let generation = 0;
let controller = null;
let rerunTimer = 0;
let sourceModel = null;
let similarityModel = null;
let ordered = [];
let orderedFiles = new Map();
let scores = new Map();
let partners = new Map();
let groupByHash = new Map();
let groupInfo = [];
let originalFilteredHashes = null;
let wrappedGrid = null;
let originalSetModel = null;
let railDragging = false;
let lastRailMove = 0;
let railFrame = 0;
let resetScrollNext = false;
let pendingScrollAnchor = null;
let runningKey = '';
let installedKey = '';
const resultCache = new Map();
let mode = (() => {
  const saved = localStorage.getItem(MODE_KEY);
  if (saved === 'duplicates') return 'near';
  return MODES[saved] ? saved : 'similar';
})();

const option = document.createElement('option');
option.value = 'similar';
option.textContent = 'Similar';
option.title = 'Browse near-duplicate and visually similar image groups';
if (sort && !sort.querySelector('option[value="similar"]')) sort.append(option);

const style = document.createElement('style');
style.textContent = `
.similarity-sort-bar{margin:10px 0 6px;padding:9px 10px;display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:#171518;color:#d8cfcb}
.similarity-sort-bar[hidden],.similarity-rail[hidden]{display:none!important}.similarity-sort-copy{min-width:0;flex:1;display:grid;gap:5px}.similarity-sort-head{display:flex;align-items:center;gap:9px;min-width:0}.similarity-sort-head strong{font-size:11px;white-space:nowrap}.similarity-sort-modes{display:flex;gap:3px;min-width:0}.similarity-sort-modes button{height:25px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#8e8582;font-size:10px;font-weight:650}.similarity-sort-modes button:hover{background:#252126;color:#ddd5d1}.similarity-sort-modes button.active{background:#eee8e4;color:#171416}.similarity-sort-copy>span{color:#8e8582;font-size:10px}.similarity-sort-progress{height:3px;overflow:hidden;border-radius:99px;background:#282429}.similarity-sort-progress i{display:block;height:100%;width:0;background:#efa09a;transition:width .12s linear}.similarity-sort-close{width:30px;height:30px;padding:0;display:grid;place-items:center;background:transparent;color:#9b9290;font-size:18px}.similarity-sort-close:hover{background:#29252a;color:#fff}
html.similarity-sort-indexing:not(.similarity-sort-active) #files{visibility:hidden!important}
html.similarity-sort-active #dateRail{display:none!important}
html.similarity-sort-active .file-card>.similarity-score{position:absolute;z-index:8;right:6px;top:6px;min-width:27px;height:19px;padding:0 6px;display:grid;place-items:center;border-radius:999px;background:rgba(13,12,14,.8);box-shadow:0 1px 6px rgba(0,0,0,.35);color:#f2eae6;font-size:9px;font-weight:800;line-height:1;pointer-events:none;backdrop-filter:blur(6px)}
`;
document.head.append(style);

const bar = document.createElement('div');
bar.className = 'similarity-sort-bar';
bar.hidden = true;
bar.innerHTML = `<div class="similarity-sort-copy"><div class="similarity-sort-head"><strong>Visual matches</strong><div class="similarity-sort-modes">${Object.entries(MODES).map(([key, value]) => `<button type="button" data-similarity-mode="${key}">${value.label}</button>`).join('')}</div></div><span></span><div class="similarity-sort-progress"><i></i></div></div><button class="similarity-sort-close" type="button" title="Return to newest" aria-label="Return to newest">×</button>`;
files?.before(bar);
const status = bar.querySelector('.similarity-sort-copy > span');
const progress = bar.querySelector('.similarity-sort-progress > i');

const rail = document.createElement('nav');
rail.className = 'date-rail similarity-rail';
rail.hidden = true;
rail.setAttribute('aria-label', 'Browse similarity groups');
dateRail?.after(rail);

function syncModeButtons() {
  for (const button of bar.querySelectorAll('[data-similarity-mode]')) button.classList.toggle('active', button.dataset.similarityMode === mode);
}
syncModeButtons();

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

function idbAll(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function loadFingerprints() {
  const db = await openDb();
  try {
    const rows = await idbAll(db.transaction(STORE, 'readonly').objectStore(STORE));
    return new Map(rows
      .filter(row => row.version === PHASH_VERSION && /^[0-9a-f]{16}$/.test(String(row.value || '')))
      .map(row => [String(row.hash), String(row.value)]));
  } finally { db.close(); }
}

async function saveFingerprints(rows) {
  if (!rows.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows) {
      const request = store.get(row.hash);
      request.onsuccess = () => store.put({ ...(request.result || {}), ...row });
      request.onerror = () => tx.abort();
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Could not save similarity fingerprints'));
  }).finally(() => db.close());
}

function modelImages() {
  const items = sourceModel?.items || [];
  return items.filter(item => item?.[2] === 'image').map(item => ({
    hash:String(item[0] || ''),
    filename:String(item[1] || ''),
    width:Number(item[3]) || 0,
    height:Number(item[4]) || 0,
    dateMs:Number(item[5]) || 0,
    size:Number(item[6]) || 0
  })).filter(file => /^[a-f0-9]{64}$/.test(file.hash));
}

function hashText(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function imageIdentity(images) {
  const tokens = images.map(file => `${file.hash}:${file.width}x${file.height}`).sort();
  let left = 2166136261;
  let right = 2246822507;
  for (const token of tokens) {
    left = hashText(token, left);
    right = hashText(token, right ^ 0x9e3779b9);
  }
  return `${images.length}:${left.toString(36)}:${right.toString(36)}`;
}

function runKeyFor(images) {
  return `${mode}:${imageIdentity(images)}`;
}

function cacheResult(key, result) {
  resultCache.delete(key);
  resultCache.set(key, {
    hashes:(result.order || []).map(file => file.hash),
    scores:[...result.scores],
    partners:[...result.partners],
    groupByHash:[...result.groupByHash],
    groupInfo:(result.groupInfo || []).map(group => ({ ...group })),
    groups:Number(result.groups) || 0,
    matched:Number(result.matched) || 0
  });
  while (resultCache.size > RESULT_CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value);
}

function cachedResult(key, images) {
  const cached = resultCache.get(key);
  if (!cached) return null;
  const byHash = new Map(images.map(file => [file.hash, file]));
  const order = cached.hashes.map(hash => byHash.get(hash)).filter(Boolean);
  if (order.length !== cached.hashes.length) {
    resultCache.delete(key);
    return null;
  }
  resultCache.delete(key);
  resultCache.set(key, cached);
  return {
    order,
    scores:new Map(cached.scores),
    partners:new Map(cached.partners),
    groupByHash:new Map(cached.groupByHash),
    groupInfo:cached.groupInfo.map(group => ({ ...group })),
    groups:cached.groups,
    matched:cached.matched
  };
}

async function pixels(hash, signal) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache', signal });
  if (!response.ok) return null;
  const blob = await response.blob();
  let image = null;
  let url = '';
  try {
    if ('createImageBitmap' in window) image = await createImageBitmap(blob);
    else {
      url = URL.createObjectURL(blob);
      image = new Image();
      image.src = url;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        signal?.addEventListener('abort', () => reject(signal.reason || new DOMException('Aborted','AbortError')), { once:true });
      });
    }
    const canvas = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(SAMPLE, SAMPLE)
      : Object.assign(document.createElement('canvas'), { width:SAMPLE, height:SAMPLE });
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    return context.getImageData(0, 0, SAMPLE, SAMPLE).data;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  } finally {
    image?.close?.();
    if (url) URL.revokeObjectURL(url);
  }
}

function pHash(data) {
  const gray = new Float64Array(SAMPLE * SAMPLE);
  for (let pixel = 0, index = 0; index < gray.length; index++, pixel += 4) gray[index] = data[pixel] * .299 + data[pixel + 1] * .587 + data[pixel + 2] * .114;

  const horizontal = new Float64Array(SAMPLE * LOW);
  for (let y = 0; y < SAMPLE; y++) for (let u = 0; u < LOW; u++) {
    let sum = 0;
    for (let x = 0; x < SAMPLE; x++) sum += gray[y * SAMPLE + x] * COS[u][x];
    horizontal[y * LOW + u] = sum * SCALE[u];
  }

  const low = new Float64Array(LOW * LOW);
  for (let v = 0; v < LOW; v++) for (let u = 0; u < LOW; u++) {
    let sum = 0;
    for (let y = 0; y < SAMPLE; y++) sum += horizontal[y * LOW + u] * COS[v][y];
    low[v * LOW + u] = sum * SCALE[v];
  }

  const values = [...low.slice(1)].sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
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

function updateProgress(done, total, text) {
  status.textContent = text;
  progress.style.width = `${total ? Math.max(2, Math.min(100, done / total * 100)) : 0}%`;
}

async function ensureFingerprints(images, signal, mine) {
  const fingerprints = await loadFingerprints();
  if (mine !== generation || signal.aborted) return null;
  const missing = images.filter(file => !fingerprints.has(file.hash));
  let done = images.length - missing.length;
  let unavailable = 0;
  updateProgress(done, images.length, `Indexing thumbnails · ${done.toLocaleString()} / ${images.length.toLocaleString()}`);

  for (let offset = 0; offset < missing.length; offset += INDEX_BATCH) {
    if (mine !== generation || signal.aborted) return null;
    const chunk = missing.slice(offset, offset + INDEX_BATCH);
    const rows = (await Promise.all(chunk.map(async file => {
      const value = await fingerprint(file.hash, signal);
      return value ? { hash:file.hash, value, version:PHASH_VERSION, updatedAt:Date.now() } : null;
    }))).filter(Boolean);
    for (const row of rows) fingerprints.set(row.hash, row.value);
    unavailable += chunk.length - rows.length;
    await saveFingerprints(rows);
    done += chunk.length;
    updateProgress(done, images.length, `Indexing thumbnails · ${done.toLocaleString()} / ${images.length.toLocaleString()}${unavailable ? ` · ${unavailable.toLocaleString()} unavailable` : ''}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  return { fingerprints, unavailable };
}

function buildGroupsInWorker(images, fingerprints, config, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./similarity-group-worker.js', import.meta.url), { type:'module' });
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      callback(value);
    };
    const abort = () => finish(reject, signal?.reason || new DOMException('Aborted', 'AbortError'));

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once:true });
    worker.onerror = event => finish(reject, new Error(event.message || 'Similarity worker failed'));
    worker.onmessage = event => {
      if (event.data?.error) {
        finish(reject, new Error(event.data.error));
        return;
      }
      const result = event.data?.result;
      if (!result) {
        finish(reject, new Error('Similarity worker returned no result'));
        return;
      }
      result.scores = new Map(result.scores || []);
      result.partners = new Map(result.partners || []);
      result.groupByHash = new Map(result.groupByHash || []);
      finish(resolve, result);
    };
    worker.postMessage({ images, fingerprints:[...fingerprints], config });
  });
}

function tuple(file) {
  return [
    file.hash,
    file.filename || file.hash,
    'image',
    file.width || 0,
    file.height || 0,
    file.dateMs || 0,
    file.size || 0,
    scores.get(file.hash) ?? -1,
    groupByHash.get(file.hash) ?? -1
  ];
}

function decorate(root = files) {
  if (!active || !root) return;
  const cards = [];
  if (root instanceof Element && root.matches?.('.file-card[data-hash]')) cards.push(root);
  root.querySelectorAll?.('.file-card[data-hash]').forEach(card => cards.push(card));
  for (const card of cards) {
    card.querySelector(':scope > .similarity-score')?.remove();
    card.querySelector(':scope > .similarity-match')?.remove();
    const value = scores.get(String(card.dataset.hash || ''));
    if (value == null) continue;
    const badge = document.createElement('span');
    badge.className = 'similarity-score';
    badge.textContent = String(value);
    badge.title = `Similarity ${value}`;
    card.append(badge);
  }
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
  if (!snapshot || !Array.isArray(snapshot.items) || modelSort.startsWith('similarity')) return;
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
    if (wanted && !String(snapshot?.sort || '').startsWith('similarity')) {
      captureSourceModel(snapshot);
      if (similarityModel) window.mochimonoGridModel = similarityModel;
      return true;
    }
    return originalSetModel(snapshot);
  };
}

function groupAt(index) {
  let answer = null;
  for (const group of groupInfo) {
    if (group.start > index) break;
    answer = group;
  }
  return answer;
}

function buildRail() {
  if (!active || !ordered.length || !groupInfo.length) {
    rail.hidden = true;
    rail.replaceChildren();
    return;
  }

  const entries = [];
  let previousSize = -1;
  for (const group of groupInfo) {
    if (group.size === previousSize) continue;
    previousSize = group.size;
    entries.push({ index:group.start, size:group.size });
  }

  rail.hidden = false;
  document.documentElement.classList.add('library-scroll');
  rail.innerHTML = `<div class="rail-track"></div>${entries.map(entry => `<button data-index="${entry.index}" class="rail-tick major" style="top:${(ordered.length === 1 ? 0 : entry.index / (ordered.length - 1) * 100).toFixed(3)}%" title="Groups of ${entry.size} images"><span>${entry.size}×</span></button>`).join('')}<div id="similarityRailThumb" class="rail-thumb"><span></span><i></i></div>`;
  updateRail();
}

function updateRail() {
  railFrame = 0;
  if (!active || rail.hidden || !ordered.length) return;
  const index = Math.max(0, Math.min(ordered.length - 1, Number(window.mochimonoStableGrid?.visibleIndex?.()) || 0));
  const group = groupAt(index);
  const thumb = rail.querySelector('#similarityRailThumb');
  if (thumb) {
    thumb.style.top = `${(ordered.length === 1 ? 0 : index / (ordered.length - 1)) * 100}%`;
    const label = thumb.querySelector('span');
    if (label) label.textContent = group ? `${group.size}×` : '';
  }

  let nearest = null;
  let nearestDistance = Infinity;
  for (const tick of rail.querySelectorAll('[data-index]')) {
    const delta = Math.abs(Number(tick.dataset.index) - index);
    if (delta < nearestDistance) { nearestDistance = delta; nearest = tick; }
  }
  for (const tick of rail.querySelectorAll('[data-index]')) tick.classList.toggle('active', tick === nearest);
}

function scheduleRail() {
  if (!active || railFrame) return;
  railFrame = requestAnimationFrame(updateRail);
}

function railIndexFromPointer(event) {
  if (!ordered.length) return 0;
  const rect = rail.getBoundingClientRect();
  const raw = Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) * (ordered.length - 1));
  const group = groupAt(raw);
  return group?.start ?? raw;
}

function moveRail(event, final = false) {
  const now = performance.now();
  if (!final && now - lastRailMove < 32) return;
  lastRailMove = now;
  window.mochimonoStableGrid?.scrollToIndex?.(railIndexFromPointer(event), 'start');
  scheduleRail();
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
    best = {
      preserve:true,
      hash:String(card.dataset.hash || ''),
      offset:rect.top - viewportTop,
      y:scrollY,
      distance
    };
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

function install(result, images, resetScroll, key) {
  pendingScrollAnchor = resetScroll
    ? { reset:true }
    : captureScrollAnchor() || { preserve:true, hash:'', offset:0, y:scrollY };

  orderedFiles = new Map(result.order.map(file => [file.hash, file]));
  ordered = result.order.map(file => file.hash);
  scores = result.scores;
  partners = result.partners;
  groupByHash = result.groupByHash;
  groupInfo = result.groupInfo;
  active = true;
  indexing = false;
  installedKey = key;
  runningKey = '';
  document.documentElement.classList.add('similarity-sort-active');
  document.documentElement.classList.remove('similarity-sort-indexing');
  patchFilteredHashes();

  similarityModel = {
    version:`similarity-groups:${mode}:${generation}:${ordered.length}`,
    sort:`similarity-groups:${mode}:${generation}`,
    items:result.order.map(tuple)
  };
  window.mochimonoGridModel = similarityModel;
  originalSetModel?.(similarityModel);

  bar.hidden = false;
  syncModeButtons();
  const config = MODES[mode];
  updateProgress(images.length, images.length, result.groups
    ? `${result.groups.toLocaleString()} groups · ${result.matched.toLocaleString()} images · largest group ${result.groupInfo[0]?.size || 0}`
    : `No ${config.label.toLowerCase()} found`);

  if (fileCount) {
    fileCount.hidden = false;
    fileCount.textContent = `${result.matched.toLocaleString()} images`;
    fileCount.title = `${result.groups.toLocaleString()} similarity groups`;
  }

  requestAnimationFrame(() => {
    decorate(files);
    buildRail();
  });
}

function deactivate() {
  generation++;
  clearTimeout(rerunTimer);
  controller?.abort();
  controller = null;
  runningKey = '';
  installedKey = '';
  active = false;
  indexing = false;
  similarityModel = null;
  ordered = [];
  orderedFiles.clear();
  scores.clear();
  partners.clear();
  groupByHash.clear();
  groupInfo = [];
  pendingScrollAnchor = null;
  restoreFilteredHashes();
  document.documentElement.classList.remove('similarity-sort-active','similarity-sort-indexing');
  bar.hidden = true;
  rail.hidden = true;
  rail.replaceChildren();
  if (railFrame) cancelAnimationFrame(railFrame);
  railFrame = 0;
}

async function activate() {
  if (!wanted || sort?.value !== 'similar' || document.documentElement.classList.contains('similarity-active')) return;
  const gridButton = views?.querySelector('[data-view="grid"]');
  if (!gridButton?.classList.contains('active')) {
    gridButton?.click();
    scheduleActivate(20, resetScrollNext);
    return;
  }

  if (!sourceModel) {
    const current = window.mochimonoGridModel;
    if (current && !String(current.sort || '').startsWith('similarity')) sourceModel = current;
  }

  const images = modelImages();
  const resetScroll = resetScrollNext || !active;
  resetScrollNext = false;
  if (!images.length) {
    indexing = false;
    runningKey = '';
    document.documentElement.classList.remove('similarity-sort-indexing');
    bar.hidden = false;
    updateProgress(0, 1, 'No images in this view.');
    return;
  }

  const key = runKeyFor(images);
  if (active && installedKey === key) {
    indexing = false;
    document.documentElement.classList.remove('similarity-sort-indexing');
    return;
  }
  if (indexing && runningKey === key) return;

  const cached = cachedResult(key, images);
  if (cached) {
    generation++;
    controller?.abort();
    controller = null;
    indexing = false;
    runningKey = '';
    install(cached, images, resetScroll, key);
    return;
  }

  const mine = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  runningKey = key;
  indexing = true;
  document.documentElement.classList.add('similarity-sort-indexing');
  bar.hidden = false;
  syncModeButtons();
  updateProgress(0, 1, active ? 'Updating visual groups…' : 'Reading images…');

  try {
    const indexed = await ensureFingerprints(images, signal, mine);
    if (!indexed || mine !== generation || signal.aborted || !wanted) return;
    updateProgress(images.length, images.length, 'Building visual groups…');
    await new Promise(resolve => requestAnimationFrame(resolve));
    const result = await buildGroupsInWorker(images, indexed.fingerprints, MODES[mode], signal);
    if (mine !== generation || signal.aborted || !wanted) return;
    cacheResult(key, result);
    install(result, images, resetScroll, key);
  } catch (error) {
    if (mine !== generation || signal.aborted) return;
    indexing = false;
    runningKey = '';
    document.documentElement.classList.remove('similarity-sort-indexing');
    updateProgress(0, 1, error.message || 'Could not build visual groups');
  } finally {
    if (mine === generation) controller = null;
  }
}

function scheduleActivate(delay = 0, resetScroll = false) {
  clearTimeout(rerunTimer);
  if (!wanted || sort?.value !== 'similar') return;
  resetScrollNext ||= resetScroll;
  bar.hidden = false;
  if (!active) document.documentElement.classList.add('similarity-sort-indexing');
  rerunTimer = setTimeout(activate, Math.max(0, delay));
}

function currentViewerHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function navigateViewer(step) {
  if (!active || viewer?.hidden !== false) return false;
  const index = ordered.indexOf(currentViewerHash());
  const hash = ordered[index + step];
  if (!hash) return false;
  window.mochimonoOpenViewer?.(hash, orderedFiles.get(hash));
  requestAnimationFrame(syncViewerNav);
  return true;
}

function syncViewerNav() {
  if (!active || viewer?.hidden !== false) return;
  const index = ordered.indexOf(currentViewerHash());
  const previous = document.querySelector('#viewer-prev');
  const next = document.querySelector('#viewer-next');
  if (previous) previous.disabled = index <= 0;
  if (next) next.disabled = index < 0 || index >= ordered.length - 1;
}

sort?.addEventListener('change', () => {
  if (sort.value === 'similar') {
    wanted = true;
    const current = window.mochimonoGridModel;
    if (current && !String(current.sort || '').startsWith('similarity')) sourceModel = current;
    scheduleActivate(30, true);
  } else {
    wanted = false;
    deactivate();
  }
}, true);

bar.addEventListener('click', event => {
  const button = event.target.closest('[data-similarity-mode]');
  if (!button || !MODES[button.dataset.similarityMode] || button.dataset.similarityMode === mode) return;
  mode = button.dataset.similarityMode;
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

bar.querySelector('.similarity-sort-close').addEventListener('click', () => {
  wanted = false;
  window.mochimonoSimilaritySortLock?.release?.();
  if (!sort) return;
  sort.value = 'date-desc';
  sort.dispatchEvent(new Event('change', { bubbles:true }));
});

rail.addEventListener('pointerdown', event => {
  if (!active || rail.hidden) return;
  railDragging = true;
  rail.classList.add('dragging');
  try { rail.setPointerCapture(event.pointerId); } catch {}
  moveRail(event, true);
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
rail.addEventListener('pointermove', event => {
  if (!railDragging) return;
  moveRail(event);
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
rail.addEventListener('pointerup', event => {
  if (!railDragging) return;
  railDragging = false;
  rail.classList.remove('dragging');
  moveRail(event, true);
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
rail.addEventListener('pointercancel', () => {
  railDragging = false;
  rail.classList.remove('dragging');
}, true);
rail.addEventListener('click', event => {
  const tick = event.target.closest('[data-index]');
  if (!active || !tick) return;
  window.mochimonoStableGrid?.scrollToIndex?.(Number(tick.dataset.index), 'start');
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

new MutationObserver(records => {
  if (!active) return;
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) decorate(node);
}).observe(files, { childList:true, subtree:true });

viewer && new MutationObserver(() => { if (active && !viewer.hidden) requestAnimationFrame(syncViewerNav); }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
viewerOpen && new MutationObserver(() => { if (active) requestAnimationFrame(syncViewerNav); }).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });
window.addEventListener('scroll', () => {
  scheduleRail();
  refreshPendingScrollAnchor();
}, { passive:true });
window.addEventListener('mochimono:stable-grid-installed', () => {
  if (!active) return;
  requestAnimationFrame(() => {
    decorate(files);
    buildRail();
    restorePendingScrollAnchor();
  });
});

window.mochimonoSimilaritySort = {
  active:() => active,
  orderedHashes:() => active ? [...ordered] : null,
  score:hash => scores.get(String(hash || '')) ?? null,
  partner:hash => partners.get(String(hash || '')) || '',
  mode:() => mode,
  groups:() => groupInfo.map(group => ({ ...group })),
  refresh:() => scheduleActivate(0, false),
  cache:() => ({ entries:resultCache.size, runningKey, installedKey })
};

wrapStableGrid();
