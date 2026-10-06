import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, watch } from 'node:fs';
import { hashFile as readHash } from './file-hash.js';
import { directoryEntries, physicalDriveKey, withDriveRead } from './drive-read.js';
import { previewState } from './preview-state.js';
import { contentForPath } from './local-content.js';
import { stat, statfs } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { api, beginJob, canceled, currentJob, pathKey, persistSettings, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { backgroundWorkAllowed, waitForBackgroundWork } from './background-work.js';
import { publishLocalCatalogChange, publishLocalCatalogReset } from './local-catalog-events.js';
import { localFileId } from './local-file-id.js';
import { openSyncIndex } from './sync-index.js';
import { isMediaFile, mediaScope, mimeFor } from './mime.js';
import { providerThumbnail, providerThumbnailFailure, providerThumbnailQueueStatus, queueProviderThumbnail, resetProviderThumbnailFailure, reuseProviderThumbnail } from './provider-thumbs.js';
import { isSourceExcluded, purgeExcludedIndex } from './source-exclusions.js';

const YIELD_EVERY_FILES = 200;
const INDEX_SAVE_BATCH = 512;
const DISCOVERY_BATCH = 128;
const HASH_SAVE_BATCH = 24;
const EARLY_PREVIEWS = 3;
const PREVIEW_QUEUE_TARGET = 256;
const PREVIEW_MAX_BURST = 16;
const CHANGE_DELAY_MS = 260;
const INCREMENTAL_FLUSH_BATCH = 2048;
const IDENTITY_TTL_MS = 10 * 60 * 1000;
const IDENTITY_CACHE_MAX = 200_000;
const PREVIEW_ERROR_BACKOFF_MS = 5_000;
const MAX_PARALLEL_BROWSE_DRIVES = 4;
const watchers = new Map();
const timers = new Map();
const hashTimers = new Map();
const foregroundChecks = new Set();
const changeTimers = new Map();
const pendingChanges = new Map();
const previewWarmers = new Map();
const identities = new Map();
const parallelBrowseJobs = new Map();
const parallelBrowseDrives = new Map();
const browseJobScope = new AsyncLocalStorage();
let previewWarmTimer = null;
let sourceProbeTimer = null;
let previewWarmCursor = 0;
let onChanged = () => {};

export const browseRootKey = path => `browse:${pathKey(path)}`;
export const browseFolderFor = path => settings.browseFolders.find(item => pathKey(item) === pathKey(path));
export const browseFolderScope = path => mediaScope(settings.browseFolderScopes[pathKey(path)]);
const protectedFolderFor = path => settings.folders.find(folder => pathKey(folder.path) === pathKey(path));
const yieldTurn = () => new Promise(resolvePromise => setImmediate(resolvePromise));
const backgroundPreviewsEnabled = () => settings.thumbnailMode !== 'off';
const isMediaPath = path => isMediaFile(path);
const browseIncludes = (root, path) => !isSourceExcluded(root, path) && (browseFolderScope(root) === 'all' || isMediaPath(path));
const scopedBrowseJob = () => browseJobScope.getStore() || null;

function checkCanceled() {
  const local = scopedBrowseJob();
  if (!local) return canceled();
  if (local.cancelRequested) throw Object.assign(new Error('Canceled'), { canceled: true });
}

async function waitForBrowseWork() {
  const local = scopedBrowseJob();
  if (!local) return waitForBackgroundWork();
  while (local.background && !backgroundWorkAllowed()) {
    checkCanceled();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  checkCanceled();
}

const browseWorkIsBackground = () => scopedBrowseJob()?.background ?? Boolean(currentJob()?.background);

const browseDriveKey = physicalDriveKey;

async function globalJobBlocksDrive(drive) {
  const running = currentJob();
  if (!running || running.status !== 'running') return false;
  const path = running.progress?.path;
  if (!path) return true;
  return await browseDriveKey(path) === drive;
}

async function startParallelBrowseJob(root, label, work, { background = true, type = 'sync' } = {}) {
  const key = pathKey(root);
  if (parallelBrowseJobs.has(key) || parallelBrowseJobs.size >= MAX_PARALLEL_BROWSE_DRIVES) return null;
  const drive = await browseDriveKey(root);
  const activeKey = parallelBrowseDrives.get(drive);
  const active = activeKey ? parallelBrowseJobs.get(activeKey) : null;
  if (active) {
    if (type === 'sync' && active.type === 'hash' && !active.cancelRequested) active.cancelRequested = true;
    return null;
  }
  if (await globalJobBlocksDrive(drive)) return null;
  if (parallelBrowseJobs.has(key) || parallelBrowseDrives.has(drive) || parallelBrowseJobs.size >= MAX_PARALLEL_BROWSE_DRIVES) return null;

  const job = {
    type, label, status: 'running', cancelRequested: false, background,
    startedAt: new Date().toISOString(), progress: { path: root }, drive
  };
  parallelBrowseJobs.set(key, job);
  parallelBrowseDrives.set(drive, key);

  setImmediate(() => browseJobScope.run(job, async () => {
    try {
      const update = patch => {
        checkCanceled();
        job.progress = { ...job.progress, ...patch, updatedAt:Date.now() };
      };
      job.result = await work(update);
      checkCanceled();
      job.status = 'done';
    } catch (error) {
      if (!error.canceled) console.error(error);
      job.status = error.canceled ? 'canceled' : 'error';
      job.error = error.message;
    } finally {
      job.cancelRequested = false;
      job.finishedAt = new Date().toISOString();
      parallelBrowseJobs.delete(key);
      if (parallelBrowseDrives.get(drive) === key) parallelBrowseDrives.delete(drive);
      if (type === 'sync' && job.status === 'error' && browseFolderFor(root)) queue(root, 30_000);
      if (type === 'hash' && browseFolderFor(root)) {
        const pending = Number(job.result?.pending) || 0;
        const progressed = Number(job.result?.hashed) || 0;
        if (job.status === 'canceled' || (job.status === 'done' && pending > 0 && progressed > 0)) scheduleBrowseHash(root, 500);
      }
    }
  }));
  return job;
}

function identityKey(file) {
  const ino = Number(file?.ino) || 0;
  const dev = Number(file?.dev) || 0;
  const birthtimeMs = Math.trunc(Number(file?.birthtimeMs) || 0);
  return ino ? `${dev}:${ino}:${birthtimeMs}` : '';
}

function rememberIdentity(file, hash, contentHash = '', tracked = false) {
  const key = identityKey(file);
  if (!key || !hash) return;
  identities.delete(key);
  identities.set(key, {
    hash: String(hash),
    contentHash: String(contentHash || ''),
    tracked: Boolean(tracked),
    size: Number(file.size) || 0,
    mtimeMs: Math.trunc(Number(file.mtimeMs) || 0),
    seenAt: Date.now()
  });
  while (identities.size > IDENTITY_CACHE_MAX) identities.delete(identities.keys().next().value);
}

function hashForIdentity(file) {
  const key = identityKey(file);
  if (!key) return null;
  const entry = identities.get(key);
  if (!entry) return null;
  if (Date.now() - entry.seenAt > IDENTITY_TTL_MS) {
    identities.delete(key);
    return null;
  }
  if (entry.size !== Number(file.size) || entry.mtimeMs !== Math.trunc(Number(file.mtimeMs) || 0)) return null;
  entry.seenAt = Date.now();
  return entry;
}

const localIdentityHash = localFileId;

function previewCompletionMatches(index, rootKey, indexedAt) {
  const state = previewWarmers.get(pathKey(String(rootKey).slice('browse:'.length)));
  return Boolean(indexedAt && state?.done && state.indexedAt === indexedAt);
}

function previewOwnerQueueTarget() {
  return PREVIEW_MAX_BURST;
}

function schedulePreviewWarm(delay = 120) {
  if (!backgroundPreviewsEnabled() || previewWarmTimer || ![...previewWarmers.values()].some(state => !state.done)) return;
  previewWarmTimer = setTimeout(runPreviewWarm, Math.max(0, delay));
  previewWarmTimer.unref?.();
}

function previewBaseState() {
  const timestamp = Date.now();
  return {
    deferred: 0,
    startedAt: timestamp,
    lastProgressAt: timestamp,
    lastError: '',
    errorCount: 0,
    passes: 0,
    backpressured: false
  };
}

function fullPreviewState(root, indexedAt = '') {
  const path = resolve(root);
  const rootKey = browseRootKey(path);
  const queue = providerThumbnailQueueStatus(path);
  return {
    ...previewBaseState(),
    kind: 'full',
    path,
    rootKey,
    indexedAt: String(indexedAt || ''),
    phase: 'checking',
    afterPath: previewState.scan(rootKey)?.indexedAt === indexedAt ? previewState.scan(rootKey).afterPath : '',
    total: 0,
    countedAt: '',
    pages: new Map(),
    page: null,
    processed: 0,
    ready: 0,
    failed: 0,
    queued: 0,
    generatedStart: Number(queue.ownerCompleted) || 0,
    pauseUntil: 0,
    done: false,
    persisted: false,
    reconciled: !previewState.scan(rootKey)?.afterPath
  };
}

function resetPreviewWarm(root, indexedAt = '') {
  if (!backgroundPreviewsEnabled()) return null;
  const state = fullPreviewState(root, indexedAt);
  previewWarmers.set(pathKey(state.path), state);
  schedulePreviewWarm(120);
  return state;
}

function resetSpecificPreviewWarm(root, records, indexedAt = '') {
  if (!backgroundPreviewsEnabled()) return null;
  const path = resolve(root);
  const unique = new Map();
  for (const record of records || []) if (record?.hash && isMediaPath(record.path || record.filename || '')) unique.set(record.hash, record);
  if (!unique.size) return null;
  const queue = providerThumbnailQueueStatus(path);
  const state = {
    ...previewBaseState(),
    kind: 'specific',
    path,
    rootKey: browseRootKey(path),
    indexedAt: String(indexedAt || ''),
    phase: 'generating',
    items: [...unique.values()].map(record => ({ ...record, done: false })),
    cursor: 0,
    total: unique.size,
    processed: 0,
    ready: 0,
    failed: 0,
    queued: 0,
    generatedStart: Number(queue.ownerCompleted) || 0,
    pauseUntil: 0,
    done: false,
    persisted: false
  };
  previewWarmers.set(pathKey(path), state);
  schedulePreviewWarm(80);
  return state;
}

process.on('mochimono:preview-cache-missing', () => {
  for (const state of previewWarmers.values()) {
    if (state.done) resetPreviewWarm(state.path, state.indexedAt);
  }
});

function previewWarmState(path) {
  return previewWarmers.get(pathKey(path)) || null;
}

function previewDiscoveryPending(root) {
  const key = pathKey(root);
  const job = parallelBrowseJobs.get(key) || currentJob();
  return Boolean(timers.has(key) || changeTimers.has(key) || pendingChanges.get(key)?.size ||
    (job?.status === 'running' && job.type !== 'hash' && job.progress?.path && pathKey(job.progress.path) === key));
}

function previewWarmStatus(path) {
  const state = previewWarmState(path);
  if (!state) return {};
  const queue = providerThumbnailQueueStatus(path);
  const generated = Math.max(0, (Number(queue.ownerCompleted) || 0) - (Number(state.generatedStart) || 0));
  return {
    previewKind: String(state.kind || 'full'),
    previewPhase: state.phase,
    previewTotal: Number(state.total) || 0,
    previewTotalKnown: Boolean((state.kind === 'specific' || state.countedAt === state.indexedAt && state.countedAt) && !previewDiscoveryPending(path)),
    previewProcessed: Number(state.processed) || 0,
    previewReady: Number(state.ready) || 0,
    previewFailed: Number(state.failed) || 0,
    previewDeferred: Number(state.deferred) || 0,
    previewGenerated: generated,
    previewQueued: Number(state.queued) || 0,
    previewWarming: !state.done,
    previewWaiting: Boolean(!state.done && (state.phase === 'unavailable' || state.phase === 'waiting' || (settings.thumbnailMode === 'idle' && !backgroundWorkAllowed()))),
    previewStartedAt: Number(state.startedAt) || 0,
    previewLastProgressAt: Math.max(Number(state.lastProgressAt) || 0, Number(queue.ownerLastCompletedAt) || 0),
    previewPauseUntil: Number(state.pauseUntil) || 0,
    previewCursor: String(state.afterPath || ''),
    previewPasses: Number(state.passes) || 0,
    previewBackpressured: Boolean(state.backpressured),
    previewError: String(state.lastError || ''),
    previewErrorCount: Number(state.errorCount) || 0,
    previewQueueBackground: Number(queue.ownerQueued) || 0,
    previewQueueActive: Number(queue.ownerActive) || 0,
    previewQueueGlobalBackground: Number(queue.background) || 0,
    previewQueueGlobalActive: Number(queue.backgroundActive) || 0,
    previewQueueUrgent: Number(queue.urgent) || 0,
    previewQueueLimit: Number(queue.backgroundLimit) || 0,
    previewDriveBlocked:Boolean(queue.ownerDriveBlocked),
    previewDriveOwner:String(queue.ownerDriveOwner || '')
  };
}

function nextPreviewWarmer() {
  const paths = settings.browseFolders;
  if (!paths.length) return null;
  if (settings.thumbnailMode !== 'max') {
    for (const path of paths) {
      const state = previewWarmState(path);
      if (state && !state.done && state.pauseUntil <= Date.now()) return state;
    }
    return null;
  }

  let blocked = null;
  for (let offset = 0; offset < paths.length; offset++) {
    const index = (previewWarmCursor + offset) % paths.length;
    const state = previewWarmState(paths[index]);
    if (!state || state.done || state.pauseUntil > Date.now()) continue;
    const queue = providerThumbnailQueueStatus(state.path);
    if (queue.ownerDriveBlocked) {
      blocked ||= { state, index };
      continue;
    }
    previewWarmCursor = (index + 1) % paths.length;
    return state;
  }

  if (blocked) {
    previewWarmCursor = (blocked.index + 1) % paths.length;
    return blocked.state;
  }
  previewWarmCursor = 0;
  return null;
}

function notePreviewProgress(state) {
  state.lastProgressAt = Date.now();
}

async function mapLimit(items, limit, work) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      items[index].result = await work(items[index]);
    }
  });
  await Promise.all(workers);
}

function queuePreviewRow(state, row) {
  const fullPath = join(state.path, ...String(row.path).replaceAll('\\', '/').split('/').filter(Boolean));
  return queueProviderThumbnail({
    hash: row.hash,
    path: row.path,
    filename: basename(row.path),
    mime: mimeFor(row.path),
    candidate: { path: fullPath, size: Number(row.size) || 0, mtimeMs:Number(row.mtimeMs) }
  }, { background: true, owner: state.path });
}

async function preparePreviewTotal(state) {
  if (!state.indexedAt || state.countedAt === state.indexedAt || previewDiscoveryPending(state.path)) return;
  const indexedAt = state.indexedAt;
  const index = openSyncIndex(SYNC_INDEX_PATH);
  let total;
  try { total = await index.mediaCount(state.rootKey); }
  finally { index.close(); }
  if (state.indexedAt !== indexedAt || previewDiscoveryPending(state.path)) return;
  state.total = total;
  state.countedAt = indexedAt;
  // Discovery can change page boundaries. Verify the settled inventory once;
  // no originals are scanned or read to establish this denominator.
  state.pages.clear();
  state.page = null;
  state.afterPath = '';
  delete state.retryCursor;
  state.processed = state.ready = state.failed = state.deferred = 0;
  state.reconciled = true;
  state.phase = 'checking';
  previewState.saveScan(state.rootKey, indexedAt, '');
}

function rememberPreviewPage(state, afterPath, counts) {
  const previous = state.pages.get(afterPath);
  for (const field of ['processed', 'ready', 'failed', 'deferred']) state[field] += counts[field] - (previous?.[field] || 0);
  state.pages.set(afterPath, counts);
}

async function checkPreviewCache(state, sourceAvailable) {
  state.passes++;
  state.backpressured = false;
  const afterPath = state.afterPath;
  if (!state.page || state.page.afterPath !== afterPath) {
    const index = openSyncIndex(SYNC_INDEX_PATH);
    try { state.page = { afterPath, rows:index.pageAfter(state.rootKey, afterPath, 128) }; }
    finally { index.close(); }
  }
  const rows = state.page.rows;
  const candidates = rows.filter(row => isMediaPath(row.path)).map(row => ({ row }));
  await mapLimit(candidates, 8, async item => {
    const thumb = await providerThumbnail(item.row.hash);
    return { thumb, failure:thumb ? null : providerThumbnailFailure(item.row.hash) };
  });

  const counts = { processed:candidates.length, ready:0, failed:0, deferred:0 };
  for (const { result } of candidates) {
    if (result.thumb) counts.ready++;
    else if (result.failure?.terminal) counts.failed++;
    else if (result.failure) counts.deferred++;
  }
  rememberPreviewPage(state, afterPath, counts);
  const pending = candidates.length - counts.ready - counts.failed;
  for (const { row, result } of candidates) {
    if (result.thumb || result.failure || !sourceAvailable) continue;
    const queue = providerThumbnailQueueStatus(state.path);
    if (queue.ownerQueued + queue.ownerActive >= previewOwnerQueueTarget() || queue.background >= PREVIEW_QUEUE_TARGET) {
      state.backpressured = true;
      break;
    }
    if (queuePreviewRow(state, row)) state.queued++;
  }
  notePreviewProgress(state);
  if (pending) {
    if (!sourceAvailable) {
      state.phase = 'unavailable';
      state.pauseUntil = Date.now() + 30_000;
      return;
    }
    const queue = providerThumbnailQueueStatus(state.path);
    if (pending > counts.deferred || queue.ownerQueued || queue.ownerActive) {
      state.phase = 'generating';
      return;
    }
    // Only retryable failures keep a checkpoint. Permanent failures are
    // settled outcomes and must not keep the folder waiting forever.
    state.retryCursor ??= state.afterPath;
  }
  if (rows.length) state.afterPath = rows.at(-1).path;
  previewState.saveScan(state.rootKey, state.indexedAt, state.retryCursor ?? state.afterPath);
  if (rows.length === 128) return;
  if (state.retryCursor !== undefined) {
    state.afterPath = state.retryCursor;
    delete state.retryCursor;
    state.phase = 'waiting';
    state.pauseUntil = Date.now() + 30_000;
    return;
  }
  if (!state.reconciled) {
    // A resumed cursor is progress, not proof that earlier outputs still exist.
    // Reconcile once from the beginning before reporting completion.
    state.reconciled = true;
    state.afterPath = '';
    previewState.saveScan(state.rootKey, state.indexedAt, '');
    return;
  }
  if (!state.countedAt || previewDiscoveryPending(state.path)) {
    state.page = null;
    state.phase = 'discovering';
    state.pauseUntil = Date.now() + 250;
    return;
  }
  if (state.ready + state.failed !== state.total) {
    state.countedAt = '';
    state.phase = 'checking';
    return;
  }
  state.phase = 'done';
  state.done = true;
  previewState.saveScan(state.rootKey, state.indexedAt, '');
}

async function warmSpecificMedia(state) {
  state.passes++;
  state.deferred = 0;
  state.phase = 'generating';
  if (!state.items.length) {
    state.done = true;
    state.phase = 'done';
    return;
  }

  let checked = 0;
  let visited = 0;
  while (checked < 96 && visited < state.items.length) {
    if (settings.thumbnailMode === 'idle' && !backgroundWorkAllowed()) return;
    const index = state.cursor % state.items.length;
    state.cursor = (index + 1) % state.items.length;
    visited++;
    const item = state.items[index];
    if (item.done) continue;
    checked++;

    const thumb = await providerThumbnail(item.hash);
    const failure = thumb ? null : providerThumbnailFailure(item.hash);
    if (thumb) {
      item.done = true;
      state.processed++;
      notePreviewProgress(state);
      state.ready++;
      continue;
    }
    if (failure) {
      if (failure.terminal) {
        item.done = true;
        state.processed++;
        state.failed++;
        notePreviewProgress(state);
      } else {
        state.deferred++;
        state.phase = 'waiting';
        state.pauseUntil = Date.now() + Math.min(30_000, failure.retryAfterMs);
      }
      continue;
    }

    if (!existsSync(state.path)) {
      state.phase = 'unavailable';
      state.pauseUntil = Date.now() + 30_000;
      continue;
    }
    if (queueProviderThumbnail({
      hash: item.hash,
      path: item.path,
      filename: item.filename || basename(item.path || ''),
      mime: item.mime || mimeFor(item.path || item.filename || ''),
      candidate: item.candidate
    }, { background: true, owner: state.path })) state.queued++;
  }

  if (state.processed >= state.total && !previewDiscoveryPending(state.path)) {
    state.done = true;
    state.phase = 'done';
  }
}

async function runPreviewWarm() {
  previewWarmTimer = null;
  if (!backgroundPreviewsEnabled()) return;
  const state = nextPreviewWarmer();
  if (!state) { schedulePreviewWarm(1000); return; }

  const now = Date.now();
  if (state.pauseUntil > now) {
    schedulePreviewWarm(state.pauseUntil - now);
    return;
  }
  state.pauseUntil = 0;

  if (settings.thumbnailMode === 'idle' && !backgroundWorkAllowed()) {
    schedulePreviewWarm(1000);
    return;
  }
  if (settings.thumbnailMode !== 'max' && (currentJob()?.status === 'running' || parallelBrowseJobs.size)) {
    schedulePreviewWarm(1000);
    return;
  }

  try {
    if (state.kind === 'specific') {
      await warmSpecificMedia(state);
    } else {
      await preparePreviewTotal(state);
      await checkPreviewCache(state, existsSync(state.path));
    }
  } catch (error) {
    state.lastError = String(error?.message || error);
    state.errorCount++;
    state.pauseUntil = Date.now() + PREVIEW_ERROR_BACKOFF_MS;
    console.warn(`Mochimono thumbnail check paused for ${state.path}: ${state.lastError}`);
  }

  const wait = state.pauseUntil > Date.now() ? state.pauseUntil - Date.now()
    : state.backpressured ? 25
      : state.phase === 'generating' ? 120
        : state.kind === 'specific' ? 120
          : settings.thumbnailMode === 'max' ? 0 : 30;
  schedulePreviewWarm(wait);
}

async function* filesUnder(directory, root = directory) {
  await waitForBrowseWork();
  checkCanceled();
  for await (const entry of directoryEntries(directory)) {
    await waitForBrowseWork();
    checkCanceled();
    if (entry.name === '.mochimono') continue;
    const path = join(directory, entry.name);
    if (isSourceExcluded(root, path)) continue;
    if (entry.isDirectory()) yield* filesUnder(path, root);
    else if (entry.isFile()) yield path;
  }
}

async function statPaths(paths) {
  return withDriveRead(paths[0], async () => {
    const items = paths.map(path => ({ path, result: null }));
    await mapLimit(items, 4, async item => {
      const file = await stat(item.path);
      return file.isFile() ? file : null;
    });
    return items.filter(item => item.result).map(item => ({ filePath: item.path, file: item.result }));
  });
}

async function* discoveredFiles(root) {
  let batch = [];
  let batchSize = EARLY_PREVIEWS;
  for await (const filePath of filesUnder(root, root)) {
    if (!browseIncludes(root, filePath)) continue;
    batch.push(filePath);
    if (batch.length < batchSize) continue;
    yield await statPaths(batch);
    batch = [];
    batchSize = DISCOVERY_BATCH;
    await yieldTurn();
  }
  if (batch.length) yield await statPaths(batch);
}

function hashFile(path, onProgress) {
  return readHash(path, { progress:onProgress, check:checkCanceled, wait:waitForBrowseWork });
}

function previewRecord(root, rel, file, hash) {
  return {
    hash,
    path: rel,
    filename: basename(rel),
    mime: mimeFor(rel),
    candidate: { path: join(root, ...rel.split('/').filter(Boolean)), size: Number(file.size) || 0, mtimeMs:Math.trunc(file.mtimeMs) }
  };
}

async function hashBrowseContent(root, update = () => {}, { compact = true } = {}) {
  const key = browseRootKey(root);
  const index = openSyncIndex(SYNC_INDEX_PATH);
  let total;
  try { total = index.browseHashStats(key).pending; }
  finally { index.close(); }

  async function* pendingRows() {
    let after = '';
    for (;;) {
      checkCanceled();
      const db = openSyncIndex(SYNC_INDEX_PATH);
      let rows;
      try { rows = db.pendingBrowseHashes(key, after); }
      finally { db.close(); }
      if (!rows.length) return;
      for (const row of rows) if (!isSourceExcluded(root, row.path)) yield row;
      after = rows.at(-1).path;
      await yieldTurn();
    }
  }

  if (!total) {
    update({ phase: 'Done', path: root, current: '', hashed: 0, total: 0, indeterminate: false });
    return { hashed: 0, pending: 0 };
  }

  let hashed = 0;
  let errors = 0;
  let writes = [];
  update({ phase: 'Hashing content', path: root, current: '', hashed: 0, total, indeterminate: false });

  const flush = () => {
    if (!writes.length) return;
    const db = openSyncIndex(SYNC_INDEX_PATH);
    try { db.saveBrowseContentHashes(key, writes); }
    finally { db.close(); }
    for (const row of writes) publishLocalCatalogChange({ rootPath:root, relativePath:row.path,
      size:row.size, mtimeMs:row.mtimeMs, id:row.id, hash:row.contentHash, replacesHash:row.id, contentHashReady:true });
    writes = [];
  };

  try {
    for await (const row of pendingRows()) {
      await waitForBrowseWork();
      checkCanceled();
      const filePath = join(root, ...String(row.path).replaceAll('\\', '/').split('/').filter(Boolean));
      try {
        const file = await stat(filePath).catch(() => null);
        if (!file?.isFile() || Number(file.size) !== Number(row.size) || Math.trunc(file.mtimeMs) !== Math.trunc(row.mtimeMs)) continue;
        let lastUpdate = 0;
        const contentHash = contentForPath(filePath, row.size, row.mtimeMs) || await hashFile(filePath, (read, force) => {
          const now = Date.now();
          if (!force && now - lastUpdate < 220) return;
          lastUpdate = now;
          const percent = file.size ? Math.min(100, Math.floor(read / file.size * 100)) : 100;
          update({ phase: 'Hashing content', path: root, current: `${row.path} · ${percent}%`, hashed, total, indeterminate: false });
        });
        const latest = await stat(filePath).catch(() => null);
        if (!latest?.isFile() || Number(latest.size) !== Number(row.size) || Math.trunc(latest.mtimeMs) !== Math.trunc(row.mtimeMs)) continue;
        await reuseProviderThumbnail(row.id, contentHash).catch(() => {});
        writes.push({ path: row.path, size: row.size, mtimeMs: row.mtimeMs, id:row.id, contentHash });
        rememberIdentity(latest, row.hash, contentHash, true);
        hashed++;
        if (writes.length >= HASH_SAVE_BATCH) flush();
        update({ phase: 'Hashing content', path: root, current: row.path, hashed, total, indeterminate: false });
      } catch (error) {
        if (error.canceled) throw error;
        errors++;
      }
    }
  } finally { flush(); }

  // Browse rows now keep their stable local id and content hash in the same
  // index row. There is no separate promotion step; once hashing completes the
  // catalog projection already exposes the content hash. Notify consumers once
  // after the background hash pass so they can refresh that identity change.
  if (compact && hashed) onChanged();

  const db = openSyncIndex(SYNC_INDEX_PATH);
  let remaining = 0;
  try { remaining = db.browseHashStats(key).pending; }
  finally { db.close(); }
  update({ phase: 'Done', path: root, current: '', hashed, total, errors, indeterminate: false });
  return { hashed, pending: remaining, errors };
}

async function previewWorkBlocksHash(root) {
  const state = previewWarmState(root);
  return Boolean(state && !state.done && state.phase !== 'waiting' && state.phase !== 'unavailable');
}

function scheduleBrowseHash(path, delay = 250) {
  const root = browseFolderFor(path);
  if (!root || settings.thumbnailMode === 'off') return;
  const key = pathKey(root);
  if (hashTimers.has(key)) return;
  const timer = setTimeout(async () => {
    hashTimers.delete(key);
    if (!browseFolderFor(root) || settings.thumbnailMode === 'off') return;
    if (!existsSync(root)) return scheduleBrowseHash(root, 30_000);
    if (timers.has(key) || changeTimers.has(key) || pendingChanges.get(key)?.size) return scheduleBrowseHash(root, 700);
    if (!backgroundWorkAllowed()) return scheduleBrowseHash(root, 1000);
    if (await previewWorkBlocksHash(root)) return scheduleBrowseHash(root, 1000);

    const db = openSyncIndex(SYNC_INDEX_PATH);
    let pending = 0;
    try { pending = db.browseHashStats(browseRootKey(root)).pending; }
    finally { db.close(); }
    if (!pending) return;

    if (settings.thumbnailMode !== 'max' && (parallelBrowseJobs.size || currentJob()?.status === 'running')) return scheduleBrowseHash(root, 1000);
    const started = await startParallelBrowseJob(
      root,
      `Hash ${basename(root) || root}`,
      update => hashBrowseContent(root, update),
      { background: true, type: 'hash' }
    );
    if (!started) scheduleBrowseHash(root, settings.thumbnailMode === 'max' ? 350 : 1000);
  }, Math.max(0, delay));
  timer.unref?.();
  hashTimers.set(key, timer);
}

export async function indexBrowseFolder(path, update = () => {}, options = {}) {
  const root = resolve(path);
  await waitForBrowseWork();
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${root} is not a directory`);

  const key = browseRootKey(root);
  purgeExcludedIndex(root, key);
  const index = openSyncIndex(SYNC_INDEX_PATH);
  const previousIndexedAt = index.lastIndexed(key);
  const previousWarmComplete = previewCompletionMatches(index, key, previousIndexedAt);
  const existingPreviewWarm = previewWarmState(root) || resetPreviewWarm(root, previousIndexedAt);
  const seen = new Set();
  const pending = [];
  const changedPreviews = [];
  let scanned = 0;
  let reused = 0;
  let errors = 0;
  let previewQueued = 0;
  let changedMedia = 0;
  let changedRows = 0;
  let indexedAt = '';
  let removed = 0;
  const phase = previousIndexedAt ? 'Checking files' : 'Finding files';
  const startedAt = Date.now();
  let reportedAt = 0;
  const report = (current = '', force = false, extra = {}) => {
    const now = Date.now();
    if (!force && now - reportedAt < 180) return;
    reportedAt = now;
    update({ phase, path:root, current, scanned, reused, added:changedRows, errors,
      filesPerSecond:Math.round(scanned / Math.max(.1, (now - startedAt) / 1000)),
      elapsedSeconds:Math.round((now - startedAt) / 1000), updatedAt:now, indeterminate:true, ...extra });
  };

  function queuePreview(filePath, file, hash) {
    if (!backgroundPreviewsEnabled() || previousWarmComplete) return false;
    const mime = mimeFor(filePath);
    if (!mime.startsWith('image/') && !mime.startsWith('video/')) return false;
    if (previewQueued >= EARLY_PREVIEWS) return false;
    previewQueued++;
    queueProviderThumbnail({
      hash,
      filename: basename(filePath),
      mime,
      candidate: { path: filePath, size: file.size, mtimeMs:Math.trunc(file.mtimeMs) }
    }, { background: browseWorkIsBackground(), owner: root });
    return true;
  }

  const flushIndex = () => {
    if (!pending.length) return;
    const rows = pending.splice(0);
    index.saveBrowseMany(key, rows);
    for (const row of rows) publishLocalCatalogChange({ rootPath:root, relativePath:row.path, ...row, hash:row.contentHash || row.hash });
  };
  report('', true);
  try {
    for await (const batch of discoveredFiles(root)) {
      for (const { filePath, file } of batch) {
        await waitForBrowseWork();
        checkCanceled();
        const rel = relative(root, filePath).replaceAll('\\', '/');
        seen.add(rel);
        try {
          const mtimeMs = Math.trunc(file.mtimeMs);
          const previous = index.get(key, rel);
          let hash = '';
          let contentHash = '';

          if (previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === mtimeMs) {
            hash = previous.id;
            contentHash = String(previous.contentHash || '');
            reused++;
            rememberIdentity(file, hash, contentHash, true);
            queuePreview(filePath, file, contentHash || hash);
          } else {
            const moved = previous ? null : hashForIdentity(file);
            if (moved) {
              hash = moved.hash;
              contentHash = moved.contentHash || (moved.tracked ? '' : moved.hash);
              reused++;
            } else {
              hash = localIdentityHash(root, rel, file);
              contentHash = '';
            }

            const row = { path: rel, size: file.size, mtimeMs, hash, contentHash };
            pending.push(row);
            changedRows++;
            rememberIdentity(file, hash, contentHash, true);
            if (isMediaPath(rel) && previous?.hash !== hash) {
              changedMedia++;
              if (previousWarmComplete) changedPreviews.push(previewRecord(root, rel, file, hash));
            }

            const preview = queuePreview(filePath, file, hash);
            if (changedRows <= EARLY_PREVIEWS || preview || pending.length >= INDEX_SAVE_BATCH) {
              flushIndex();
              await yieldTurn();
            }
          }

          scanned++;
          report(rel);
        } catch (error) {
          if (error.canceled) throw error;
          errors++;
        }
      }
      await yieldTurn();
    }

    await waitForBrowseWork();
    if (!await stat(root).then(info => info.isDirectory()).catch(() => false)) throw new Error('Source disconnected during indexing');
    flushIndex();
    report('', true, { phase:'Finalizing index', checked:0, total:scanned, indeterminate:false });
    removed = await index.prune(key, seen, checkCanceled, checked => {
      report('', false, { phase:'Finalizing index', checked, total:Math.max(scanned, checked), indeterminate:false });
    });
    if (!existsSync(root)) throw new Error('Source disconnected while finalizing index');
    indexedAt = new Date().toISOString();
    if (errors) throw new Error(`${errors} files could not be indexed`);
    index.markIndexed(key, indexedAt);
    if (removed) publishLocalCatalogReset();
  } finally {
    try { flushIndex(); }
    finally { index.close(); }
  }

  if (previousWarmComplete && !changedMedia && existingPreviewWarm) existingPreviewWarm.indexedAt = indexedAt;

  if (backgroundPreviewsEnabled()) {
    if (existingPreviewWarm?.kind === 'full' && !existingPreviewWarm.done) {
      existingPreviewWarm.indexedAt = indexedAt;
      existingPreviewWarm.reconciled = false;
      existingPreviewWarm.pauseUntil = 0;
      schedulePreviewWarm(0);
    } else if (!previousWarmComplete) {
      if (existingPreviewWarm && !existingPreviewWarm.done && !changedMedia) {
        existingPreviewWarm.indexedAt = indexedAt;
        existingPreviewWarm.persisted = false;
        schedulePreviewWarm(0);
      } else resetPreviewWarm(root, indexedAt);
    } else if (changedPreviews.length) resetSpecificPreviewWarm(root, changedPreviews, indexedAt);
  }

  if (options.scheduleHash !== false) scheduleBrowseHash(root, 150);
  const changed = changedRows + removed;
  update({ phase: 'Done', path: root, current: '', scanned, hashed: 0, reused, removed, errors, indeterminate: false });
  return { path: root, files: scanned, changed, removed, hashed: 0, reused, errors };
}

async function indexed(root, update) {
  try {
    const result = await indexBrowseFolder(root, update);
    if (result.changed) onChanged();
    return result;
  } catch (error) {
    if (!error.canceled) queue(root, 30_000);
    throw error;
  }
}

function clearPendingChanges(root) {
  const key = pathKey(root);
  clearTimeout(changeTimers.get(key));
  changeTimers.delete(key);
  pendingChanges.delete(key);
}

function queue(path, delay = 800, foreground = false) {
  const root = browseFolderFor(path);
  if (!root) return;
  const key = pathKey(root);
  if (foreground) foregroundChecks.add(key);
  clearPendingChanges(root);
  clearTimeout(timers.get(key));
  const timer = setTimeout(async () => {
    timers.delete(key);
    const isForeground = foregroundChecks.has(key);
    if (!existsSync(root)) return queue(root, 30_000, isForeground);
    watchFolder(root);

    if (settings.thumbnailMode === 'max') {
      const started = await startParallelBrowseJob(
        root,
        `Check ${basename(root) || root}`,
        update => indexed(root, update),
        { background: false, type: 'sync' }
      );
      if (!started) return queue(root, 350, isForeground);
      foregroundChecks.delete(key);
      return;
    }

    if (parallelBrowseJobs.size || currentJob()?.status === 'running') return queue(root, 1500, isForeground);
    foregroundChecks.delete(key);
    beginJob('sync', `Check ${basename(root) || root}`, update => indexed(root, update), { background: false });
  }, delay);
  timer.unref?.();
  timers.set(key, timer);
}

function watchedTarget(root, filename) {
  const raw = String(filename || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!raw || raw === '.mochimono' || raw.startsWith('.mochimono/')) return null;
  const target = resolve(root, ...raw.split('/').filter(Boolean));
  const rel = relative(root, target).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../')) return null;
  return { path: target, rel };
}

function encodedChange(eventType, rel) {
  return `${eventType === 'change' ? 'change' : 'rename'}\0${rel}`;
}

function decodedChange(value) {
  const text = String(value || '');
  const split = text.indexOf('\0');
  if (split < 0) return { eventType: 'rename', name: text };
  return { eventType: text.slice(0, split), name: text.slice(split + 1) };
}

async function updateBrowseChanges(root, names, update = () => {}) {
  const key = browseRootKey(root);
  const index = openSyncIndex(SYNC_INDEX_PATH);
  const indexedAt = index.lastIndexed(key);
  const wasPreviewComplete = previewCompletionMatches(index, key, indexedAt);
  const changedPreviews = [];
  const coveredDirectories = [];
  let changed = 0;
  let removed = 0;
  let reused = 0;
  let scanned = 0;
  let needsFull = false;

  const covered = rel => coveredDirectories.some(prefix => rel.startsWith(prefix));

  async function reconcileFile(filePath, rel, file, previous = index.get(key, rel)) {
    if (!browseIncludes(root, filePath)) {
      const count = index.forget(key, rel);
      removed += count;
      changed += count;
      scanned++;
      return;
    }

    const mtimeMs = Math.trunc(file.mtimeMs);
    if (previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === mtimeMs) {
      rememberIdentity(file, previous.id, previous.contentHash, true);
      scanned++;
      return;
    }

    const moved = previous ? null : hashForIdentity(file);
    let hash;
    let contentHash;
    if (moved) {
      hash = moved.hash;
      contentHash = moved.contentHash || (moved.tracked ? '' : moved.hash);
      reused++;
    } else {
      hash = localIdentityHash(root, rel, file);
      contentHash = '';
    }

    rememberIdentity(file, hash, contentHash, true);
    index.saveBrowse(key, rel, file.size, mtimeMs, hash, contentHash);
    publishLocalCatalogChange({ rootPath:root, relativePath:rel, size:file.size, mtimeMs, hash:contentHash || hash });
    changed++;

    if (isMediaPath(rel) && previous?.hash !== hash) changedPreviews.push(previewRecord(root, rel, file, hash));

    scanned++;
    if (scanned % 50 === 0) update({ phase: 'Updating', path: root, current: rel, scanned, hashed: 0, reused, indeterminate: true });
    if (scanned % YIELD_EVERY_FILES === 0) await yieldTurn();
  }

  async function reconcileDirectory(target) {
    const prefix = `${target.rel}/`;
    if (covered(target.rel)) return;
    const cached = index.loadPrefix(key, prefix);
    const seen = new Set();
    update({ phase: 'Updating', path: root, current: `${target.rel}/`, scanned, hashed: 0, reused, indeterminate: true });

    for await (const filePath of filesUnder(target.path, root)) {
      if (!browseIncludes(root, filePath)) continue;
      const rel = relative(root, filePath).replaceAll('\\', '/');
      seen.add(rel);
      const file = await stat(filePath).catch(() => null);
      if (!file?.isFile()) continue;
      await reconcileFile(filePath, rel, file, cached.get(rel) || null);
    }

    for (const rel of cached.keys()) {
      if (seen.has(rel)) continue;
      const count = index.forget(key, rel);
      removed += count;
      changed += count;
    }
    coveredDirectories.push(prefix);
  }

  update({ phase: 'Updating', path: root, current: '', scanned: 0, hashed: 0, reused: 0, indeterminate: true });
  try {
    for (const value of names) {
      await waitForBrowseWork();
      checkCanceled();
      const { eventType, name } = decodedChange(value);
      const target = watchedTarget(root, name);
      if (!target) {
        needsFull = true;
        break;
      }
      if (isSourceExcluded(root, target.rel) || covered(target.rel)) continue;

      const file = await stat(target.path).catch(() => null);
      if (!file) {
        const prefix = `${target.rel}/`;
        const count = index.hasPrefix(key, prefix)
          ? index.forgetPrefix(key, prefix)
          : index.forget(key, target.rel);
        removed += count;
        changed += count;
        scanned++;
        continue;
      }
      if (file.isDirectory()) {
        if (eventType === 'rename') await reconcileDirectory(target);
        else scanned++;
        continue;
      }
      if (!file.isFile()) continue;
      await reconcileFile(target.path, target.rel, file);
    }
  } catch (error) {
    index.close();
    throw error;
  }

  if (needsFull) {
    index.close();
    return indexBrowseFolder(root, update);
  }

  let nextIndexedAt = indexedAt;
  if (changed || removed) {
    nextIndexedAt = new Date().toISOString();
    index.markIndexed(key, nextIndexedAt);
    const activeWarm = previewWarmState(root);
    if (wasPreviewComplete && !changedPreviews.length && activeWarm) activeWarm.indexedAt = nextIndexedAt;
    if (!wasPreviewComplete && activeWarm && !activeWarm.done && !changedPreviews.length) {
      activeWarm.indexedAt = nextIndexedAt;
      activeWarm.persisted = false;
    }
  }
  index.close();

  if (changedPreviews.length && backgroundPreviewsEnabled()) {
    if (wasPreviewComplete) resetSpecificPreviewWarm(root, changedPreviews, nextIndexedAt);
    else resetPreviewWarm(root, nextIndexedAt);
  }
  if (removed) publishLocalCatalogReset();
  if (changed || removed) scheduleBrowseHash(root, 180);

  update({ phase: 'Done', path: root, current: '', scanned, hashed: 0, reused, removed, indeterminate: false });
  return { path: root, files: scanned, changed, removed, hashed: 0, reused, errors: 0 };
}

async function incrementalIndexed(root, names, update) {
  const result = await updateBrowseChanges(root, names, update);
  if (result.changed || result.removed) onChanged();
  return result;
}

function flushChanges(root, delay = CHANGE_DELAY_MS) {
  const key = pathKey(root);
  clearTimeout(changeTimers.get(key));
  const timer = setTimeout(async () => {
    changeTimers.delete(key);
    const pending = pendingChanges.get(key);
    if (!pending?.size) return;
    if (timers.has(key)) return pendingChanges.delete(key);
    const names = [...pending];
    pendingChanges.delete(key);

    let started;
    if (settings.thumbnailMode === 'max') {
      started = await startParallelBrowseJob(
        root,
        `Update ${basename(root) || root}`,
        update => incrementalIndexed(root, names, update),
        { background: false, type: 'sync' }
      );
    } else if (!parallelBrowseJobs.size && currentJob()?.status !== 'running') {
      started = beginJob('sync', `Update ${basename(root) || root}`, update => incrementalIndexed(root, names, update), { background: false });
    }

    if (!started) {
      const next = pendingChanges.get(key) || new Set();
      names.forEach(name => next.add(name));
      pendingChanges.set(key, next);
      flushChanges(root, settings.thumbnailMode === 'max' ? 350 : 900);
    }
  }, delay);
  timer.unref?.();
  changeTimers.set(key, timer);
}

function queueChange(path, filename, eventType = 'rename') {
  const root = browseFolderFor(path);
  if (!root || timers.has(pathKey(root))) return;
  const target = watchedTarget(root, filename);
  if (!target) return queue(root, 900);
  if (isSourceExcluded(root, target.rel)) return;
  const key = pathKey(root);
  const pending = pendingChanges.get(key) || new Set();
  pending.add(encodedChange(eventType, target.rel));
  pendingChanges.set(key, pending);
  if (pending.size >= INCREMENTAL_FLUSH_BATCH) return flushChanges(root, 0);
  flushChanges(root);
}

function watchFolder(path) {
  const root = resolve(path);
  const key = pathKey(root);
  if (watchers.has(key) || !existsSync(root)) return;
  try {
    const watcher = watch(root, { recursive: true }, (eventType, filename) => queueChange(root, filename, eventType));
    watcher.on('error', () => {
      watcher.close();
      watchers.delete(key);
      queue(root, 0);
    });
    watchers.set(key, watcher);
  } catch {}
}

function unwatchFolder(path) {
  const key = pathKey(path);
  watchers.get(key)?.close();
  watchers.delete(key);
  previewWarmers.delete(key);
  foregroundChecks.delete(key);
  const parallel = parallelBrowseJobs.get(key);
  if (parallel?.status === 'running') parallel.cancelRequested = true;
  clearTimeout(timers.get(key));
  timers.delete(key);
  clearTimeout(hashTimers.get(key));
  hashTimers.delete(key);
  clearPendingChanges(path);
}

export async function addBrowseFolder(path, scope = 'media') {
  const root = resolve(String(path));
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error('Folder not found'), { status: 400 });
  if (protectedFolderFor(root)) return root;

  const selectedScope = mediaScope(scope);
  const exists = Boolean(browseFolderFor(root));
  const scopeChanged = browseFolderScope(root) !== selectedScope;
  if (!exists) settings.browseFolders.push(root);
  settings.browseFolderScopes[pathKey(root)] = selectedScope;
  if (!exists || scopeChanged) await persistSettings();
  watchFolder(root);
  queue(root, 0, true);
  return root;
}

async function detachBrowseFolder(path, forgetIndex) {
  const key = pathKey(path);
  const index = settings.browseFolders.findIndex(item => pathKey(item) === key);
  if (index < 0) throw Object.assign(new Error('Folder not found'), { status: 404 });
  const [root] = settings.browseFolders.splice(index, 1);
  delete settings.browseFolderScopes[key];
  unwatchFolder(root);
  if (forgetIndex) {
    const db = openSyncIndex(SYNC_INDEX_PATH);
    try { db.forgetRoot(browseRootKey(root)); } finally { db.close(); }
    delete settings.sourceExclusions?.[key];
  }
  await persistSettings();
  return root;
}

export async function removeBrowseFolder(path) {
  await detachBrowseFolder(path, true);
  publishLocalCatalogReset();
  onChanged();
}

async function waitForRootWorkToStop(root) {
  const key = pathKey(root);
  const deadline = Date.now() + 30_000;
  const parallel = parallelBrowseJobs.get(key);
  if (parallel?.status === 'running') parallel.cancelRequested = true;
  const running = currentJob();
  if (running?.status === 'running' && running.progress?.path && pathKey(running.progress.path) === key) running.cancelRequested = true;

  while (parallelBrowseJobs.has(key) || (() => {
    const active = currentJob();
    return active?.status === 'running' && active.progress?.path && pathKey(active.progress.path) === key;
  })()) {
    if (Date.now() >= deadline) throw new Error(`Could not stop active work for ${root}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
}

async function finalizeBrowseHashes(root) {
  const key = pathKey(root);
  clearTimeout(hashTimers.get(key));
  hashTimers.delete(key);
  clearTimeout(timers.get(key));
  timers.delete(key);
  clearPendingChanges(root);
  await waitForRootWorkToStop(root);
  await indexBrowseFolder(root, () => {}, { scheduleHash: false });
  await hashBrowseContent(root, () => {}, { compact: false });
  const db = openSyncIndex(SYNC_INDEX_PATH);
  try { db.promoteAllBrowseHashes(browseRootKey(root)); }
  finally { db.close(); }
}

export async function protectBrowseFolder(path, addProtectedFolder) {
  const root = browseFolderFor(path);
  if (!root) throw Object.assign(new Error('Folder not found'), { status: 404 });
  const scope = browseFolderScope(root);

  await finalizeBrowseHashes(root);

  const db = openSyncIndex(SYNC_INDEX_PATH);
  try { db.moveRoot(browseRootKey(root), pathKey(root)); }
  finally { db.close(); }

  await detachBrowseFolder(root, false);
  try {
    const folder = await addProtectedFolder(root, scope);
    onChanged();
    return folder;
  } catch (error) {
    const rollback = openSyncIndex(SYNC_INDEX_PATH);
    try { rollback.moveRoot(pathKey(root), browseRootKey(root)); }
    finally { rollback.close(); }
    settings.browseFolders.push(root);
    settings.browseFolderScopes[pathKey(root)] = scope;
    await persistSettings();
    watchFolder(root);
    onChanged();
    throw error;
  }
}

export async function browseThumbnailFailures(path) {
  const root = browseFolderFor(path);
  if (!root) throw Object.assign(new Error('Folder not found'), { status:404 });
  const index = openSyncIndex(SYNC_INDEX_PATH);
  const failures = [];
  let after = '';
  try {
    for (;;) {
      const rows = index.pageAfter(browseRootKey(root), after, 1000);
      for (const row of rows) {
        if (!isMediaPath(row.path) || isSourceExcluded(root, row.path)) continue;
        const stored = previewState.get(row.hash);
        if (!stored?.error || stored.size) continue;
        failures.push({ path:row.path, hash:row.hash, id:row.id, error:stored.error,
          attempts:previewState.attempts(row.hash), terminal:stored.retry_at === -1,
          retryAt:stored.retry_at > 0 ? stored.retry_at : null });
      }
      if (rows.length < 1000) break;
      after = rows.at(-1).path;
      await yieldTurn();
    }
  } finally { index.close(); }
  return failures;
}

export async function retryBrowseThumbnails(path) {
  const failures = await browseThumbnailFailures(path);
  for (const file of failures) {
    resetProviderThumbnailFailure(file.hash);
    resetProviderThumbnailFailure(file.id);
  }
  const root = browseFolderFor(path);
  if (!root) throw Object.assign(new Error('Folder not found'), { status:404 });
  const index = openSyncIndex(SYNC_INDEX_PATH);
  // Reset even while background work is off; the new pass starts when enabled.
  try { previewWarmers.set(pathKey(root), fullPreviewState(root, index.lastIndexed(browseRootKey(root)) || '')); }
  finally { index.close(); }
  schedulePreviewWarm(0);
  scheduleBrowseHash(root, 150);
  return failures.length;
}

export async function browseFolderStats() {
  const db = openSyncIndex(SYNC_INDEX_PATH);
  const running = currentJob();
  try {
    return await Promise.all(settings.browseFolders.map(async path => {
      const filesystem = await statfs(path).then(fs => ({
        capacityBytes: Number(fs.blocks) * Number(fs.bsize),
        freeBytes: Number(fs.bavail) * Number(fs.bsize)
      })).catch(() => ({ capacityBytes: 0, freeBytes: 0 }));
      const key = browseRootKey(path);
      const localKey = pathKey(path);
      const indexed = db.stats(key);
      const hashStats = db.browseHashStats(key);
      const indexedAt = db.lastIndexed(key);
      if (backgroundPreviewsEnabled() && !previewWarmState(path) && indexed.files && !previewCompletionMatches(db, key, indexedAt)) resetPreviewWarm(path, indexedAt);
      const fullCheckQueued = timers.has(localKey);
      const incrementalQueued = changeTimers.has(localKey);
      const pendingChangeCount = pendingChanges.get(localKey)?.size || 0;
      const queued = fullCheckQueued || incrementalQueued || Boolean(pendingChangeCount);
      const parallelRunning = parallelBrowseJobs.get(localKey);
      const globalRunningHere = running?.status === 'running' && running?.progress?.path && pathKey(running.progress.path) === localKey;
      const runningJob = parallelRunning?.status === 'running' ? parallelRunning : globalRunningHere ? running : null;
      const runningHere = Boolean(runningJob);
      const hashing = runningJob?.type === 'hash';
      const indexRunning = runningHere && !hashing;
      const available = existsSync(path);
      const hashWaiting = hashStats.pending > 0 && settings.thumbnailMode === 'idle' && !backgroundWorkAllowed() && !hashing;
      const hashWaitReason = !hashStats.pending || hashing ? '' : !available ? 'Drive offline'
        : settings.thumbnailMode === 'off' ? 'Background work is off'
        : hashWaiting ? 'Waiting until your PC is idle'
        : queued || indexRunning ? 'Waiting for indexing'
        : await previewWorkBlocksHash(path) ? 'Waiting for thumbnails'
        : parallelBrowseJobs.size || running?.status === 'running' ? 'Waiting for other work'
        : 'Waiting to start';
      return {
        path,
        scope: browseFolderScope(path),
        ...indexed,
        ...filesystem,
        ...previewWarmStatus(path),
        lastIndexed: indexedAt,
        pending: queued || indexRunning,
        hashPending: hashStats.pending,
        hashReady: hashStats.ready,
        hashTracked: hashStats.tracked,
        hashing,
        progress:runningJob?.progress || null,
        startedAt:runningJob?.startedAt || null,
        hashWaiting,
        hashWaitReason,
        waitingForIdle: Boolean(indexRunning && runningJob.background && !backgroundWorkAllowed()),
        available,
        protected: false,
        diagnostics: {
          watcher: watchers.has(localKey),
          fullCheckQueued,
          incrementalQueued,
          pendingChanges: pendingChangeCount,
          foregroundCheck: foregroundChecks.has(localKey),
          running: runningHere,
          runningBackground: Boolean(runningHere && runningJob?.background),
          jobType: runningJob?.type || '',
          hashPending: hashStats.pending,
          hashReady: hashStats.ready,
          hashTracked: hashStats.tracked,
          hashProcessed: hashing ? Number(runningJob.progress?.hashed) || 0 : 0,
          hashTotal: hashing ? Number(runningJob.progress?.total) || 0 : 0,
          parallelDrive: parallelRunning?.drive || '',
          parallelActive: parallelBrowseJobs.size
        }
      };
    }));
  } finally { db.close(); }
}

export function refreshBrowsePreviewPolicy() {
  if (previewWarmTimer) clearTimeout(previewWarmTimer);
  previewWarmTimer = null;
  if (settings.thumbnailMode !== 'off') {
    const db = openSyncIndex(SYNC_INDEX_PATH);
    try {
      for (const path of settings.browseFolders) {
        if (!previewWarmState(path)) {
          const key = browseRootKey(path);
          const indexed = db.stats(key);
          const indexedAt = db.lastIndexed(key);
          if (indexed.files && !previewCompletionMatches(db, key, indexedAt)) resetPreviewWarm(path, indexedAt);
        }
        scheduleBrowseHash(path, 0);
      }
    } finally { db.close(); }
    schedulePreviewWarm(0);
  }
}

function dedupeConfiguredRoots() {
  const protectedKeys = new Set(settings.folders.map(folder => pathKey(folder.path)));
  const seen = new Set();
  const keep = [];
  const removed = [];

  for (const path of settings.browseFolders) {
    const key = pathKey(path);
    if (protectedKeys.has(key) || seen.has(key)) removed.push(path);
    else {
      seen.add(key);
      keep.push(path);
    }
  }

  if (!removed.length) return;
  settings.browseFolders.splice(0, settings.browseFolders.length, ...keep);
  for (const path of removed) delete settings.browseFolderScopes[pathKey(path)];

  const db = openSyncIndex(SYNC_INDEX_PATH);
  try { for (const path of removed) db.forgetRoot(browseRootKey(path)); }
  finally { db.close(); }
  persistSettings().catch(() => {});
}

export function startBrowseService(changeHandler = () => {}) {
  onChanged = typeof changeHandler === 'function' ? changeHandler : () => {};
  dedupeConfiguredRoots();
  sourceProbeTimer ||= setInterval(() => {
    for (const path of settings.browseFolders) {
      const key = pathKey(path);
      if (existsSync(path) && !watchers.has(key) && !timers.has(key) && !parallelBrowseJobs.has(key)) {
        watchFolder(path);
        queue(path, 0);
      }
    }
  }, 30_000);
  sourceProbeTimer.unref?.();
  for (const path of settings.browseFolders) {
    purgeExcludedIndex(path, browseRootKey(path));
    watchFolder(path);
    const db = openSyncIndex(SYNC_INDEX_PATH);
    try { resetPreviewWarm(path, db.lastIndexed(browseRootKey(path)) || ''); }
    finally { db.close(); }
    if (existsSync(path)) queue(path, 0);
    else scheduleBrowseHash(path, 30_000);
  }
}

export function stopBrowseService() {
  clearInterval(sourceProbeTimer);
  sourceProbeTimer = null;
  if (previewWarmTimer) clearTimeout(previewWarmTimer);
  previewWarmTimer = null;
  previewWarmers.clear();
  identities.clear();
  for (const timer of hashTimers.values()) clearTimeout(timer);
  hashTimers.clear();
  onChanged = () => {};
  for (const path of settings.browseFolders) unwatchFolder(path);
}
