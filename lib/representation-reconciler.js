import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { api, now, settings } from './agent-context.js';
import { backupLocations } from './agent-backups.js';
import { localLocations } from './local-locations.js';
import { mimeFor } from './mime.js';

const INTERVAL_MS = 12_000;
const COPY_LIMIT = 24;
let running = false;
let timer = null;
let status = { running:false, phase:'Idle', copied:0, removedOriginals:0, skippedUnsafe:0, error:'' };

const controlPath = root => join(root, '.mochimono');
const replicaDbPath = root => join(controlPath(root), 'representations.sqlite');
const compactObjectPath = (root, hash) => join(controlPath(root), 'renditions', 'objects', hash.slice(0, 2), hash);
const backupInventoryPath = root => join(controlPath(root), 'inventory.sqlite');
const backupOriginalPath = (root, hash) => join(controlPath(root), 'objects', hash.slice(0, 2), hash);

function openReplicaDb(root) {
  mkdir(dirname(replicaDbPath(root)), { recursive:true }).catch(() => {});
  const db = new DatabaseSync(replicaDbPath(root), { timeout:5000 });
  db.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS compact_replicas (
      original_hash TEXT PRIMARY KEY,
      rendition_hash TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
      size INTEGER NOT NULL,
      stored_at TEXT NOT NULL,
      verified_at TEXT NOT NULL
    ) STRICT;
  `);
  return db;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function mediaType(path) {
  const mime = mimeFor(path);
  return mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : '';
}

function safePath(root, relativePath) {
  const base = resolve(String(root || ''));
  const target = resolve(base, ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  return targetKey === baseKey || targetKey.startsWith(`${baseKey}${sep}`) ? target : '';
}

async function downloadCompact(originalHash, rendition, destination) {
  const response = await api(`/api/renditions/${originalHash}/file`);
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive:true });
  const digest = createHash('sha256');
  let size = 0;
  const verifier = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    }
  });
  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  try {
    await pipeline(source, verifier, createWriteStream(temp, { flags:'wx' }));
    const actual = digest.digest('hex');
    if (actual !== rendition.hash || size !== Number(rendition.size)) throw new Error(`Compact verification failed for ${originalHash}`);
    await rm(destination, { force:true });
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force:true }).catch(() => {});
    throw error;
  }
}

async function ensureCompact(root, originalHash, rendition) {
  const db = openReplicaDb(root);
  try {
    const row = db.prepare('SELECT * FROM compact_replicas WHERE original_hash=?').get(originalHash);
    const destination = compactObjectPath(root, rendition.hash);
    if (row?.rendition_hash === rendition.hash && Number(row.size) === Number(rendition.size)) {
      const info = await stat(destination).catch(() => null);
      if (info?.isFile() && Number(info.size) === Number(rendition.size)) return false;
    }
    await downloadCompact(originalHash, rendition, destination);
    if (row?.rendition_hash && row.rendition_hash !== rendition.hash) {
      await rm(compactObjectPath(root, row.rendition_hash), { force:true }).catch(() => {});
    }
    const stamp = now();
    db.prepare(`INSERT INTO compact_replicas(original_hash,rendition_hash,media_type,size,stored_at,verified_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(original_hash) DO UPDATE SET rendition_hash=excluded.rendition_hash,media_type=excluded.media_type,size=excluded.size,stored_at=excluded.stored_at,verified_at=excluded.verified_at`)
      .run(originalHash, rendition.hash, rendition.mediaType, Number(rendition.size), stamp, stamp);
    return true;
  } finally { db.close(); }
}

async function removeCompact(root, originalHash) {
  if (!existsSync(replicaDbPath(root))) return false;
  const db = openReplicaDb(root);
  try {
    const row = db.prepare('SELECT rendition_hash FROM compact_replicas WHERE original_hash=?').get(originalHash);
    if (!row) return false;
    await rm(compactObjectPath(root, row.rendition_hash), { force:true }).catch(() => {});
    db.prepare('DELETE FROM compact_replicas WHERE original_hash=?').run(originalHash);
    return true;
  } finally { db.close(); }
}

async function compactHashes(root) {
  if (!existsSync(replicaDbPath(root))) return [];
  const db = openReplicaDb(root);
  try {
    const result = [];
    for (const row of db.prepare('SELECT original_hash,rendition_hash,size FROM compact_replicas').all()) {
      const info = await stat(compactObjectPath(root, row.rendition_hash)).catch(() => null);
      if (info?.isFile() && Number(info.size) === Number(row.size)) result.push(row.original_hash);
    }
    return result;
  } finally { db.close(); }
}

async function report(locationId, representation, hashes) {
  const values = [...new Set(hashes)];
  if (!values.length) {
    await api('/api/representations/report', { method:'POST', body:{ locationId, representation, hashes:[], complete:true } });
    return;
  }
  for (let offset = 0; offset < values.length; offset += 10_000) {
    await api('/api/representations/report', {
      method:'POST',
      body:{ locationId, representation, hashes:values.slice(offset, offset + 10_000), complete:offset === 0 }
    });
  }
}

async function renditionsFor(hashes) {
  const map = new Map();
  const values = [...new Set(hashes)];
  for (let offset = 0; offset < values.length; offset += 1000) {
    const data = await api('/api/renditions/check', { method:'POST', body:{ hashes:values.slice(offset, offset + 1000) } });
    for (const item of data.renditions || []) map.set(item.originalHash, item);
  }
  return map;
}

function policyMaps(storage) {
  const preference = new Map((storage.policies || []).map(item => [`${item.locationId}\0${item.mediaType}`, item.representation]));
  const retention = new Map((storage.retention || []).map(item => [`${item.locationId}\0${item.mediaType}`, item.allowOriginalRemoval === true]));
  const mode = (locationId, type) => {
    const key = `${locationId}\0${type}`;
    const representation = preference.get(key) || 'original';
    return representation === 'compact' ? (retention.get(key) ? 'compact-only' : 'compact') : 'original';
  };
  return { mode };
}

async function safeToRemove(hash, locationId) {
  const state = await api(`/api/representations/${hash}`);
  const here = (state.locations || []).some(item => item.locationId === locationId && item.representation === 'original');
  return here && Number(state.originalCopies) > 1 && state.safeToRemoveOneOriginal === true;
}

async function removeLocalOriginal(root, relativePath, hash) {
  const path = safePath(root, relativePath);
  if (!path) return false;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return true;
  // Never trust a stale index for destructive work. Re-hash immediately before
  // deletion and leave the file alone if its bytes have changed.
  if (await sha256(path) !== hash) return false;
  await rm(path, { force:true });
  return true;
}

function backupOriginalHashes(root) {
  if (!existsSync(backupInventoryPath(root))) return [];
  const db = new DatabaseSync(backupInventoryPath(root), { readOnly:true, timeout:3000 });
  try { return db.prepare('SELECT hash FROM objects ORDER BY hash').all().map(row => row.hash); }
  finally { db.close(); }
}

async function removeBackupOriginal(root, driveId, hash) {
  if (!existsSync(backupInventoryPath(root))) return false;
  const db = new DatabaseSync(backupInventoryPath(root), { timeout:5000 });
  try {
    const row = db.prepare('SELECT hash FROM objects WHERE hash=?').get(hash);
    if (!row) return true;
    const path = backupOriginalPath(root, hash);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && await sha256(path) !== hash) return false;
    await rm(path, { force:true }).catch(() => {});
    db.prepare('DELETE FROM objects WHERE hash=?').run(hash);
  } finally { db.close(); }
  await api(`/api/drives/${encodeURIComponent(driveId)}/replicas/remove`, { method:'POST', body:{ hashes:[hash] } });
  return true;
}

async function reconcileLocal(storage, budget) {
  const local = localLocations();
  const { mode } = policyMaps(storage);
  const locations = new Map((local.locations || []).filter(item => item.available !== false).map(item => [item.id, item]));
  const filesByLocation = new Map();
  for (const [hash, locationId, relativePath] of local.files || []) {
    const location = locations.get(locationId);
    const type = mediaType(relativePath);
    if (!location || !type || !/^[a-f0-9]{64}$/.test(hash)) continue;
    if (!filesByLocation.has(locationId)) filesByLocation.set(locationId, []);
    filesByLocation.get(locationId).push({ hash, relativePath, type });
  }

  for (const [locationId, location] of locations) {
    const files = filesByLocation.get(locationId) || [];
    await report(locationId, 'original', files.map(file => file.hash));
    const wantedHashes = files.filter(file => mode(locationId, file.type) !== 'original').map(file => file.hash);
    const renditionMap = await renditionsFor(wantedHashes);
    const grouped = new Map();
    for (const file of files) {
      if (!grouped.has(file.hash)) grouped.set(file.hash, []);
      grouped.get(file.hash).push(file);
    }

    for (const [hash, entries] of grouped) {
      const type = entries[0].type;
      const wanted = mode(locationId, type);
      if (wanted === 'original') {
        await removeCompact(location.rootPath, hash);
        continue;
      }
      const rendition = renditionMap.get(hash);
      if (!rendition) continue; // Missing Compact can never justify deleting Original.
      if (budget.count >= COPY_LIMIT) continue;
      if (await ensureCompact(location.rootPath, hash, rendition)) { budget.count++; status.copied++; }
      if (wanted !== 'compact-only') continue;
      if (!await safeToRemove(hash, locationId)) { status.skippedUnsafe++; continue; }
      let allRemoved = true;
      for (const file of entries) {
        if (!await removeLocalOriginal(location.rootPath, file.relativePath, hash)) allRemoved = false;
      }
      if (allRemoved) {
        status.removedOriginals++;
        await api(`/api/representations/${hash}/presence?locationId=${encodeURIComponent(locationId)}&representation=original`, { method:'DELETE' });
      }
    }
    await report(locationId, 'compact', await compactHashes(location.rootPath));
  }
}

async function reconcileBackups(storage, budget) {
  const { mode } = policyMaps(storage);
  const backups = await backupLocations();
  for (const backup of backups || []) {
    if (!backup.path || !backup.meta?.id) continue;
    const locationId = `backup:${backup.meta.id}`;
    const originals = backupOriginalHashes(backup.path);
    const renditionMap = await renditionsFor(originals);
    for (const hash of originals) {
      const rendition = renditionMap.get(hash);
      const type = rendition?.mediaType || '';
      if (!type) continue;
      const wanted = mode(locationId, type);
      if (wanted === 'original') {
        await removeCompact(backup.path, hash);
        continue;
      }
      if (!rendition) continue;
      if (budget.count < COPY_LIMIT && await ensureCompact(backup.path, hash, rendition)) { budget.count++; status.copied++; }
      if (wanted !== 'compact-only') continue;
      if (!await safeToRemove(hash, locationId)) { status.skippedUnsafe++; continue; }
      if (await removeBackupOriginal(backup.path, backup.meta.id, hash)) status.removedOriginals++;
    }
    await report(locationId, 'compact', await compactHashes(backup.path));
  }
}

async function reconcileOnce() {
  if (running || !settings.token) return;
  running = true;
  status = { running:true, phase:'Reading storage policy', copied:0, removedOriginals:0, skippedUnsafe:0, error:'' };
  try {
    const storage = await api('/api/compression/storage-snapshot');
    const budget = { count:0 };
    status.phase = 'Reconciling local folders';
    await reconcileLocal(storage, budget);
    status.phase = 'Reconciling backups';
    await reconcileBackups(storage, budget);
    status.phase = 'Idle';
  } catch (error) {
    status.error = error?.message || String(error);
    status.phase = 'Idle';
    if (!/not connected|offline|fetch failed|ECONNREFUSED/i.test(status.error)) console.warn('Representation reconciliation failed', status.error);
  } finally {
    running = false;
    status.running = false;
  }
}

function schedule(delay = INTERVAL_MS) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await reconcileOnce();
    schedule();
  }, delay);
  timer.unref?.();
}

export function startRepresentationReconciler() {
  reconcileOnce().finally(() => schedule());
}

export function reconcileRepresentationsNow() {
  return reconcileOnce();
}

export function representationReconcilerStatus() {
  return { ...status };
}
