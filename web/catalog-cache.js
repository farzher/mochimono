const DB_NAME = 'mochimono-library';
const DB_VERSION = 1;
const SCHEMA = 1;
const META_KEY = 'catalog';
const WRITE_BATCH = 1500;

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
  const pending = pendingGeometry.get(hash);
  if (pending?.width && pending?.height) return { ...file, width: pending.width, height: pending.height };
  const previous = records.get(hash);
  if (!(Number(previous?.width) > 0 && Number(previous?.height) > 0)) return file;
  return { ...file, width: Number(previous.width), height: Number(previous.height) };
}

function memorySnapshot() {
  if (!meta?.version || records.size !== Number(meta.count || 0)) return null;
  return {
    version: String(meta.version),
    imports: Array.isArray(meta.imports) ? meta.imports : [],
    files: [...records.values()].map(publicFile),
    savedAt: Number(meta.savedAt) || 0
  };
}

async function loadFromDb() {
  const db = await openDb();
  if (!db) return null;
  const transaction = db.transaction(['files', 'meta']);
  const done = transactionDone(transaction);
  const [storedMeta, all] = await Promise.all([
    requestResult(transaction.objectStore('meta').get(META_KEY)),
    requestResult(transaction.objectStore('files').getAll())
  ]);
  await done;
  if (!storedMeta || storedMeta.schema !== SCHEMA || !storedMeta.version) return null;

  const files = all.filter(file => file.__snapshot === storedMeta.version).map(publicFile);
  if (files.length !== Number(storedMeta.count || 0)) return null;

  meta = storedMeta;
  records = new Map(files.map(file => [String(file.hash), file]));
  return memorySnapshot();
}

async function load() {
  const memory = memorySnapshot();
  if (memory) return memory;
  if (!loadPromise) {
    loadPromise = loadFromDb().finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

async function save(files, options = {}) {
  if (!Array.isArray(files)) return;
  const version = String(options.version || '');
  if (!version) return;
  return enqueueWrite(async () => {
    const db = await openDb();
    if (!db) return;

    const clean = files
      .filter(file => /^[a-f0-9]{64}$/.test(String(file?.hash || '')))
      .map(file => mergeGeometry(publicFile(file)));

    for (let offset = 0; offset < clean.length; offset += WRITE_BATCH) {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');
      for (const file of clean.slice(offset, offset + WRITE_BATCH)) {
        store.put({ ...file, __snapshot: version });
      }
      await transactionDone(transaction);
      await idle();
    }

    const nextMeta = {
      key: META_KEY,
      schema: SCHEMA,
      version,
      imports: Array.isArray(options.imports) ? options.imports : [],
      count: clean.length,
      savedAt: Date.now()
    };
    {
      const transaction = db.transaction('meta', 'readwrite');
      transaction.objectStore('meta').put(nextMeta);
      await transactionDone(transaction);
    }

    meta = nextMeta;
    records = new Map(clean.map(file => [String(file.hash), file]));
    for (const file of clean) {
      const geometry = pendingGeometry.get(String(file.hash));
      if (geometry && Number(file.width) === geometry.width && Number(file.height) === geometry.height) pendingGeometry.delete(String(file.hash));
    }
    idle().then(() => enqueueWrite(() => cleanupOldSnapshots(version))).catch(() => {});
  });
}

async function cleanupOldSnapshots(version) {
  if (meta?.version !== version) return;
  const db = await openDb();
  if (!db || meta?.version !== version) return;
  const transaction = db.transaction('files', 'readwrite');
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
  await transactionDone(transaction);
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
  if (!pendingGeometry.size) return Promise.resolve();
  return enqueueWrite(async () => {
    if (!pendingGeometry.size) return;
    if (!records.size) await load().catch(() => null);
    const version = String(meta?.version || '');
    if (!version) return;
    const db = await openDb();
    if (!db) return;

    const batch = [...pendingGeometry];
    pendingGeometry.clear();
    const transaction = db.transaction('files', 'readwrite');
    const store = transaction.objectStore('files');
    for (const [hash, geometry] of batch) {
      const previous = records.get(hash);
      if (!previous) continue;
      const next = { ...previous, width: geometry.width, height: geometry.height };
      records.set(hash, next);
      store.put({ ...next, __snapshot: version });
    }
    await transactionDone(transaction);
    if (pendingGeometry.size) scheduleGeometryWrite();
  });
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

async function clear() {
  if (geometryJob) {
    if ('cancelIdleCallback' in window) cancelIdleCallback(geometryJob);
    else clearTimeout(geometryJob);
    geometryJob = 0;
  }
  pendingGeometry.clear();
  return enqueueWrite(async () => {
    const db = await openDb();
    if (!db) return;
    const transaction = db.transaction(['files', 'meta'], 'readwrite');
    transaction.objectStore('files').clear();
    transaction.objectStore('meta').clear();
    await transactionDone(transaction);
    meta = null;
    records.clear();
  });
}

window.mochimonoCatalogCache = {
  load,
  save,
  rememberDimensions,
  clear,
  state: () => ({ version: meta?.version || '', count: records.size, savedAt: Number(meta?.savedAt) || 0 })
};

// Start the IndexedDB read immediately, before library-app waits on the server
// health check. Normal reloads can then restore the cached grid from memory in
// the same frame instead of briefly painting a Loading screen first.
load().catch(() => {});
