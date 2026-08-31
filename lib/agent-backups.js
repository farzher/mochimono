import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { userInfo, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { api, canceled, now, rememberBackup, settings } from './agent-context.js';
import { inspectBackup, restoreBackup } from './restore.js';

const controlPath = root => join(root, '.mochimono');
const driveMetaPath = root => join(controlPath(root), 'drive.json');
const driveDbPath = root => join(controlPath(root), 'inventory.sqlite');
const backupObjectPath = (root, hash) => join(controlPath(root), 'objects', hash.slice(0, 2), hash);

function openInventory(root, create = false) {
  if (!create && !existsSync(driveDbPath(root))) throw new Error('This backup inventory is missing.');
  const db = new DatabaseSync(driveDbPath(root), { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS objects (
      hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      stored_at TEXT NOT NULL,
      verified_at TEXT
    ) STRICT;
  `);
  return db;
}

export async function readBackup(root) {
  return JSON.parse(await readFile(driveMetaPath(resolve(root)), 'utf8'));
}

async function writeBackup(root, meta) {
  await writeFile(driveMetaPath(resolve(root)), `${JSON.stringify(meta, null, 2)}\n`);
}

async function stamp(root, field) {
  const meta = await readBackup(root);
  meta[field] = now();
  await writeBackup(root, meta);
  return meta[field];
}

async function registerBackup(meta) {
  return api('/api/drives/register', { method: 'POST', body: meta });
}

export async function backupInit(path, name, configure = false) {
  const root = resolve(path);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error(`${root} is not a directory`), { status: 400 });

  if (existsSync(driveMetaPath(root))) {
    if (!existsSync(driveDbPath(root))) throw new Error('This backup inventory is missing.');
    const meta = await readBackup(root);
    if (configure && String(name || '').trim()) {
      meta.name = String(name).trim();
      await writeBackup(root, meta);
    }
    await rememberBackup(root);
    let remote = null;
    try { remote = await registerBackup(meta); } catch {}
    return { path: root, meta, remote, existing: true, configured: configure };
  }

  await mkdir(controlPath(root), { recursive: true });
  const meta = {
    format: 1,
    id: randomUUID(),
    name: String(name || basename(root) || root),
    policy: { all: true, collectionId: null },
    createdAt: now()
  };
  await writeBackup(root, meta);
  openInventory(root, true).close();
  await rememberBackup(root);
  let remote = null;
  try { remote = await registerBackup(meta); } catch {}
  return { path: root, meta, remote, existing: false };
}

export async function setBackupPolicy(path, collectionId, collectionName = '') {
  const root = resolve(path);
  const meta = await readBackup(root);
  const id = Number(collectionId) || 0;
  meta.policy = id
    ? { all: false, collectionId: id, collectionName: String(collectionName || '').slice(0, 80) }
    : { all: true, collectionId: null };
  await writeBackup(root, meta);
  let remote = null;
  try { remote = await registerBackup(meta); } catch {}
  return { meta, remote };
}

async function downloadVerified(hash, expectedSize, destination) {
  canceled();
  const response = await api(`/api/objects/${hash}`);
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive: true });
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
    await pipeline(source, verifier, createWriteStream(temp, { flags: 'wx' }));
    canceled();
    if (digest.digest('hex') !== hash || size !== expectedSize) throw new Error(`Verification failed for ${hash}`);
    await rm(destination, { force: true });
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function reportReplicas(id, replicas) {
  if (replicas.length) await api(`/api/drives/${encodeURIComponent(id)}/replicas`, { method: 'POST', body: { replicas } });
}

async function saveCatalogSnapshot(root) {
  canceled();
  const response = await api('/api/catalog/export');
  const target = join(controlPath(root), 'catalog.sqlite');
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  try {
    await pipeline(source, createWriteStream(temp, { flags: 'wx' }));
    canceled();
    await rm(target, { force: true });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function backupUpdate(path, update = () => {}) {
  const root = resolve(path);
  const meta = await readBackup(root);
  await rememberBackup(root);
  const registered = await registerBackup(meta);
  if (registered?.policy?.missing) throw Object.assign(new Error('Choose a current backup scope before updating'), { status: 409 });

  const db = openInventory(root);
  const find = db.prepare('SELECT hash, size, verified_at FROM objects WHERE hash = ?');
  const save = db.prepare('INSERT INTO objects(hash, size, stored_at, verified_at) VALUES(?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET size=excluded.size, stored_at=excluded.stored_at, verified_at=excluded.verified_at');
  let after = '';
  let copied = 0;
  let copiedBytes = 0;
  let already = 0;
  let reports = [];

  try {
    do {
      canceled();
      const page = await api(`/api/drives/${encodeURIComponent(meta.id)}/desired?after=${encodeURIComponent(after)}&limit=1000`);
      for (const object of page.objects || []) {
        canceled();
        const destination = backupObjectPath(root, object.hash);
        const local = find.get(object.hash);
        let present = false;
        if (local && existsSync(destination)) {
          try { present = (await stat(destination)).size === Number(object.size); } catch {}
        }
        if (present) {
          already++;
          reports.push({ hash: object.hash, verifiedAt: local.verified_at });
        } else {
          update({ phase: 'Backing up', current: object.hash.slice(0, 12), copied, already, copiedBytes });
          await downloadVerified(object.hash, Number(object.size), destination);
          const timestamp = now();
          save.run(object.hash, Number(object.size), timestamp, timestamp);
          reports.push({ hash: object.hash, verifiedAt: timestamp });
          copied++;
          copiedBytes += Number(object.size);
        }
        if (reports.length >= 1000) {
          await reportReplicas(meta.id, reports);
          reports = [];
        }
      }
      after = page.nextAfter || '';
    } while (after);

    await reportReplicas(meta.id, reports);
    update({ phase: 'Saving', copied, already, copiedBytes });
    await saveCatalogSnapshot(root);
    await stamp(root, 'lastBackupAt');
    return { drive: meta.name, copied, already, copiedBytes };
  } finally { db.close(); }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    canceled();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function backupVerify(path, update = () => {}) {
  const root = resolve(path);
  const meta = await readBackup(root);
  await rememberBackup(root);
  const db = openInventory(root);
  const rows = db.prepare('SELECT hash, size FROM objects ORDER BY hash').all();
  const mark = db.prepare('UPDATE objects SET verified_at = ? WHERE hash = ?');
  const forget = db.prepare('DELETE FROM objects WHERE hash = ?');
  const good = [];
  const bad = [];
  let badCount = 0;

  try {
    for (let index = 0; index < rows.length; index++) {
      canceled();
      const row = rows[index];
      update({ phase: 'Verifying', current: row.hash.slice(0, 12), checked: index, total: rows.length, bad: badCount });
      let ok = false;
      try {
        const object = backupObjectPath(root, row.hash);
        ok = (await stat(object)).size === Number(row.size) && await hashFile(object) === row.hash;
      } catch (error) {
        if (error.canceled) throw error;
      }
      if (ok) {
        const timestamp = now();
        mark.run(timestamp, row.hash);
        good.push({ hash: row.hash, verifiedAt: timestamp });
      } else {
        forget.run(row.hash);
        bad.push(row.hash);
        badCount++;
      }
    }
  } finally { db.close(); }

  try {
    await registerBackup(meta);
    for (let i = 0; i < good.length; i += 1000) await reportReplicas(meta.id, good.slice(i, i + 1000));
    for (let i = 0; i < bad.length; i += 1000) await api(`/api/drives/${encodeURIComponent(meta.id)}/replicas/remove`, { method: 'POST', body: { hashes: bad.slice(i, i + 1000) } });
  } catch {}

  await stamp(root, 'lastVerifiedAt');
  update({ phase: 'Done', checked: rows.length, total: rows.length, bad: badCount });
  return { drive: meta.name, checked: rows.length, healthy: rows.length - badCount, bad: badCount };
}

export async function backupRestore(path, update = () => {}) {
  const root = resolve(path);
  const result = await restoreBackup(root, api, update);
  await stamp(root, 'lastRestoreAt');
  return result;
}

export async function backupStatus(path) {
  const root = resolve(path);
  const meta = await readBackup(root);
  await rememberBackup(root);
  const db = openInventory(root);
  const local = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes, MIN(verified_at) AS oldestVerification FROM objects').get();
  db.close();
  let remote = null;
  try { remote = await registerBackup(meta); } catch {}
  return { path: root, meta, local: { count: Number(local.count) || 0, bytes: Number(local.bytes) || 0, oldestVerification: local.oldestVerification }, remote };
}

async function pathInfo(path) {
  const root = resolve(path);
  const fs = await statfs(root);
  let meta = null;
  try { meta = await readBackup(root); } catch {}
  return {
    path: root,
    totalBytes: Number(fs.blocks) * Number(fs.bsize),
    freeBytes: Number(fs.bavail) * Number(fs.bsize),
    managed: Boolean(meta),
    meta
  };
}

async function roots() {
  const candidates = [];
  if (platform() === 'win32') {
    for (let code = 67; code <= 90; code++) candidates.push(`${String.fromCharCode(code)}:\\`);
  } else if (platform() === 'darwin') {
    candidates.push('/');
    try { for (const entry of await readdir('/Volumes', { withFileTypes: true })) if (entry.isDirectory()) candidates.push(join('/Volumes', entry.name)); } catch {}
  } else {
    candidates.push('/');
    for (const base of ['/mnt', join('/media', userInfo().username), join('/run/media', userInfo().username)]) {
      try { for (const entry of await readdir(base, { withFileTypes: true })) if (entry.isDirectory()) candidates.push(join(base, entry.name)); } catch {}
    }
  }
  const result = [];
  for (const path of [...new Set(candidates)]) {
    try { result.push(await pathInfo(path)); } catch {}
  }
  return result;
}

export async function backupLocations() {
  const discovered = (await roots()).filter(item => item.managed).map(item => item.path);
  const result = [];
  for (const path of [...new Set([...settings.backups, ...discovered])]) {
    try {
      const info = await pathInfo(path);
      if (!info.managed) continue;
      const status = await backupStatus(path);
      result.push({ ...info, local: status.local, remote: status.remote });
    } catch {}
  }
  return result;
}

export const backupContents = inspectBackup;

export async function backupCollections() {
  const data = await api('/api/smart-collections');
  return data.collections || [];
}
