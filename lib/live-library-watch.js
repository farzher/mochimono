import { createHash } from 'node:crypto';
import { createReadStream, existsSync, watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { CONFIG_DIR, pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { browseStageRows } from './browse-staging.js';
import { publishLocalCatalogChange, publishLocalCatalogReset } from './local-catalog-events.js';
import { isMediaFile, mediaScope } from './mime.js';
import { openSyncIndex } from './sync-index.js';

const LIVE_DELAY_MS = 180;
const LIVE_MAX_BYTES = 128 * 1024 * 1024;
const watchers = new Map();
const timers = new Map();
const pending = new Map();
let clients = 0;
let configWatcher = null;
let configTimer = null;

const browseRootKey = path => `browse:${pathKey(path)}`;

function safeTarget(root, filename) {
  const raw = String(filename || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!raw || raw === '.mochimono' || raw.startsWith('.mochimono/')) return null;
  const base = resolve(root);
  const target = resolve(base, ...raw.split('/').filter(Boolean));
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  if (targetKey !== baseKey && !targetKey.startsWith(`${baseKey}${sep}`)) return null;
  const rel = relative(base, target).replaceAll('\\', '/');
  return rel ? { path:target, rel } : null;
}

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark:1024 * 1024 })) digest.update(chunk);
  return digest.digest('hex');
}

function publish(root, rel, file, hash) {
  publishLocalCatalogChange({ rootPath:root, relativePath:rel, size:file.size, mtimeMs:Math.trunc(file.mtimeMs), hash });
}

async function indexChanges(root) {
  const key = pathKey(root);
  const names = pending.get(key);
  if (!names?.size) return;
  pending.delete(key);
  const rootKey = browseRootKey(root);
  const index = openSyncIndex(SYNC_INDEX_PATH);
  let removed = false;
  try {
    for (const filename of names) {
      const target = safeTarget(root, filename);
      if (!target) continue;
      const file = await stat(target.path).catch(() => null);
      if (!file) {
        removed = Boolean(index.forget(rootKey, target.rel)) || removed;
        continue;
      }
      if (!file.isFile()) continue;
      if (mediaScope(settings.browseFolderScopes[pathKey(root)]) === 'media' && !isMediaFile(target.path)) {
        removed = Boolean(index.forget(rootKey, target.rel)) || removed;
        continue;
      }
      if (Number(file.size) > LIVE_MAX_BYTES) continue;
      const rel = target.rel;
      const mtimeMs = Math.trunc(file.mtimeMs);
      const previous = index.get(rootKey, rel);
      if (previous && previous.hash && Number(previous.size) === Number(file.size) && Number(previous.mtimeMs) === mtimeMs) {
        publish(root, rel, file, String(previous.hash));
        continue;
      }
      const hash = await hashFile(target.path).catch(() => '');
      if (!hash) continue;
      const latest = await stat(target.path).catch(() => null);
      if (!latest?.isFile()) continue;
      if (Number(latest.size) !== Number(file.size) || Math.trunc(latest.mtimeMs) !== mtimeMs) {
        queueChange(root, rel, 500);
        continue;
      }
      index.saveBrowse(rootKey, rel, file.size, mtimeMs, hash, hash);
      publish(root, rel, file, hash);
    }
  } finally {
    index.close();
  }
  if (removed) publishLocalCatalogReset();
}

function schedule(root, delay = LIVE_DELAY_MS) {
  const key = pathKey(root);
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => {
    timers.delete(key);
    void indexChanges(root);
  }, Math.max(0, delay));
  timer.unref?.();
  timers.set(key, timer);
}

function queueChange(root, filename, delay = LIVE_DELAY_MS) {
  const target = safeTarget(root, filename);
  if (!target) return;
  const key = pathKey(root);
  const names = pending.get(key) || new Set();
  names.add(target.rel);
  pending.set(key, names);
  schedule(root, delay);
}

function closeWatcher(key) {
  try { watchers.get(key)?.close(); } catch {}
  watchers.delete(key);
  clearTimeout(timers.get(key));
  timers.delete(key);
  pending.delete(key);
}

function reconcileWatchers() {
  if (!clients) return;
  const configured = new Map((settings.browseFolders || []).map(path => [pathKey(path), resolve(path)]));
  for (const key of [...watchers.keys()]) if (!configured.has(key)) closeWatcher(key);
  for (const [key, root] of configured) {
    if (watchers.has(key) || !existsSync(root)) continue;
    try {
      const watcher = watch(root, { recursive:true }, (_event, filename) => queueChange(root, filename));
      watcher.on('error', () => closeWatcher(key));
      watchers.set(key, watcher);
    } catch {}
  }
}

function publishStagedRows() {
  const roots = new Map((settings.browseFolders || []).map(path => [browseRootKey(path), resolve(path)]));
  for (const row of browseStageRows(4000)) {
    const root = roots.get(String(row.root));
    if (!root) continue;
    publishLocalCatalogChange({ rootPath:root, relativePath:row.path, size:row.size, mtimeMs:row.mtimeMs, hash:row.hash });
  }
}

function startConfigWatcher() {
  if (configWatcher || !existsSync(CONFIG_DIR)) return;
  try {
    configWatcher = watch(CONFIG_DIR, (_event, filename) => {
      if (filename && String(filename).toLowerCase() !== 'agent.json') return;
      clearTimeout(configTimer);
      configTimer = setTimeout(reconcileWatchers, 80);
      configTimer.unref?.();
    });
    configWatcher.on('error', () => {
      try { configWatcher?.close(); } catch {}
      configWatcher = null;
    });
  } catch {}
}

function stop() {
  for (const key of [...watchers.keys()]) closeWatcher(key);
  try { configWatcher?.close(); } catch {}
  configWatcher = null;
  clearTimeout(configTimer);
  configTimer = null;
}

export function acquireLiveLibraryWatchers() {
  clients++;
  if (clients === 1) {
    reconcileWatchers();
    startConfigWatcher();
    // The SSE route subscribes immediately after acquiring us. Publish staged
    // rows on the next turn so that bridge is listening before we emit them.
    setImmediate(publishStagedRows);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clients = Math.max(0, clients - 1);
    if (!clients) stop();
  };
}
