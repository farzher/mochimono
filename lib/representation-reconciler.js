import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { api, CONFIG_DIR, now, settings } from './agent-context.js';
import { readBackup } from './agent-backups.js';
import { localLocations } from './local-locations.js';
import { mimeFor } from './mime.js';

const INTERVAL_MS = 30_000;
const COPY_LIMIT = 24;
const WORK_ID = 'storage-placement';
const WORK_DB_PATH = join(CONFIG_DIR, 'work.sqlite');
let running = false;
let timer = null;
let status = { running:false, phase:'Idle', copied:0, removedOriginals:0, skippedUnsafe:0, error:'' };

const controlPath = root => join(root, '.mochimono');
const replicaDbPath = root => join(controlPath(root), 'representations.sqlite');
const compactObjectPath = (root, hash) => join(controlPath(root), 'renditions', 'objects', hash.slice(0, 2), hash);
const backupInventoryPath = root => join(controlPath(root), 'inventory.sqlite');
const backupOriginalPath = (root, hash) => join(controlPath(root), 'objects', hash.slice(0, 2), hash);

function updateWork(state, message = '', progress = 0, result = null) {
  if (!existsSync(WORK_DB_PATH)) return;
  const db = new DatabaseSync(WORK_DB_PATH, { timeout:5000 });
  try {
    if (state === 'remove') {
      db.prepare('DELETE FROM work_items WHERE id=?').run(WORK_ID);
      return;
    }
    const stamp = now();
    const summary = result
      ? [`${Number(result.copied) || 0} copied`, `${Number(result.removedOriginals) || 0} originals removed`, result.skippedUnsafe ? `${result.skippedUnsafe} protected` : ''].filter(Boolean).join(' · ')
      : 'Storage';
    db.prepare(`INSERT INTO work_items(id,kind,original_hash,filename,media_type,preset_id,preset_name,options_json,status,progress,message,result_json,created_at,started_at,finished_at)
      VALUES(?,?,?,?,?,NULL,?,?,?, ?,?,?, ?,?,?)
      ON CONFLICT(id) DO UPDATE SET preset_name=excluded.preset_name,status=excluded.status,progress=excluded.progress,message=excluded.message,result_json=excluded.result_json,started_at=COALESCE(work_items.started_at,excluded.started_at),finished_at=excluded.finished_at`)
      .run(WORK_ID, 'placement', '0'.repeat(64), 'Storage placement', 'image', summary, '{}', state, Math.max(0, Math.min(100, Number(progress) || 0)), message, result ? JSON.stringify(result) : null, stamp, state === 'running' ? stamp : null, ['done','error'].includes(state) ? stamp : null);
  } catch {} finally { db.close(); }
}

function openReplicaDb(root) {
  mkdirSync(dirname(replicaDbPath(root)), { recursive:true });
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

function compactRows(root) {
  if (!existsSync(replicaDbPath(root))) return [];
  const db = openReplicaDb(root);
  try {
    return db.prepare('SELECT original_hash AS originalHash,rendition_hash AS renditionHash,media_type AS mediaType,size,verified_at AS verifiedAt FROM compact_replicas').all()
      .map(row => ({ ...row, size:Number(row.size) || 0 }));
  } finally { db.close(); }
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
    if (actual !== rendition.hash || size !== Number(rendition.size)) throw new Error(`Squished verification failed for ${originalHash}`);
    await rm(destination, { force:true });
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force:true }).catch(() => {});
    throw error;
  }
}

async function compactReady(root, originalHash, rendition) {
  if (!rendition || !existsSync(replicaDbPath(root))) return false;
  const db = openReplicaDb(root);
  try {
    const row = db.prepare('SELECT rendition_hash,size FROM compact_replicas WHERE original_hash=?').get(originalHash);
    if (row?.rendition_hash !== rendition.hash || Number(row.size) !== Number(rendition.size)) return false;
    const info = await stat(compactObjectPath(root, rendition.hash)).catch(() => null);
    return Boolean(info?.isFile() && Number(info.size) === Number(rendition.size));
  } finally { db.close(); }
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
  const result = [];
  for (const row of compactRows(root)) {
    const info = await stat(compactObjectPath(root, row.renditionHash)).catch(() => null);
    if (info?.isFile() && Number(info.size) === row.size) result.push(row.originalHash);
  }
  return result;
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
  const state = await api(`/api/representations/${hash}/safe-remove?locationId=${encodeURIComponent(locationId)}`);
  return state.safe === true && state.currentVerified === true;
}

function backupOriginalHashes(root) {
  if (!existsSync(backupInventoryPath(root))) return [];
  const db = new DatabaseSync(backupInventoryPath(root), { readOnly:true, timeout:3000 });
  try { return db.prepare('SELECT hash FROM objects ORDER BY hash').all().map(row => row.hash); }
  finally { db.close(); }
}

async function removeBackupOriginal(root, driveId, hash) {
  if (!existsSync(backupInventoryPath(root))) return false;
  const path = backupOriginalPath(root, hash);
  const verifyDb = new DatabaseSync(backupInventoryPath(root), { readOnly:true, timeout:5000 });
  try {
    if (!verifyDb.prepare('SELECT 1 FROM objects WHERE hash=?').get(hash)) return true;
  } finally { verifyDb.close(); }
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || await sha256(path) !== hash) return false;

  // Clear the server's replica record before removing bytes. If anything fails
  // after this point, Mochimono under-counts an extra Original rather than ever
  // over-counting one that no longer exists, which is the conservative failure.
  await api(`/api/drives/${encodeURIComponent(driveId)}/replicas/remove`, { method:'POST', body:{ hashes:[hash] } });
  await rm(path, { force:true });
  const db = new DatabaseSync(backupInventoryPath(root), { timeout:5000 });
  try { db.prepare('DELETE FROM objects WHERE hash=?').run(hash); }
  finally { db.close(); }
  return true;
}

async function configuredBackups() {
  const result = [];
  for (const root of settings.backups || []) {
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) continue;
    const meta = await readBackup(root).catch(() => null);
    if (meta?.id) result.push({ path:root, meta });
  }
  return result;
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
    const hasCompactPolicy = ['image','video'].some(type => mode(locationId, type) !== 'original');
    if (!hasCompactPolicy && !existsSync(replicaDbPath(location.rootPath))) continue;
    const files = filesByLocation.get(locationId) || [];
    const sourceByHash = new Map();
    for (const file of files) if (!sourceByHash.has(file.hash)) sourceByHash.set(file.hash, file);
    const storedRows = compactRows(location.rootPath);
    const storedByHash = new Map(storedRows.map(row => [row.originalHash, row]));
    const candidates = [...new Set([...sourceByHash.keys(), ...storedByHash.keys()])];
    const renditionMap = await renditionsFor(candidates);

    await report(locationId, 'original', files.map(file => file.hash));

    for (const hash of candidates) {
      const source = sourceByHash.get(hash);
      const stored = storedByHash.get(hash);
      const type = source?.type || stored?.mediaType || renditionMap.get(hash)?.mediaType || '';
      if (!type) continue;
      // Local source folders are deliberately never destructive. Even if a stale
      // older policy row says compact-only, treat it as additive Compact.
      const wanted = mode(locationId, type) === 'original' ? 'original' : 'compact';
      if (wanted === 'original') {
        if (source) await removeCompact(location.rootPath, hash);
        continue;
      }
      const rendition = renditionMap.get(hash);
      if (!rendition) {
        if (source) await removeCompact(location.rootPath, hash);
        continue;
      }
      if (!await compactReady(location.rootPath, hash, rendition) && budget.count < COPY_LIMIT) {
        if (await ensureCompact(location.rootPath, hash, rendition)) { budget.count++; status.copied++; }
      }
    }
    await report(locationId, 'compact', await compactHashes(location.rootPath));
  }
}

async function reconcileBackups(storage, budget) {
  const { mode } = policyMaps(storage);
  const backups = await configuredBackups();
  for (const backup of backups) {
    const locationId = `backup:${backup.meta.id}`;
    const hasCompactPolicy = ['image','video'].some(type => mode(locationId, type) !== 'original');
    if (!hasCompactPolicy && !existsSync(replicaDbPath(backup.path))) continue;
    const originals = new Set(backupOriginalHashes(backup.path));
    const storedRows = compactRows(backup.path);
    const storedByHash = new Map(storedRows.map(row => [row.originalHash, row]));
    const candidates = [...new Set([...originals, ...storedByHash.keys()])];
    const renditionMap = await renditionsFor(candidates);

    for (const hash of candidates) {
      const stored = storedByHash.get(hash);
      const rendition = renditionMap.get(hash);
      const type = rendition?.mediaType || stored?.mediaType || '';
      if (!type) continue;
      const wanted = mode(locationId, type);
      const originalPresent = originals.has(hash);

      if (wanted === 'original') {
        // Keep Compact as a safety fallback until normal backup reconciliation
        // has restored the Original, then remove the redundant Compact.
        if (originalPresent) await removeCompact(backup.path, hash);
        continue;
      }

      if (!rendition) {
        // A missing managed rendition can never justify dropping an Original.
        if (originalPresent) await removeCompact(backup.path, hash);
        continue;
      }

      let ready = await compactReady(backup.path, hash, rendition);
      if (!ready && budget.count < COPY_LIMIT) {
        if (await ensureCompact(backup.path, hash, rendition)) { budget.count++; status.copied++; }
        ready = await compactReady(backup.path, hash, rendition);
      }
      if (wanted !== 'compact-only' || !originalPresent || !ready) continue;
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
    const hasCompactPolicy = (storage.policies || []).some(item => item.representation === 'compact');
    if (!hasCompactPolicy) {
      status.phase = 'Idle';
      updateWork('remove');
      return;
    }
    updateWork('running', 'Reading storage policy', 5);
    const budget = { count:0 };
    status.phase = 'Reconciling local folders';
    updateWork('running', status.phase, 25);
    await reconcileLocal(storage, budget);
    status.phase = 'Reconciling backups';
    updateWork('running', status.phase, 65);
    await reconcileBackups(storage, budget);
    status.phase = 'Idle';
    if (status.copied || status.removedOriginals || status.skippedUnsafe) updateWork('done', 'Storage matches policy', 100, status);
    else updateWork('remove');
  } catch (error) {
    status.error = error?.message || String(error);
    status.phase = 'Idle';
    updateWork('error', status.error, 100, status);
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
