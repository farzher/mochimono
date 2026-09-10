const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');
const fileCount = document.querySelector('#fileCount');
const dateRail = document.querySelector('#dateRail');

const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const PHASH_VERSION = 'phash16-dct8-v1';
const THUMB_VERSION = 3;
const SAMPLE = 16;
const LOW = 8;
const INDEX_BATCH = 32;
const MAX_DISTANCE = 7;
const POPCOUNT = [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];
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
let groups = 0;
let originalFilteredHashes = null;
let wrappedGrid = null;
let originalSetModel = null;
let railDragging = false;
let lastRailMove = 0;
let railFrame = 0;

const option = document.createElement('option');
option.value = 'similar';
option.textContent = 'Similar';
option.title = 'Images with the strongest perceptual matches first';
if (sort && !sort.querySelector('option[value="similar"]')) sort.append(option);

const style = document.createElement('style');
style.textContent = `
.similarity-sort-bar{margin:10px 0 6px;padding:9px 10px;display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:#171518;color:#d8cfcb}
.similarity-sort-bar[hidden],.similarity-rail[hidden]{display:none!important}.similarity-sort-copy{min-width:0;flex:1;display:grid;gap:4px}.similarity-sort-copy strong{font-size:11px}.similarity-sort-copy span{color:#8e8582;font-size:10px}.similarity-sort-progress{height:3px;overflow:hidden;border-radius:99px;background:#282429}.similarity-sort-progress i{display:block;height:100%;width:0;background:#efa09a;transition:width .12s linear}.similarity-sort-close{width:30px;height:30px;padding:0;display:grid;place-items:center;background:transparent;color:#9b9290;font-size:18px}.similarity-sort-close:hover{background:#29252a;color:#fff}
html.similarity-sort-indexing:not(.similarity-sort-active) #files{visibility:hidden!important}
html.similarity-sort-active #dateRail{display:none!important}
html.similarity-sort-active .file-card>.similarity-score{position:absolute;z-index:8;right:6px;top:6px;min-width:27px;height:19px;padding:0 6px;display:grid;place-items:center;border-radius:999px;background:rgba(13,12,14,.8);box-shadow:0 1px 6px rgba(0,0,0,.35);color:#f2eae6;font-size:9px;font-weight:800;line-height:1;pointer-events:none;backdrop-filter:blur(6px)}
`;
document.head.append(style);

const bar = document.createElement('div');
bar.className = 'similarity-sort-bar';
bar.hidden = true;
bar.innerHTML = '<div class="similarity-sort-copy"><strong>Most similar images</strong><span></span><div class="similarity-sort-progress"><i></i></div></div><button class="similarity-sort-close" type="button" title="Return to newest" aria-label="Return to newest">×</button>';
files?.before(bar);
const status = bar.querySelector('span');
const progress = bar.querySelector('i');

const rail = document.createElement('nav');
rail.className = 'date-rail similarity-rail';
rail.hidden = true;
rail.setAttribute('aria-label', 'Browse by similarity');
dateRail?.after(rail);

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
    for (const row of rows) store.put(row);
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
  for (let pixel = 0, index = 0; index < gray.length; index++, pixel += 4) {
    gray[index] = data[pixel] * .299 + data[pixel + 1] * .587 + data[pixel + 2] * .114;
  }
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

function distance(left, right) {
  let total = 0;
  for (let index = 0; index < 16; index++) total += POPCOUNT[parseInt(left[index], 16) ^ parseInt(right[index], 16)];
  return total;
}

function similarityScore(delta) {
  return Math.max(0, Math.round(100 - delta * 4));
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

function closestOrder(images, fingerprints) {
  const fileIndex = new Map(images.map((file, index) => [file.hash, index]));
  const parent = Int32Array.from(images, (_, index) => index);
  const best = new Uint8Array(images.length);
  const partner = new Int32Array(images.length);
  best.fill(64);
  partner.fill(-1);

  const find = value => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (left, right) => {
    left = find(left); right = find(right);
    if (left !== right) parent[right] = left;
  };
  const consider = (index, other, delta) => {
    if (delta < best[index] || (delta === best[index] && (partner[index] < 0 || images[other].hash < images[partner[index]].hash))) {
      best[index] = delta;
      partner[index] = other;
    }
  };

  const identical = new Map();
  for (const file of images) {
    const value = fingerprints.get(file.hash);
    if (!value) continue;
    let members = identical.get(value);
    if (!members) identical.set(value, members = []);
    members.push(fileIndex.get(file.hash));
  }

  const unique = [];
  for (const [value, members] of identical) {
    const first = members[0];
    if (members.length > 1) {
      for (let index = 0; index < members.length; index++) {
        const member = members[index];
        const other = members[index === 0 ? 1 : 0];
        consider(member, other, 0);
        if (index) union(first, member);
      }
    }
    unique.push({ value, members, representative:first, words:[0,4,8,12].map(offset => parseInt(value.slice(offset, offset + 4), 16)) });
  }

  const buckets = Array.from({ length:4 }, () => new Map());
  for (let index = 0; index < unique.length; index++) for (let block = 0; block < 4; block++) {
    const word = unique[index].words[block];
    let bucket = buckets[block].get(word);
    if (!bucket) buckets[block].set(word, bucket = []);
    bucket.push(index);
  }

  for (let index = 0; index < unique.length; index++) {
    const item = unique[index];
    const candidates = new Set();
    for (let block = 0; block < 4; block++) {
      const word = item.words[block];
      const collect = key => {
        for (const other of buckets[block].get(key) || []) if (other > index) candidates.add(other);
      };
      collect(word);
      for (let bit = 0; bit < 16; bit++) collect(word ^ (1 << bit));
    }
    for (const otherIndex of candidates) {
      const other = unique[otherIndex];
      const delta = distance(item.value, other.value);
      if (delta > MAX_DISTANCE) continue;
      union(item.representative, other.representative);
      const leftPartner = other.members[0];
      const rightPartner = item.members[0];
      for (const member of item.members) consider(member, leftPartner, delta);
      for (const member of other.members) consider(member, rightPartner, delta);
    }
  }

  const scoreMap = new Map();
  const partnerMap = new Map();
  const groupsByRoot = new Map();
  const other = [];
  let matched = 0;

  for (let index = 0; index < images.length; index++) {
    if (best[index] <= MAX_DISTANCE && partner[index] >= 0) {
      scoreMap.set(images[index].hash, similarityScore(best[index]));
      partnerMap.set(images[index].hash, images[partner[index]].hash);
      const root = find(index);
      let group = groupsByRoot.get(root);
      if (!group) {
        group = { members:[], bestDistance:64, newest:0, key:images[index].hash };
        groupsByRoot.set(root, group);
      }
      group.members.push(index);
      group.bestDistance = Math.min(group.bestDistance, best[index]);
      group.newest = Math.max(group.newest, images[index].dateMs || 0);
      if (images[index].hash < group.key) group.key = images[index].hash;
      matched++;
    } else other.push(index);
  }

  const matchGroups = [...groupsByRoot.values()];
  for (const group of matchGroups) {
    group.members.sort((a, b) =>
      best[a] - best[b] ||
      (images[b].dateMs || 0) - (images[a].dateMs || 0) ||
      images[a].hash.localeCompare(images[b].hash)
    );
  }
  matchGroups.sort((a, b) =>
    a.bestDistance - b.bestDistance ||
    b.members.length - a.members.length ||
    b.newest - a.newest ||
    a.key.localeCompare(b.key)
  );
  other.sort((a, b) => (images[b].dateMs || 0) - (images[a].dateMs || 0));

  return {
    order:[...matchGroups.flatMap(group => group.members), ...other].map(index => images[index]),
    scores:scoreMap,
    partners:partnerMap,
    groups:matchGroups.length,
    matched
  };
}

function tuple(file) {
  return [file.hash, file.filename || file.hash, 'image', file.width || 0, file.height || 0, file.dateMs || 0, file.size || 0, scores.get(file.hash) ?? -1];
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
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.sort === 'similarity') return;
  sourceModel = snapshot;
  if (wanted) scheduleActivate(active ? 80 : 20);
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
    if (wanted && snapshot?.sort !== 'similarity') {
      captureSourceModel(snapshot);
      if (similarityModel) window.mochimonoGridModel = similarityModel;
      return true;
    }
    return originalSetModel(snapshot);
  };
}

function buildRail() {
  if (!active || !ordered.length) {
    rail.hidden = true;
    rail.replaceChildren();
    return;
  }
  const entries = [];
  let previous = null;
  for (let index = 0; index < ordered.length; index++) {
    const value = scores.get(ordered[index]);
    const token = value == null ? 'other' : String(value);
    if (token === previous) continue;
    previous = token;
    entries.push({ index, label:value == null ? 'Other images' : `Similarity ${value}`, short:value == null ? 'Other' : String(value) });
  }
  rail.hidden = false;
  document.documentElement.classList.add('library-scroll');
  rail.innerHTML = `<div class="rail-track"></div>${entries.map(entry => `<button data-index="${entry.index}" class="rail-tick major" style="top:${(ordered.length === 1 ? 0 : entry.index / (ordered.length - 1) * 100).toFixed(3)}%" title="${entry.label}"><span>${entry.short}</span></button>`).join('')}<div id="similarityRailThumb" class="rail-thumb"><span></span><i></i></div>`;
  updateRail();
}

function railLabel(index) {
  const hash = ordered[Math.max(0, Math.min(ordered.length - 1, index))];
  const value = scores.get(hash);
  return value == null ? 'Other' : String(value);
}

function updateRail() {
  railFrame = 0;
  if (!active || rail.hidden || !ordered.length) return;
  const index = Math.max(0, Math.min(ordered.length - 1, Number(window.mochimonoStableGrid?.visibleIndex?.()) || 0));
  const thumb = rail.querySelector('#similarityRailThumb');
  if (thumb) {
    thumb.style.top = `${(ordered.length === 1 ? 0 : index / (ordered.length - 1)) * 100}%`;
    const label = thumb.querySelector('span');
    if (label) label.textContent = railLabel(index);
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
  return Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))) * (ordered.length - 1));
}

function moveRail(event, final = false) {
  const now = performance.now();
  if (!final && now - lastRailMove < 32) return;
  lastRailMove = now;
  window.mochimonoStableGrid?.scrollToIndex?.(railIndexFromPointer(event), 'center');
  scheduleRail();
}

function install(result, images) {
  orderedFiles = new Map(images.map(file => [file.hash, file]));
  ordered = result.order.map(file => file.hash);
  scores = result.scores;
  partners = result.partners;
  groups = result.groups;
  active = true;
  indexing = false;
  document.documentElement.classList.add('similarity-sort-active');
  document.documentElement.classList.remove('similarity-sort-indexing');
  patchFilteredHashes();
  similarityModel = { version:`similarity:${generation}:${ordered.length}`, sort:'similarity', items:result.order.map(tuple) };
  window.mochimonoGridModel = similarityModel;
  originalSetModel?.(similarityModel);
  bar.hidden = false;
  updateProgress(images.length, images.length, `${result.matched.toLocaleString()} images have a close match · ${groups.toLocaleString()} groups`);
  if (fileCount) {
    fileCount.hidden = false;
    fileCount.textContent = `${images.length.toLocaleString()} images`;
    fileCount.title = `${result.matched.toLocaleString()} with a close perceptual match`;
  }
  requestAnimationFrame(() => {
    decorate(files);
    buildRail();
  });
  scrollTo({ top:0, left:0, behavior:'auto' });
}

function deactivate() {
  generation++;
  clearTimeout(rerunTimer);
  controller?.abort();
  controller = null;
  active = false;
  indexing = false;
  similarityModel = null;
  ordered = [];
  orderedFiles.clear();
  scores.clear();
  partners.clear();
  groups = 0;
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
    scheduleActivate(20);
    return;
  }
  if (!sourceModel) {
    const current = window.mochimonoGridModel;
    if (current?.sort !== 'similarity') sourceModel = current;
  }
  const images = modelImages();
  if (!images.length) {
    indexing = false;
    document.documentElement.classList.remove('similarity-sort-indexing');
    bar.hidden = false;
    updateProgress(0, 1, 'No images in this view.');
    return;
  }

  const mine = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const firstRun = !active;
  indexing = true;
  document.documentElement.classList.add('similarity-sort-indexing');
  bar.hidden = false;
  if (firstRun) updateProgress(0, 1, 'Reading images…');
  else status.textContent = 'Updating similarity order…';

  try {
    const indexed = await ensureFingerprints(images, signal, mine);
    if (!indexed || mine !== generation || signal.aborted || !wanted) return;
    updateProgress(images.length, images.length, 'Finding closest matches…');
    await new Promise(resolve => requestAnimationFrame(resolve));
    const result = closestOrder(images, indexed.fingerprints);
    if (mine !== generation || signal.aborted || !wanted) return;
    install(result, images);
  } catch (error) {
    if (mine !== generation || signal.aborted) return;
    indexing = false;
    document.documentElement.classList.remove('similarity-sort-indexing');
    updateProgress(0, 1, error.message || 'Could not sort similar images');
  }
}

function scheduleActivate(delay = 0) {
  clearTimeout(rerunTimer);
  if (!wanted || sort?.value !== 'similar') return;
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
    if (current?.sort !== 'similarity') sourceModel = current;
    scheduleActivate(30);
  } else {
    wanted = false;
    deactivate();
  }
}, true);

views?.addEventListener('click', event => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (wanted && view && view !== 'grid') {
    wanted = false;
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
  window.mochimonoStableGrid?.scrollToIndex?.(Number(tick.dataset.index), 'center');
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

new MutationObserver(records => {
  if (!active) return;
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) decorate(node);
}).observe(files, { childList:true, subtree:true });

viewer && new MutationObserver(() => { if (active && !viewer.hidden) requestAnimationFrame(syncViewerNav); }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
viewerOpen && new MutationObserver(() => { if (active) requestAnimationFrame(syncViewerNav); }).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });
window.addEventListener('scroll', scheduleRail, { passive:true });
window.addEventListener('mochimono:stable-grid-installed', () => {
  if (!active) return;
  requestAnimationFrame(() => {
    decorate(files);
    buildRail();
  });
});

setTimeout(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('mochimono-library-ui') || '{}');
    if (saved?.sort === 'similar' && sort) {
      sort.value = 'similar';
      sort.dispatchEvent(new Event('change', { bubbles:true }));
    }
  } catch {}
}, 0);

window.mochimonoSimilaritySort = {
  active:() => active,
  orderedHashes:() => active ? [...ordered] : null,
  score:hash => scores.get(String(hash || '')) ?? null,
  partner:hash => partners.get(String(hash || '')) || '',
  groups:() => groups,
  refresh:() => scheduleActivate(0)
};

wrapStableGrid();
