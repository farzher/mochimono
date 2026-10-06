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
const pendingSyncs = new Set();
let syncPumpTimer = 0;
let autoTimer = 0;
let viewerBlobUrl = '';
let viewerBlobHash = '';
const fileLocations = new Map();

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

function all(store, range) {
  return new Promise((resolve, reject) => {
    const request = store.getAll(range);
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

function mimeFor(file, path = '') {
  const supplied = String(file?.type || '').trim();
  if (supplied) return supplied;
  const name = String(path || file?.name || '');
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['jpg','jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'avif') return 'image/avif';
  if (['heic','heif'].includes(ext)) return 'image/heic';
  if (['tif','tiff'].includes(ext)) return 'image/tiff';
  if (['mp4','m4v'].includes(ext)) return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  if (['mpg','mpeg','m2v'].includes(ext)) return 'video/mpeg';
  if (['mts','m2ts'].includes(ext)) return 'video/mp2t';
  return 'application/octet-stream';
}

function mediaFile(file, path) {
  const type = mimeFor(file, path);
  if (type.startsWith('image/') || type.startsWith('video/')) return true;
  const name = String(path || file?.name || '');
  const index = name.lastIndexOf('.');
  return index >= 0 && MEDIA_EXTENSIONS.has(name.slice(index + 1).toLowerCase());
}

function normalizeSource(source) {
  if (!source) return source;
  return {
    ...source,
    scope:source.scope === 'all' ? 'all' : 'media',
    cloud:source.cloud === true
  };
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

const BROWSER_PROTECTION_ID = 'mochimono:browser-protection-id';

function browserProtectionDevice() {
  let id = localStorage.getItem(BROWSER_PROTECTION_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(BROWSER_PROTECTION_ID, id);
  }
  return `Browser:${id}`;
}

async function publishProtectionIntents() {
  const scanId = crypto.randomUUID();
  const device = browserProtectionDevice();
  const sources = (await sourceList()).filter(source => source.cloud === true);
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const entries = batch;
    batch = [];
    await request(`/api/protection/intents/${encodeURIComponent(device)}`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ scanId, entries })
    });
  };

  for (const source of sources) {
    for (const row of (await manifestFor(source.id)).values()) {
      const hash = String(row.hash || '');
      if (!row.cloudSynced || !/^[a-f0-9]{64}$/.test(hash)) continue;
      batch.push({
        rootPath:source.rootPath || source.name,
        path:String(row.path || ''),
        hash,
        size:Number(row.size) || 0,
        importId:Number(source.importId) || 0
      });
      if (batch.length >= 500) await flush();
    }
  }
  await flush();
  await request(`/api/protection/intents/${encodeURIComponent(device)}`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ scanId, entries:[], final:true })
  });
}

async function sourceList() {
  const db = await openDb();
  try {
    const rows = await all(db.transaction(SOURCES, 'readonly').objectStore(SOURCES));
    return rows.map(normalizeSource);
  } finally { db.close(); }
}

async function saveSource(source) {
  const normalized = normalizeSource(source);
  await transaction([SOURCES], 'readwrite', ({ sources }) => sources.put(normalized));
  dispatchEvent(new CustomEvent('mochimono:browser-folders-changed'));
  return normalized;
}

async function sourceById(id) {
  const db = await openDb();
  try { return normalizeSource(await get(db.transaction(SOURCES, 'readonly').objectStore(SOURCES), String(id))); }
  finally { db.close(); }
}

async function manifestFor(id) {
  const prefix = `${id}\u0000`;
  const db = await openDb();
  try {
    const rows = await all(db.transaction(FILES, 'readonly').objectStore(FILES), IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    return new Map(rows.map(row => [row.path, row]));
  } finally { db.close(); }
}

async function replaceManifest(id, rows) {
  const prefix = `${id}\u0000`;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FILES, 'readwrite');
    const store = tx.objectStore(FILES);
    store.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    for (const row of rows) store.put({ ...row, key:`${id}\u0000${row.path}` });
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

function yieldUi() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}

function emitSync(detail) {
  dispatchEvent(new CustomEvent('mochimono:browser-folder-sync', { detail }));
}

function queueSourceSync(id,name='') {
  id=String(id||'');
  if(!id||pendingSyncs.has(id))return;
  pendingSyncs.add(id);
  if(activeSync===id)return;
  emitSync({ id, name:String(name||''), state:'queued' });
  clearTimeout(syncPumpTimer);
  syncPumpTimer=setTimeout(pumpSourceSyncs,0);
}

async function pumpSourceSyncs() {
  syncPumpTimer=0;
  if(activeSync||!pendingSyncs.size){
    if(pendingSyncs.size)syncPumpTimer=setTimeout(pumpSourceSyncs,100);
    return;
  }
  const id=pendingSyncs.values().next().value;
  pendingSyncs.delete(id);
  try{await syncSource(id);}catch{}
  if(pendingSyncs.size)syncPumpTimer=setTimeout(pumpSourceSyncs,0);
}

let previewQueuePromise=null;
function queueSourcePreviews(rows) {
  const records=(rows||[])
    .filter(row=>/^[a-f0-9]{64}$/.test(String(row.hash||''))&&mediaFile(null,row.path))
    .sort((a,b)=>Number(b.lastModified||0)-Number(a.lastModified||0))
    .slice(0,12)
    .map(row=>({
      hash:String(row.hash),
      filename:String(row.path||'').split('/').at(-1)||row.path,
      mime:row.mime||'application/octet-stream',
      kind:String(row.mime||'').startsWith('video/')?'video':'image',
      urgent:true
    }));
  if(!records.length)return;
  previewQueuePromise ||= import('./browser-thumbnail-fallback.js');
  previewQueuePromise.then(module=>{
    for(const record of records)module.queueBrowserThumbnail(record);
  }).catch(()=>{ previewQueuePromise=null; });
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
  for (const existing of sources) {
    if (await sameHandle(existing.handle, handle)) {
      existing.handle = handle;
      existing.name = handle.name;
      existing.scope = scope === 'all' ? 'all' : 'media';
      if (!existing.rootPath) existing.rootPath = handle.name;
      await saveSource(existing);
      return existing;
    }
  }
  return saveSource({
    id:crypto.randomUUID(),
    handle,
    name:handle.name,
    importId:0,
    rootPath:handle.name,
    scope:scope === 'all' ? 'all' : 'media',
    cloud:false,
    createdAt:new Date().toISOString(),
    lastSynced:'',
    lastError:''
  });
}

async function addHandles(handles, scope = 'media', { sync = true } = {}) {
  const added = [];
  for (const handle of handles || []) {
    if (handle?.kind !== 'directory') continue;
    const access=await permission(handle,true);
    const source=await addHandle(handle,scope);
    if(access!=='granted'){
      source.lastError='Permission required';
      await saveSource(source);
    }else if(source.lastError==='Permission required'){
      source.lastError='';
      await saveSource(source);
    }
    added.push(source);
  }
  if(sync)for(const source of added)if(source.lastError!=='Permission required')queueSourceSync(source.id,source.name);
  return added;
}

function libraryFile(row, source) {
  const date = new Date(Number(row.lastModified) || Date.now()).toISOString();
  const filename = String(row.path || '').split('/').at(-1) || row.path;
  return {
    hash:row.hash,
    replacesHash:row.replacesHash || '',
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
    searchText:`${source.name} ${source.rootPath || ''} ${row.path}`,
    serverStored:Boolean(source.cloud && row.cloudSynced),
    browserSourceId:source.id
  };
}

async function publishSource(source, rows = null) {
  const manifest = rows || [...(await manifestFor(source.id)).values()];
  for (const row of manifest) if (row.hash) fileLocations.set(String(row.hash), { source, row });
  const files = manifest.filter(row => /^[a-f0-9]{64}$/.test(String(row.hash || ''))).map(row => libraryFile(row, source));
  if (files.length) window.mochimonoLibrary?.upsertMany?.(files);
  return files;
}

async function saveManifestBatch(id, rows) {
  await transaction([FILES], 'readwrite', ({ files }) => {
    for (const row of rows) files.put({ ...row, key:`${id}\u0000${row.path}` });
  });
  dispatchEvent(new CustomEvent('mochimono:browser-files-changed'));
}

async function localBrowserId(source, path, file) {
  const value = `mochimono-browser-v1\0${source.id}\0${path}\0${file.size}\0${file.lastModified}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function syncSource(id, { userGesture = false } = {}) {
  const source = await sourceById(id);
  if (!source) throw new Error('Browser folder not found');
  if (activeSync) throw new Error(activeSync===source.id?'This folder is already indexing':'Another browser folder is indexing');
  if (await permission(source.handle, userGesture) !== 'granted') {
    source.lastError = 'Permission required';
    await saveSource(source);
    throw new Error('Folder permission required');
  }

  activeSync = source.id;
  let lastProgressAt=0;
  let sliceStarted=performance.now();
  const progress=(detail={},force=false)=>{
    const now=performance.now();
    if(!force&&now-lastProgressAt<120)return;
    lastProgressAt=now;
    emitSync({ id:source.id, name:source.name, state:'running', phase:'indexing', ...detail });
  };
  progress({},true);
  try {
    const previous = await manifestFor(source.id);
    const next = [];
    const uploads = [];
    let batch = [];
    let scanned = 0;
    let transferred = 0;
    let skipped = 0;
    const flush = async () => {
      if (!batch.length) return;
      if (!await sourceById(source.id)) throw new Error('Folder removed');
      const rows = batch;
      batch = [];
      await saveManifestBatch(source.id, rows);
      await publishSource(source, rows);
      queueSourcePreviews(rows);
      await yieldUi();
    };

    // Discover and publish first. Local folders never send originals to localhost
    // just to identify them, and neither uploads nor image decoding gate access.
    for await (const item of filesUnder(source.handle)) {
      if (source.scope !== 'all' && !mediaFile(null, item.path)) continue;
      const file = await item.handle.getFile();
      const path = cleanRelative(item.path);
      const old = previous.get(path);
      const same = old?.hash && Number(old.size) === file.size && Number(old.lastModified) === file.lastModified;
      const row = same ? { ...old } : {
        path, size:file.size, lastModified:file.lastModified,
        hash:await localBrowserId(source, path, file),
        mime:mimeFor(file, path), cloudSynced:false
      };
      next.push(row);
      batch.push(row);
      if (source.cloud && !row.cloudSynced) uploads.push({ handle:item.handle, row });
      else skipped++;
      scanned++;
      if (scanned === 1 || batch.length >= 64 || performance.now() - sliceStarted > 100) {
        await flush();
        sliceStarted = performance.now();
      }
      progress({ scanned, transferred, skipped, current:path });
    }
    await flush();
    await replaceManifest(source.id, next);
    let finished = { removed:0 };

    if (source.cloud) {
      const started = await request('/api/client/import/start', {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ label:source.name, importId:source.importId || 0,
          rootPath:source.rootPath || source.name, scope:source.scope, browser:true, cloud:true })
      });
      source.importId = Number(started.importId);
      const currentSource = await sourceById(source.id);
      if (!currentSource) throw new Error('Folder removed');
      currentSource.importId = source.importId;
      await saveSource(currentSource);
      // Every path was discovered successfully before any remote pruning can run.
      for (let offset = 0; offset < next.length; offset += 1000) {
        await request(`/api/client/import/seen?session=${encodeURIComponent(started.session)}`, {
          method:'POST', headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ paths:next.slice(offset, offset + 1000).map(row => row.path) })
        });
      }
      let cursor = 0;
      let uploadError = null;
      await Promise.all(Array.from({ length:Math.min(2, uploads.length) }, async () => {
        while (cursor < uploads.length && !uploadError) {
          const { handle, row } = uploads[cursor++];
          try {
            if (!await sourceById(source.id)) throw new Error('Folder removed');
            const file = await handle.getFile();
            if (file.size !== row.size || file.lastModified !== row.lastModified) throw new Error(`File changed: ${row.path}`);
            const params = new URLSearchParams({ session:started.session, path:row.path,
              mtime:new Date(file.lastModified || Date.now()).toISOString() });
            const data = await request(`/api/client/import/file?${params}`, {
              method:'PUT', headers:{ 'x-mochimono-file-mime':row.mime }, body:file
            });
            row.replacesHash = row.hash;
            row.hash = data.hash;
            row.cloudSynced = data.ignored !== true;
            await saveManifestBatch(source.id, [row]);
            await publishSource(source, [row]);
            queueSourcePreviews([row]);
            transferred++;
            progress({ phase:'uploading', scanned, transferred, skipped, current:row.path });
          } catch (error) { uploadError ||= error; }
        }
      }));
      if (uploadError) throw uploadError;
      finished = await request(`/api/client/import/finish?session=${encodeURIComponent(started.session)}`, { method:'POST' });
    }
    const latest=await sourceById(source.id);
    if(!latest){
      await replaceManifest(source.id,[]);
      emitSync({ id:source.id, name:source.name, state:'done', phase:'removed', scanned, transferred, skipped });
      return { scanned, transferred, skipped, removed:Number(finished.removed) || 0, importId:source.importId, cloud:source.cloud };
    }
    latest.importId=source.importId;
    latest.lastSynced=new Date().toISOString();
    latest.lastError='';
    await saveSource(latest);
    await publishSource(latest,next);
    queueSourcePreviews(next);
    if(source.cloud){
      await publishProtectionIntents();
      window.mochimonoLibrary?.refresh?.().catch?.(()=>{});
    }
    emitSync({ id:source.id, name:latest.name, state:'done', phase:'indexed', scanned, transferred, skipped, removed:Number(finished.removed) || 0 });
    return { scanned, transferred, skipped, removed:Number(finished.removed) || 0, importId:source.importId, cloud:source.cloud };
  } catch (error) {
    const latest=await sourceById(source.id).catch(()=>null);
    if(latest){
      latest.lastError=error.message||String(error);
      await saveSource(latest).catch(()=>{});
    } else await replaceManifest(source.id, []).catch(() => {});
    emitSync({ id:source.id, name:latest?.name||source.name, state:'error', error:error.message||String(error) });
    throw error;
  } finally {
    activeSync = null;
    if(pendingSyncs.size&&!syncPumpTimer)syncPumpTimer=setTimeout(pumpSourceSyncs,0);
  }
}

async function setRootPath(id, rootPath) {
  const source = await sourceById(id);
  if (!source) throw new Error('Browser folder not found');
  source.rootPath = String(rootPath || '').trim().slice(0, 2000) || source.name;
  if (source.cloud && source.importId) {
    await request('/api/import-roots', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ roots:[{ importId:source.importId, deviceName:'Browser', rootPath:source.rootPath }] })
    });
  }
  await saveSource(source);
  await publishSource(source);
  return source;
}

async function setScope(id, scope) {
  const source = await sourceById(id);
  if (!source) throw new Error('Browser folder not found');
  source.scope = scope === 'all' ? 'all' : 'media';
  if (source.cloud && source.importId) {
    await request('/api/import-scope', {
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ importId:source.importId, scope:source.scope })
    });
  }
  await saveSource(source);
  return source;
}

async function setCloud(id, enabled) {
  const source = await sourceById(id);
  if (!source) throw new Error('Browser folder not found');
  source.cloud = enabled === true;
  await saveSource(source);
  await publishSource(source);
  await publishProtectionIntents();
  return source;
}

async function removeSource(id) {
  const source = await sourceById(id);
  if (!source) return false;
  pendingSyncs.delete(String(id));
  for (const [hash, entry] of fileLocations) if (entry.source.id === id) fileLocations.delete(hash);
  await transaction([SOURCES], 'readwrite', ({ sources }) => sources.delete(String(id)));
  await replaceManifest(String(id), []);
  if (source.cloud) await publishProtectionIntents();
  dispatchEvent(new CustomEvent('mochimono:browser-folders-changed'));
  window.mochimonoLibrary?.refresh?.().catch?.(() => {});
  return true;
}

function previewRows(rows) {
  return rows
    .filter(row => row.hash && (String(row.mime || '').startsWith('image/') || String(row.mime || '').startsWith('video/')))
    .sort((a, b) => Number(b.lastModified || 0) - Number(a.lastModified || 0))
    .slice(0, 12)
    .map(row => ({
      hash:row.hash,
      filename:String(row.path || '').split('/').at(-1) || row.path,
      mime:row.mime,
      width:Number(row.width) || 0,
      height:Number(row.height) || 0
    }));
}

async function describeSources() {
  const sources = await sourceList();
  return Promise.all(sources.map(async source => {
    const manifest = [...(await manifestFor(source.id)).values()];
    return {
      ...source,
      handle:undefined,
      permission:await permission(source.handle, false),
      files:manifest.length,
      bytes:manifest.reduce((sum, row) => sum + (Number(row.size) || 0), 0),
      previews:previewRows(manifest)
    };
  }));
}

function cleanParts(value) {
  return String(value || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.' && part !== '..');
}

function rootParts(source) {
  const raw = String(source.rootPath || source.name || '').trim();
  const normalized = raw.replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(normalized)) {
    const parts = cleanParts(normalized);
    if (parts.length) parts[0] = parts[0].toUpperCase();
    return parts;
  }
  if (normalized.startsWith('/')) return ['Root', ...cleanParts(normalized)];
  return ['Browser', ...cleanParts(raw || source.name)];
}

async function browserTree(path = '') {
  const wanted = cleanRelative(path);
  const folders = new Map();
  const files = [];
  const seenFiles = new Set();
  for (const source of await sourceList()) {
    const root = rootParts(source);
    for (const row of (await manifestFor(source.id)).values()) {
      if (!row.hash) continue;
      const full = [...root, ...cleanParts(row.path)];
      const parent = full.slice(0, -1);
      const parentKey = parent.join('/');
      for (let depth = 0; depth < parent.length; depth++) {
        const folderPath = parent.slice(0, depth + 1).join('/');
        const owner = parent.slice(0, depth).join('/');
        if (owner !== wanted) continue;
        const name = parent[depth];
        const current = folders.get(folderPath) || { name, path:folderPath, references:0 };
        current.references++;
        folders.set(folderPath, current);
      }
      if (parentKey !== wanted) continue;
      const virtualPath = full.join('/');
      const key = `${row.hash}\u0000${virtualPath}`;
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      files.push({ ...libraryFile(row, source), virtualPath, local:true, browser:true });
    }
  }
  return {
    path:wanted,
    folders:[...folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' })),
    files:files.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric:true, sensitivity:'base' }))
  };
}

async function fileAtPath(root, relative) {
  const parts = cleanParts(relative);
  let handle = root;
  for (let index = 0; index < parts.length; index++) {
    handle = index === parts.length - 1
      ? await handle.getFileHandle(parts[index])
      : await handle.getDirectoryHandle(parts[index]);
  }
  return handle?.getFile?.();
}

async function browserFileForHash(hash) {
  const known = fileLocations.get(String(hash));
  if (known && await permission(known.source.handle, false) === 'granted') {
    try {
      const file = await fileAtPath(known.source.handle, known.row.path);
      if (file.size === known.row.size && file.lastModified === known.row.lastModified) return file;
    } catch {}
    return null;
  }
  const sources = await sourceList();
  sources.sort((a, b) => Number(a.cloud) - Number(b.cloud));
  for (const source of sources) {
    if (await permission(source.handle, false) !== 'granted') continue;
    for (const row of (await manifestFor(source.id)).values()) {
      if (String(row.hash) !== String(hash)) continue;
      try {
        const file = await fileAtPath(source.handle, row.path);
        if (file.size === row.size && file.lastModified === row.lastModified) return file;
      } catch {}
    }
  }
  return null;
}

async function browserObjectUrl(hash) {
  const file = await browserFileForHash(hash);
  if (!file) return '';
  if (viewerBlobUrl) URL.revokeObjectURL(viewerBlobUrl);
  viewerBlobHash = String(hash);
  viewerBlobUrl = URL.createObjectURL(file);
  return viewerBlobUrl;
}

function viewerHashFrom(node) {
  const values = [node?.dataset?.fullSrc, node?.getAttribute?.('src') || '', document.querySelector('#viewer-open')?.getAttribute('href') || ''];
  for (const value of values) {
    const hash = String(value || '').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1];
    if (hash) return hash;
  }
  return '';
}

async function repairViewerBrowserSource() {
  const media = document.querySelector('#viewer-media img,#viewer-media video');
  if (!media || media.dataset.browserSourceHash) return;
  const hash = viewerHashFrom(media);
  if (!hash) return;
  const file = await browserFileForHash(hash);
  if (!file || !media.isConnected || media.dataset.browserSourceHash) return;
  const url = viewerBlobHash === hash && viewerBlobUrl ? viewerBlobUrl : await browserObjectUrl(hash);
  if (!url || !media.isConnected) return;
  media.dataset.browserSourceHash = hash;
  if (media instanceof HTMLImageElement) {
    media.src = url;
    media.removeAttribute('data-full-src');
  } else {
    media.src = url;
    media.load();
  }
}

function installViewerBridge() {
  const viewerMedia = document.querySelector('#viewer-media');
  const viewerOpen = document.querySelector('#viewer-open');
  if (!viewerMedia || !viewerOpen) return;
  new MutationObserver(() => queueMicrotask(() => repairViewerBrowserSource().catch(() => {})))
    .observe(viewerMedia, { childList:true, subtree:true, attributes:true, attributeFilter:['src','data-full-src'] });
  viewerOpen.addEventListener('click', async event => {
    const hash = String(viewerOpen.getAttribute('href') || '').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1];
    if (!hash) return;
    const file = await browserFileForHash(hash);
    if (!file) return;
    event.preventDefault();
    const url = URL.createObjectURL(file);
    open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, true);
}

async function restoreBrowserFiles() {
  for (const source of await sourceList()) await publishSource(source);
}

async function autoSync() {
  if (document.visibilityState !== 'visible') return;
  const sources = await sourceList().catch(() => []);
  const now = Date.now();
  for (const source of sources) {
    const last = source.lastSynced ? new Date(source.lastSynced).getTime() : 0;
    if (last && now - last < AUTO_SYNC_MS) continue;
    if (await permission(source.handle, false) !== 'granted') continue;
    queueSourceSync(source.id,source.name);
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
window.addEventListener('mochimono:catalog-updated', () => restoreBrowserFiles().catch(() => {}));

scheduleAuto();
setTimeout(() => autoSync().catch(() => {}), 1500);
setTimeout(() => restoreBrowserFiles().catch(() => {}), 100);
installViewerBridge();

window.mochimonoBrowserFolders = {
  addHandles,
  list:describeSources,
  names:async ()=> (await sourceList()).map(source=>({id:source.id,name:source.name})),
  sync:async (id,options={})=>{
    if(activeSync){queueSourceSync(id);return {queued:true};}
    return syncSource(id,options);
  },
  setRootPath,
  setScope,
  setCloud,
  tree:browserTree,
  remove:removeSource,
  fileForHash:browserFileForHash,
  permission:async id => {
    const source = await sourceById(id);
    return source ? permission(source.handle, false) : 'denied';
  }
};

dispatchEvent(new CustomEvent('mochimono:browser-folders-ready'));
