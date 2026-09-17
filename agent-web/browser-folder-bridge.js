const frame = document.querySelector('#filesFrame');
const DB_NAME = 'mochimono-browser-folders';
const DB_VERSION = 1;
const SOURCES = 'sources';
const FILES = 'files';
const SHA256 = /^[a-f0-9]{64}$/;
const WRAPPED = Symbol('mochimonoBrowserCloudPreflight');

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES, { keyPath:'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath:'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Browser folder database is unavailable'));
  });
}

function all(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function snapshot() {
  const db = await openDb();
  try {
    const tx = db.transaction([SOURCES, FILES], 'readonly');
    const [sources, files] = await Promise.all([all(tx.objectStore(SOURCES)), all(tx.objectStore(FILES))]);
    return { sources, files };
  } finally { db.close(); }
}

function sourceIdFromRow(row) {
  const key = String(row?.key || '');
  const split = key.indexOf('\u0000');
  return split > 0 ? key.slice(0, split) : '';
}

function libraryFile(row, source) {
  const date = new Date(Number(row.lastModified) || Date.now()).toISOString();
  const filename = String(row.path || '').split('/').at(-1) || row.path;
  return {
    hash:String(row.hash || ''),
    size:Number(row.size) || 0,
    mime:row.mime || 'application/octet-stream',
    filename,
    originalPath:row.path,
    rootPath:source.rootPath || source.name,
    fileDate:date,
    createdAt:source.createdAt || date,
    addedAt:source.createdAt || date,
    width:Number(row.width) || 0,
    height:Number(row.height) || 0,
    searchText:`${source.name || ''} ${source.rootPath || ''} ${row.path || ''}`.trim(),
    serverStored:Boolean(source.cloud === true && row.cloudSynced === true),
    browserSourceId:String(source.id || '')
  };
}

async function browserCatalog() {
  const { sources, files } = await snapshot();
  const byId = new Map(sources.map(source => [String(source.id || ''), source]));
  const result = [];
  for (const row of files) {
    const source = byId.get(sourceIdFromRow(row));
    if (!source || !SHA256.test(String(row.hash || ''))) continue;
    result.push(libraryFile(row, source));
  }
  return result;
}

async function writeCloudState(source, rows) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([SOURCES, FILES], 'readwrite');
    tx.objectStore(SOURCES).put(source);
    const store = tx.objectStore(FILES);
    for (const row of rows) store.put({ ...row, key:row.key || `${source.id}\u0000${row.path}` });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Could not update browser folder Cloud state'));
  }).finally(() => db.close());
}

async function cloudPreflight(id) {
  const { sources, files } = await snapshot();
  const source = sources.find(item => String(item.id) === String(id));
  if (!source?.cloud) return false;
  const rows = files.filter(row => sourceIdFromRow(row) === String(source.id));
  if (!rows.length) return false;

  let importMissing = !Number(source.importId);
  if (!importMissing) {
    const response = await fetch(`/api/folders?import=${encodeURIComponent(source.importId)}`, { cache:'no-store' });
    if (response.status === 404) importMissing = true;
    else if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Could not verify Cloud folder');
  }

  if (importMissing) {
    source.importId = 0;
    source.lastSynced = '';
    for (const row of rows) row.cloudSynced = false;
    await writeCloudState(source, rows);
    return true;
  }

  const syncedHashes = [...new Set(rows.filter(row => row.cloudSynced === true && SHA256.test(String(row.hash || ''))).map(row => String(row.hash)))];
  if (!syncedHashes.length) return false;
  const unavailable = new Set();
  for (let offset = 0; offset < syncedHashes.length; offset += 1000) {
    const response = await fetch('/api/objects/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ hashes:syncedHashes.slice(offset, offset + 1000) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not verify Cloud files');
    for (const hash of [...(data.missing || []), ...(data.ignored || [])]) unavailable.add(String(hash));
  }
  if (!unavailable.size) return false;
  source.lastSynced = '';
  for (const row of rows) if (unavailable.has(String(row.hash))) row.cloudSynced = false;
  await writeCloudState(source, rows);
  return true;
}

function notifyFrame() {
  try { frame?.contentWindow?.postMessage({ type:'mochimono-browser-catalog-changed' }, location.origin); } catch {}
}

function wrapApi(api) {
  if (!api || api[WRAPPED]) return api;
  const sync = api.sync?.bind(api);
  if (sync) api.sync = async (id, options) => {
    await cloudPreflight(id);
    return sync(id, options);
  };
  api.catalog = browserCatalog;
  Object.defineProperty(api, WRAPPED, { value:true });
  return api;
}

function patchCurrentApi() {
  if (window.mochimonoBrowserFolders) wrapApi(window.mochimonoBrowserFolders);
}

async function repairCloudSources() {
  const { sources } = await snapshot();
  for (const source of sources) {
    if (source?.cloud !== true) continue;
    await cloudPreflight(source.id).catch(() => {});
  }
  notifyFrame();
}

window.mochimonoBrowserFolderCatalog = browserCatalog;
window.addEventListener('mochimono:browser-folders-ready', () => {
  patchCurrentApi();
  void repairCloudSources();
  notifyFrame();
});
window.addEventListener('mochimono:browser-folders-changed', notifyFrame);
window.addEventListener('mochimono:browser-folder-sync', event => {
  if (event.detail?.state === 'done') notifyFrame();
});
frame?.addEventListener('load', notifyFrame);

const originalActivate = window.mochimonoBrowserFolderShell?.activate;
if (originalActivate) {
  window.mochimonoBrowserFolderShell.activate = async (...args) => wrapApi(await originalActivate(...args));
}
patchCurrentApi();
