import './startup-geometry.js';

const DB_NAME = 'mochimono-library';
const DB_VERSION = 1;
const SCHEMA = 1;
const META_KEY = 'catalog';
const WRITE_BATCH = 1500;
const READ_PARALLELISM = 4;
const HASH_PREFIXES = '0123456789abcdef';
const QUICK_VERSION = 2;
const QUICK_FILES = 600;
const QUICK_MEDIA = 5000;
const QUICK_UPGRADE_DELAY = 8000;
const CLIENT = document.documentElement.classList.contains('client-library');

let dbPromise = null;
let loadPromise = null;
let meta = null;
let records = new Map();
let pendingGeometry = new Map();
let geometryJob = 0;
let quickUpgradeJob = 0;
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
    files: [...records.values()].map(file => mergeGeometry(file)),
    savedAt: Number(meta.savedAt) || 0
  };
}

function quickSnapshot(value = meta) {
  if (!validMeta(value) || !Array.isArray(value.quickFiles) || !value.quickFiles.length) return null;
  return {
    version: String(value.version),
    imports: Array.isArray(value.imports) ? value.imports : [],
    files: value.quickFiles.map(file => mergeGeometry(file)),
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

async function loadQuick() {
  const started = performance.now();
  const db = await openDb();
  if (!db) return quickSnapshot();
  const storedMeta = validMeta(meta) ? meta : await readMeta(db);
  if (!storedMeta) return null;
  meta = storedMeta;

  // quickFiles is already a self-contained saved snapshot, and geometry writes
  // update the same metadata record. Re-reading every quick hash individually
  // added hundreds/thousands of IndexedDB requests before first paint for no gain.
  const snapshot = quickSnapshot(storedMeta);
  lastQuickLoadMs = performance.now() - started;
  return snapshot;
}

async function readPrefix(db, prefix, version) {
  const transaction = db.transaction('files', 'readonly');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('files');
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  const rows = await requestResult(store.getAll(range));
  await done;

  const files = [];
  for (const file of rows) {
    if (file?.__snapshot !== version) continue;
    // IndexedDB returned a fresh mutable object. Strip the internal marker in
    // place instead of allocating one complete duplicate of the whole catalog.
    delete file.__snapshot;
    files.push(file);
  }
  return files;
}

async function readFilesParallel(db, version) {
  const files = [];
  let cursor = 0;
  const workers = Array.from({ length:READ_PARALLELISM }, async () => {
    while (cursor < HASH_PREFIXES.length) {
      const prefix = HASH_PREFIXES[cursor++];
      files.push(...await readPrefix(db, prefix, version));
    }
  });
  await Promise.all(workers);
  return files;
}

function scheduleQuickUpgrade(files, storedMeta) {
  if (!validMeta(storedMeta) || Number(storedMeta.quickVersion) === QUICK_VERSION || quickUpgradeJob) return;
  const run = () => {
    quickUpgradeJob = 0;
    // This is a one-time local migration and sorts the complete catalog. Do not
    // trust requestIdleCallback here: Chrome can call it during cold startup.
    // Wait for a real quiet period and keep backing off while the user navigates.
    if (window.mochimonoGridInteraction?.state?.().active) {
      quickUpgradeJob = setTimeout(run, 2000);
      return;
    }
    enqueueWrite(() => upgradeQuickMeta(files, storedMeta)).catch(() => {});
  };
  quickUpgradeJob = setTimeout(run, QUICK_UPGRADE_DELAY);
}

async function upgradeQuickMeta(files, expectedMeta) {
  if (!validMeta(meta) || meta.version !== expectedMeta.version) return;
  const db = await openDb();
  if (!db || meta.version !== expectedMeta.version) return;
  const nextMeta = { ...meta, quickVersion:QUICK_VERSION, quickFiles:quickFiles(files) };
  const transaction = db.transaction('meta', 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('meta').put(nextMeta);
  await done;
  if (meta?.version === nextMeta.version) meta = nextMeta;
}

async function loadFromDb(knownMeta = null) {
  const started = performance.now();
  const db = await openDb();
  if (!db) return null;
  const storedMeta = validMeta(knownMeta) ? knownMeta : await readMeta(db);
  if (!storedMeta) return null;

  const files = await readFilesParallel(db, String(storedMeta.version));
  if (files.length !== Number(storedMeta.count || 0)) return null;
  meta = storedMeta;

  const nextRecords = new Map();
  for (let index = 0; index < files.length; index++) {
    const file = mergeGeometry(files[index]);
    files[index] = file;
    nextRecords.set(String(file.hash), file);
  }
  records = nextRecords;
  lastFullLoadMs = performance.now() - started;
  scheduleQuickUpgrade(files, storedMeta);

  // Return the already-loaded objects directly. The old path rebuilt another
  // full array of cloned objects through memorySnapshot() immediately before
  // library-app normalized them yet again.
  return {
    version:String(storedMeta.version),
    imports:Array.isArray(storedMeta.imports) ? storedMeta.imports : [],
    files,
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
      window.removeEventListener('mochimono:stable-grid-installed', onGrid);
      clearTimeout(timer);
      paintTurn().then(resolve);
    };
    const onGrid = () => finish();
    // Keep the temporary startup empty state hidden long enough for the quick
    // worker geometry to actually arrive. The old 140ms timeout exposed
    // "No files" while a valid quick layout was still being built.
    const timer = setTimeout(finish, 900);
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
      await installQuickPreview(quick).catch(() => {
        document.documentElement.classList.remove('mochimono-quick-grid-pending');
        return false;
      });
      // The quick grid has had a paint turn. Hydrate the complete local catalog
      // immediately, but do it with parallel readonly ranges rather than a long
      // chain of sequential transactions.
      return loadFromDb(meta);
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

function quickFiles(files) {
  const sorted = [...files].sort((a, b) => {
    const aDate = Number(a.dateMs) || Date.parse(a.fileDate || a.createdAt || 0) || 0;
    const bDate = Number(b.dateMs) || Date.parse(b.fileDate || b.createdAt || 0) || 0;
    return bDate - aDate || String(a.hash || '').localeCompare(String(b.hash || ''));
  });
  const selected = new Map();
  for (const file of sorted.slice(0, QUICK_FILES)) selected.set(String(file.hash), file);
  let media = 0;
  for (const file of sorted) {
    if (!isMediaFile(file)) continue;
    selected.set(String(file.hash), file);
    if (++media >= QUICK_MEDIA) break;
  }
  return [...selected.values()].map(publicFile);
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
    quickVersion: QUICK_VERSION,
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
  if (quickUpgradeJob) {
    clearTimeout(quickUpgradeJob);
    quickUpgradeJob = 0;
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
  state: () => ({
    version: meta?.version || '',
    count: records.size,
    quickCount:Array.isArray(meta?.quickFiles) ? meta.quickFiles.length : 0,
    quickVersion:Number(meta?.quickVersion) || 0,
    savedAt: Number(meta?.savedAt) || 0,
    quickLoadMs:Math.round(lastQuickLoadMs * 10) / 10,
    fullLoadMs:Math.round(lastFullLoadMs * 10) / 10
  })
};