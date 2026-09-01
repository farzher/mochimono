import { createHash } from 'node:crypto';
import { createReadStream, existsSync, watch } from 'node:fs';
import { opendir, stat, statfs } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { beginJob, canceled, currentJob, pathKey, persistSettings, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { openSyncIndex } from './sync-index.js';

const RECONCILE_MS = 60 * 60 * 1000;
const YIELD_EVERY_FILES = 200;
const HASH_YIELD_BYTES = 8 * 1024 * 1024;
const watchers = new Map();
const timers = new Map();
let reconcileTimer = null;
let onChanged = () => {};

export const browseRootKey = path => `browse:${pathKey(path)}`;
export const browseFolderFor = path => settings.browseFolders.find(item => pathKey(item) === pathKey(path));
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

async function hashFile(path) {
  const hash = createHash('sha256');
  let sinceYield = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    canceled();
    hash.update(chunk);
    sinceYield += chunk.length;
    if (sinceYield >= HASH_YIELD_BYTES) {
      sinceYield = 0;
      // Hashing is background Browse work. Yield periodically even within one
      // huge file so the Agent can keep serving UI/object requests promptly.
      await yieldHashTurn();
    }
  }
  return hash.digest('hex');
}

export async function indexBrowseFolder(path, update = () => {}) {
  const root = resolve(path);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${root} is not a directory`);

  const index = openSyncIndex(SYNC_INDEX_PATH);
  const key = browseRootKey(root);
  const cached = index.load(key);
  const seen = new Set();
  const pending = [];
  let scanned = 0;
  let hashed = 0;
  let reused = 0;
  let errors = 0;

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
        if (previous && Number(previous.size) === file.size && Number(previous.mtimeMs) === mtimeMs) {
          hash = previous.hash;
          reused++;
        } else {
          update({ phase: 'Indexing', path: root, current: rel, scanned, hashed, reused, indeterminate: true });
          hash = await hashFile(filePath);
          const latest = await stat(filePath);
          if (latest.size !== file.size || Math.trunc(latest.mtimeMs) !== mtimeMs) continue;
          // Do not mutate the live provider index for every file. On very large
          // Browse trees that made the provider cache invalidate and rebuild over
          // and over while the scan was still running. Publish changed rows once
          // the scan completes instead.
          pending.push({ path: rel, size: file.size, mtimeMs, hash });
          hashed++;
        }
        scanned++;
        if (scanned % 50 === 0) update({ phase: 'Indexing', path: root, current: rel, scanned, hashed, reused, indeterminate: true });
        if (scanned % YIELD_EVERY_FILES === 0) await yieldTurn();
      } catch (error) {
        if (error.canceled) throw error;
        errors++;
      }
    }
    index.saveMany(key, pending);
    index.prune(key, seen);
    index.markIndexed(key);
  } finally { index.close(); }

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
    beginJob('sync', `Index ${basename(root) || root}`, update => indexed(root, update));
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
      return {
        path,
        ...db.stats(key),
        ...filesystem,
        lastIndexed: db.lastIndexed(key),
        available: existsSync(path),
        protected: false
      };
    }));
  } finally { db.close(); }
}

export function startBrowseService(changeHandler = () => {}) {
  onChanged = typeof changeHandler === 'function' ? changeHandler : () => {};
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
