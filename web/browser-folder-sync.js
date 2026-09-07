const DB_NAME = 'mochimono-browser-folders';
const DB_VERSION = 1;
const SOURCES = 'sources';
const FILES = 'files';
const AUTO_SYNC_MS = 5 * 60 * 1000;
const THUMB_EDGE = 768;
const THUMB_VERSION = 3;
const MEDIA_EXTENSIONS = new Set([
  'jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff',
  'mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp'
]);

let activeSync = null;
let autoTimer = 0;
let viewerBlobUrl = '';
let viewerBlobHash = '';

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
    cloud:source.cloud === true || (source.cloud == null && Number(source.importId) > 0)
  };
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
    const source = await addHandle(handle, scope);
    added.push(source);
    if (sync) await syncSource(source.id, { userGesture:true });
  }
  return added;
}

function waitFor(target, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`Timed out waiting for ${event}`)), timeout);
    const done = error => {
      clearTimeout(timer);
      target.removeEventListener(event, loaded);
      target.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const loaded = () => done();
    const failed = () => done(new Error('Media could not be decoded'));
    target.addEventListener(event, loaded, { once:true });
    target.addEventListener('error', failed, { once:true });
  });
}

const canvasFor = (width, height) => typeof OffscreenCanvas !== 'undefined'
  ? new OffscreenCanvas(width, height)
  : Object.assign(document.createElement('canvas'), { width, height });

async function canvasBlob(canvas) {
  const blob = 'convertToBlob' in canvas
    ? await canvas.convertToBlob({ type:'image/webp', quality:.82 })
    : await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .82));
  if (!blob) throw new Error('Could not encode thumbnail');
  return blob;
}

async function imageThumbnail(file) {
  let image;
  let objectUrl = '';
  try {
    if ('createImageBitmap' in window) image = await createImageBitmap(file, { imageOrientation:'from-image' });
    else {
      image = new Image();
      objectUrl = URL.createObjectURL(file);
      image.src = objectUrl;
      if (!image.complete) await waitFor(image, 'load');
    }
    const sourceWidth = image.width || image.naturalWidth;
    const sourceHeight = image.height || image.naturalHeight;
    const scale = Math.min(1, THUMB_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = canvasFor(width, height);
    canvas.getContext('2d', { alpha:false }).drawImage(image, 0, 0, width, height);
    return { blob:await canvasBlob(canvas), width, height };
  } finally {
    image?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function videoThumbnail(file) {
  const video = document.createElement('video');
  const objectUrl = URL.createObjectURL(file);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = objectUrl;
  try {
    if (video.readyState < 1) await waitFor(video, 'loadedmetadata');
    if (!video.videoWidth || !video.videoHeight) throw new Error('Video has no frame size');
    if (Number.isFinite(video.duration) && video.duration > .15) {
      video.currentTime = Math.min(.5, Math.max(.05, video.duration * .1));
      await waitFor(video, 'seeked');
    }
    if (video.readyState < 2) await waitFor(video, 'loadeddata');
    const scale = Math.min(1, THUMB_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = canvasFor(width, height);
    canvas.getContext('2d', { alpha:false }).drawImage(video, 0, 0, width, height);
    return { blob:await canvasBlob(canvas), width, height };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function ensureThumbnail(hash, file, path, previous = null) {
  if (!hash || !mediaFile(file, path)) return previous || {};
  const existing = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { method:'HEAD' }).catch(() => null);
  if (existing?.ok) return previous || {};
  try {
    const mime = mimeFor(file, path);
    const result = mime.startsWith('video/') ? await videoThumbnail(file) : await imageThumbnail(file);
    const response = await fetch(`/api/client/browser-thumb/${hash}`, {
      method:'PUT',
      headers:{
        'content-type':'image/webp',
        'x-mochimono-width':String(result.width),
        'x-mochimono-height':String(result.height)
      },
      body:result.blob
    });
    if (!response.ok) throw new Error('Could not save browser thumbnail');
    dispatchEvent(new CustomEvent('mochimono:browser-thumbnail-ready', { detail:{ hash, width:result.width, height:result.height } }));
    return { width:result.width, height:result.height };
  } catch {
    return previous || {};
  }
}

function libraryFile(row, source) {
  const date = new Date(Number(row.lastModified) || Date.now()).toISOString();
  const filename = String(row.path || '').split('/').at(-1) || row.path;
  return {
    hash:row.hash,
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
  const files = manifest.filter(row => /^[a-f0-9]{64}$/.test(String(row.hash || ''))).map(row => libraryFile(row, source));
  if (files.length) window.mochimonoLibrary?.upsertMany?.(files);
  return files;
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
        browser:true,
        browserSourceId:source.id,
        cloud:source.cloud === true
      })
    });
    if (Number(started.importId) > 0) source.importId = Number(started.importId);

    const next = [];
    let scanned = 0;
    let transferred = 0;
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
      const same = old && old.hash && Number(old.size) === Number(file.size) && Number(old.lastModified) === Number(file.lastModified);
      const canSkip = same && (!source.cloud || old.cloudSynced === true);

      if (canSkip) {
        const dimensions = await ensureThumbnail(old.hash, file, path, old);
        next.push({ ...old, ...dimensions, path, size:file.size, lastModified:file.lastModified, mime:old.mime || mimeFor(file, path) });
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
        const data = await request(`/api/client/import/file?${params}`, {
          method:'PUT',
          headers:{ 'x-mochimono-file-mime':file.type || 'application/octet-stream' },
          body:file
        });
        const dimensions = await ensureThumbnail(data.hash, file, path, old);
        next.push({
          path,
          size:file.size,
          lastModified:file.lastModified,
          hash:data.hash,
          mime:data.mime || mimeFor(file, path),
          width:Number(dimensions.width || old?.width) || 0,
          height:Number(dimensions.height || old?.height) || 0,
          cloudSynced:source.cloud === true && data.ignored !== true
        });
        transferred++;
      }
      dispatchEvent(new CustomEvent('mochimono:browser-folder-sync', { detail:{ id:source.id, state:'running', scanned, transferred, skipped } }));
    }
    await flushSeen();
    const finished = await request(`/api/client/import/finish?session=${encodeURIComponent(started.session)}`, { method:'POST' });
    await replaceManifest(source.id, next);
    source.lastSynced = new Date().toISOString();
    source.lastError = '';
    await saveSource(source);
    await publishSource(source, next);
    if (source.cloud) window.mochimonoLibrary?.refresh?.().catch?.(() => {});
    dispatchEvent(new CustomEvent('mochimono:browser-folder-sync', { detail:{
      id:source.id, state:'done', scanned, transferred, skipped, removed:Number(finished.removed) || 0
    } }));
    return { scanned, transferred, skipped, removed:Number(finished.removed) || 0, importId:source.importId, cloud:source.cloud };
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
  return source;
}

async function removeSource(id) {
  const source = await sourceById(id);
  if (!source) return false;
  await transaction([SOURCES], 'readwrite', ({ sources }) => sources.delete(String(id)));
  await replaceManifest(String(id), []);
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
  const sources = await sourceList();
  sources.sort((a, b) => Number(a.cloud) - Number(b.cloud));
  for (const source of sources) {
    if (await permission(source.handle, false) !== 'granted') continue;
    for (const row of (await manifestFor(source.id)).values()) {
      if (String(row.hash) !== String(hash)) continue;
      try { return await fileAtPath(source.handle, row.path); } catch {}
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
window.addEventListener('mochimono:catalog-updated', () => restoreBrowserFiles().catch(() => {}));

scheduleAuto();
setTimeout(() => autoSync().catch(() => {}), 1500);
setTimeout(() => restoreBrowserFiles().catch(() => {}), 100);
installViewerBridge();

window.mochimonoBrowserFolders = {
  addHandles,
  list:describeSources,
  sync:syncSource,
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
