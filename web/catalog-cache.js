const DB_NAME = 'mochimono-library';
const DB_VERSION = 1;
const SCHEMA = 1;
const META_KEY = 'catalog';
const WRITE_BATCH = 1500;

let dbPromise = null;
let meta = null;
let records = new Map();

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
  const previous = records.get(String(file?.hash || ''));
  if (!previous) return file;
  if (Number(file.width) > 0 && Number(file.height) > 0) return file;
  if (!(Number(previous.width) > 0 && Number(previous.height) > 0)) return file;
  return { ...file, width: Number(previous.width), height: Number(previous.height) };
}

async function load() {
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
  return {
    version: String(storedMeta.version),
    imports: Array.isArray(storedMeta.imports) ? storedMeta.imports : [],
    files,
    savedAt: Number(storedMeta.savedAt) || 0
  };
}

async function save(files, options = {}) {
  const db = await openDb();
  if (!db || !Array.isArray(files)) return;
  const version = String(options.version || '');
  if (!version) return;

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
  cleanupOldSnapshots(version).catch(() => {});
}

async function cleanupOldSnapshots(version) {
  await idle();
  const db = await openDb();
  if (!db) return;
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

async function rememberDimensions(hash, width, height) {
  hash = String(hash || '');
  width = Number(width) || 0;
  height = Number(height) || 0;
  if (!hash || !width || !height) return;

  let previous = records.get(hash);
  if (previous && Number(previous.width) === width && Number(previous.height) === height) return;

  const db = await openDb();
  if (!db) return;
  if (!previous) {
    const transaction = db.transaction('files');
    previous = publicFile(await requestResult(transaction.objectStore('files').get(hash)));
    await transactionDone(transaction).catch(() => {});
  }
  if (!previous) return;

  const next = { ...previous, width, height };
  records.set(hash, next);
  const transaction = db.transaction('files', 'readwrite');
  transaction.objectStore('files').put({ ...next, __snapshot: meta?.version || previous.__snapshot || '' });
  await transactionDone(transaction).catch(() => {});
}

async function clear() {
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
  save,
  rememberDimensions,
  clear,
  state: () => ({ version: meta?.version || '', count: records.size, savedAt: Number(meta?.savedAt) || 0 })
};
