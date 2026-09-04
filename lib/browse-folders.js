import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, watch } from 'node:fs';
import { opendir, stat, statfs } from 'node:fs/promises';
import { platform } from 'node:os';
import { basename, join, parse, relative, resolve } from 'node:path';
import { api, beginJob, canceled, currentJob, pathKey, persistSettings, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { backgroundWorkAllowed, waitForBackgroundWork } from './background-work.js';
import { browseStageStats, openBrowseStage } from './browse-staging.js';
import { openSyncIndex } from './sync-index.js';
import { mimeFor } from './mime.js';
import { providerThumbnail, providerThumbnailFailure, providerThumbnailQueueStatus, queueProviderThumbnail } from './provider-thumbs.js';

const YIELD_EVERY_FILES = 200;
const HASH_YIELD_BYTES = 8 * 1024 * 1024;
const STAGE_EVERY_FILES = 24;
const DISCOVERY_BATCH = 128;
const HASH_SAVE_BATCH = 24;
const EARLY_PREVIEWS = 3;
const PREVIEW_SCAN_BATCH = 512;
const PREVIEW_QUEUE_TARGET = 256;
const PREVIEW_MAX_BURST = 64;
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
let previewWarmCursor = 0;
let onChanged = () => {};

export const browseRootKey = path => `browse:${pathKey(path)}`;
export const browseFolderFor = path => settings.browseFolders.find(item => pathKey(item) === pathKey(path));
const protectedFolderFor = path => settings.folders.find(folder => pathKey(folder.path) === pathKey(path));
const yieldTurn = () => new Promise(resolvePromise => setImmediate(resolvePromise));
const yieldHashTurn = () => new Promise(resolvePromise => setTimeout(resolvePromise, 1));
const backgroundPreviewsEnabled = () => settings.thumbnailMode !== 'off';
const isMediaPath = path => {
  const mime = mimeFor(path);
  return mime.startsWith('image/') || mime.startsWith('video/');
};
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

async function browseDriveKey(path) {
  const root = resolve(String(path || ''));
  if (platform() === 'win32') return `volume:${parse(root).root.toLowerCase()}`;
  const info = await stat(root).catch(() => null);
  return info?.dev != null ? `device:${String(info.dev)}` : `path:${pathKey(root)}`;
}

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
    // Live filesystem reconciliation always wins over speculative content
    // hashing. The hash job will resume from its persisted metadata later.
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
        job.progress = { ...job.progress, ...patch };
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

function localIdentityHash(root, rel, file) {
  return createHash('sha256')
    .update(`mochimono-local-v1\0${pathKey(root)}\0${String(rel)}\0${Number(file.size) || 0}\0${Math.trunc(Number(file.mtimeMs) || 0)}`)
    .digest('hex');
}

function previewCompletionMatches(index, rootKey, indexedAt) {
  return Boolean(indexedAt && index.lastPreviewed(rootKey) === indexedAt);
}

function previewMediaTotal(rootKey) {
  const index = openSyncIndex(SYNC_INDEX_PATH);
  const hashes = new Set();
  let afterPath = '';
  try {
    while (true) {
      const rows = index.pageAfter(rootKey, afterPath, 1000);
      if (!rows.length) break;
      for (const row of rows) if (isMediaPath(row.path)) hashes.add(row.hash);
      afterPath = rows.at(-1)?.path || afterPath;
      if (rows.length < 1000) break;
    }
  } finally { index.close(); }
  return hashes.size;
}

function previewOwnerQueueTarget() {
  // Four drives can each keep a 64-item lane full without overflowing the
  // global 256-item feeder. Folder count should not reduce per-drive throughput.
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
    afterPath: '',
    total: previewMediaTotal(rootKey),
    processed: 0,
    ready: 0,
    failed: 0,
    queued: 0,
    generatedStart: Number(queue.ownerCompleted) || 0,
    pauseUntil: 0,
    seen: new Set(),
    done: false,
    persisted: false
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

function previewWarmState(path) {
  return previewWarmers.get(pathKey(path)) || null;
}

function previewWarmStatus(path) {
  const state = previewWarmState(path);
  if (!state) return {};
  const queue = providerThumbnailQueueStatus(path);
  const generated = Math.max(0, (Number(queue.ownerCompleted) || 0) - (Number(state.generatedStart) || 0));
  return {
    previewPhase: state.phase,
    previewTotal: Number(state.total) || 0,
    previewProcessed: Number(state.processed) || 0,
    previewReady: Number(state.ready) || 0,
    previewFailed: Number(state.failed) || 0,
    previewDeferred: Number(state.deferred) || 0,
    previewGenerated: generated,
    previewQueued: Number(state.queued) || 0,
    previewWarming: !state.done,
    previewWaiting: Boolean(!state.done && settings.thumbnailMode === 'idle' && !backgroundWorkAllowed()),
    previewStartedAt: Number(state.startedAt) || 0,
    previewLastProgressAt: Math.max(Number(state.lastProgressAt) || 0, Number(queue.ownerLastCompletedAt) || 0),
    previewPauseUntil: Number(state.pauseUntil) || 0,
    previewCursor: String(state.afterPath || ''),
    previewPasses: Number(state.passes) || 0,
    previewError: String(state.lastError || ''),
    previewErrorCount: Number(state.errorCount) || 0,
    previewQueueBackground: Number(queue.ownerQueued) || 0,
    previewQueueActive: Number(queue.ownerActive) || 0,
    previewQueueGlobalBackground: Number(queue.background) || 0,
    previewQueueGlobalActive: Number(queue.backgroundActive) || 0,
    previewQueueUrgent: Number(queue.urgent) || 0,
    previewQueueLimit: Number(queue.backgroundLimit) || 0
  };
}

function nextPreviewWarmer() {
  const paths = settings.browseFolders;
  if (!paths.length) return null;
  if (settings.thumbnailMode !== 'max') {
    for (const path of paths) {
      const state = previewWarmState(path);
      if (state && !state.done) return state;
    }
    return null;
  }

  let blocked = null;
  for (let offset = 0; offset < paths.length; offset++) {
    const index = (previewWarmCursor + offset) % paths.length;
    const state = previewWarmState(paths[index]);
    if (!state || state.done) continue;
    const queue = providerThumbnailQueueStatus(state.path);
    if (queue.ownerDriveBlocked) {
      blocked ||= { state, index };
      continue;
    }
    previewWarmCursor = (index + 1) % paths.length;
    return state;
  }

  // A just-finished drive lease can briefly block its next folder. Keep the
  // feeder alive; the provider lease expires on its own after the grace period.
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

function previewCheckConcurrency() {
  return settings.thumbnailMode === 'max' ? 64 : 12;
}

function queuePreviewRow(state, row) {
  const fullPath = join(state.path, ...String(row.path).replaceAll('\\', '/').split('/').filter(Boolean));
  return queueProviderThumbnail({
    hash: row.hash,
    path: row.path,
    filename: basename(row.path),
    mime: mimeFor(row.path),
    candidate: { path: fullPath, size: Number(row.size) || 0 }
  }, { background: true, owner: state.path });
}

async function checkPreviewCache(state) {
  state.passes++;
  state.backpressured = false;
  const capacity = providerThumbnailQueueStatus(state.path);
  if (capacity.ownerQueued + capacity.ownerActive >= previewOwnerQueueTarget() || capacity.background >= PREVIEW_QUEUE_TARGET) {
    state.backpressured = true;
    return;
  }

  const index = openSyncIndex(SYNC_INDEX_PATH);
  let rows;
  try { rows = index.pageAfter(state.rootKey, state.afterPath, PREVIEW_SCAN_BATCH); }
  finally { index.close(); }

  const candidates = [];
  for (const row of rows) {
    if (!isMediaPath(row.path) || state.seen.has(row.hash)) continue;
    candidates.push({ row, result: null });
  }
  await mapLimit(candidates, previewCheckConcurrency(), async item => {
    const thumb = await providerThumbnail(item.row.hash);
    const failure = thumb ? null : providerThumbnailFailure(item.row.hash);
    return { thumb, failure };
  });

  let stop = false;
  let queuedThisPass = 0;
  const candidateByPath = new Map(candidates.map(item => [item.row.path, item]));
  for (const row of rows) {
    if (stop) break;
    state.afterPath = row.path;
    if (!isMediaPath(row.path) || state.seen.has(row.hash)) continue;
    const item = candidateByPath.get(row.path);
    const thumb = item?.result?.thumb || null;
    const failure = item?.result?.failure || null;

    state.seen.add(row.hash);
    state.processed++;
    notePreviewProgress(state);
    if (thumb) {
      state.ready++;
      continue;
    }
    if (failure?.terminal) {
      state.failed++;
      continue;
    }
    if (failure?.retryAfterMs) {
      state.deferred++;
      continue;
    }

    const queue = providerThumbnailQueueStatus(state.path);
    const ownerTarget = previewOwnerQueueTarget();
    if (queue.ownerQueued + queue.ownerActive >= ownerTarget || queue.background >= PREVIEW_QUEUE_TARGET) {
      state.seen.delete(row.hash);
      state.processed--;
      state.lastProgressAt = Date.now();
      state.afterPath = rows[Math.max(0, rows.indexOf(row) - 1)]?.path || '';
      state.backpressured = true;
      stop = true;
      break;
    }

    if (queuePreviewRow(state, row)) {
      state.queued++;
      queuedThisPass++;
      if (settings.thumbnailMode === 'max' && queuedThisPass >= PREVIEW_MAX_BURST) return;
    }
  }

  // Keep scanning and refilling while workers consume the queue. Only switch to
  // the drain phase once the whole folder's cache has been examined.
  if (stop || rows.length >= PREVIEW_SCAN_BATCH) return;
  state.total = Math.max(state.total, state.processed);
  const queue = providerThumbnailQueueStatus(state.path);
  if (!queue.ownerQueued && !queue.ownerActive) {
    state.phase = 'done';
    state.done = true;
    return;
  }
  state.phase = 'generating';
}

async function warmSpecificMedia(state) {
  state.passes++;
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
    if (thumb || failure?.terminal || failure?.retryAfterMs) {
      item.done = true;
      state.processed++;
      notePreviewProgress(state);
      if (thumb) state.ready++;
      else if (failure?.terminal) state.failed++;
      else state.deferred++;
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

  if (state.processed >= state.total) {
    state.done = true;
    state.phase = 'done';
  }
}

function markPreviewWarmComplete(state) {
  if (state.persisted || !state.done) return;
  state.persisted = true;
  const index = openSyncIndex(SYNC_INDEX_PATH);
  try {
    const indexedAt = index.lastIndexed(state.rootKey);
    if (indexedAt && (!state.indexedAt || indexedAt === state.indexedAt)) index.markPreviewed(state.rootKey, indexedAt);
  } finally { index.close(); }
}

async function runPreviewWarm() {
  previewWarmTimer = null;
  if (!backgroundPreviewsEnabled()) return;
  const state = nextPreviewWarmer();
  if (!state) return;

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
    if (!existsSync(state.path)) {
      state.done = true;
      state.phase = 'done';
    } else if (state.kind === 'specific') {
      await warmSpecificMedia(state);
    } else if (state.phase === 'checking') {
      await checkPreviewCache(state);
    } else if (state.phase === 'generating') {
      const queue = providerThumbnailQueueStatus(state.path);
      if (!queue.ownerQueued && !queue.ownerActive) {
        state.done = true;
        state.phase = 'done';
        notePreviewProgress(state);
      }
    }
  } catch (error) {
    state.lastError = String(error?.message || error);
    state.errorCount++;
    state.pauseUntil = Date.now() + PREVIEW_ERROR_BACKOFF_MS;
    console.warn(`Mochimono thumbnail check paused for ${state.path}: ${state.lastError}`);
  }

  if (state.done) markPreviewWarmComplete(state);
  const wait = state.pauseUntil > Date.now() ? state.pauseUntil - Date.now()
    : state.backpressured ? 25
      : state.phase === 'generating' ? 120
        : state.kind === 'specific' ? 120
          : settings.thumbnailMode === 'max' ? 0 : 30;
  schedulePreviewWarm(wait);
}

async function* filesUnder(directory) {
  await waitForBrowseWork();
  checkCanceled();
  let dir;
  try { dir = await opendir(directory); } catch { return; }
  for await (const entry of dir) {
    await waitForBrowseWork();
    checkCanceled();
    if (entry.name === '.mochimono') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

function discoveryConcurrency() {
  return settings.thumbnailMode === 'max' ? 32 : 8;
}

async function statPaths(paths) {
  const items = paths.map(path => ({ path, result: null }));
  await mapLimit(items, discoveryConcurrency(), async item => {
    const file = await stat(item.path).catch(() => null);
    return file?.isFile() ? file : null;
  });
  return items.filter(item => item.result).map(item => ({ filePath: item.path, file: item.result }));
}

async function* discoveredFiles(root) {
  let batch = [];
  for await (const filePath of filesUnder(root)) {
    batch.push(filePath);
    if (batch.length < DISCOVERY_BATCH) continue;
    yield await statPaths(batch);
    batch = [];
    await yieldTurn();
  }
  if (batch.length) yield await statPaths(batch);
}

async function hashFile(path, onProgress) {
  const hash = createHash('sha256');
  let read = 0;
  let sinceYield = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    await waitForBrowseWork();
    checkCanceled();
    hash.update(chunk);
    read += chunk.length;
    sinceYield += chunk.length;
    if (sinceYield >= HASH_YIELD_BYTES) {
      sinceYield = 0;
      onProgress?.(read, false);
      await yieldHashTurn();
    }
  }
  onProgress?.(read, true);
  return hash.digest('hex');
}

function previewRecord(root, rel, file, hash) {
  return {
    hash,
    path: rel,
    filename: basename(rel),
    mime: mimeFor(rel),
    candidate: { path: join(root, ...rel.split('/').filter(Boolean)), size: Number(file.size) || 0 }
  };
}

async function existingServerHashes(hashes) {
  if (!settings.token || !hashes.length) return new Set();
  const existing = new Set();
  for (let offset = 0; offset < hashes.length; offset += 400) {
    const chunk = hashes.slice(offset, offset + 400);
    try {
      const result = await api('/api/objects/check', { method: 'POST', body: { hashes: chunk } });
      const missing = new Set((result.missing || []).map(String));
      const ignored = new Set((result.ignored || []).map(String));
      for (const hash of chunk) if (!missing.has(hash) && !ignored.has(hash)) existing.add(hash);
    } catch {
      break;
    }
  }
  return existing;
}

async function compactKnownBrowseHashes(root) {
  const index = openSyncIndex(SYNC_INDEX_PATH);
  let promoted = 0;
  try {
    const states = index.readyBrowseContentHashes();
    const rootHashes = [...new Set(states.filter(row => row.root === browseRootKey(root)).map(row => String(row.contentHash || '')).filter(Boolean))];
    if (!rootHashes.length) return 0;
    const promote = index.duplicateBrowseContentHashes(rootHashes);
    for (const hash of await existingServerHashes(rootHashes)) promote.add(hash);
    promoted = index.promoteBrowseContentHashes([...promote]);
  } finally { index.close(); }
  if (promoted) onChanged();
  return promoted;
}

async function hashBrowseContent(root, update = () => {}, { compact = true } = {}) {
  const key = browseRootKey(root);
  const index = openSyncIndex(SYNC_INDEX_PATH);
  let pending;
  try {
    const files = index.load(key);
    pending = [...index.browseHashState(key).values()]
      .filter(row => !row.contentHash)
      .map(row => ({ ...row, hash: files.get(row.path)?.hash || '' }))
      .filter(row => row.hash && Number(files.get(row.path)?.size) === Number(row.size) && Number(files.get(row.path)?.mtimeMs) === Number(row.mtimeMs));
  } finally { index.close(); }

  if (!pending.length) {
    update({ phase: 'Done', path: root, current: '', hashed: 0, total: 0, indeterminate: false });
    return { hashed: 0, pending: 0 };
  }

  let hashed = 0;
  let errors = 0;
  let writes = [];
  update({ phase: 'Hashing content', path: root, current: '', hashed: 0, total: pending.length, indeterminate: false });

  const flush = () => {
    if (!writes.length) return;
    const db = openSyncIndex(SYNC_INDEX_PATH);
    try { db.saveBrowseContentHashes(key, writes); }
    finally { db.close(); }
    writes = [];
  };

  for (const row of pending) {
    await waitForBrowseWork();
    checkCanceled();
    const filePath = join(root, ...String(row.path).replaceAll('\\', '/').split('/').filter(Boolean));
    try {
      const file = await stat(filePath).catch(() => null);
      if (!file?.isFile() || Number(file.size) !== Number(row.size) || Math.trunc(file.mtimeMs) !== Math.trunc(row.mtimeMs)) continue;
      let lastUpdate = 0;
      const contentHash = await hashFile(filePath, (read, force) => {
        const now = Date.now();
        if (!force && now - lastUpdate < 220) return;
        lastUpdate = now;
        const percent = file.size ? Math.min(100, Math.floor(read / file.size * 100)) : 100;
        update({ phase: 'Hashing content', path: root, current: `${row.path} · ${percent}%`, hashed, total: pending.length, indeterminate: false });
      });
      const latest = await stat(filePath).catch(() => null);
      if (!latest?.isFile() || Number(latest.size) !== Number(row.size) || Math.trunc(latest.mtimeMs) !== Math.trunc(row.mtimeMs)) continue;
      writes.push({ path: row.path, size: row.size, mtimeMs: row.mtimeMs, contentHash });
      rememberIdentity(latest, row.hash, contentHash, true);
      hashed++;
      if (writes.length >= HASH_SAVE_BATCH) flush();
      update({ phase: 'Hashing content', path: root, current: row.path, hashed, total: pending.length, indeterminate: false });
    } catch (error) {
      if (error.canceled) throw error;
      errors++;
    }
  }
  flush();
  if (compact) await compactKnownBrowseHashes(root);

  const db = openSyncIndex(SYNC_INDEX_PATH);
  let remaining = 0;
  try { remaining = db.browseHashStats(key).pending; }
  finally { db.close(); }
  update({ phase: 'Done', path: root, current: '', hashed, total: pending.length, errors, indeterminate: false });
  return { hashed, pending: remaining, errors };
}

async function previewWorkBlocksHash(root) {
  const drive = await browseDriveKey(root);
  for (const state of previewWarmers.values()) {
    if (state.done || !existsSync(state.path)) continue;
    if (await browseDriveKey(state.path) === drive) return true;
  }
  return false;
}

function scheduleBrowseHash(path, delay = 250) {
  const root = browseFolderFor(path);
  if (!root || settings.thumbnailMode === 'off') return;
  const key = pathKey(root);
  if (hashTimers.has(key)) return;
  const timer = setTimeout(async () => {
    hashTimers.delete(key);
    if (!browseFolderFor(root) || !existsSync(root) || settings.thumbnailMode === 'off') return;
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

  const index = openSyncIndex(SYNC_INDEX_PATH);
  const stage = openBrowseStage();
  const key = browseRootKey(root);
  const previousIndexedAt = index.lastIndexed(key);
  const previousWarmComplete = previewCompletionMatches(index, key, previousIndexedAt);
  const existingPreviewWarm = previewWarmState(root);
  const cached = index.load(key);
  const hashState = index.browseHashState(key);
  const seen = new Set();
  const pending = [];
  const stagePending = [];
  const changedPreviews = [];
  let scanned = 0;
  let reused = 0;
  let errors = 0;
  let previewQueued = 0;
  let changedMedia = 0;
  let completed = false;
  let indexedAt = '';
  let removed = 0;
  const phase = previousIndexedAt ? 'Checking changes' : 'Indexing';

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
      candidate: { path: filePath, size: file.size }
    }, { background: browseWorkIsBackground(), owner: root });
    return true;
  }

  stage.clear(key);
  update({ phase, path: root, current: '', scanned: 0, hashed: 0, reused: 0, indeterminate: true });
  try {
    for await (const batch of discoveredFiles(root)) {
      for (const { filePath, file } of batch) {
        await waitForBrowseWork();
        checkCanceled();
        const rel = relative(root, filePath).replaceAll('\\', '/');
        seen.add(rel);
        try {
          const mtimeMs = Math.trunc(file.mtimeMs);
          const previous = cached.get(rel);
          const previousState = hashState.get(rel);
          const stateMatches = previousState && Number(previousState.size) === Number(file.size) && Number(previousState.mtimeMs) === mtimeMs;
          let hash = '';
          let contentHash = '';
          let stagedEarly = false;

          if (previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === mtimeMs && (!previousState || stateMatches)) {
            hash = previous.hash;
            contentHash = stateMatches ? String(previousState.contentHash || '') : String(previous.hash);
            reused++;
            rememberIdentity(file, hash, contentHash, Boolean(stateMatches));
            queuePreview(filePath, file, hash);
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
            stagePending.push(row);
            rememberIdentity(file, hash, contentHash, true);
            if (isMediaPath(rel) && previous?.hash !== hash) {
              changedMedia++;
              if (previousWarmComplete) changedPreviews.push(previewRecord(root, rel, file, hash));
            }

            const preview = queuePreview(filePath, file, hash);
            stagedEarly = pending.length <= EARLY_PREVIEWS || preview;
            if (stagedEarly || stagePending.length >= STAGE_EVERY_FILES) {
              stage.saveMany(key, stagePending.splice(0));
              await yieldTurn();
            }
          }

          scanned++;
          if (scanned % 100 === 0) update({ phase, path: root, current: rel, scanned, hashed: 0, reused, indeterminate: true });
        } catch (error) {
          if (error.canceled) throw error;
          errors++;
        }
      }
      await yieldTurn();
    }

    await waitForBrowseWork();
    if (stagePending.length) stage.saveMany(key, stagePending.splice(0));
    index.saveBrowseMany(key, pending);
    removed = index.prune(key, seen);
    indexedAt = new Date().toISOString();
    index.markIndexed(key, indexedAt);
    stage.clear(key);
    completed = true;
  } finally {
    if (!completed) {
      try { stage.clear(key); } catch {}
    }
    stage.close();
    index.close();
  }

  {
    const completion = openSyncIndex(SYNC_INDEX_PATH);
    try {
      if (previousWarmComplete && !changedMedia) completion.markPreviewed(key, indexedAt);
      else if (changedMedia || !previousIndexedAt) completion.clearPreviewed(key);
    } finally { completion.close(); }
  }

  if (backgroundPreviewsEnabled()) {
    if (!previousIndexedAt) resetPreviewWarm(root, indexedAt);
    else if (!previousWarmComplete) {
      if (existingPreviewWarm && !existingPreviewWarm.done && !changedMedia) {
        existingPreviewWarm.indexedAt = indexedAt;
        existingPreviewWarm.persisted = false;
        schedulePreviewWarm(0);
      } else resetPreviewWarm(root, indexedAt);
    } else if (changedPreviews.length) resetSpecificPreviewWarm(root, changedPreviews, indexedAt);
  }

  if (options.scheduleHash !== false) scheduleBrowseHash(root, 150);
  const changed = pending.length + removed;
  update({ phase: 'Done', path: root, current: '', scanned, hashed: 0, reused, removed, errors, indeterminate: false });
  return { path: root, files: scanned, changed, removed, hashed: 0, reused, errors };
}

async function indexed(root, update) {
  const result = await indexBrowseFolder(root, update);
  if (result.changed) onChanged();
  return result;
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
    if (!isForeground && !backgroundWorkAllowed()) return queue(root, settings.thumbnailMode === 'off' ? 5000 : 1000);

    if (settings.thumbnailMode === 'max') {
      const started = await startParallelBrowseJob(
        root,
        `Check ${basename(root) || root}`,
        update => indexed(root, update),
        { background: !isForeground, type: 'sync' }
      );
      if (!started) return queue(root, 350, isForeground);
      foregroundChecks.delete(key);
      return;
    }

    if (parallelBrowseJobs.size || currentJob()?.status === 'running') return queue(root, 1500, isForeground);
    foregroundChecks.delete(key);
    beginJob('sync', `Check ${basename(root) || root}`, update => indexed(root, update), { background: !isForeground });
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
    const mtimeMs = Math.trunc(file.mtimeMs);
    const previousState = index.browseHashEntry(key, rel);
    const stateMatches = previousState && Number(previousState.size) === Number(file.size) && Number(previousState.mtimeMs) === mtimeMs;
    if (previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === mtimeMs && (!previousState || stateMatches)) {
      rememberIdentity(file, previous.hash, stateMatches ? previousState.contentHash : previous.hash, Boolean(stateMatches));
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

    for await (const filePath of filesUnder(target.path)) {
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
      if (covered(target.rel)) continue;

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
    if (wasPreviewComplete && !changedPreviews.length) index.markPreviewed(key, nextIndexedAt);
    else if (changedPreviews.length) index.clearPreviewed(key);

    const activeWarm = previewWarmState(root);
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
    if (!backgroundWorkAllowed()) return flushChanges(root, settings.thumbnailMode === 'off' ? 5000 : 1000);
    const names = [...pending];
    pendingChanges.delete(key);

    let started;
    if (settings.thumbnailMode === 'max') {
      started = await startParallelBrowseJob(
        root,
        `Update ${basename(root) || root}`,
        update => incrementalIndexed(root, names, update),
        { background: true, type: 'sync' }
      );
    } else if (!parallelBrowseJobs.size && currentJob()?.status !== 'running') {
      started = beginJob('sync', `Update ${basename(root) || root}`, update => incrementalIndexed(root, names, update), { background: true });
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

export async function addBrowseFolder(path) {
  const root = resolve(String(path));
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error('Folder not found'), { status: 400 });
  if (protectedFolderFor(root)) return root;

  if (!browseFolderFor(root)) {
    settings.browseFolders.push(root);
    await persistSettings();
  }
  watchFolder(root);
  queue(root, 0, true);
  return root;
}

async function detachBrowseFolder(path, forgetIndex) {
  const key = pathKey(path);
  const index = settings.browseFolders.findIndex(item => pathKey(item) === key);
  if (index < 0) throw Object.assign(new Error('Folder not found'), { status: 404 });
  const [root] = settings.browseFolders.splice(index, 1);
  unwatchFolder(root);
  if (forgetIndex) {
    const db = openSyncIndex(SYNC_INDEX_PATH);
    try { db.forgetRoot(browseRootKey(root)); } finally { db.close(); }
  }
  await persistSettings();
  return root;
}

export async function removeBrowseFolder(path) {
  await detachBrowseFolder(path, true);
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

  // Protection is content-addressed. Local browsing can use cheap stable IDs,
  // but every row must have a real SHA-256 before it enters protected storage.
  await finalizeBrowseHashes(root);

  const db = openSyncIndex(SYNC_INDEX_PATH);
  try { db.moveRoot(browseRootKey(root), pathKey(root)); }
  finally { db.close(); }

  await detachBrowseFolder(root, false);
  try {
    const folder = await addProtectedFolder(root);
    onChanged();
    return folder;
  } catch (error) {
    const rollback = openSyncIndex(SYNC_INDEX_PATH);
    try { rollback.moveRoot(pathKey(root), browseRootKey(root)); }
    finally { rollback.close(); }
    settings.browseFolders.push(root);
    await persistSettings();
    watchFolder(root);
    onChanged();
    throw error;
  }
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
      const staging = indexed.files ? { files: 0, bytes: 0 } : browseStageStats(key);
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
      const automatic = (queued && !foregroundChecks.has(localKey)) || (indexRunning && runningJob.background);
      const hashWaiting = hashStats.pending > 0 && settings.thumbnailMode === 'idle' && !backgroundWorkAllowed() && !hashing;
      return {
        path,
        ...(staging.files ? staging : indexed),
        ...filesystem,
        ...previewWarmStatus(path),
        lastIndexed: indexedAt,
        pending: queued || indexRunning,
        hashPending: hashStats.pending,
        hashReady: hashStats.ready,
        hashTracked: hashStats.tracked,
        hashing,
        hashWaiting,
        waitingForIdle: Boolean(automatic && !backgroundWorkAllowed()),
        available: existsSync(path),
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

  const db = openSyncIndex(SYNC_INDEX_PATH);
  try { for (const path of removed) db.forgetRoot(browseRootKey(path)); }
  finally { db.close(); }
  persistSettings().catch(() => {});
}

export function startBrowseService(changeHandler = () => {}) {
  onChanged = typeof changeHandler === 'function' ? changeHandler : () => {};
  dedupeConfiguredRoots();
  for (const path of settings.browseFolders) {
    watchFolder(path);
    if (existsSync(path)) queue(path, 0);
  }
}

export function stopBrowseService() {
  if (previewWarmTimer) clearTimeout(previewWarmTimer);
  previewWarmTimer = null;
  previewWarmers.clear();
  identities.clear();
  for (const timer of hashTimers.values()) clearTimeout(timer);
  hashTimers.clear();
  onChanged = () => {};
  for (const path of settings.browseFolders) unwatchFolder(path);
}
