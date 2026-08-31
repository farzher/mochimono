import { createHash } from 'node:crypto';
import { createReadStream, existsSync, watch } from 'node:fs';
import { opendir, stat, statfs } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { Transform } from 'node:stream';
import { api, beginJob, canceled, currentJob, now, pathKey, persistSettings, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { mimeFor } from './mime.js';
import { openSyncIndex } from './sync-index.js';
import { queueLocalThumbnail } from './thumbnail-agent.js';

const FULL_RECONCILE_MS = 60 * 60 * 1000;
const syncIndex = openSyncIndex(SYNC_INDEX_PATH);
const folderWatchers = new Map();
const pendingSyncs = new Set();
const syncTimers = new Map();
const dirtyPaths = new Map();
const dirtyAll = new Set();
let pumpTimer = null;
let reconcileTimer = null;

const relativeKey = path => {
  const clean = String(path || '').replaceAll('\\', '/').replace(/^\/+/, '');
  return platform() === 'win32' ? clean.toLowerCase() : clean;
};

export const folderFor = path => settings.folders.find(folder => pathKey(folder.path) === pathKey(path));

function transferProgress(doneBytes, totalBytes, startedAt) {
  const elapsed = Math.max(0.1, (Date.now() - startedAt) / 1000);
  const speedBps = doneBytes / elapsed;
  return {
    doneBytes,
    totalBytes,
    speedBps: Math.round(speedBps),
    etaSeconds: speedBps > 0 && doneBytes < totalBytes ? Math.ceil((totalBytes - doneBytes) / speedBps) : 0,
    indeterminate: false
  };
}

function progressReporter(update, base) {
  let last = 0;
  return (patch, force = false) => {
    const time = Date.now();
    if (!force && time - last < 180) return;
    last = time;
    update({ ...base, ...patch });
  };
}

async function* filesUnder(directory) {
  canceled();
  let dir;
  try { dir = await opendir(directory); }
  catch { return; }
  for await (const entry of dir) {
    canceled();
    if (entry.name === '.mochimono') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

async function hashFile(path, onProgress) {
  const hash = createHash('sha256');
  let read = 0;
  for await (const chunk of createReadStream(path)) {
    canceled();
    hash.update(chunk);
    read += chunk.length;
    onProgress?.(read);
  }
  return hash.digest('hex');
}

async function uploadFile(record, onProgress) {
  let sent = 0;
  let last = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      sent += chunk.length;
      const time = Date.now();
      if (time - last >= 180 || sent === record.size) {
        last = time;
        onProgress?.(sent);
      }
      callback(null, chunk);
    }
  });
  await api(`/api/objects/${record.hash}`, {
    method: 'PUT',
    headers: { 'content-length': String(record.size), 'x-mochimono-mime': record.mime },
    body: createReadStream(record.path).pipe(meter)
  });
  canceled();
}

function queuePreview(record) {
  return queueLocalThumbnail({
    hash: record.hash,
    path: record.path,
    size: record.size,
    mtime: record.mtime,
    mime: record.mime,
    filename: basename(record.path)
  });
}

function peekDirty(root) {
  const key = pathKey(root);
  return { all: dirtyAll.has(key), paths: dirtyPaths.get(key) || new Set() };
}

function consumeDirty(root) {
  const key = pathKey(root);
  const all = dirtyAll.delete(key);
  const paths = dirtyPaths.get(key) || new Set();
  dirtyPaths.delete(key);
  return { all, paths };
}

function localChangedPath(root, relativePath) {
  const base = resolve(root);
  const target = resolve(base, ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  if (targetKey !== baseKey && !targetKey.startsWith(`${baseKey}${sep}`)) return null;
  return target;
}

async function checkObjectsAndPreviews(records) {
  const hashes = [...new Set(records.map(record => record.hash))];
  const missing = new Set();
  const ignored = new Set();
  const previewReady = new Set();
  for (let index = 0; index < hashes.length; index += 1000) {
    const result = await api('/api/objects/check', { method: 'POST', body: { hashes: hashes.slice(index, index + 1000) } });
    for (const hash of result.missing || []) missing.add(hash);
    for (const hash of result.ignored || []) ignored.add(hash);
  }
  for (let index = 0; index < hashes.length; index += 500) {
    const result = await api('/api/thumbs/check', { method: 'POST', body: { hashes: hashes.slice(index, index + 500) } });
    for (const preview of result.thumbnails || []) previewReady.add(preview.hash);
  }
  return { missing, ignored, previewReady };
}

async function uploadMissing(records, missing, previewReady, update, root) {
  const unique = new Map();
  for (const record of records) if (!unique.has(record.hash)) unique.set(record.hash, record);
  for (const [hash, record] of unique) if (!missing.has(hash) && !previewReady.has(hash)) queuePreview(record);

  const missingRecords = [...missing].map(hash => unique.get(hash)).filter(Boolean);
  const uploadBytes = missingRecords.reduce((sum, record) => sum + record.size, 0);
  let uploadedBytes = 0;
  if (uploadBytes) {
    const uploadStarted = Date.now();
    const report = progressReporter(update, { phase: 'Uploading', path: root });
    for (const record of missingRecords) {
      const base = uploadedBytes;
      await uploadFile(record, sent => report({ current: record.relative, ...transferProgress(base + sent, uploadBytes, uploadStarted) }));
      if (!previewReady.has(record.hash)) queuePreview(record);
      uploadedBytes += record.size;
      report({ current: record.relative, ...transferProgress(uploadedBytes, uploadBytes, uploadStarted) }, true);
    }
  }
  return { missingRecords, uploadedBytes };
}

async function saveSources(importId, records, ignored, root) {
  const accepted = records.filter(record => !ignored.has(record.hash));
  for (let index = 0; index < accepted.length; index += 1000) {
    await api('/api/sources', {
      method: 'POST',
      body: {
        importId,
        sources: accepted.slice(index, index + 1000).map(record => ({
          hash: record.hash,
          path: record.relative,
          filename: basename(record.path),
          mtime: record.mtime
        }))
      }
    });
  }
  await api('/api/import-roots', {
    method: 'POST',
    body: { roots: [{ importId, deviceName: settings.device, rootPath: resolve(root) }] }
  });
  return accepted;
}

async function syncFiles(folderPath, update, importId = null) {
  const root = resolve(folderPath);
  const rootKey = pathKey(root);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`${root} is not a directory`);

  const cached = syncIndex.load(rootKey);
  const dirty = consumeDirty(root);
  const records = [];
  const hashed = [];
  const toHash = [];
  let errors = 0;
  let reusedHashes = 0;
  const scanReport = progressReporter(update, { phase: 'Scanning', path: root, indeterminate: true });
  scanReport({ scanned: 0, current: '' }, true);

  for await (const path of filesUnder(root)) {
    try {
      const file = await stat(path);
      const relativePath = relative(root, path).replaceAll('\\', '/');
      const cachePath = relativeKey(relativePath);
      const record = {
        path,
        relative: relativePath,
        cachePath,
        size: file.size,
        mtime: file.mtime.toISOString(),
        mtimeMs: Math.trunc(file.mtimeMs),
        mime: mimeFor(path)
      };
      records.push(record);
      const previous = cached.get(cachePath);
      if (!dirty.paths.has(cachePath) && previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === record.mtimeMs) {
        record.hash = previous.hash;
        hashed.push(record);
        reusedHashes++;
      } else toHash.push(record);
      scanReport({ scanned: records.length, current: relativePath, reusedHashes });
    } catch (error) {
      if (error.canceled) throw error;
      errors++;
    }
  }
  syncIndex.prune(rootKey, new Set(records.map(record => record.cachePath)));
  scanReport({ scanned: records.length, current: '', reusedHashes }, true);

  const hashBytes = toHash.reduce((sum, record) => sum + record.size, 0);
  let hashedBytes = 0;
  const hashStarted = Date.now();
  const hashReport = progressReporter(update, { phase: 'Hashing', path: root });
  for (const record of toHash) {
    const base = hashedBytes;
    try {
      record.hash = await hashFile(record.path, read => hashReport({ current: record.relative, reusedHashes, ...transferProgress(base + read, hashBytes, hashStarted) }));
      const latest = await stat(record.path);
      if (latest.size !== record.size || Math.trunc(latest.mtimeMs) !== record.mtimeMs) {
        queueFolderSync(root, record.relative, 500);
        continue;
      }
      hashed.push(record);
      syncIndex.save(rootKey, record.cachePath, record.size, record.mtimeMs, record.hash);
    } catch (error) {
      if (error.canceled) throw error;
      errors++;
    }
    hashedBytes += record.size;
    hashReport({ current: record.relative, reusedHashes, ...transferProgress(hashedBytes, hashBytes, hashStarted) }, true);
  }

  update({ phase: 'Checking', path: root, indeterminate: true, current: '', reusedHashes });
  const { missing, ignored, previewReady } = await checkObjectsAndPreviews(hashed);
  const { missingRecords, uploadedBytes } = await uploadMissing(hashed, missing, previewReady, update, root);

  update({ phase: 'Saving', path: root, indeterminate: true, current: '' });
  const source = settings.device;
  const created = importId ? { id: importId } : await api('/api/imports', { method: 'POST', body: { sourceName: source } });
  if (importId) await api(`/api/imports/${importId}`, { method: 'POST', body: { sourceName: source } });
  const accepted = await saveSources(created.id, hashed, ignored, root);

  return {
    importId: created.id,
    source,
    scanned: records.length,
    hashed: toHash.length,
    reusedHashes,
    new: missingRecords.length,
    duplicates: Math.max(0, accepted.length - missingRecords.length),
    ignored: hashed.length - accepted.length,
    errors,
    uploadedBytes
  };
}

async function syncChangedFiles(folder, update) {
  const root = resolve(folder.path);
  const rootKey = pathKey(root);
  const dirty = consumeDirty(root);
  if (dirty.all || !folder.importId) return syncFiles(root, update, folder.importId);

  const records = [];
  let needsFullScan = false;
  for (const relativePath of dirty.paths) {
    const path = localChangedPath(root, relativePath);
    if (!path) continue;
    try {
      const file = await stat(path);
      if (file.isDirectory()) { needsFullScan = true; break; }
      if (!file.isFile()) continue;
      const rel = relative(root, path).replaceAll('\\', '/');
      records.push({
        path,
        relative: rel,
        cachePath: relativeKey(rel),
        size: file.size,
        mtime: file.mtime.toISOString(),
        mtimeMs: Math.trunc(file.mtimeMs),
        mime: mimeFor(path)
      });
    } catch {
      syncIndex.forget(rootKey, relativeKey(relativePath));
    }
  }
  if (needsFullScan) return syncFiles(root, update, folder.importId);
  if (!records.length) return { importId: folder.importId, source: settings.device, changed: 0, new: 0, uploadedBytes: 0 };

  const totalBytes = records.reduce((sum, record) => sum + record.size, 0);
  let doneBytes = 0;
  let errors = 0;
  const started = Date.now();
  const report = progressReporter(update, { phase: 'Hashing', path: root });
  const hashed = [];
  for (const record of records) {
    const base = doneBytes;
    try {
      record.hash = await hashFile(record.path, read => report({ current: record.relative, ...transferProgress(base + read, totalBytes, started) }));
      const latest = await stat(record.path);
      if (latest.size !== record.size || Math.trunc(latest.mtimeMs) !== record.mtimeMs) queueFolderSync(root, record.relative, 500);
      else {
        hashed.push(record);
        syncIndex.save(rootKey, record.cachePath, record.size, record.mtimeMs, record.hash);
      }
    } catch (error) {
      if (error.canceled) throw error;
      errors++;
      queueFolderSync(root, record.relative, 1000);
    }
    doneBytes += record.size;
    report({ current: record.relative, ...transferProgress(doneBytes, totalBytes, started) }, true);
  }
  if (!hashed.length) return { importId: folder.importId, source: settings.device, changed: records.length, new: 0, errors, uploadedBytes: 0 };

  update({ phase: 'Checking', path: root, indeterminate: true, current: '' });
  const { missing, ignored, previewReady } = await checkObjectsAndPreviews(hashed);
  const { missingRecords, uploadedBytes } = await uploadMissing(hashed, missing, previewReady, update, root);
  update({ phase: 'Saving', path: root, indeterminate: true, current: '' });
  await saveSources(folder.importId, hashed, ignored, root);

  return { importId: folder.importId, source: settings.device, changed: records.length, new: missingRecords.length, errors, uploadedBytes };
}

async function syncFolder(folder, update) {
  const dirty = peekDirty(folder.path);
  const incremental = Boolean(folder.importId && !dirty.all && dirty.paths.size);
  const result = incremental ? await syncChangedFiles(folder, update) : await syncFiles(folder.path, update, folder.importId);
  folder.importId = result.importId;
  folder.lastSynced = now();
  await persistSettings();
  return result;
}

function markDirty(path, filename) {
  const key = pathKey(path);
  if (filename == null) return void dirtyAll.add(key);
  const relativePath = relativeKey(filename);
  if (!relativePath) return void dirtyAll.add(key);
  if (!dirtyPaths.has(key)) dirtyPaths.set(key, new Set());
  dirtyPaths.get(key).add(relativePath);
}

export function queueFolderSync(path, filename = undefined, delay = 500) {
  const folder = folderFor(path);
  if (!folder) return;
  const key = pathKey(folder.path);
  if (filename !== undefined) markDirty(folder.path, filename);
  clearTimeout(syncTimers.get(key));
  const queue = () => {
    syncTimers.delete(key);
    pendingSyncs.add(key);
    pumpSyncs();
  };
  if (delay > 0) {
    const timer = setTimeout(queue, delay);
    timer.unref?.();
    syncTimers.set(key, timer);
  } else queue();
}

export function watchFolder(folder) {
  const key = pathKey(folder.path);
  if (folderWatchers.has(key) || !existsSync(folder.path)) return;
  try {
    const watcher = watch(folder.path, { recursive: true }, (_event, filename) => {
      queueFolderSync(folder.path, filename == null ? null : String(filename), 700);
    });
    watcher.on('error', () => {
      watcher.close();
      folderWatchers.delete(key);
      queueFolderSync(folder.path, null, 0);
    });
    folderWatchers.set(key, watcher);
  } catch {
    queueFolderSync(folder.path, undefined, 0);
  }
}

export function unwatchFolder(path) {
  const key = pathKey(path);
  folderWatchers.get(key)?.close();
  folderWatchers.delete(key);
  pendingSyncs.delete(key);
  clearTimeout(syncTimers.get(key));
  syncTimers.delete(key);
  dirtyPaths.delete(key);
  dirtyAll.delete(key);
}

export function pumpSyncs() {
  if (!settings.token || currentJob()?.status === 'running' || !pendingSyncs.size) return;
  const key = pendingSyncs.values().next().value;
  const folder = settings.folders.find(item => pathKey(item.path) === key);
  pendingSyncs.delete(key);
  if (!folder || !existsSync(folder.path)) return;
  beginJob('sync', `Sync ${basename(folder.path) || folder.path}`, update => syncFolder(folder, update));
}

export async function addFolder(path) {
  const root = resolve(String(path));
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error('Folder not found'), { status: 400 });
  let folder = folderFor(root);
  if (!folder) {
    folder = { path: root, importId: null, lastSynced: null };
    settings.folders.push(folder);
    await persistSettings();
  }
  watchFolder(folder);
  queueFolderSync(root, undefined, 0);
  return folder;
}

export async function removeFolder(path) {
  const key = pathKey(path);
  const index = settings.folders.findIndex(folder => pathKey(folder.path) === key);
  if (index < 0) throw Object.assign(new Error('Folder not found'), { status: 404 });
  const [folder] = settings.folders.splice(index, 1);
  unwatchFolder(folder.path);
  syncIndex.forgetRoot(key);
  await persistSettings();
}

export async function folderStats() {
  return Promise.all(settings.folders.map(async folder => {
    const filesystem = await statfs(folder.path).then(fs => ({
      capacityBytes: Number(fs.blocks) * Number(fs.bsize),
      freeBytes: Number(fs.bavail) * Number(fs.bsize)
    })).catch(() => ({ capacityBytes: 0, freeBytes: 0 }));
    return { path: folder.path, ...syncIndex.stats(pathKey(folder.path)), ...filesystem };
  }));
}

export function startSyncService() {
  for (const folder of settings.folders) {
    watchFolder(folder);
    queueFolderSync(folder.path, undefined, 0);
  }
  pumpTimer ||= setInterval(pumpSyncs, 1000);
  reconcileTimer ||= setInterval(() => settings.folders.forEach(folder => queueFolderSync(folder.path, undefined, 0)), FULL_RECONCILE_MS);
  pumpTimer.unref?.();
  reconcileTimer.unref?.();
}

export function stopSyncService() {
  if (pumpTimer) clearInterval(pumpTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  pumpTimer = reconcileTimer = null;
  for (const folder of settings.folders) unwatchFolder(folder.path);
  syncIndex.close();
}
