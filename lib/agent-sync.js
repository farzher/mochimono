import { hashFile as readHash } from './file-hash.js';
import { directoryEntries, driveReadStream } from './drive-read.js';
import { contentForPath } from './local-content.js';
import { queueProviderThumbnail } from './provider-thumbs.js';import { existsSync, watch } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { Transform } from 'node:stream';
import { api, beginJob, canceled, currentJob, now, pathKey, persistSettings, serverState, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { backgroundWorkAllowed, waitForBackgroundWork } from './background-work.js';
import { localFileId } from './local-file-id.js';
import { publishLocalCatalogChange, publishLocalCatalogReset } from './local-catalog-events.js';
import { isMediaFile, mediaScope, mimeFor } from './mime.js';
import { isSourceExcluded, purgeExcludedIndex } from './source-exclusions.js';
import { openSyncIndex } from './sync-index.js';
import { queueLocalThumbnail, setThumbnailIngestBusy } from './thumbnail-agent.js';

const FULL_RECONCILE_MS = 24 * 60 * 60 * 1000;
const CLOUD_RECHECK_MS = 30_000;
const LIVE_INDEX_DELAY_MS = 180;
const REMOTE_SETTLE_MS = Math.max(1_000, Number(process.env.MOCHIMONO_REMOTE_SETTLE_MS) || 10_000);
const INGEST_BATCH_FILES = 64;
const INGEST_BATCH_BYTES = 256 * 1024 * 1024;
const configuredUploadWorkers = () => Math.max(1, Math.min(4, Number(process.env.MOCHIMONO_UPLOAD_WORKERS) || Number(settings.uploadWorkers) || 2));
const syncIndex = openSyncIndex(SYNC_INDEX_PATH);
const folderWatchers = new Map();
const pendingSyncs = new Set();
const foregroundSyncs = new Set();
const syncTimers = new Map();
const dirtyPaths = new Map();
const dirtyAll = new Set();
const localIndexTimers = new Map();
const localIndexPaths = new Map();
const localIndexRunning = new Set();
let pumpTimer = null;
let reconcileTimer = null;
let cloudTimer = null;
let cloudWasOnline = null;

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
    speedBps:Math.round(speedBps),
    etaSeconds:speedBps > 0 && doneBytes < totalBytes ? Math.ceil((totalBytes - doneBytes) / speedBps) : 0,
    indeterminate:false
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

async function* filesUnder(directory, scope, root = directory) {
  await waitForBackgroundWork();
  canceled();
  for await (const entry of directoryEntries(directory)) {
    await waitForBackgroundWork();
    canceled();
    if (entry.name === '.mochimono' || entry.name === '.mochimono-friend') continue;
    const path = join(directory, entry.name);
    if (isSourceExcluded(root, path)) continue;
    if (entry.isDirectory()) yield* filesUnder(path, scope, root);
    else if (entry.isFile() && (scope === 'all' || isMediaFile(path))) yield path;
  }
}

function hashFile(path, onProgress) {
  return readHash(path, { progress:onProgress, wait:waitForBackgroundWork, check:canceled });
}

async function uploadFile(record, onProgress, signal) {
  let sent = 0;
  let last = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      waitForBackgroundWork().then(() => {
        canceled();
        sent += chunk.length;
        const time = Date.now();
        if (time - last >= 180 || sent === record.size) {
          last = time;
          onProgress?.(sent);
        }
        callback(null, chunk);
      }).catch(callback);
    }
  });
  canceled();
  const source = driveReadStream(record.path, { end:record.size - 1 });
  source.on('error', error => meter.destroy(error));
  try {
    await api(`/api/objects/${record.hash}`, {
      method:'PUT',
      headers:{ 'content-length':String(record.size), 'x-mochimono-mime':record.mime },
      body:source.pipe(meter), signal
    });
    canceled();
  } finally { source.destroy(); meter.destroy(); }
}

function queuePreview(record, priority = false) {
  if (!isMediaFile(record.path, record.mime)) return null;
  return queueLocalThumbnail({
    hash:record.hash,
    path:record.path,
    size:record.size,
    mtime:record.mtime,
    mime:record.mime,
    filename:basename(record.path),
    priority
  });
}

function peekDirty(root) {
  const key = pathKey(root);
  return { all:dirtyAll.has(key), paths:dirtyPaths.get(key) || new Set() };
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
  const prefix = baseKey.endsWith(sep) ? baseKey : `${baseKey}${sep}`;
  if (targetKey !== baseKey && !targetKey.startsWith(prefix)) return null;
  return target;
}

function publishWatchedRecord(folder, record) {
  publishLocalCatalogChange({
    rootPath:resolve(folder.path),
    relativePath:record.relative,
    size:record.size,
    mtimeMs:record.mtimeMs,
    hash:record.hash,
    importId:folder.importId,
    backupIntent:true,
    contentHashReady:Boolean(record.contentHash)
  });
}

function scheduleLocalIndex(folder, delay = LIVE_INDEX_DELAY_MS) {
  const key = pathKey(folder.path);
  clearTimeout(localIndexTimers.get(key));
  const timer = setTimeout(() => {
    localIndexTimers.delete(key);
    indexWatchedChanges(folder).catch(error => console.warn('Live index failed:', error.message));
  }, Math.max(0, delay));
  timer.unref?.();
  localIndexTimers.set(key, timer);
}

function queueLocalIndex(folder, filename, delay = LIVE_INDEX_DELAY_MS) {
  if (filename == null) return;
  const rel = relativeKey(filename);
  if (!rel || isSourceExcluded(folder.path, rel)) return;
  const key = pathKey(folder.path);
  const pending = localIndexPaths.get(key) || new Set();
  pending.add(rel);
  localIndexPaths.set(key, pending);
  scheduleLocalIndex(folder, delay);
}

async function indexWatchedChanges(folder) {
  const root = resolve(folder.path);
  const rootKey = pathKey(root);
  if (localIndexRunning.has(rootKey)) return scheduleLocalIndex(folder, 120);
  const pending = localIndexPaths.get(rootKey);
  if (!pending?.size) return;
  localIndexPaths.delete(rootKey);
  localIndexRunning.add(rootKey);
  try {
    for (const relativePath of pending) {
      if (isSourceExcluded(root, relativePath)) continue;
      const path = localChangedPath(root, relativePath);
      if (!path) continue;
      const file = await stat(path).catch(() => null);
      if (!file) {
        if (syncIndex.forget(rootKey, relativePath)) publishLocalCatalogReset();
        continue;
      }
      if (!file.isFile()) continue;
      if (mediaScope(folder.scope) === 'media' && !isMediaFile(path)) {
        syncIndex.forget(rootKey, relativePath);
        continue;
      }

      const rel = relative(root, path).replaceAll('\\', '/');
      const cachePath = relativeKey(rel);
      const mtimeMs = Math.trunc(file.mtimeMs);
      const previous = syncIndex.get(rootKey, cachePath);
      if (previous && Number(previous.size) === Number(file.size) && Number(previous.mtimeMs) === mtimeMs && previous.hash) {
        publishWatchedRecord(folder, { relative:rel, size:file.size, mtimeMs, hash:String(previous.hash), contentHash:previous.contentHash });
        continue;
      }

      const hash = localFileId(root, cachePath, file);
      syncIndex.saveBrowse(rootKey, cachePath, file.size, mtimeMs, hash);
      publishWatchedRecord(folder, { relative:rel, size:file.size, mtimeMs, hash });
    }
  } finally {
    localIndexRunning.delete(rootKey);
    if (localIndexPaths.get(rootKey)?.size) scheduleLocalIndex(folder, 120);
  }
}

async function checkIngestBatch(records) {
  await waitForBackgroundWork();
  const unique = new Map();
  for (const record of records) if (record?.hash && !unique.has(record.hash)) unique.set(record.hash, record);
  const hashes = [...unique.keys()];
  if (!hashes.length) return { unique, missing:new Set(), ignored:new Set(), previewReady:new Set() };

  const [objects, previews] = await Promise.all([
    api('/api/objects/check', { method:'POST', body:{ hashes } }),
    api('/api/thumbs/check', { method:'POST', body:{ hashes } })
  ]);
  return {
    unique,
    missing:new Set(objects.missing || []),
    ignored:new Set(objects.ignored || []),
    previewReady:new Set((previews.thumbnails || []).map(item => item.hash))
  };
}

function createUploadPool(update, root) {
  const uploadWorkers = configuredUploadWorkers();
  const controller = new AbortController();
  const uploadBacklog = Math.max(8, uploadWorkers * 4);
  const queue = [];
  const inFlight = new Map();
  const failures = [];
  const capacityWaiters = [];
  const drainWaiters = [];
  const report = progressReporter(update, { phase:'Uploading', path:root });
  let startedAt = 0;
  let active = 0;
  let plannedBytes = 0;
  let completedBytes = 0;
  let reportEnabled = false;

  const backlog = () => active + queue.length;

  function uploadProgress(current = '', force = false) {
    if (!reportEnabled || !plannedBytes) return;
    const inFlightBytes = [...inFlight.values()].reduce((sum, bytes) => sum + bytes, 0);
    const sent = Math.min(plannedBytes, completedBytes + inFlightBytes);
    report({ current, ...transferProgress(sent, plannedBytes, startedAt || Date.now()) }, force);
  }

  function wake() {
    if (backlog() <= uploadBacklog) while (capacityWaiters.length) capacityWaiters.shift()();
    if (!backlog()) while (drainWaiters.length) drainWaiters.shift()();
  }

  function pump() {
    while (!controller.signal.aborted && active < uploadWorkers && queue.length) {
      const job = queue.shift();
      startedAt ||= Date.now();
      active++;
      inFlight.set(job.record.hash, 0);
      uploadFile(job.record, sent => {
        inFlight.set(job.record.hash, sent);
        uploadProgress(job.record.relative);
      }, controller.signal).then(() => {
        completedBytes += job.record.size;
        if (job.needsPreview) queuePreview(job.record, false);
      }).catch(error => {
        failures.push({ error, record:job.record });
      }).finally(() => {
        inFlight.delete(job.record.hash);
        active--;
        uploadProgress(job.record.relative, true);
        pump();
        wake();
      });
    }
  }

  return {
    schedule(record, needsPreview) {
      plannedBytes += record.size;
      queue.push({ record, needsPreview });
      pump();
    },
    async waitForBacklog() {
      while (backlog() > uploadBacklog) await new Promise(resolvePromise => capacityWaiters.push(resolvePromise));
    },
    enableProgress() {
      reportEnabled = true;
      uploadProgress('', true);
    },
    async drain() {
      pump();
      if (backlog()) await new Promise(resolvePromise => drainWaiters.push(resolvePromise));
      if (failures.length) throw failures[0].error;
      uploadProgress('', true);
      return { uploadedBytes:completedBytes, uploadBytes:plannedBytes };
    },
    hasWork() { return plannedBytes > completedBytes; },
    stop() {
      controller.abort();
      queue.length = 0;
      wake();
    }
  };
}

async function ingestRecords({ root, rootKey, readyRecords = [], hashRecords = [], update, reusedHashes = 0, onChanged, cloud = true }) {
  const hashed = [...readyRecords];
  const ignored = new Set();
  const scheduledUploads = new Set();
  const newHashes = new Set();
  const previewLater = new Map();
  const pool = createUploadPool(update, root);
  let errors = 0;
  let batch = [];
  let batchBytes = 0;
  let indexWrites = [];
  const providers = await import('./provider-thumbs.js');
  const flushIndex = () => {
    if (!indexWrites.length) return;
    const changed = indexWrites.filter(row => syncIndex.get(rootKey, row.path)?.contentHash !== row.contentHash);
    syncIndex.saveBrowseContentHashes(rootKey, changed);
    for (const row of changed) publishLocalCatalogChange({ rootPath:root, relativePath:row.path,
      size:row.size, mtimeMs:row.mtimeMs, id:row.id, hash:row.contentHash, replacesHash:row.id, backupIntent:true, contentHashReady:true });
    indexWrites = [];
  };

  async function processBatch() {
    if (!batch.length) return;
    await waitForBackgroundWork();
    const current = batch;
    batch = [];
    batchBytes = 0;
    if (!cloud) {
      for (const record of current) queueProviderThumbnail({ hash:record.hash, filename:basename(record.path), mime:record.mime,
        candidate:{ path:record.path, size:record.size, mtimeMs:record.mtimeMs } }, { background:true, owner:root });
      return;
    }
    await pool.waitForBacklog();
    const checked = await checkIngestBatch(current);
    for (const hash of checked.ignored) ignored.add(hash);
    for (const [hash, record] of checked.unique) {
      if (checked.ignored.has(hash)) continue;
      if (checked.missing.has(hash)) {
        if (scheduledUploads.has(hash)) continue;
        scheduledUploads.add(hash);
        newHashes.add(hash);
        pool.schedule(record, !checked.previewReady.has(hash));
      } else if (!checked.previewReady.has(hash)) previewLater.set(hash, record);
    }
  }

  async function addReady(record) {
    batch.push(record);
    batchBytes += record.size;
    if (batch.length >= INGEST_BATCH_FILES || batchBytes >= INGEST_BATCH_BYTES) await processBatch();
  }

  let finished = false;
  try {
  for (const record of readyRecords) await addReady(record);

  const hashBytes = hashRecords.reduce((sum, record) => sum + record.size, 0);
  let hashedBytes = 0;
  const hashStarted = Date.now();
  const hashReport = progressReporter(update, { phase:'Hashing', path:root });

  try {
    for (const record of hashRecords) {
      await waitForBackgroundWork();
      const base = hashedBytes;
      try {
        if ((settings.thumbnailMode === 'max' || backgroundWorkAllowed()) && settings.thumbnailMode !== 'off' &&
            record.mime.startsWith('image/') && record.size <= 128 * 1024 * 1024 &&
            !contentForPath(record.path, record.size, record.mtimeMs)) {
          const indexed = syncIndex.get(rootKey, record.cachePath);
          if (indexed?.id) await providers.ensureProviderThumbnail({ hash:indexed.id, owner:root,
            filename:basename(record.path), mime:record.mime,
            candidate:{ path:record.path, size:record.size, mtimeMs:record.mtimeMs } });
        }
        record.hash = contentForPath(record.path, record.size, record.mtimeMs) || await hashFile(record.path, read => hashReport({
          current:record.relative,
          reusedHashes,
          ...transferProgress(base + read, hashBytes, hashStarted)
        }));
        const latest = await stat(record.path);
        if (latest.size !== record.size || Math.trunc(latest.mtimeMs) !== record.mtimeMs) onChanged?.(record);
        else {
          hashed.push(record);
          const previous = syncIndex.get(rootKey, record.cachePath);
          const id = previous?.id || record.hash;
          await providers.reuseProviderThumbnail(id, record.hash).catch(() => {});
          indexWrites.push({ path:record.cachePath, size:record.size, mtimeMs:record.mtimeMs, id, contentHash:record.hash });
          providers.queueProviderThumbnail({ hash:record.hash, filename:basename(record.path), mime:record.mime,
            candidate:{ path:record.path, size:record.size, mtimeMs:record.mtimeMs } }, { background:true, owner:root });
          if (indexWrites.length >= INGEST_BATCH_FILES) flushIndex();
          await addReady(record);
        }
      } catch (error) {
        if (error.canceled) throw error;
        errors++;
        onChanged?.(record, error);
      }
      hashedBytes += record.size;
      hashReport({ current:record.relative, reusedHashes, ...transferProgress(hashedBytes, hashBytes, hashStarted) }, true);
    }
  } finally { flushIndex(); }
  await processBatch();
  for (const record of previewLater.values()) queuePreview(record, false);
  if (pool.hasWork()) pool.enableProgress();
  const uploads = cloud ? await pool.drain() : { uploadedBytes:0, uploadBytes:0 };
  finished = true;
  return { hashed, ignored, newHashes, errors, ...uploads };
  } finally {
    if (!finished) pool.stop();
  }
}

async function saveSources(importId, records, ignored, root) {
  const accepted = records.filter(record => !ignored.has(record.hash));
  for (let index = 0; index < accepted.length; index += 1000) {
    await waitForBackgroundWork();
    await api('/api/sources', {
      method:'POST',
      body:{
        importId,
        sources:accepted.slice(index, index + 1000).map(record => ({
          hash:record.hash,
          path:record.relative,
          filename:basename(record.path),
          mtime:record.mtime
        }))
      }
    });
  }
  await waitForBackgroundWork();
  await api('/api/import-roots', {
    method:'POST',
    body:{ roots:[{ importId, deviceName:settings.device, rootPath:resolve(root) }] }
  });
  return accepted;
}

async function syncFiles(folderPath, update, importId = null, scope = 'media', cloud = true) {
  const root = resolve(folderPath);
  const rootKey = pathKey(root);
  const selectedScope = mediaScope(scope);
  await waitForBackgroundWork();
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`${root} is not a directory`);

  purgeExcludedIndex(root, rootKey);
  consumeDirty(root);
  const records = [];
  const readyRecords = [];
  const hashRecords = [];
  let scanErrors = 0;
  let reusedHashes = 0;
  let indexWrites = [];
  let earlyPreviews = 0;
  const providers = await import('./provider-thumbs.js');
  const flushIndex = () => {
    if (!indexWrites.length) return;
    syncIndex.saveBrowseMany(rootKey, indexWrites);
    for (const row of indexWrites) publishLocalCatalogChange({ rootPath:root, relativePath:row.path,
      size:row.size, mtimeMs:row.mtimeMs, hash:row.id, backupIntent:true, contentHashReady:false });
    indexWrites = [];
  };
  const scanReport = progressReporter(update, { phase:'Scanning', path:root, indeterminate:true });
  scanReport({ scanned:0, current:'' }, true);

  for await (const path of filesUnder(root, selectedScope, root)) {
    try {
      await waitForBackgroundWork();
      const file = await stat(path);
      const relativePath = relative(root, path).replaceAll('\\', '/');
      const cachePath = relativeKey(relativePath);
      const record = {
        path,
        relative:relativePath,
        cachePath,
        size:file.size,
        mtime:file.mtime.toISOString(),
        mtimeMs:Math.trunc(file.mtimeMs),
        mime:mimeFor(path)
      };
      records.push(record);
      const previous = syncIndex.get(rootKey, cachePath);
      if (previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === record.mtimeMs && previous.contentHash) {
        record.hash = String(previous.contentHash);
        readyRecords.push(record);
        reusedHashes++;
      } else {
        hashRecords.push(record);
        const id = localFileId(root, cachePath, file);
        indexWrites.push({ path:cachePath, size:file.size, mtimeMs:record.mtimeMs, id });
        if (indexWrites.length >= 128 || records.length <= 3) flushIndex();
        if (earlyPreviews < 3 && isMediaFile(path)) {
          earlyPreviews++;
          providers.queueProviderThumbnail({ hash:id, filename:basename(path), mime:record.mime,
            candidate:{ path, size:file.size, mtimeMs:record.mtimeMs } }, { owner:root });
        }
      }
      scanReport({ scanned:records.length, current:relativePath, reusedHashes });
    } catch (error) {
      if (error.canceled) throw error;
      scanErrors++;
    }
  }
  if (!await stat(root).then(info => info.isDirectory()).catch(() => false)) throw new Error('Source disconnected during indexing');
  flushIndex();
  scanReport({ phase:'Finalizing index', checked:0, total:records.length, indeterminate:false }, true);
  const removed = await syncIndex.prune(rootKey, new Set(records.map(record => record.cachePath)), canceled,
    checked => scanReport({ phase:'Finalizing index', checked, total:Math.max(checked, records.length), indeterminate:false }));
  if (removed) publishLocalCatalogReset();
  scanReport({ scanned:records.length, current:'', reusedHashes }, true);

  const ingested = await ingestRecords({
    root,
    rootKey,
    readyRecords,
    hashRecords,
    update,
    reusedHashes,
    cloud,
    onChanged:record => queueFolderSync(root, record.relative, 500)
  });

  if (!cloud) {
    return {
      importId,
      source:settings.device,
      scanned:records.length,
      hashed:hashRecords.length,
      reusedHashes,
      errors:scanErrors + ingested.errors,
      uploadedBytes:0,
      localOnly:true
    };
  }

  await waitForBackgroundWork();
  update({ phase:'Saving', path:root, indeterminate:true, current:'' });
  const source = settings.device;
  const created = importId ? { id:importId } : await api('/api/imports', { method:'POST', body:{ sourceName:source } });
  if (importId) await api(`/api/imports/${importId}`, { method:'POST', body:{ sourceName:source } });
  const accepted = await saveSources(created.id, ingested.hashed, ingested.ignored, root);

  return {
    importId:created.id,
    source,
    scanned:records.length,
    hashed:hashRecords.length,
    reusedHashes,
    new:ingested.newHashes.size,
    duplicates:Math.max(0, accepted.length - ingested.newHashes.size),
    ignored:ingested.hashed.length - accepted.length,
    errors:scanErrors + ingested.errors,
    uploadedBytes:ingested.uploadedBytes,
    localOnly:false
  };
}

async function syncChangedFiles(folder, update, cloud = true) {
  const root = resolve(folder.path);
  const rootKey = pathKey(root);
  const selectedScope = mediaScope(folder.scope);
  const dirty = consumeDirty(root);
  if (dirty.all || (cloud && !folder.importId)) return syncFiles(root, update, folder.importId, selectedScope, cloud);

  const records = [];
  const readyRecords = [];
  const hashRecords = [];
  let needsFullScan = false;
  for (const relativePath of dirty.paths) {
    await waitForBackgroundWork();
    if (isSourceExcluded(root, relativePath)) continue;
    const path = localChangedPath(root, relativePath);
    if (!path) continue;
    try {
      const file = await stat(path);
      if (file.isDirectory()) { needsFullScan = true; break; }
      if (!file.isFile()) continue;
      const rel = relative(root, path).replaceAll('\\', '/');
      if (selectedScope === 'media' && !isMediaFile(path)) {
        syncIndex.forget(rootKey, relativeKey(rel));
        continue;
      }
      if (cloud) {
        const age = Math.max(0, Date.now() - Number(file.mtimeMs || 0));
        if (age < REMOTE_SETTLE_MS) {
          queueFolderSync(root, rel, REMOTE_SETTLE_MS - age + 250);
          continue;
        }
      }
      const record = {
        path,
        relative:rel,
        cachePath:relativeKey(rel),
        size:file.size,
        mtime:file.mtime.toISOString(),
        mtimeMs:Math.trunc(file.mtimeMs),
        mime:mimeFor(path)
      };
      records.push(record);
      const previous = syncIndex.get(rootKey, record.cachePath);
      if (previous?.contentHash && Number(previous.size) === Number(record.size) && Number(previous.mtimeMs) === Number(record.mtimeMs)) {
        record.hash = String(previous.contentHash);
        readyRecords.push(record);
      } else {
        const id = localFileId(root, record.cachePath, file);
        syncIndex.saveBrowse(rootKey, record.cachePath, record.size, record.mtimeMs, id);
        publishWatchedRecord(folder, { ...record, hash:id });
        hashRecords.push(record);
      }
    } catch {
      syncIndex.forget(rootKey, relativeKey(relativePath));
    }
  }
  if (needsFullScan) return syncFiles(root, update, folder.importId, selectedScope, cloud);
  if (!records.length) return { importId:folder.importId, source:settings.device, changed:0, new:0, uploadedBytes:0, localOnly:!cloud };

  const ingested = await ingestRecords({
    root,
    rootKey,
    readyRecords,
    hashRecords,
    update,
    reusedHashes:readyRecords.length,
    cloud,
    onChanged:record => queueFolderSync(root, record.relative, 700)
  });

  if (!cloud || !ingested.hashed.length) {
    return {
      importId:folder.importId,
      source:settings.device,
      changed:records.length,
      new:0,
      errors:ingested.errors,
      uploadedBytes:0,
      localOnly:!cloud
    };
  }

  await waitForBackgroundWork();
  update({ phase:'Saving', path:root, indeterminate:true, current:'' });
  await saveSources(folder.importId, ingested.hashed, ingested.ignored, root);

  return {
    importId:folder.importId,
    source:settings.device,
    changed:records.length,
    new:ingested.newHashes.size,
    errors:ingested.errors,
    uploadedBytes:ingested.uploadedBytes,
    localOnly:false
  };
}

async function cloudAvailable() {
  if (!settings.token) return false;
  return Boolean((await serverState()).online);
}

async function syncFolder(folder, update) {
  setThumbnailIngestBusy(true);
  try {
    await waitForBackgroundWork();
    const cloud = await cloudAvailable();
    cloudWasOnline = cloud;
    const dirty = peekDirty(folder.path);
    const incremental = Boolean(!dirty.all && dirty.paths.size && (!cloud || folder.importId));
    const result = incremental
      ? await syncChangedFiles(folder, update, cloud)
      : await syncFiles(folder.path, update, folder.importId, folder.scope, cloud);

    if (!result.errors) syncIndex.markIndexed(pathKey(folder.path));
    if (cloud && !result.errors) {
      folder.importId = result.importId;
      await api('/api/import-scope', { method:'POST', body:{ importId:result.importId, scope:mediaScope(folder.scope) } });
      folder.lastSynced = now();
      await persistSettings();
    }
    if (result.errors) queueFolderSync(folder.path, null, 30_000);
    return result;
  } catch (error) {
    // The index, successful hashes and server-verified objects are already
    // durable. Recheck incomplete work without claiming a successful sync.
    queueFolderSync(folder.path, undefined, 30_000);
    throw error;
  } finally {
    setThumbnailIngestBusy(false);
  }
}

export async function syncProtectedFolders(update) {
  const folders=(settings.folders||[]).filter(folder=>folder.protected!==false&&existsSync(folder.path));
  const results=[];
  for(let index=0;index<folders.length;index++){
    canceled();
    const folder=folders[index];
    const key=pathKey(folder.path);
    clearTimeout(syncTimers.get(key));
    syncTimers.delete(key);
    pendingSyncs.delete(key);
    foregroundSyncs.delete(key);
    update({phase:'Backing up files',path:folder.path,current:basename(folder.path)||folder.path,folder:index+1,folders:folders.length,indeterminate:true});
    results.push(await syncFolder(folder,patch=>update({...patch,folder:index+1,folders:folders.length})));
  }
  return results;
}

function markDirty(path, filename) {
  const key = pathKey(path);
  if (filename == null) return void dirtyAll.add(key);
  const relativePath = relativeKey(filename);
  if (!relativePath || isSourceExcluded(path, relativePath)) return;
  if (!dirtyPaths.has(key)) dirtyPaths.set(key, new Set());
  dirtyPaths.get(key).add(relativePath);
}

export function queueFolderSync(path, filename = undefined, delay = 500, foreground = false) {
  const folder = folderFor(path);
  if (!folder) return;
  const key = pathKey(folder.path);
  if (filename !== undefined && filename !== null && isSourceExcluded(folder.path, relativeKey(filename))) return;
  if (filename !== undefined) markDirty(folder.path, filename);
  if (foreground) foregroundSyncs.add(key);
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
    const watcher = watch(folder.path, { recursive:true }, (_event, filename) => {
      const name = filename == null ? null : String(filename);
      if (name && isSourceExcluded(folder.path, name)) return;
      queueLocalIndex(folder, name);
      queueFolderSync(folder.path, name, 700);
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
  foregroundSyncs.delete(key);
  clearTimeout(syncTimers.get(key));
  syncTimers.delete(key);
  clearTimeout(localIndexTimers.get(key));
  localIndexTimers.delete(key);
  localIndexPaths.delete(key);
  localIndexRunning.delete(key);
  dirtyPaths.delete(key);
  dirtyAll.delete(key);
}

export function pumpSyncs() {
  if (currentJob()?.status === 'running' || !pendingSyncs.size) return;
  const foregroundKey = [...pendingSyncs].find(key => foregroundSyncs.has(key));
  const key = foregroundKey || pendingSyncs.values().next().value;
  const foreground = foregroundSyncs.has(key);
  if (!foreground && !backgroundWorkAllowed()) return;
  const folder = settings.folders.find(item => pathKey(item.path) === key);
  pendingSyncs.delete(key);
  foregroundSyncs.delete(key);
  if (!folder) return;
  if (!existsSync(folder.path)) return queueFolderSync(folder.path, undefined, 30_000);
  watchFolder(folder);
  beginJob('sync', `${settings.token ? 'Sync' : 'Index'} ${basename(folder.path) || folder.path}`, update => syncFolder(folder, update), { background:!foreground });
}

async function probeCloud() {
  for (const folder of settings.folders) {
    if (!folderWatchers.has(pathKey(folder.path)) && existsSync(folder.path)) {
      watchFolder(folder);
      queueFolderSync(folder.path, null, 0);
    }
  }
  const online = await cloudAvailable().catch(() => false);
  if (online && cloudWasOnline === false) {
    for (const folder of settings.folders) queueFolderSync(folder.path, null, 0);
  }
  cloudWasOnline = online;
}

export async function addFolder(path, scope = 'media') {
  const root = resolve(String(path));
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error('Folder not found'), { status:400 });
  const selectedScope = mediaScope(scope);
  let folder = folderFor(root);
  let scopeChanged = false;
  if (!folder) {
    folder = { path:root, importId:null, lastSynced:null, scope:selectedScope };
    settings.folders.push(folder);
    await persistSettings();
  } else if (mediaScope(folder.scope) !== selectedScope) {
    folder.scope = selectedScope;
    folder.lastSynced = null;
    scopeChanged = true;
    await persistSettings();
  }
  watchFolder(folder);
  queueFolderSync(root, scopeChanged ? null : undefined, 0, true);
  return folder;
}

export async function removeFolder(path) {
  const key = pathKey(path);
  const index = settings.folders.findIndex(folder => pathKey(folder.path) === key);
  if (index < 0) throw Object.assign(new Error('Folder not found'), { status:404 });
  const [folder] = settings.folders.splice(index, 1);
  unwatchFolder(folder.path);
  syncIndex.forgetRoot(key);
  delete settings.sourceExclusions?.[key];
  await persistSettings();
  publishLocalCatalogReset();
}

export async function folderStats() {
  const running = currentJob();
  return Promise.all(settings.folders.map(async folder => {
    const key = pathKey(folder.path);
    const filesystem = await statfs(folder.path).then(fs => ({
      capacityBytes:Number(fs.blocks) * Number(fs.bsize),
      freeBytes:Number(fs.bavail) * Number(fs.bsize)
    })).catch(() => ({ capacityBytes:0, freeBytes:0 }));
    const queued = pendingSyncs.has(key) || syncTimers.has(key);
    const runningHere = running?.status === 'running' && running?.progress?.path && pathKey(running.progress.path) === key;
    const automatic = (queued && !foregroundSyncs.has(key)) || (runningHere && running.background);
    return {
      path:folder.path,
      scope:mediaScope(folder.scope),
      ...syncIndex.stats(key),
      ...filesystem,
      lastIndexed:syncIndex.lastIndexed(key),
      pending:queued || runningHere,
      progress:runningHere ? running.progress : null,
      startedAt:runningHere ? running.startedAt : null,
      waitingForIdle:Boolean(automatic && !backgroundWorkAllowed())
    };
  }));
}

export function startSyncService() {
  for (const folder of settings.folders) {
    purgeExcludedIndex(folder.path, pathKey(folder.path));
    watchFolder(folder);
    queueFolderSync(folder.path, undefined, 0);
  }
  pumpTimer ||= setInterval(pumpSyncs, 1000);
  reconcileTimer ||= setInterval(() => settings.folders.forEach(folder => queueFolderSync(folder.path, undefined, 0)), FULL_RECONCILE_MS);
  cloudTimer ||= setInterval(() => probeCloud().catch(() => {}), CLOUD_RECHECK_MS);
  pumpTimer.unref?.();
  reconcileTimer.unref?.();
  cloudTimer.unref?.();
  void probeCloud();
}

export function stopSyncService() {
  if (pumpTimer) clearInterval(pumpTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (cloudTimer) clearInterval(cloudTimer);
  pumpTimer = reconcileTimer = cloudTimer = null;
  for (const folder of settings.folders) unwatchFolder(folder.path);
  syncIndex.close();
}
