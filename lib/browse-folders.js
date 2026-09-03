import { createHash } from 'node:crypto';
import { createReadStream, existsSync, watch } from 'node:fs';
import { opendir, stat, statfs } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { beginJob, canceled, currentJob, pathKey, persistSettings, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { browseStageStats, openBrowseStage } from './browse-staging.js';
import { openSyncIndex } from './sync-index.js';
import { mimeFor } from './mime.js';
import { providerThumbnail, providerThumbnailFailure, providerThumbnailQueueStatus, queueProviderThumbnail } from './provider-thumbs.js';

const RECONCILE_MS = 60 * 60 * 1000;
const YIELD_EVERY_FILES = 200;
const HASH_YIELD_BYTES = 8 * 1024 * 1024;
const STAGE_EVERY_FILES = 24;
const EARLY_PREVIEWS = 3;
const PREVIEW_COUNT_BATCH = 1000;
const PREVIEW_WARM_BATCH = 96;
const PREVIEW_QUEUE_TARGET = 128;
const CHANGE_DELAY_MS = 260;
const MAX_INCREMENTAL_CHANGES = 2048;
const IDENTITY_TTL_MS = 10 * 60 * 1000;
const IDENTITY_CACHE_MAX = 200_000;
const watchers = new Map();
const timers = new Map();
const changeTimers = new Map();
const pendingChanges = new Map();
const previewWarmers = new Map();
const identities = new Map();
let reconcileTimer = null;
let previewWarmTimer = null;
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

function identityKey(file) {
  const ino = Number(file?.ino) || 0;
  const dev = Number(file?.dev) || 0;
  const birthtimeMs = Math.trunc(Number(file?.birthtimeMs) || 0);
  return ino ? `${dev}:${ino}:${birthtimeMs}` : '';
}

function rememberIdentity(file, hash) {
  const key = identityKey(file);
  if (!key || !hash) return;
  identities.delete(key);
  identities.set(key, {
    hash: String(hash),
    size: Number(file.size) || 0,
    mtimeMs: Math.trunc(Number(file.mtimeMs) || 0),
    seenAt: Date.now()
  });
  while (identities.size > IDENTITY_CACHE_MAX) identities.delete(identities.keys().next().value);
}

function hashForIdentity(file) {
  const key = identityKey(file);
  if (!key) return '';
  const entry = identities.get(key);
  if (!entry) return '';
  if (Date.now() - entry.seenAt > IDENTITY_TTL_MS) {
    identities.delete(key);
    return '';
  }
  if (entry.size !== Number(file.size) || entry.mtimeMs !== Math.trunc(Number(file.mtimeMs) || 0)) return '';
  entry.seenAt = Date.now();
  return entry.hash;
}

function previewCompletionMatches(index, rootKey, indexedAt) {
  return Boolean(indexedAt && index.lastPreviewed(rootKey) === indexedAt);
}

function schedulePreviewWarm(delay = 250) {
  if (!backgroundPreviewsEnabled() || previewWarmTimer || ![...previewWarmers.values()].some(state => !state.done)) return;
  previewWarmTimer = setTimeout(runPreviewWarm, Math.max(0, delay));
  previewWarmTimer.unref?.();
}

function fullPreviewState(root, indexedAt = '') {
  const path = resolve(root);
  return {
    kind: 'full',
    path,
    rootKey: browseRootKey(path),
    indexedAt: String(indexedAt || ''),
    phase: 'counting',
    afterPath: '',
    scanned: 0,
    total: 0,
    processed: 0,
    ready: 0,
    failed: 0,
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
  schedulePreviewWarm(350);
  return state;
}

function resetSpecificPreviewWarm(root, records, indexedAt = '') {
  if (!backgroundPreviewsEnabled()) return null;
  const path = resolve(root);
  const unique = new Map();
  for (const record of records || []) if (record?.hash && isMediaPath(record.path || record.filename || '')) unique.set(record.hash, record);
  if (!unique.size) return null;
  const state = {
    kind: 'specific',
    path,
    rootKey: browseRootKey(path),
    indexedAt: String(indexedAt || ''),
    phase: 'warming',
    items: [...unique.values()].map(record => ({ ...record, done: false })),
    cursor: 0,
    total: unique.size,
    processed: 0,
    ready: 0,
    failed: 0,
    pauseUntil: 0,
    done: false,
    persisted: false
  };
  previewWarmers.set(pathKey(path), state);
  schedulePreviewWarm(120);
  return state;
}

function previewWarmState(path) {
  return previewWarmers.get(pathKey(path)) || null;
}

function previewWarmStatus(path) {
  const state = previewWarmState(path);
  if (!state) return {};
  return {
    previewPhase: state.phase,
    previewTotal: Number(state.total) || 0,
    previewProcessed: Number(state.processed) || 0,
    previewReady: Number(state.ready) || 0,
    previewFailed: Number(state.failed) || 0,
    previewWarming: !state.done
  };
}

function nextPreviewWarmer() {
  for (const path of settings.browseFolders) {
    const state = previewWarmState(path);
    if (state && !state.done) return state;
  }
  return null;
}

function beginPreviewPhase(state, phase) {
  state.phase = phase;
  state.afterPath = '';
  state.scanned = 0;
  state.processed = 0;
  state.ready = 0;
  state.failed = 0;
  state.pauseUntil = 0;
  state.seen.clear();
}

async function countPreviewMedia(state) {
  const index = openSyncIndex(SYNC_INDEX_PATH);
  let rows;
  try { rows = index.pageAfter(state.rootKey, state.afterPath, PREVIEW_COUNT_BATCH); }
  finally { index.close(); }

  for (const row of rows) {
    state.afterPath = row.path;
    state.scanned++;
    if (!isMediaPath(row.path) || state.seen.has(row.hash)) continue;
    state.seen.add(row.hash);
    state.total++;
  }

  if (rows.length < PREVIEW_COUNT_BATCH) beginPreviewPhase(state, state.total ? 'warming' : 'done');
  if (state.phase === 'done') state.done = true;
}

async function warmPreviewMedia(state) {
  const target = settings.thumbnailMode === 'max' ? Math.min(480, PREVIEW_QUEUE_TARGET * 4) : PREVIEW_QUEUE_TARGET;
  if (providerThumbnailQueueStatus().background >= target) return;

  const index = openSyncIndex(SYNC_INDEX_PATH);
  let rows;
  try { rows = index.pageAfter(state.rootKey, state.afterPath, PREVIEW_WARM_BATCH); }
  finally { index.close(); }

  let reachedQueueLimit = false;
  for (const row of rows) {
    if (!isMediaPath(row.path) || state.seen.has(row.hash)) {
      state.afterPath = row.path;
      continue;
    }

    const thumb = await providerThumbnail(row.hash);
    const failure = thumb ? null : providerThumbnailFailure(row.hash);
    if (thumb || failure?.terminal) {
      state.seen.add(row.hash);
      state.afterPath = row.path;
      state.processed++;
      if (thumb) state.ready++;
      else state.failed++;
      continue;
    }
    if (failure?.retryAfterMs) {
      state.pauseUntil = Date.now() + Math.max(250, Number(failure.retryAfterMs) || 0);
      reachedQueueLimit = true;
      break;
    }
    if (providerThumbnailQueueStatus().background >= target) {
      reachedQueueLimit = true;
      break;
    }

    const fullPath = join(state.path, ...String(row.path).replaceAll('\\', '/').split('/').filter(Boolean));
    const queued = queueProviderThumbnail({
      hash: row.hash,
      path: row.path,
      filename: basename(row.path),
      mime: mimeFor(row.path),
      candidate: { path: fullPath, size: Number(row.size) || 0 }
    }, { background: true });
    if (!queued) {
      state.pauseUntil = Date.now() + 250;
      reachedQueueLimit = true;
      break;
    }

    state.seen.add(row.hash);
    state.afterPath = row.path;
    state.processed++;
  }

  if (!reachedQueueLimit && rows.length < PREVIEW_WARM_BATCH) state.phase = 'finishing';
}

async function checkPreviewMedia(state) {
  const index = openSyncIndex(SYNC_INDEX_PATH);
  let rows;
  try { rows = index.pageAfter(state.rootKey, state.afterPath, PREVIEW_WARM_BATCH); }
  finally { index.close(); }

  for (const row of rows) {
    state.afterPath = row.path;
    if (!isMediaPath(row.path) || state.seen.has(row.hash)) continue;
    state.seen.add(row.hash);
    state.processed++;
    const thumb = await providerThumbnail(row.hash);
    if (thumb) state.ready++;
    else if (providerThumbnailFailure(row.hash)?.terminal) state.failed++;
  }

  if (rows.length >= PREVIEW_WARM_BATCH) return;
  if (state.ready + state.failed >= state.total) {
    state.phase = 'done';
    state.done = true;
    return;
  }
  beginPreviewPhase(state, 'warming');
}

async function warmSpecificMedia(state) {
  if (!state.items.length) {
    state.done = true;
    state.phase = 'done';
    return;
  }

  let checked = 0;
  let visited = 0;
  while (checked < 64 && visited < state.items.length) {
    const index = state.cursor % state.items.length;
    state.cursor = (index + 1) % state.items.length;
    visited++;
    const item = state.items[index];
    if (item.done) continue;
    checked++;

    const thumb = await providerThumbnail(item.hash);
    const failure = thumb ? null : providerThumbnailFailure(item.hash);
    if (thumb || failure?.terminal) {
      item.done = true;
      state.processed++;
      if (thumb) state.ready++;
      else state.failed++;
      continue;
    }
    if (failure?.retryAfterMs) {
      state.pauseUntil = Math.max(state.pauseUntil, Date.now() + Math.max(250, Number(failure.retryAfterMs) || 0));
      continue;
    }

    queueProviderThumbnail({
      hash: item.hash,
      path: item.path,
      filename: item.filename || basename(item.path || ''),
      mime: item.mime || mimeFor(item.path || item.filename || ''),
      candidate: item.candidate
    }, { background: true });
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
  if (!backgroundPreviewsEnabled()) {
    previewWarmers.clear();
    return;
  }
  const state = nextPreviewWarmer();
  if (!state) return;

  const now = Date.now();
  if (state.pauseUntil > now) {
    schedulePreviewWarm(state.pauseUntil - now);
    return;
  }
  state.pauseUntil = 0;

  if (currentJob()?.status === 'running') {
    schedulePreviewWarm(1000);
    return;
  }

  try {
    if (!existsSync(state.path)) {
      state.done = true;
      state.phase = 'done';
    } else if (state.kind === 'specific') {
      await warmSpecificMedia(state);
    } else if (state.phase === 'counting') {
      await countPreviewMedia(state);
    } else if (state.phase === 'warming') {
      await warmPreviewMedia(state);
    } else if (state.phase === 'finishing') {
      const queue = providerThumbnailQueueStatus();
      if (!queue.background && !queue.backgroundActive) beginPreviewPhase(state, 'checking');
    } else if (state.phase === 'checking') {
      await checkPreviewMedia(state);
    }
  } catch (error) {
    console.warn(`Mochimono preview warming paused for ${state.path}: ${error?.message || error}`);
  }

  if (state.done) markPreviewWarmComplete(state);
  const wait = state.pauseUntil > Date.now() ? state.pauseUntil - Date.now() : state.phase === 'finishing' ? 450 : state.kind === 'specific' ? 220 : 40;
  schedulePreviewWarm(wait);
}

async function* filesUnder(directory) {
  canceled();
  let dir;
  try { dir = await opendir(directory); } catch { return; }
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
  let sinceYield = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    canceled();
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

export async function indexBrowseFolder(path, update = () => {}) {
  const root = resolve(path);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${root} is not a directory`);

  const index = openSyncIndex(SYNC_INDEX_PATH);
  const stage = openBrowseStage();
  const key = browseRootKey(root);
  const previousIndexedAt = index.lastIndexed(key);
  const previousWarmComplete = previewCompletionMatches(index, key, previousIndexedAt);
  const cached = index.load(key);
  const seen = new Set();
  const pending = [];
  const stagePending = [];
  const changedPreviews = [];
  let scanned = 0;
  let hashed = 0;
  let hashedMedia = 0;
  let reused = 0;
  let errors = 0;
  let previewQueued = 0;
  let completed = false;
  let indexedAt = '';

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
    });
    return true;
  }

  stage.clear(key);
  update({ phase: 'Indexing', path: root, current: '', scanned: 0, hashed: 0, reused: 0, indeterminate: true });
  try {
    for await (const filePath of filesUnder(root)) {
      canceled();
      const rel = relative(root, filePath).replaceAll('\\', '/');
      seen.add(rel);
      try {
        const file = await stat(filePath);
        const mtimeMs = Math.trunc(file.mtimeMs);
        const previous = cached.get(rel);
        let hash = '';
        let stagedEarly = false;

        if (previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === mtimeMs) {
          hash = previous.hash;
          reused++;
          rememberIdentity(file, hash);
          queuePreview(filePath, file, hash);
        } else {
          const movedHash = previous ? '' : hashForIdentity(file);
          if (movedHash) {
            hash = movedHash;
            reused++;
            const row = { path: rel, size: file.size, mtimeMs, hash };
            pending.push(row);
            stagePending.push(row);
            rememberIdentity(file, hash);
          } else {
            update({ phase: 'Indexing', path: root, current: rel, scanned, hashed, reused, indeterminate: true });
            let lastHashUpdate = 0;
            hash = await hashFile(filePath, (read, force) => {
              const time = Date.now();
              if (!force && time - lastHashUpdate < 180) return;
              lastHashUpdate = time;
              const percent = file.size ? Math.min(100, Math.floor(read / file.size * 100)) : 100;
              update({ phase: 'Indexing', path: root, current: `${rel} · ${percent}%`, scanned, hashed, reused, indeterminate: true });
            });
            const latest = await stat(filePath);
            if (latest.size !== file.size || Math.trunc(latest.mtimeMs) !== mtimeMs) continue;
            rememberIdentity(latest, hash);
            const row = { path: rel, size: file.size, mtimeMs, hash };
            pending.push(row);
            stagePending.push(row);
            hashed++;
            if (isMediaPath(rel) && previous?.hash !== hash) {
              hashedMedia++;
              if (previousWarmComplete) changedPreviews.push(previewRecord(root, rel, file, hash));
            }
          }

          const preview = queuePreview(filePath, file, hash);
          stagedEarly = pending.length <= EARLY_PREVIEWS || preview;
          if (stagedEarly || stagePending.length >= STAGE_EVERY_FILES) {
            stage.saveMany(key, stagePending.splice(0));
            await yieldTurn();
          }
        }

        scanned++;
        if (scanned % 50 === 0) update({ phase: 'Indexing', path: root, current: rel, scanned, hashed, reused, indeterminate: true });
        if (scanned % YIELD_EVERY_FILES === 0) await yieldTurn();
      } catch (error) {
        if (error.canceled) throw error;
        errors++;
      }
    }

    if (stagePending.length) stage.saveMany(key, stagePending.splice(0));
    index.saveMany(key, pending);
    index.prune(key, seen);
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
      if (previousWarmComplete && !hashedMedia) completion.markPreviewed(key, indexedAt);
      else if (hashedMedia || !previousIndexedAt) completion.clearPreviewed(key);
    } finally { completion.close(); }
  }

  if (backgroundPreviewsEnabled()) {
    if (!previousIndexedAt || !previousWarmComplete) resetPreviewWarm(root, indexedAt);
    else if (changedPreviews.length) resetSpecificPreviewWarm(root, changedPreviews, indexedAt);
  }

  update({ phase: 'Done', path: root, current: '', scanned, hashed, reused, errors, indeterminate: false });
  return { path: root, files: scanned, hashed, reused, errors };
}

async function indexed(root, update) {
  const result = await indexBrowseFolder(root, update);
  onChanged();
  return result;
}

function clearPendingChanges(root) {
  const key = pathKey(root);
  clearTimeout(changeTimers.get(key));
  changeTimers.delete(key);
  pendingChanges.delete(key);
}

function queue(path, delay = 800) {
  const root = browseFolderFor(path);
  if (!root) return;
  const key = pathKey(root);
  clearPendingChanges(root);
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => {
    timers.delete(key);
    if (currentJob()?.status === 'running') return queue(root, 1500);
    beginJob('sync', `Sync ${basename(root) || root}`, update => indexed(root, update));
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

async function updateBrowseChanges(root, names, update = () => {}) {
  const key = browseRootKey(root);
  const index = openSyncIndex(SYNC_INDEX_PATH);
  const indexedAt = index.lastIndexed(key);
  const wasPreviewComplete = previewCompletionMatches(index, key, indexedAt);
  const changedPreviews = [];
  let changed = 0;
  let removed = 0;
  let hashed = 0;
  let reused = 0;
  let needsFull = false;

  update({ phase: 'Updating', path: root, current: '', scanned: 0, hashed: 0, reused: 0, indeterminate: true });
  try {
    let scanned = 0;
    for (const name of names) {
      canceled();
      const target = watchedTarget(root, name);
      if (!target) {
        needsFull = true;
        break;
      }

      const file = await stat(target.path).catch(() => null);
      const previous = index.get(key, target.rel);
      if (!file) {
        if (index.hasPrefix(key, `${target.rel}/`)) {
          needsFull = true;
          break;
        }
        const count = index.forget(key, target.rel);
        removed += count;
        changed += count;
        scanned++;
        continue;
      }
      if (file.isDirectory()) {
        needsFull = true;
        break;
      }
      if (!file.isFile()) continue;

      const mtimeMs = Math.trunc(file.mtimeMs);
      if (previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === mtimeMs) {
        rememberIdentity(file, previous.hash);
        scanned++;
        continue;
      }

      let hash = hashForIdentity(file);
      const reusedIdentity = Boolean(hash);
      if (reusedIdentity) reused++;
      else {
        hash = await hashFile(target.path);
        const latest = await stat(target.path).catch(() => null);
        if (!latest?.isFile() || latest.size !== file.size || Math.trunc(latest.mtimeMs) !== mtimeMs) continue;
        hashed++;
      }
      rememberIdentity(file, hash);
      index.save(key, target.rel, file.size, mtimeMs, hash);
      changed++;

      if (isMediaPath(target.rel) && !reusedIdentity && previous?.hash !== hash) {
        changedPreviews.push(previewRecord(root, target.rel, file, hash));
      }

      scanned++;
      if (scanned % 50 === 0) update({ phase: 'Updating', path: root, current: target.rel, scanned, hashed, reused, indeterminate: true });
      if (scanned % YIELD_EVERY_FILES === 0) await yieldTurn();
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
  }
  index.close();

  if (changedPreviews.length && backgroundPreviewsEnabled()) {
    if (wasPreviewComplete) resetSpecificPreviewWarm(root, changedPreviews, nextIndexedAt);
    else resetPreviewWarm(root, nextIndexedAt);
  }

  update({ phase: 'Done', path: root, current: '', scanned: names.length, hashed, reused, removed, indeterminate: false });
  return { path: root, files: names.length, changed, removed, hashed, reused, errors: 0 };
}

async function incrementalIndexed(root, names, update) {
  const result = await updateBrowseChanges(root, names, update);
  if (result.changed || result.hashed || result.removed) onChanged();
  return result;
}

function flushChanges(root, delay = CHANGE_DELAY_MS) {
  const key = pathKey(root);
  clearTimeout(changeTimers.get(key));
  const timer = setTimeout(() => {
    changeTimers.delete(key);
    const pending = pendingChanges.get(key);
    if (!pending?.size) return;
    if (timers.has(key)) return pendingChanges.delete(key);
    if (currentJob()?.status === 'running') return flushChanges(root, 900);
    const names = [...pending];
    pendingChanges.delete(key);
    const started = beginJob('sync', `Sync ${basename(root) || root}`, update => incrementalIndexed(root, names, update));
    if (!started) {
      const next = pendingChanges.get(key) || new Set();
      names.forEach(name => next.add(name));
      pendingChanges.set(key, next);
      flushChanges(root, 900);
    }
  }, delay);
  timer.unref?.();
  changeTimers.set(key, timer);
}

function queueChange(path, filename) {
  const root = browseFolderFor(path);
  if (!root || timers.has(pathKey(root))) return;
  const target = watchedTarget(root, filename);
  if (!target) return queue(root, 900);
  const key = pathKey(root);
  const pending = pendingChanges.get(key) || new Set();
  pending.add(target.rel);
  pendingChanges.set(key, pending);
  if (pending.size > MAX_INCREMENTAL_CHANGES) return queue(root, 500);
  flushChanges(root);
}

function watchFolder(path) {
  const root = resolve(path);
  const key = pathKey(root);
  if (watchers.has(key) || !existsSync(root)) return;
  try {
    const watcher = watch(root, { recursive: true }, (_event, filename) => queueChange(root, filename));
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
  clearTimeout(timers.get(key));
  timers.delete(key);
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
  queue(root, 0);
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

export async function protectBrowseFolder(path, addProtectedFolder) {
  const root = browseFolderFor(path);
  if (!root) throw Object.assign(new Error('Folder not found'), { status: 404 });

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
  try {
    return await Promise.all(settings.browseFolders.map(async path => {
      const filesystem = await statfs(path).then(fs => ({
        capacityBytes: Number(fs.blocks) * Number(fs.bsize),
        freeBytes: Number(fs.bavail) * Number(fs.bsize)
      })).catch(() => ({ capacityBytes: 0, freeBytes: 0 }));
      const key = browseRootKey(path);
      const indexed = db.stats(key);
      const staging = indexed.files ? { files: 0, bytes: 0 } : browseStageStats(key);
      const indexedAt = db.lastIndexed(key);
      if (backgroundPreviewsEnabled() && !previewWarmState(path) && indexed.files && !previewCompletionMatches(db, key, indexedAt)) resetPreviewWarm(path, indexedAt);
      return {
        path,
        ...(staging.files ? staging : indexed),
        ...filesystem,
        ...previewWarmStatus(path),
        lastIndexed: indexedAt,
        available: existsSync(path),
        protected: false
      };
    }));
  } finally { db.close(); }
}

export function refreshBrowsePreviewPolicy(previousMode = '') {
  if (previewWarmTimer) clearTimeout(previewWarmTimer);
  previewWarmTimer = null;
  if (!backgroundPreviewsEnabled()) {
    previewWarmers.clear();
    return;
  }
  if (previousMode === 'off') {
    const db = openSyncIndex(SYNC_INDEX_PATH);
    try {
      for (const path of settings.browseFolders) {
        const key = browseRootKey(path);
        const indexed = db.stats(key);
        const indexedAt = db.lastIndexed(key);
        if (indexed.files && !previewCompletionMatches(db, key, indexedAt)) resetPreviewWarm(path, indexedAt);
      }
    } finally { db.close(); }
  } else schedulePreviewWarm(0);
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
  if (!reconcileTimer) {
    reconcileTimer = setInterval(() => settings.browseFolders.forEach(path => { if (existsSync(path)) queue(path, 0); }), RECONCILE_MS);
    reconcileTimer.unref?.();
  }
}

export function stopBrowseService() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (previewWarmTimer) clearTimeout(previewWarmTimer);
  reconcileTimer = null;
  previewWarmTimer = null;
  previewWarmers.clear();
  identities.clear();
  onChanged = () => {};
  for (const path of settings.browseFolders) unwatchFolder(path);
}
