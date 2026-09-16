import './startup-geometry.js';

const DB_NAME = 'mochimono-library';
const DB_VERSION = 1;
const SCHEMA = 1;
const META_KEY = 'catalog';
const WRITE_BATCH = 1500;
const QUICK_FILES = 600;
const QUICK_MEDIA = 5000;
const CLIENT = document.documentElement.classList.contains('client-library');

let dbPromise = null;
let loadPromise = null;
let meta = null;
let records = new Map();
let pendingGeometry = new Map();
let geometryJob = 0;
let writeChain = Promise.resolve();
let lastQuickLoadMs = 0;
let lastFullLoadMs = 0;

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

const idle = () => new Promise(resolve => {
  if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout:500 });
  else setTimeout(resolve, 0);
});

const paintTurn = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const startupStyle = document.createElement('style');
startupStyle.textContent = 'html.mochimono-quick-grid-pending #files>.empty{visibility:hidden!important}';
document.head.append(startupStyle);
if (CLIENT) document.documentElement.classList.add('mochimono-quick-grid-pending');

function enqueueWrite(work) {
  const result = writeChain.then(work, work);
  writeChain = result.catch(() => {});
  return result;
}

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('files', { keyPath:'hash' });
      db.createObjectStore('meta', { keyPath:'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    console.warn('Mochimono local catalog is unavailable.', error);
    return null;
  });
  return dbPromise;
}

function mergeGeometry(file) {
  if (!file) return file;
  if (Number(file.width) > 0 && Number(file.height) > 0) return file;
  const hash = String(file.hash || '');
  const startup = window.mochimonoStartupGeometry?.get?.(hash);
  if (startup?.width && startup?.height) return { ...file, width:startup.width, height:startup.height };
  const pending = pendingGeometry.get(hash);
  if (pending?.width && pending?.height) return { ...file, width:pending.width, height:pending.height };
  const previous = records.get(hash);
  if (Number(previous?.width) > 0 && Number(previous?.height) > 0) return { ...file, width:Number(previous.width), height:Number(previous.height) };
  return file;
}

const validMeta = value => Boolean(value && value.schema === SCHEMA && value.version && Number(value.count) >= 0);

function quickSnapshot(value = meta) {
  if (!validMeta(value) || !Array.isArray(value.quickFiles)) return null;
  return {
    version:String(value.version),
    imports:Array.isArray(value.imports) ? value.imports : [],
    files:value.quickFiles.map(mergeGeometry),
    totalCount:Number(value.count) || 0,
    savedAt:Number(value.savedAt) || 0,
    partial:true
  };
}

async function readMeta(db) {
  if (!db) return null;
  const transaction = db.transaction('meta', 'readonly');
  const done = transactionDone(transaction);
  const value = await requestResult(transaction.objectStore('meta').get(META_KEY)).catch(() => null);
  await done.catch(() => {});
  return validMeta(value) ? value : null;
}

async function loadQuick() {
  const started = performance.now();
  const db = await openDb();
  if (!db) return quickSnapshot();
  meta = validMeta(meta) ? meta : await readMeta(db);
  lastQuickLoadMs = performance.now() - started;
  return quickSnapshot(meta);
}

async function loadFromDb() {
  const started = performance.now();
  const db = await openDb();
  if (!db) return null;
  const storedMeta = validMeta(meta) ? meta : await readMeta(db);
  if (!storedMeta) return null;
  const transaction = db.transaction('files', 'readonly');
  const done = transactionDone(transaction);
  const files = await requestResult(transaction.objectStore('files').getAll()).catch(() => []);
  await done.catch(() => {});
  if (files.length !== Number(storedMeta.count)) return null;
  const next = files.map(mergeGeometry);
  records = new Map(next.map(file => [String(file.hash), file]));
  meta = storedMeta;
  lastFullLoadMs = performance.now() - started;
  return {
    version:String(storedMeta.version),
    imports:Array.isArray(storedMeta.imports) ? storedMeta.imports : [],
    files:next,
    savedAt:Number(storedMeta.savedAt) || 0
  };
}

function waitForQuickGrid() {
  const stable = window.mochimonoStableGrid;
  if (stable?.active?.() && stable?.count?.() > 0) return paintTurn();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('mochimono:stable-grid-installed', finish);
      clearTimeout(timer);
      paintTurn().then(resolve);
    };
    const timer = setTimeout(finish, 900);
    window.addEventListener('mochimono:stable-grid-installed', finish, { once:true });
  });
}

async function installQuickPreview(snapshot) {
  if (!snapshot?.files?.length || !CLIENT) {
    document.documentElement.classList.remove('mochimono-quick-grid-pending');
    return false;
  }
  const library = window.mochimonoLibrary;
  if (!library?.upsertMany || Number(library.state?.().total) > 0) {
    document.documentElement.classList.remove('mochimono-quick-grid-pending');
    return false;
  }
  document.querySelector('#login')?.setAttribute('hidden', '');
  const app = document.querySelector('#app');
  const logout = document.querySelector('#logout');
  if (app) app.hidden = false;
  if (logout) logout.hidden = false;
  try {
    library.upsertMany(snapshot.files);
    await waitForQuickGrid();
  } finally {
    document.documentElement.classList.remove('mochimono-quick-grid-pending');
  }
  window.dispatchEvent(new CustomEvent('mochimono:catalog-quick-restored', {
    detail:{ count:snapshot.files.length, totalCount:snapshot.totalCount, version:snapshot.version }
  }));
  return true;
}

async function load() {
  if (meta?.version && records.size === Number(meta.count)) {
    document.documentElement.classList.remove('mochimono-quick-grid-pending');
    return { version:String(meta.version), imports:meta.imports || [], files:[...records.values()], savedAt:Number(meta.savedAt) || 0 };
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const quick = await loadQuick().catch(() => null);
      if (!quick) document.documentElement.classList.remove('mochimono-quick-grid-pending');
      await installQuickPreview(quick).catch(() => document.documentElement.classList.remove('mochimono-quick-grid-pending'));
      return loadFromDb();
    })().finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

const MEDIA_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff','mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);
function isMediaFile(file) {
  const mime = String(file?.mime || '').toLowerCase();
  if (mime.startsWith('image/') || mime.startsWith('video/')) return true;
  const extension = String(file?.filename || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  return MEDIA_EXTENSIONS.has(extension);
}

function selectQuickFiles(files) {
  const sorted = [...files].sort((a, b) => {
    const aDate = Number(a.dateMs) || Date.parse(a.fileDate || a.createdAt || 0) || 0;
    const bDate = Number(b.dateMs) || Date.parse(b.fileDate || b.createdAt || 0) || 0;
    return bDate - aDate || String(a.hash || '').localeCompare(String(b.hash || ''));
  });
  const selected = new Map(sorted.slice(0, QUICK_FILES).map(file => [String(file.hash), file]));
  let media = 0;
  for (const file of sorted) {
    if (!isMediaFile(file)) continue;
    selected.set(String(file.hash), file);
    if (++media >= QUICK_MEDIA) break;
  }
  return [...selected.values()];
}

function save(files, options = {}) {
  return enqueueWrite(() => saveNow(files, options));
}

async function saveNow(files, options = {}) {
  const db = await openDb();
  const version = String(options.version || '');
  if (!db || !version || !Array.isArray(files)) return;
  const clean = files.filter(file => /^[a-f0-9]{64}$/.test(String(file?.hash || ''))).map(mergeGeometry);

  {
    const transaction = db.transaction(['files', 'meta'], 'readwrite');
    transaction.objectStore('files').clear();
    transaction.objectStore('meta').clear();
    await transactionDone(transaction);
  }
  for (let offset = 0; offset < clean.length; offset += WRITE_BATCH) {
    const transaction = db.transaction('files', 'readwrite');
    const store = transaction.objectStore('files');
    for (const file of clean.slice(offset, offset + WRITE_BATCH)) store.put(file);
    await transactionDone(transaction);
    await idle();
  }

  const nextMeta = {
    key:META_KEY,
    schema:SCHEMA,
    version,
    imports:Array.isArray(options.imports) ? options.imports : [],
    count:clean.length,
    quickFiles:selectQuickFiles(clean),
    savedAt:Date.now()
  };
  {
    const transaction = db.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put(nextMeta);
    await transactionDone(transaction);
  }
  meta = nextMeta;
  records = new Map(clean.map(file => [String(file.hash), file]));
}

function scheduleGeometryWrite() {
  if (geometryJob) return;
  const run = () => {
    geometryJob = 0;
    flushDimensions().catch(() => {});
  };
  if ('requestIdleCallback' in window) geometryJob = requestIdleCallback(run, { timeout:650 });
  else geometryJob = setTimeout(run, 100);
}

function flushDimensions() {
  return enqueueWrite(flushDimensionsNow);
}

async function flushDimensionsNow() {
  if (!pendingGeometry.size) return;
  if (!records.size) await load().catch(() => null);
  if (!records.size) return;
  const batch = [...pendingGeometry];
  pendingGeometry.clear();
  const db = await openDb();
  if (!db) return;
  const transaction = db.transaction(['files', 'meta'], 'readwrite');
  const store = transaction.objectStore('files');
  const changed = new Map();
  for (const [hash, geometry] of batch) {
    const previous = records.get(hash);
    if (!previous) continue;
    const next = { ...previous, width:geometry.width, height:geometry.height };
    records.set(hash, next);
    changed.set(hash, geometry);
    store.put(next);
  }
  if (changed.size && meta?.version && Array.isArray(meta.quickFiles)) {
    meta = {
      ...meta,
      quickFiles:meta.quickFiles.map(file => {
        const geometry = changed.get(String(file.hash || ''));
        return geometry ? { ...file, width:geometry.width, height:geometry.height } : file;
      })
    };
    transaction.objectStore('meta').put(meta);
  }
  await transactionDone(transaction).catch(() => {});
  if (pendingGeometry.size) scheduleGeometryWrite();
}

function rememberDimensions(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!hash || !width || !height) return;
  const previous = records.get(hash);
  if (previous && Number(previous.width) === width && Number(previous.height) === height) return;
  if (previous) records.set(hash, { ...previous, width, height });
  pendingGeometry.set(hash, { width, height });
  scheduleGeometryWrite();
}

function clear() {
  if (geometryJob) {
    if ('cancelIdleCallback' in window) cancelIdleCallback(geometryJob);
    else clearTimeout(geometryJob);
    geometryJob = 0;
  }
  pendingGeometry.clear();
  document.documentElement.classList.remove('mochimono-quick-grid-pending');
  return enqueueWrite(clearNow);
}

async function clearNow() {
  const db = await openDb();
  if (!db) return;
  const transaction = db.transaction(['files', 'meta'], 'readwrite');
  transaction.objectStore('files').clear();
  transaction.objectStore('meta').clear();
  await transactionDone(transaction);
  meta = null;
  records.clear();
}

window.mochimonoCatalogCache = {
  load,
  loadQuick,
  save,
  rememberDimensions,
  clear,
  state:() => ({
    version:meta?.version || '',
    count:records.size,
    quickCount:Array.isArray(meta?.quickFiles) ? meta.quickFiles.length : 0,
    savedAt:Number(meta?.savedAt) || 0,
    quickLoadMs:Math.round(lastQuickLoadMs * 10) / 10,
    fullLoadMs:Math.round(lastFullLoadMs * 10) / 10
  })
};
