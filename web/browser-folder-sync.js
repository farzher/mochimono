const DB_NAME = 'mochimono-browser-folders';
const DB_VERSION = 1;
const SOURCES = 'sources';
const FILES = 'files';
const AUTO_SYNC_MS = 5 * 60 * 1000;
const MEDIA_EXTENSIONS = new Set([
  'jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff',
  'mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp'
]);

let activeSync = null;
let autoTimer = 0;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES, { keyPath:'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath:'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(storeNames, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = Object.fromEntries(storeNames.map(name => [name, tx.objectStore(name)]));
    let result;
    try { result = work(stores, tx); }
    catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Browser folder database transaction aborted')); };
  });
}

function all(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function get(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function cleanRelative(value) {
  return String(value || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.' && part !== '..').join('/');
}

function mediaFile(file, path) {
  const type = String(file?.type || '');
  if (type.startsWith('image/') || type.startsWith('video/')) return true;
  const name = String(path || file?.name || '');
  const index = name.lastIndexOf('.');
  return index >= 0 && MEDIA_EXTENSIONS.has(name.slice(index + 1).toLowerCase());
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function sourceList() {
  const db = await openDb();
  try {
    return await all(db.transaction(SOURCES, 'readonly').objectStore(SOURCES));
  } finally { db.close(); }
}

async function saveSource(source) {
  await transaction([SOURCES], 'readwrite', ({ sources }) => sources.put(source));
  dispatchEvent(new CustomEvent('mochimono:browser-folders-changed'));
  return source;
}

async function sourceById(id) {
  const db = await openDb();
  try { return await get(db.transaction(SOURCES, 'readonly').objectStore(SOURCES), String(id)); }
  finally { db.close(); }
}

async function manifestFor(id) {
  const prefix = `${id}\u0000`;
  const db = await openDb();
  try {
    const rows = await all(db.transaction(FILES, 'readonly').objectStore(FILES));
    return new Map(rows.filter(row => row.key.startsWith(prefix)).map(row => [row.path, row]));
  } finally { db.close(); }
}

async function replaceManifest(id, rows) {
  const prefix = `${id}\u0000`;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FILES, 'readwrite');
    const store = tx.objectStore(FILES);
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const value = cursor.result;
      if (!value) {
        for (const row of rows) store.put({ ...row, key:`${id}\u0000${row.path}` });
        return;
      }
      if (String(value.key).startsWith(prefix)) value.delete();
      value.continue();
    };
    cursor.onerror = () => reject(cursor.error);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not save browser folder manifest')); };
  });
}

async function permission(handle, ask = false) {
  if (!handle) return 'denied';
  if (!handle.queryPermission) return 'granted';
  let state = await handle.queryPermission({ mode:'read' }).catch(() => 'prompt');
  if (state !== 'granted' && ask && handle.requestPermission) {
    state = await handle.requestPermission({ mode:'read' }).catch(() => state);
  }
  return state;
}

async function* filesUnder(handle, prefix = '') {
  for await (const [name, child] of handle.entries()) {
    const path = cleanRelative(prefix ? `${prefix}/${name}` : name);
    if (child.kind === 'directory') yield* filesUnder(child, path);
    else if (child.kind === 'file') yield { handle:child, path };
  }
}

async function sameHandle(left, right) {
  if (!left || !right) return false;
  if (left.isSameEntry) return left.isSameEntry(right).catch(() => false);
  return left.name === right.name;
}

async function addHandle(handle, scope = 'media') {
  if (!handle || handle.kind !== 'directory') throw new Error('Drop a folder to sync it');
  const sources = await sourceList();
  for (const source of sources) {
    if (await sameHandle(source.handle, handle)) {
      source.handle = handle;
      source.name = handle.name;
      source.scope = scope === 'all' ? 'all' : 'media';
      if (!source.rootPath) source.rootPath = handle.name;
      await saveSource(source);
      return source;
    }
  }
  return saveSource({
    id:crypto.randomUUID(),
    handle,
    name:handle.name,
    importId:0,
    rootPath:handle.name,
    scope:scope === 'all' ? 'all' : 'media',
    createdAt:new Date().toISOString(),
    lastSynced:'',
    lastError:''
  });
}

async function addHandles(handles, scope = 'media', { sync = true } = {}) {
  const added = [];
  for (const handle of handles || []) {
    if (handle?.kind !== 'directory') continue;
    const source = await addHandle(handle, scope);
    added.push(source);
    if (sync) await syncSource(source.id, { userGesture:true });
  }
  return added;
}

async function syncSource(id, { userGesture = false } = {}) {
  const source = await sourceById(id);
  if (!source) throw new Error('Browser folder not found');
  if (activeSync && activeSync !== source.id) throw new Error('Another browser folder is syncing');
  if (await permission(source.handle, userGesture) !== 'granted') {
    source.lastError = 'Permission required';
    await saveSource(source);
    throw new Error('Folder permission required');
  }

  activeSync = source.id;
  dispatchEvent(new CustomEvent('mochimono:browser-folder-sync', { detail:{ id:source.id, state:'running' } }));
  try {
    const previous = await manifestFor(source.id);
    const started = await request('/api/client/import/start', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        label:source.name,
        importId:source.importId || 0,
        rootPath:source.rootPath || source.name,
        scope:source.scope,
        browser:true
      })
    });
    source.importId = Number(started.importId) || source.importId || 0;

    const next = [];
    let scanned = 0;
    let uploaded = 0;
    let skipped = 0;
    let seenBatch = [];
    const flushSeen = async () => {
      if (!seenBatch.length) return;
      const paths = seenBatch;
      seenBatch = [];
      await request(`/api/client/import/seen?session=${encodeURIComponent(started.session)}`, {
        method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ paths })
      });
    };

    for await (const item of filesUnder(source.handle)) {
      const file = await item.handle.getFile();
      if (source.scope !== 'all' && !mediaFile(file, item.path)) continue;
      scanned++;
      const path = cleanRelative(item.path);
      const old = previous.get(path);
      next.push({ path, size:file.size, lastModified:file.lastModified });
      if (old && Number(old.size) === Number(file.size) && Number(old.lastModified) === Number(file.lastModified)) {
        seenBatch.push(path);
        skipped++;
        if (seenBatch.length >= 1000) await flushSeen();
      } else {
        await flushSeen();
        const params = new URLSearchParams({
          session:started.session,
          path,
          mtime:new Date(file.lastModified || Date.now()).toISOString()
        });
        await request(`/api/client/import/file?${params}`, {
          method:'PUT',
          headers:{ 'x-mochimono-file-mime':file.type || 'application/octet-stream' },
          body:file
        });
        uploaded++;
      }
      dispatchEvent(new CustomEvent('mochimono:browser-folder-sync', { detail:{ id:source.id, state:'running', scanned, uploaded, skipped } }));
    }
    await flushSeen();
    const finished = await request(`/api/client/import/finish?session=${encodeURIComponent(started.session)}`, { method:'POST' });
    await replaceManifest(source.id, next);
    source.lastSynced = new Date().toISOString();
    source.lastError = '';
    await saveSource(source);
    window.mochimonoLibrary?.refresh?.().catch?.(() => {});
    dispatchEvent(new CustomEvent('mochimono:browser-folder-sync', { detail:{ id:source.id, state:'done', scanned, uploaded, skipped, removed:Number(finished.removed) || 0 } }));
    return { scanned, uploaded, skipped, removed:Number(finished.removed) || 0, importId:source.importId };
  } catch (error) {
    source.lastError = error.message || String(error);
    await saveSource(source).catch(() => {});
    dispatchEvent(new CustomEvent('mochimono:browser-folder-sync', { detail:{ id:source.id, state:'error', error:source.lastError } }));
    throw error;
  } finally {
    activeSync = null;
  }
}

async function setRootPath(id, rootPath) {
  const source = await sourceById(id);
  if (!source) throw new Error('Browser folder not found');
  source.rootPath = String(rootPath || '').trim().slice(0, 2000) || source.name;
  if (source.importId) {
    await request('/api/import-roots', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ roots:[{ importId:source.importId, deviceName:'Browser', rootPath:source.rootPath }] })
    });
  }
  await saveSource(source);
  window.mochimonoLibrary?.refresh?.().catch?.(() => {});
  return source;
}

async function setScope(id, scope) {
  const source = await sourceById(id);
  if (!source) throw new Error('Browser folder not found');
  source.scope = scope === 'all' ? 'all' : 'media';
  if (source.importId) {
    await request('/api/import-scope', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ importId:source.importId, scope:source.scope })
    });
  }
  await saveSource(source);
  return source;
}

async function removeSource(id) {
  const source = await sourceById(id);
  if (!source) return false;
  await transaction([SOURCES], 'readwrite', ({ sources }) => sources.delete(String(id)));
  await replaceManifest(String(id), []);
  dispatchEvent(new CustomEvent('mochimono:browser-folders-changed'));
  return true;
}

async function describeSources() {
  const sources = await sourceList();
  return Promise.all(sources.map(async source => ({
    ...source,
    handle:undefined,
    permission:await permission(source.handle, false)
  })));
}

async function autoSync() {
  if (document.visibilityState !== 'visible' || activeSync) return;
  const sources = await sourceList().catch(() => []);
  const now = Date.now();
  for (const source of sources) {
    const last = source.lastSynced ? new Date(source.lastSynced).getTime() : 0;
    if (last && now - last < AUTO_SYNC_MS) continue;
    if (await permission(source.handle, false) !== 'granted') continue;
    await syncSource(source.id).catch(() => {});
  }
}

function scheduleAuto() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    await autoSync();
    scheduleAuto();
  }, AUTO_SYNC_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') autoSync().catch(() => {});
});
scheduleAuto();
setTimeout(() => autoSync().catch(() => {}), 1500);

window.mochimonoBrowserFolders = {
  addHandles,
  list:describeSources,
  sync:syncSource,
  setRootPath,
  setScope,
  remove:removeSource,
  permission:async id => {
    const source = await sourceById(id);
    return source ? permission(source.handle, false) : 'denied';
  }
};

dispatchEvent(new CustomEvent('mochimono:browser-folders-ready'));
