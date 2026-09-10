const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');
const fileCount = document.querySelector('#fileCount');
const rail = document.querySelector('#dateRail');

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

let active = false;
let indexing = false;
let generation = 0;
let controller = null;
let ordered = [];
let orderedFiles = new Map();
let scores = new Map();
let closeGroups = 0;
let installing = false;
let rerunTimer = 0;
let originalFilteredHashes = null;

const option = document.createElement('option');
option.value = 'similar';
option.textContent = 'Similar';
option.title = 'Images with the strongest perceptual matches first';
if (sort && !sort.querySelector('option[value="similar"]')) sort.append(option);

const style = document.createElement('style');
style.textContent = `
.similarity-sort-bar{margin:10px 0 6px;padding:9px 10px;display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:#171518;color:#d8cfcb}
.similarity-sort-bar[hidden]{display:none!important}.similarity-sort-copy{min-width:0;flex:1;display:grid;gap:4px}.similarity-sort-copy strong{font-size:11px}.similarity-sort-copy span{color:#8e8582;font-size:10px}.similarity-sort-progress{height:3px;overflow:hidden;border-radius:99px;background:#282429}.similarity-sort-progress i{display:block;height:100%;width:0;background:#efa09a;transition:width .12s linear}.similarity-sort-close{width:30px;height:30px;padding:0;display:grid;place-items:center;background:transparent;color:#9b9290;font-size:18px}.similarity-sort-close:hover{background:#29252a;color:#fff}
html.similarity-sort-indexing #files{visibility:hidden!important}html.similarity-sort-active .date-rail{display:none!important}
html.similarity-sort-active .file-card>.similarity-score{position:absolute;z-index:8;right:6px;top:6px;min-width:27px;height:19px;padding:0 6px;display:grid;place-items:center;border-radius:999px;background:rgba(13,12,14,.76);box-shadow:0 1px 6px rgba(0,0,0,.35);color:#f2eae6;font-size:9px;font-weight:800;line-height:1;pointer-events:none;backdrop-filter:blur(6px)}
`;
document.head.append(style);

const bar = document.createElement('div');
bar.className = 'similarity-sort-bar';
bar.hidden = true;
bar.innerHTML = '<div class="similarity-sort-copy"><strong>Most similar images</strong><span></span><div class="similarity-sort-progress"><i></i></div></div><button class="similarity-sort-close" type="button" title="Return to newest" aria-label="Return to newest">×</button>';
files?.before(bar);
const status = bar.querySelector('span');
const progress = bar.querySelector('i');

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

async function loadFingerprints() {
  const db = await openDb();
  try {
    const rows = await all(db.transaction(STORE, 'readonly').objectStore(STORE));
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

function currentImages() {
  const items = window.mochimonoGridModel?.items || [];
  return items.filter(item => item?.[2] === 'image').map(item => ({
    hash:String(item[0] || ''),
    filename:String(item[1] || ''),
    mime:'image/*',
    width:Number(item[3]) || 0,
    height:Number(item[4]) || 0,
    fileDate:new Date(Number(item[5]) || Date.now()).toISOString(),
    size:Number(item[6]) || 0,
    dateMs:Number(item[5]) || 0
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
  best.fill(64);

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

  const identical = new Map();
  for (const file of images) {
    const value = fingerprints.get(file.hash);
    if (!value) continue;
    let group = identical.get(value);
    if (!group) identical.set(value, group = []);
    group.push(fileIndex.get(file.hash));
  }

  const unique = [];
  for (const [value, members] of identical) {
    const first = members[0];
    if (members.length > 1) {
      best[first] = 0;
      for (let index = 1; index < members.length; index++) {
        best[members[index]] = 0;
        union(first, members[index]);
      }
    }
    unique.push({ value, members, representative:first, words:[0,4,8,12].map(offset => parseInt(value.slice(offset, offset + 4), 16)) });
  }

  const buckets = Array.from({ length:4 }, () => new Map());
  for (let index = 0; index < unique.length; index++) {
    for (let block = 0; block < 4; block++) {
      const word = unique[index].words[block];
      let bucket = buckets[block].get(word);
      if (!bucket) buckets[block].set(word, bucket = []);
      bucket.push(index);
    }
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
      for (const member of item.members) if (delta < best[member]) best[member] = delta;
      for (const member of other.members) if (delta < best[member]) best[member] = delta;
    }
  }

  const groups = new Map();
  for (let index = 0; index < images.length; index++) {
    const root = find(index);
    let group = groups.get(root);
    if (!group) groups.set(root, group = []);
    group.push(index);
  }

  const clustered = [];
  const singles = [];
  for (const members of groups.values()) {
    if (members.length > 1 && members.some(index => best[index] <= MAX_DISTANCE)) clustered.push(members);
    else singles.push(...members);
  }

  const groupStrength = members => Math.min(...members.map(index => best[index]));
  const groupNewest = members => Math.max(...members.map(index => images[index].dateMs || 0));
  clustered.sort((a, b) => groupStrength(a) - groupStrength(b) || b.length - a.length || groupNewest(b) - groupNewest(a));
  for (const members of clustered) members.sort((a, b) => best[a] - best[b] || (images[b].dateMs || 0) - (images[a].dateMs || 0));
  singles.sort((a, b) => (images[b].dateMs || 0) - (images[a].dateMs || 0));

  const order = [...clustered.flat(), ...singles].map(index => images[index]);
  const scoreMap = new Map();
  for (let index = 0; index < images.length; index++) if (best[index] <= MAX_DISTANCE) scoreMap.set(images[index].hash, similarityScore(best[index]));
  return { order, scores:scoreMap, groups:clustered.length, matched:scoreMap.size };
}

function tuple(file) {
  return [file.hash, file.filename || file.hash, 'image', file.width || 0, file.height || 0, file.dateMs || 0, file.size || 0];
}

function decorate(root = files) {
  if (!active || !root) return;
  const cards = [];
  if (root instanceof Element && root.matches?.('.file-card[data-hash]')) cards.push(root);
  root.querySelectorAll?.('.file-card[data-hash]').forEach(card => cards.push(card));
  for (const card of cards) {
    const value = scores.get(card.dataset.hash);
    card.querySelector(':scope > .similarity-score')?.remove();
    if (value == null) continue;
    const badge = document.createElement('span');
    badge.className = 'similarity-score';
    badge.textContent = String(value);
    badge.title = `Similarity ${value} · closest perceptual match`;
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

function install(result, images) {
  orderedFiles = new Map(images.map(file => [file.hash, file]));
  ordered = result.order.map(file => file.hash);
  scores = result.scores;
  closeGroups = result.groups;
  active = true;
  indexing = false;
  document.documentElement.classList.add('similarity-sort-active');
  document.documentElement.classList.remove('similarity-sort-indexing');
  patchFilteredHashes();
  const model = {
    version:`similar-sort:${generation}:${ordered.length}`,
    sort:'similarity',
    items:result.order.map(tuple)
  };
  installing = true;
  window.mochimonoGridModel = model;
  window.mochimonoStableGrid?.setModel?.(model);
  installing = false;
  if (rail) rail.hidden = true;
  bar.hidden = false;
  updateProgress(images.length, images.length, `${result.matched.toLocaleString()} images have a close match · ${result.groups.toLocaleString()} groups · ${images.length.toLocaleString()} images indexed`);
  if (fileCount) {
    fileCount.hidden = false;
    fileCount.textContent = `${images.length.toLocaleString()} images`;
    fileCount.title = `${result.matched.toLocaleString()} with a close perceptual match`;
  }
  requestAnimationFrame(() => decorate(files));
  scrollTo({ top:0, left:0, behavior:'auto' });
}

function deactivate() {
  generation++;
  controller?.abort();
  controller = null;
  active = false;
  indexing = false;
  ordered = [];
  orderedFiles.clear();
  scores.clear();
  closeGroups = 0;
  restoreFilteredHashes();
  document.documentElement.classList.remove('similarity-sort-active','similarity-sort-indexing');
  bar.hidden = true;
}

async function activate() {
  if (sort?.value !== 'similar' || document.documentElement.classList.contains('similarity-active')) return;
  const gridButton = views?.querySelector('[data-view="grid"]');
  if (!gridButton?.classList.contains('active')) {
    gridButton?.click();
    setTimeout(scheduleActivate, 0);
    return;
  }

  const mine = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  active = false;
  indexing = true;
  ordered = [];
  scores.clear();
  restoreFilteredHashes();
  document.documentElement.classList.remove('similarity-sort-active');
  document.documentElement.classList.add('similarity-sort-indexing');
  bar.hidden = false;
  updateProgress(0, 1, 'Reading images…');

  try {
    const images = currentImages();
    if (mine !== generation || signal.aborted) return;
    if (!images.length) {
      indexing = false;
      document.documentElement.classList.remove('similarity-sort-indexing');
      updateProgress(0, 1, 'No images in this view.');
      return;
    }
    const indexed = await ensureFingerprints(images, signal, mine);
    if (!indexed || mine !== generation || signal.aborted) return;
    updateProgress(images.length, images.length, 'Finding closest matches…');
    await new Promise(resolve => requestAnimationFrame(resolve));
    const result = closestOrder(images.filter(file => indexed.fingerprints.has(file.hash)), indexed.fingerprints);
    if (mine !== generation || signal.aborted) return;
    install(result, images.filter(file => indexed.fingerprints.has(file.hash)));
  } catch (error) {
    if (mine !== generation || signal.aborted) return;
    indexing = false;
    document.documentElement.classList.remove('similarity-sort-indexing');
    updateProgress(0, 1, error.message || 'Could not sort similar images');
  }
}

function scheduleActivate(delay = 0) {
  clearTimeout(rerunTimer);
  if (sort?.value !== 'similar') return;
  document.documentElement.classList.add('similarity-sort-indexing');
  bar.hidden = false;
  status.textContent = 'Updating similarity order…';
  rerunTimer = setTimeout(activate, delay);
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
  if (sort.value === 'similar') scheduleActivate(0);
  else deactivate();
}, true);

for (const selector of ['#source','#collectionFilter','#locationFilter','#typeFilter']) {
  document.querySelector(selector)?.addEventListener('change', () => { if (sort?.value === 'similar') scheduleActivate(0); }, true);
}
document.querySelector('#search')?.addEventListener('input', () => { if (sort?.value === 'similar') scheduleActivate(90); }, true);
views?.addEventListener('click', event => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (sort?.value === 'similar' && view && view !== 'grid') {
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
  if (!sort) return;
  sort.value = 'date-desc';
  sort.dispatchEvent(new Event('change', { bubbles:true }));
});

new MutationObserver(records => {
  if (!active) return;
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) decorate(node);
}).observe(files, { childList:true, subtree:true });

viewer && new MutationObserver(() => { if (active && !viewer.hidden) requestAnimationFrame(syncViewerNav); }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
viewerOpen && new MutationObserver(() => { if (active) requestAnimationFrame(syncViewerNav); }).observe(viewerOpen, { attributes:true, attributeFilter:['href'] });

new MutationObserver(() => {
  if (!document.documentElement.classList.contains('similarity-active')) return;
  if (active || indexing) {
    deactivate();
    if (fileCount) fileCount.hidden = true;
  }
}).observe(document.documentElement, { attributes:true, attributeFilter:['class'] });

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
  groups:() => closeGroups,
  refresh:() => scheduleActivate(0)
};
