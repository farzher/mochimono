import { createHash } from 'node:crypto';
import { createReadStream, existsSync, watch } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import { beginJob, canceled, currentJob, pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { backgroundWorkAllowed, waitForBackgroundWork } from './background-work.js';
import { isMediaFile, mediaScope, mimeFor } from './mime.js';
import { queueProviderThumbnail } from './provider-thumbs.js';
import { openSyncIndex } from './sync-index.js';

const INDEX_CHECK_MS = 1800;
const WATCH_RECONCILE_MS = 5000;
const OFFLINE_RESCAN_MS = 60_000;
const CLOUD_PROBE_MS = 2500;
const FILE_BUFFER = 1024 * 1024;

const index = openSyncIndex(SYNC_INDEX_PATH);
const watchers = new Map();
const dirty = new Set();
let pumpTimer = null;
let watcherTimer = null;
let rescanTimer = null;
let stopped = false;
let probing = null;
let lastCloudProbeAt = 0;
let lastCloudOnline = false;

const relativeKey = value => {
  const clean = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  return platform() === 'win32' ? clean.toLowerCase() : clean;
};

function folderForKey(key) {
  return (settings.folders || []).find(folder => pathKey(folder.path) === key) || null;
}

async function cloudOnline() {
  const now = Date.now();
  if (now - lastCloudProbeAt < CLOUD_PROBE_MS) return lastCloudOnline;
  if (probing) return probing;
  probing = (async () => {
    lastCloudProbeAt = Date.now();
    if (!settings.token) return false;
    try {
      const response = await fetch(`${settings.server}/api/stats`, {
        headers:{ authorization:`Bearer ${settings.token}` },
        signal:AbortSignal.timeout(1400)
      });
      return response.ok;
    } catch {
      return false;
    }
  })().then(value => {
    lastCloudOnline = Boolean(value);
    return lastCloudOnline;
  }).finally(() => { probing = null; });
  return probing;
}

async function* filesUnder(directory, scope) {
  await waitForBackgroundWork();
  canceled();
  let directoryHandle;
  try { directoryHandle = await opendir(directory); }
  catch { return; }
  for await (const entry of directoryHandle) {
    await waitForBackgroundWork();
    canceled();
    if (entry.name === '.mochimono' || entry.name === '.mochimono-friend') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path, scope);
    else if (entry.isFile() && (scope === 'all' || isMediaFile(path))) yield path;
  }
}

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark:FILE_BUFFER })) {
    await waitForBackgroundWork();
    canceled();
    digest.update(chunk);
  }
  return digest.digest('hex');
}

function queuePreview(root, path, row) {
  if (!row.hash || !isMediaFile(path, row.mime)) return;
  queueProviderThumbnail({
    hash:row.hash,
    filename:basename(path),
    mime:row.mime,
    owner:root,
    candidate:{
      kind:'local',
      path,
      size:row.size,
      mime:row.mime,
      root
    }
  }, { background:true, owner:root });
}

async function indexFolder(folder, update = () => {}) {
  const root = resolve(folder.path);
  const rootKey = pathKey(root);
  const scope = mediaScope(folder.scope);
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) return { path:root, unavailable:true };

  const cached = index.load(rootKey);
  const current = new Set();
  let scanned = 0;
  let hashed = 0;
  let reused = 0;
  let bytes = 0;
  update({ phase:'Indexing', path:root, scanned:0, hashed:0, indeterminate:true, current:'' });

  for await (const path of filesUnder(root, scope)) {
    canceled();
    let info;
    try { info = await stat(path); }
    catch { continue; }
    if (!info.isFile()) continue;

    const relativePath = relative(root, path).replaceAll('\\', '/');
    const cachePath = relativeKey(relativePath);
    current.add(cachePath);
    scanned++;
    bytes += Number(info.size) || 0;

    const mime = mimeFor(path);
    const previous = cached.get(cachePath);
    const same = previous && Number(previous.size) === Number(info.size) && Number(previous.mtimeMs) === Math.trunc(info.mtimeMs);
    let hash = same ? String(previous.hash || '') : '';
    if (hash) reused++;
    else {
      update({ phase:'Hashing', path:root, scanned, hashed, reusedHashes:reused, current:relativePath });
      try { hash = await hashFile(path); }
      catch (error) {
        if (error?.canceled) throw error;
        continue;
      }
      hashed++;
      index.save(rootKey, cachePath, info.size, Math.trunc(info.mtimeMs), hash);
    }

    // Existing hashes are just as useful offline as newly learned hashes. Queue
    // every media file through the persistent provider cache; existing previews
    // are cheap cache hits and missing ones are generated locally in background.
    queuePreview(root, path, { hash, size:info.size, mime });

    if (scanned % 40 === 0) update({
      phase:hashed ? 'Hashing' : 'Indexing', path:root, scanned, hashed,
      reusedHashes:reused, current:relativePath, bytes
    });
  }

  const removed = index.prune(rootKey, current);
  index.markIndexed(rootKey);
  update({ phase:'Indexed offline', path:root, scanned, hashed, reusedHashes:reused, removed, bytes, current:'' });
  return { path:root, scanned, hashed, reused, removed, bytes, offline:true };
}

function markDirty(path) {
  if (!path) return;
  dirty.add(pathKey(path));
}

function closeWatcher(key) {
  try { watchers.get(key)?.close(); } catch {}
  watchers.delete(key);
}

function reconcileWatchers() {
  if (stopped) return;
  const configured = new Set((settings.folders || []).map(folder => pathKey(folder.path)));
  for (const key of [...watchers.keys()]) if (!configured.has(key)) closeWatcher(key);

  for (const folder of settings.folders || []) {
    const key = pathKey(folder.path);
    if (watchers.has(key) || !existsSync(folder.path)) continue;
    markDirty(folder.path);
    try {
      const watcher = watch(folder.path, { recursive:true }, () => markDirty(folder.path));
      watcher.on('error', () => {
        closeWatcher(key);
        markDirty(folder.path);
      });
      watchers.set(key, watcher);
    } catch {
      // Some platforms cannot recursively watch. The offline rescan timer below
      // still keeps the persistent index correct; it just reacts less quickly.
    }
  }
}

async function pump() {
  if (stopped || !dirty.size || currentJob()?.status === 'running' || !backgroundWorkAllowed()) return;
  if (await cloudOnline()) return;

  const key = dirty.values().next().value;
  dirty.delete(key);
  const folder = folderForKey(key);
  if (!folder || !existsSync(folder.path)) return;
  const name = basename(folder.path) || folder.path;
  const job = beginJob('sync', `Check ${name}`, update => indexFolder(folder, update), {
    background:true,
    path:folder.path
  });
  if (!job) dirty.add(key);
}

export async function startOfflineIndexService() {
  if (pumpTimer) return;
  stopped = false;
  reconcileWatchers();
  for (const folder of settings.folders || []) markDirty(folder.path);
  pumpTimer = setInterval(() => pump().catch(() => {}), INDEX_CHECK_MS);
  watcherTimer = setInterval(reconcileWatchers, WATCH_RECONCILE_MS);
  rescanTimer = setInterval(() => {
    if (lastCloudOnline) return;
    for (const folder of settings.folders || []) markDirty(folder.path);
  }, OFFLINE_RESCAN_MS);
  pumpTimer.unref?.();
  watcherTimer.unref?.();
  rescanTimer.unref?.();
  // Resolve the initial Cloud state before the normal sync service starts. If
  // Cloud is down, begin the local-only indexing job first so Cloud ingestion
  // cannot block the persistent index on startup.
  await pump().catch(() => {});
}

export function stopOfflineIndexService() {
  stopped = true;
  if (pumpTimer) clearInterval(pumpTimer);
  if (watcherTimer) clearInterval(watcherTimer);
  if (rescanTimer) clearInterval(rescanTimer);
  pumpTimer = watcherTimer = rescanTimer = null;
  for (const key of [...watchers.keys()]) closeWatcher(key);
  dirty.clear();
  try { index.close(); } catch {}
}
