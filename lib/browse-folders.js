import { createHash } from 'node:crypto';
import { createReadStream, existsSync, watch } from 'node:fs';
import { opendir, stat, statfs } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { beginJob, canceled, currentJob, pathKey, persistSettings, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { browseStageStats, openBrowseStage } from './browse-staging.js';
import { openSyncIndex } from './sync-index.js';
import { mimeFor } from './mime.js';
import { queueProviderThumbnail } from './provider-thumbs.js';

const RECONCILE_MS = 60 * 60 * 1000;
const YIELD_EVERY_FILES = 200;
const HASH_YIELD_BYTES = 8 * 1024 * 1024;
const STAGE_EVERY_FILES = 24;
const EARLY_PREVIEWS = 3;
const watchers = new Map();
const timers = new Map();
let reconcileTimer = null;
let onChanged = () => {};

export const browseRootKey = path => `browse:${pathKey(path)}`;
export const browseFolderFor = path => settings.browseFolders.find(item => pathKey(item) === pathKey(path));
const protectedFolderFor = path => settings.folders.find(folder => pathKey(folder.path) === pathKey(path));
const yieldTurn = () => new Promise(resolvePromise => setImmediate(resolvePromise));
const yieldHashTurn = () => new Promise(resolvePromise => setTimeout(resolvePromise, 1));

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

export async function indexBrowseFolder(path, update = () => {}) {
  const root = resolve(path);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${root} is not a directory`);

  const index = openSyncIndex(SYNC_INDEX_PATH);
  const stage = openBrowseStage();
  const key = browseRootKey(root);
  const cached = index.load(key);
  const seen = new Set();
  const pending = [];
  const stagePending = [];
  let scanned = 0;
  let hashed = 0;
  let reused = 0;
  let errors = 0;
  let previewQueued = 0;
  let completed = false;

  function queueEarlyPreview(filePath, file, hash) {
    if (previewQueued >= EARLY_PREVIEWS) return false;
    const mime = mimeFor(filePath);
    if (!mime.startsWith('image/') && !mime.startsWith('video/')) return false;
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
          queueEarlyPreview(filePath, file, hash);
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
          const row = { path: rel, size: file.size, mtimeMs, hash };
          pending.push(row);
          stagePending.push(row);
          hashed++;
          const preview = queueEarlyPreview(filePath, file, hash);
          stagedEarly = hashed <= EARLY_PREVIEWS || preview;
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
    // Publish the canonical provider index once. The staging DB is deliberately
    // separate so progressive UI updates cannot invalidate/rebuild the full
    // merged provider catalog while this scan is still running.
    index.saveMany(key, pending);
    index.prune(key, seen);
    index.markIndexed(key);
    stage.clear(key);
    completed = true;
  } finally {
    if (!completed) {
      try { stage.clear(key); } catch {}
    }
    stage.close();
    index.close();
  }

  update({ phase: 'Done', path: root, current: '', scanned, hashed, reused, errors, indeterminate: false });
  return { path: root, files: scanned, hashed, reused, errors };
}

async function indexed(root, update) {
  const result = await indexBrowseFolder(root, update);
  onChanged();
  return result;
}

function queue(path, delay = 800) {
  const root = browseFolderFor(path);
  if (!root) return;
  const key = pathKey(root);
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => {
    timers.delete(key);
    if (currentJob()?.status === 'running') return queue(root, 1500);
    beginJob('sync', `Sync ${basename(root) || root}`, update => indexed(root, update));
  }, delay);
  timer.unref?.();
  timers.set(key, timer);
}

function watchFolder(path) {
  const root = resolve(path);
  const key = pathKey(root);
  if (watchers.has(key) || !existsSync(root)) return;
  try {
    const watcher = watch(root, { recursive: true }, () => queue(root, 900));
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
  clearTimeout(timers.get(key));
  timers.delete(key);
}

export async function addBrowseFolder(path) {
  const root = resolve(String(path));
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error('Folder not found'), { status: 400 });

  // One physical root on one Agent is one Storage entry. Adding a folder that is
  // already Cloud-backed must be idempotent instead of creating a second Local row.
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
      return {
        path,
        ...(staging.files ? staging : indexed),
        ...filesystem,
        lastIndexed: db.lastIndexed(key),
        available: existsSync(path),
        protected: false
      };
    }));
  } finally { db.close(); }
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

  // Old builds could leave the same root in both Local and Cloud-backed lists.
  // Drop only the obsolete Browse index; the protected root has its own index key.
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
  reconcileTimer = null;
  onChanged = () => {};
  for (const path of settings.browseFolders) unwatchFolder(path);
}
