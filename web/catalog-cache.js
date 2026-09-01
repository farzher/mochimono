const CLIENT = document.documentElement.classList.contains('client-library');

if (CLIENT && 'indexedDB' in window) {
  const DB_NAME = 'mochimono-catalog';
  const DB_VERSION = 3;
  const META_KEY = 'client-catalog-v3';
  const SCHEMA = 3;
  const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const PAGE = 5000;
  const WRITE_BATCH = 1000;

  const app = document.querySelector('#app');
  const filesElement = document.querySelector('#files');
  let dbPromise = null;
  let meta = null;
  let records = new Map();
  let refreshTimer = 0;
  let refreshing = false;

  const requestResult = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  const idle = () => new Promise(resolve => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 0);
  });

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'hash' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        // The old implementation stored thumbnail blobs in IndexedDB. Mochimono
        // now has an immutable HTTP cache plus a persistent Agent-side preview
        // cache, so keeping a second copy in IndexedDB only wastes space.
        if (db.objectStoreNames.contains('thumbs')) db.deleteObjectStore('thumbs');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      console.warn('Mochimono catalog cache unavailable', error);
      return null;
    });
    return dbPromise;
  }

  async function readSnapshot() {
    const db = await openDb();
    if (!db) return null;
    const transaction = db.transaction(['files', 'meta']);
    const done = transactionDone(transaction);
    const [files, storedMeta] = await Promise.all([
      requestResult(transaction.objectStore('files').getAll()),
      requestResult(transaction.objectStore('meta').get(META_KEY))
    ]);
    await done;
    if (!storedMeta || storedMeta.schema !== SCHEMA || storedMeta.writing) return null;
    if (Date.now() - Number(storedMeta.savedAt || 0) > MAX_AGE) return null;
    if (Number(storedMeta.count) !== files.length) return null;
    return { files, meta: storedMeta };
  }

  async function writeMeta(next) {
    const db = await openDb();
    if (!db) return;
    const transaction = db.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put({ key: META_KEY, schema: SCHEMA, ...next });
    await transactionDone(transaction);
  }

  function mergeLearnedGeometry(file) {
    const previous = records.get(String(file?.hash || ''));
    if (!previous) return file;
    if (Number(file.width) > 0 && Number(file.height) > 0) return file;
    if (!(Number(previous.width) > 0 && Number(previous.height) > 0)) return file;
    return { ...file, width: Number(previous.width), height: Number(previous.height) };
  }

  async function writeSnapshot(files, version) {
    const db = await openDb();
    if (!db || !Array.isArray(files)) return;
    const clean = files.filter(file => /^[a-f0-9]{64}$/.test(String(file?.hash || ''))).map(mergeLearnedGeometry);

    await writeMeta({ writing: true, savedAt: Date.now(), version: String(version || ''), count: clean.length });

    {
      const transaction = db.transaction('files', 'readwrite');
      transaction.objectStore('files').clear();
      await transactionDone(transaction);
    }

    for (let offset = 0; offset < clean.length; offset += WRITE_BATCH) {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');
      for (const file of clean.slice(offset, offset + WRITE_BATCH)) store.put(file);
      await transactionDone(transaction);
      await idle();
    }

    meta = { key: META_KEY, schema: SCHEMA, writing: false, savedAt: Date.now(), version: String(version || ''), count: clean.length };
    await writeMeta(meta);
    records = new Map(clean.map(file => [String(file.hash), file]));
  }

  async function rememberDimensions(hash, width, height) {
    hash = String(hash || '');
    width = Number(width) || 0;
    height = Number(height) || 0;
    if (!hash || !width || !height) return;
    const previous = records.get(hash);
    if (!previous) return;
    if (Number(previous.width) === width && Number(previous.height) === height) return;
    const next = { ...previous, width, height };
    records.set(hash, next);
    const db = await openDb();
    if (!db) return;
    const transaction = db.transaction('files', 'readwrite');
    transaction.objectStore('files').put(next);
    await transactionDone(transaction).catch(() => {});
  }

  function libraryReady() {
    return !app?.hidden && window.mochimonoLibrary?.upsertMany && window.mochimonoLibrary?.state;
  }

  async function restore() {
    const snapshot = await readSnapshot().catch(() => null);
    if (!snapshot?.files?.length) return;
    meta = snapshot.meta;
    records = new Map(snapshot.files.map(file => [String(file.hash), file]));

    // app.js starts its health check before this module runs. Wait until it has
    // made the Library visible, then restore exactly once. If the fresh catalog
    // already won the race, do nothing rather than mixing stale data into it.
    const started = performance.now();
    while (!libraryReady() && performance.now() - started < 3000) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const library = window.mochimonoLibrary;
    if (!library?.upsertMany || library.state().total > 0) return;
    library.upsertMany(snapshot.files);
    window.dispatchEvent(new CustomEvent('mochimono:catalog-cache-restored', { detail: { count: snapshot.files.length } }));
  }

  async function fetchFreshSnapshot() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
      const versionResponse = await fetch('/api/catalog/version', { cache: 'no-store' });
      if (!versionResponse.ok) return;
      const version = String((await versionResponse.json()).version || '');
      if (meta?.version === version && meta?.count === records.size && records.size) return;

      const fresh = [];
      let after = '';
      do {
        const response = await fetch(`/api/catalog?limit=${PAGE}&after=${encodeURIComponent(after)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const page = await response.json();
        fresh.push(...(page.files || []));
        after = page.nextAfter || '';
        await idle();
      } while (after);

      await writeSnapshot(fresh, version);
    } catch (error) {
      console.warn('Could not refresh Mochimono catalog cache', error);
    } finally {
      refreshing = false;
    }
  }

  function scheduleRefresh(delay = 1500) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const run = () => fetchFreshSnapshot().catch(() => {});
      if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 });
      else run();
    }, delay);
  }

  filesElement?.addEventListener('load', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains('cached-thumb')) return;
    const hash = image.closest('[data-hash]')?.dataset?.hash || '';
    if (hash && image.naturalWidth && image.naturalHeight) rememberDimensions(hash, image.naturalWidth, image.naturalHeight).catch(() => {});
  }, true);

  // Do not infer application state from UI wording. In particular, locations.js
  // intentionally renames "All sources" to "Origin". The old startup helpers
  // used that text as a readiness signal, which made canonical-date/timeline
  // behavior depend on MutationObserver ordering. A version check is the source
  // of truth now, and cache maintenance stays off the first-paint critical path.
  setTimeout(() => scheduleRefresh(0), 5000);
  window.addEventListener('mochimono:locations-updated', () => scheduleRefresh(1500));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh(2500);
  });
  window.addEventListener('focus', () => scheduleRefresh(2500), { passive: true });
  addEventListener('beforeunload', () => clearTimeout(refreshTimer), { once: true });

  // Retire the two partial caches. Keeping them around would make debugging
  // future startup behavior unnecessarily ambiguous even though their scripts
  // are no longer loaded.
  try {
    localStorage.removeItem('mochimono-fast-local-v1');
    localStorage.removeItem('mochimono-timeline-rail-v1');
  } catch {}

  window.mochimonoCatalogCache = { rememberDimensions, refresh: () => scheduleRefresh(0) };
  restore().catch(() => {});
}
