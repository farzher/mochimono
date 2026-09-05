import './startup-geometry.js';

const DB_NAME = 'mochimono-library';
const DB_VERSION = 1;
const SCHEMA = 1;
const META_KEY = 'catalog';
const WRITE_BATCH = 1500;
const READ_BATCH = 1800;
const QUICK_FILES = 200;
const CLIENT = document.documentElement.classList.contains('client-library');

let dbPromise = null;
let loadPromise = null;
let meta = null;
let records = new Map();
let pendingGeometry = new Map();
let geometryJob = 0;
let writeChain = Promise.resolve();

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
  if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 500 });
  else setTimeout(resolve, 0);
});

const paintTurn = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const startupStyle = document.createElement('style');
startupStyle.textContent = 'html.mochimono-quick-grid-pending #files>.empty{visibility:hidden!important}';
document.head.append(startupStyle);
if (CLIENT) document.documentElement.classList.add('mochimono-quick-grid-pending');

function enqueueWrite(work) {
  const run = () => work();
  const result = writeChain.then(run, run);
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
      db.createObjectStore('files', { keyPath: 'hash' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    console.warn('Mochimono local catalog is unavailable.', error);
    return null;
  });
  return dbPromise;
}

function publicFile(file) {
  if (!file) return file;
  const { __snapshot, ...clean } = file;
  return clean;
}

function mergeGeometry(file) {
  const hash = String(file?.hash || '');
  if (Number(file.width) > 0 && Number(file.height) > 0) return file;
  const startup = window.mochimonoStartupGeometry?.get?.(hash);
  if (startup?.width && startup?.height) return { ...file, width: startup.width, height: startup.height };
  const pending = pendingGeometry.get(hash);
  if (pending?.width && pending?.height) return { ...file, width: pending.width, height: pending.height };
  const previous = records.get(hash);
  if (!(Number(previous?.width) > 0 && Number(previous?.height) > 0)) return file;
  return { ...file, width: Number(previous.width), height: Number(previous.height) };
}

function validMeta(value) {
  return Boolean(value && value.schema === SCHEMA && value.version);
}

function memorySnapshot() {
  if (!meta?.version || records.size !== Number(meta.count || 0)) return null;
  return {
    version: String(meta.version),
    imports: Array.isArray(meta.imports) ? meta.imports : [],
    files: [...records.values()].map(file => publicFile(mergeGeometry(file))),
    savedAt: Number(meta.savedAt) || 0
  };
}

function quickSnapshot(value = meta) {
  if (!validMeta(value) || !Array.isArray(value.quickFiles) || !value.quickFiles.length) return null;
  return {
    version: String(value.version),
    imports: Array.isArray(value.imports) ? value.imports : [],
    files: value.quickFiles.map(file => publicFile(mergeGeometry(file))),
    totalCount: Number(value.count) || value.quickFiles.length,
    savedAt: Number(value.savedAt) || 0,
    partial: true
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

async function thumbnailGeometry(files) {
  const hashes = files.map(file => String(file.hash || '')).filter(Boolean);
  if (!hashes.length) return new Map();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    const response = await fetch('/api/thumbs/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ hashes }),
      signal:controller.signal
    });
    if (!response.ok) return new Map();
    const data = await response.json();
    return new Map((data.thumbnails || []).map(item => [String(item.hash || ''), item]));
  } catch {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

async function hydrateQuickSnapshot(db, snapshot) {
  if (!db || !snapshot?.files?.length) return snapshot;
  const targets = snapshot.files.map((file, index) => ({ file, index }));
  const transaction = db.transaction('files', 'readonly');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('files');
  const [rows, geometry] = await Promise.all([
    Promise.all(targets.map(({ file }) => requestResult(store.get(String(file.hash || ''))).catch(() => null))),
    thumbnailGeometry(snapshot.files)
  ]);
  await done.catch(() => {});

  const files = [...snapshot.files];
  rows.forEach((stored, position) => {
    if (!stored || stored.__snapshot !== snapshot.version) return;
    const target = targets[position];
    files[target.index] = publicFile(mergeGeometry({ ...target.file, ...stored }));
  });
  for (let index = 0; index < files.length; index++) {
    const item = geometry.get(String(files[index].hash || ''));
    const width = Number(item?.width) || 0;
    const height = Number(item?.height) || 0;
    if (width > 0 && height > 0) files[index] = { ...files[index], width, height };
  }
  return { ...snapshot, files };
}

async function loadQuick() {
  const db = await openDb();
  if (!db) return quickSnapshot();
  const storedMeta = validMeta(meta) ? meta : await readMeta(db);
  if (!storedMeta) return null;
  meta = storedMeta;
  return hydrateQuickSnapshot(db, quickSnapshot(storedMeta));
}

async function readFilesBatched(db, version) {
  const files = [];
  let after = null;

  while (true) {
    const transaction = db.transaction('files', 'readonly');
    const done = transactionDone(transaction);
    const store = transaction.objectStore('files');
    const range = after == null ? undefined : IDBKeyRange.lowerBound(after, true);
    const [batch, keys] = await Promise.all([
      requestResult(store.getAll(range, READ_BATCH)),
      requestResult(store.getAllKeys(range, READ_BATCH))
    ]);
    await done;

    for (const file of batch) {
      if (file?.__snapshot === version) files.push(publicFile(file));
    }
    if (batch.length < READ_BATCH || !keys.length) break;
    after = keys.at(-1);
    await idle();
  }

  return files;
}

async function loadFromDb(knownMeta = null) {
  const db = await openDb();
  if (!db) return null;
  const storedMeta = validMeta(knownMeta) ? knownMeta : await readMeta(db);
  if (!storedMeta) return null;

  const files = await readFilesBatched(db, String(storedMeta.version));
  if (files.length !== Number(storedMeta.count || 0)) return null;
  meta = storedMeta;
  records = new Map(files.map(file => [String(file.hash), file]));
  return memorySnapshot();
}

function waitForQuickGrid() {
  const stable = window.mochimonoStableGrid;
  if (stable?.active?.() && stable?.count?.() > 0) return paintTurn();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('mochimono:stable-grid-installed', onGrid);
      clearTimeout(timer);
      paintTurn().then(resolve);
    };
    const onGrid = () => finish();
    const timer = setTimeout(finish, 140);
    window.addEventListener('mochimono:stable-grid-installed', onGrid, { once:true });
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

  const login = document.querySelector('#login');
  const app = document.querySelector('#app');
  const logout = document.querySelector('#logout');
  if (login) login.hidden = true;
  if (app) app.hidden = false;
  if (logout) logout.hidden = false;

  try {
    library.upsertMany(snapshot.files);
    await waitForQuickGrid();
  } finally {
    document.documentElement.classList.remove('mochimono-quick-grid-pending');
  }

  window.dispatchEvent(new CustomEvent('mochimono:catalog-quick-restored', {
    detail: { count:snapshot.files.length, totalCount:snapshot.totalCount, version:snapshot.version }
  }));
  return true;
}

async function load() {
  const memory = memorySnapshot();
  if (memory) {
    document.documentElement.classList.remove('mochimono-quick-grid-pending');
    return memory;
  }
  if (!loadPromise) {
    loadPromise = (async () => {
      const quick = await loadQuick().catch(() => null);
      if (!quick) document.documentElement.classList.remove('mochimono-quick-grid-pending');
      const painted = await installQuickPreview(quick).catch(() => {
        document.documentElement.classList.remove('mochimono-quick-grid-pending');
        return false;
      });
      if (painted) await idle();
      return loadFromDb(meta);
    })().finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

function quickFiles(files) {
  return [...files]
    .sort((a, b) => {
      const aDate = Number(a.dateMs) || Date.parse(a.fileDate || a.createdAt || 0) || 0;
      const bDate = Number(b.dateMs) || Date.parse(b.fileDate || b.createdAt || 0) || 0;
      return bDate - aDate || String(a.hash || '').localeCompare(String(b.hash || ''));
    })
    .slice(0, QUICK_FILES)
    .map(publicFile);
}

function save(files, options = {}) {
  return enqueueWrite(() => saveNow(files, options));
}

async function saveNow(files, options = {}) {
  const db = await openDb();
  if (!db || !Array.isArray(files)) return;
  const version = String(options.version || '');
  if (!version) return;

  const clean = files
    .filter(file => /^[a-f0-9]{64}$/.test(String(file?.hash || '')))
    .map(file => mergeGeometry(publicFile(file)));

  for (let offset = 0; offset < clean.length; offset += WRITE_BATCH) {
    const transaction = db.transaction('files', 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore('files');
    for (const file of clean.slice(offset, offset + WRITE_BATCH)) store.put({ ...file, __snapshot: version });
    await done;
    await idle();
  }

  const nextMeta = {
    key: META_KEY,
    schema: SCHEMA,
    version,
    imports: Array.isArray(options.imports) ? options.imports : [],
    count: clean.length,
    quickFiles: quickFiles(clean),
    savedAt: Date.now()
  };
  {
    const transaction = db.transaction('meta', 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('meta').put(nextMeta);
    await done;
  }

  meta = nextMeta;
  records = new Map(clean.map(file => [String(file.hash), file]));
  for (const file of clean) {
    const geometry = pendingGeometry.get(String(file.hash));
    if (geometry && Number(file.width) === geometry.width && Number(file.height) === geometry.height) pendingGeometry.delete(String(file.hash));
  }
  idle().then(() => enqueueWrite(() => cleanupOldSnapshots(version))).catch(() => {});
}

async function cleanupOldSnapshots(version) {
  if (meta?.version !== version) return;
  const db = await openDb();
  if (!db || meta?.version !== version) return;
  const transaction = db.transaction('files', 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('files');
  await new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      if (cursor.value?.__snapshot !== version) cursor.delete();
      cursor.continue();
    };
  });
  await done;
}

function scheduleGeometryWrite() {
  if (geometryJob) return;
  const run = () => {
    geometryJob = 0;
    flushDimensions().catch(() => {});
  };
  if ('requestIdleCallback' in window) geometryJob = requestIdleCallback(run, { timeout: 650 });
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
  const done = transactionDone(transaction);
  const store = transaction.objectStore('files');
  const changed = new Map();
  for (const [hash, geometry] of batch) {
    const previous = records.get(hash);
    if (!previous) continue;
    const next = { ...previous, width: geometry.width, height: geometry.height };
    records.set(hash, next);
    changed.set(hash, geometry);
    store.put({ ...next, __snapshot: meta?.version || '' });
  }

  if (changed.size && meta?.version && Array.isArray(meta.quickFiles)) {
    const nextQuick = meta.quickFiles.map(file => {
      const geometry = changed.get(String(file.hash || ''));
      return geometry ? { ...file, width: geometry.width, height: geometry.height } : file;
    });
    meta = { ...meta, quickFiles: nextQuick };
    transaction.objectStore('meta').put(meta);
  }

  await done.catch(() => {});
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
  const done = transactionDone(transaction);
  transaction.objectStore('files').clear();
  transaction.objectStore('meta').clear();
  await done;
  meta = null;
  records.clear();
}

window.mochimonoCatalogCache = {
  load,
  loadQuick,
  save,
  rememberDimensions,
  clear,
  state: () => ({ version: meta?.version || '', count: records.size, savedAt: Number(meta?.savedAt) || 0 })
};
