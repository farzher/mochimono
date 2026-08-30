const CACHE_NAME = 'mochimono-catalog';
const CACHE_VERSION = 2;
const UI_KEY = 'mochimono-library-ui';
const files = document.querySelector('#files');
const folderbar = document.querySelector('#folderbar');
const source = document.querySelector('#source');
const collectionFilter = document.querySelector('#collectionFilter');
const search = document.querySelector('#search');
const typeFilter = document.querySelector('#typeFilter');
const sort = document.querySelector('#sort');
const selectToggle = document.querySelector('#selectFiles');
const selectionBar = document.querySelector('#selectionBar');
const selectionCount = document.querySelector('#selectionCount');
const selectAll = document.querySelector('#selectAll');
const selectionCollection = document.querySelector('#selectionCollection');
const selectionDelete = document.querySelector('#selectionDelete');
const selectionIgnore = document.querySelector('#selectionIgnore');
const selectionClear = document.querySelector('#selectionClear');

let selectionMode = false;
let anchorHash = '';
let selected = new Set();
let cachePromise;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'm2v', 'mts', 'm2ts', '3gp']);

function extension(name) {
  return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
}

function cache() {
  if (!cachePromise) {
    cachePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_NAME, CACHE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'hash' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'hash' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return cachePromise;
}

const idb = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const txDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
});

function currentView() {
  return document.querySelector('#views [data-view].active')?.dataset.view || 'grid';
}

function saveUi() {
  localStorage.setItem(UI_KEY, JSON.stringify({
    view: currentView(),
    sort: sort.value,
    type: typeFilter.value
  }));
}

function restoreUi() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch { return; }
  if (['date-desc', 'date-asc', 'size-desc'].includes(saved.sort)) {
    sort.value = saved.sort;
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (['', 'media', 'image', 'video', 'audio', 'application', 'other'].includes(saved.type)) {
    typeFilter.value = saved.type;
    typeFilter.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (['grid', 'list', 'folders'].includes(saved.view)) {
    document.querySelector(`#views [data-view="${saved.view}"]`)?.click();
  }
}

function syncSelectedClasses() {
  files.querySelectorAll('[data-hash]').forEach(item => item.classList.toggle('selected', selected.has(item.dataset.hash)));
}

function syncSelectionUi() {
  const count = selected.size;
  selectionBar.hidden = !selectionMode && !count;
  selectToggle.classList.toggle('active', selectionMode);
  selectionCount.textContent = count ? `${count.toLocaleString()} selected` : 'Select files';
  selectionCollection.disabled = !count;
  selectionDelete.disabled = !count;
  selectionIgnore.disabled = !count;
  syncSelectedClasses();
}

function clearSelection(exit = true) {
  selected.clear();
  anchorHash = '';
  if (exit) selectionMode = false;
  syncSelectionUi();
}

function renderedHashes() {
  return [...files.querySelectorAll('[data-hash]')].map(item => item.dataset.hash);
}

function toggleHash(hash, extend) {
  if (extend && anchorHash) {
    const hashes = renderedHashes();
    const a = hashes.indexOf(anchorHash);
    const b = hashes.indexOf(hash);
    if (a >= 0 && b >= 0) {
      for (const item of hashes.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(item);
      anchorHash = hash;
      return;
    }
  }
  if (selected.has(hash)) selected.delete(hash);
  else selected.add(hash);
  anchorHash = hash;
}

function fileKind(file) {
  const base = String(file.mime || '').split('/')[0];
  if (base && base !== 'application') return base;
  if (file.mime && file.mime !== 'application/octet-stream') return base;
  const ext = extension(file.filename);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return base || 'other';
}

function mediaTypeMatches(file, filter) {
  const base = fileKind(file);
  if (!filter) return true;
  if (filter === 'media') return base === 'image' || base === 'video';
  if (filter === 'application') return base === 'application' || base === 'text';
  if (filter === 'other') return !['image', 'video', 'audio', 'application', 'text'].includes(base);
  return base === filter;
}

function breadcrumbPath() {
  return [...folderbar.querySelectorAll('[data-folder-depth]')]
    .filter(button => Number(button.dataset.folderDepth) > 0)
    .map(button => button.textContent.trim())
    .join('/');
}

async function cachedCatalog() {
  const db = await cache();
  const transaction = db.transaction(['files', 'meta']);
  const done = txDone(transaction);
  const fileRequest = transaction.objectStore('files').getAll();
  const metaRequest = transaction.objectStore('meta').get('catalog');
  const [records, meta] = await Promise.all([idb(fileRequest), idb(metaRequest)]);
  await done;
  return { records, meta };
}

async function selectedCollectionHashes(id) {
  const response = await fetch(`/api/collections/${encodeURIComponent(id)}/hashes`);
  if (!response.ok) throw new Error('Could not read this collection.');
  return new Set((await response.json()).hashes || []);
}

async function selectionUniverse() {
  const sourceId = Number(source.value) || 0;
  if (!folderbar.hidden && sourceId) {
    const response = await fetch(`/api/folders?import=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(breadcrumbPath())}`);
    if (!response.ok) throw new Error('Could not read this folder.');
    const data = await response.json();
    return data.files.map(file => file.hash);
  }

  const { records, meta } = await cachedCatalog();
  const sourceNames = new Map((meta?.imports || []).map(item => [Number(item.id), String(item.sourceName || '')]));
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const fileType = typeFilter.value;
  const collectionId = Number(collectionFilter.value) || 0;
  const collectionHashes = collectionId ? await selectedCollectionHashes(collectionId) : null;

  return records.filter(file => {
    const importIds = Array.isArray(file.importIds)
      ? file.importIds.map(Number)
      : String(file.importIds || '').split(',').map(Number).filter(Boolean);
    if (!mediaTypeMatches(file, fileType)) return false;
    if (collectionHashes && !collectionHashes.has(file.hash)) return false;
    if (sourceId && !importIds.includes(sourceId)) return false;
    if (terms.length) {
      const names = importIds.map(id => sourceNames.get(id) || '').join(' ');
      const haystack = `${file.filename || ''} ${file.originalPath || ''} ${file.searchText || ''} ${names}`.toLowerCase();
      if (!terms.every(term => haystack.includes(term))) return false;
    }
    return true;
  }).map(file => file.hash);
}

async function removeCached(hashes) {
  const db = await cache();
  const transaction = db.transaction(['files', 'thumbs'], 'readwrite');
  const done = txDone(transaction);
  const fileStore = transaction.objectStore('files');
  const thumbStore = transaction.objectStore('thumbs');
  for (const hash of hashes) {
    fileStore.delete(hash);
    thumbStore.delete(hash);
  }
  await done;
}

async function deleteSelected(ignore) {
  const hashes = [...selected];
  if (!hashes.length) return;
  const label = ignore ? 'Delete + Ignore' : 'Delete';
  if (!confirm(`${label} ${hashes.length.toLocaleString()} file${hashes.length === 1 ? '' : 's'}?`)) return;

  selectionDelete.disabled = true;
  selectionIgnore.disabled = true;
  selectAll.disabled = true;
  let next = 0;
  let done = 0;
  const failed = [];
  const succeeded = [];
  const workers = Array.from({ length: Math.min(10, hashes.length) }, async () => {
    while (next < hashes.length) {
      const hash = hashes[next++];
      try {
        const response = await fetch(`/api/objects/${hash}/delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ignore })
        });
        if (!response.ok) throw new Error(`${response.status}`);
        succeeded.push(hash);
      } catch {
        failed.push(hash);
      }
      done++;
      selectionCount.textContent = `Deleting ${done.toLocaleString()} / ${hashes.length.toLocaleString()}`;
    }
  });
  await Promise.all(workers);
  await removeCached(succeeded).catch(console.warn);
  if (failed.length) alert(`${failed.length.toLocaleString()} file${failed.length === 1 ? '' : 's'} could not be deleted.`);
  location.reload();
}

selectToggle.addEventListener('click', () => {
  if (selectionMode || selected.size) clearSelection(true);
  else {
    selectionMode = true;
    syncSelectionUi();
  }
});

selectionClear.addEventListener('click', () => clearSelection(true));
selectAll.addEventListener('click', async () => {
  selectionMode = true;
  selectAll.disabled = true;
  selectionCount.textContent = 'Selecting…';
  try {
    selected = new Set(await selectionUniverse());
    anchorHash = '';
  } catch (error) {
    alert(error.message);
  } finally {
    selectAll.disabled = false;
    syncSelectionUi();
  }
});
selectionCollection.addEventListener('click', () => {
  if (!selected.size) return;
  window.dispatchEvent(new CustomEvent('mochimono:add-to-collection', { detail: { hashes: [...selected] } }));
});
selectionDelete.addEventListener('click', () => deleteSelected(false));
selectionIgnore.addEventListener('click', () => deleteSelected(true));

files.addEventListener('click', event => {
  const item = event.target.closest('[data-hash]');
  if (!item) return;
  if (!selectionMode && !event.ctrlKey && !event.metaKey && !event.shiftKey) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  selectionMode = true;
  toggleHash(item.dataset.hash, event.shiftKey);
  syncSelectionUi();
}, true);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.querySelector('#viewer').hidden && (selectionMode || selected.size)) clearSelection(true);
});

for (const control of [sort, typeFilter]) control.addEventListener('change', saveUi);
document.querySelector('#views').addEventListener('click', event => {
  if (!event.target.closest('[data-view]')) return;
  clearSelection(true);
  setTimeout(saveUi);
});
source.addEventListener('change', () => clearSelection(true));
collectionFilter.addEventListener('change', () => clearSelection(true));
search.addEventListener('input', () => { if (selected.size) clearSelection(true); });

new MutationObserver(syncSelectedClasses).observe(files, { childList: true, subtree: true });

restoreUi();
syncSelectionUi();
