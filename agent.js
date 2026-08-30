import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const SERVER = (process.env.MOCHIMONO_URL || 'http://127.0.0.1:8642').replace(/\/$/, '');
const TOKEN = process.env.MOCHIMONO_TOKEN || '';
const BATCH = 250;

function usage() {
  console.log(`Mochimono agent

Environment:
  MOCHIMONO_URL    Server URL (default http://127.0.0.1:8642)
  MOCHIMONO_TOKEN  Required server token

Commands:
  import <folder> [--source=name]
  backup-init <drive-path> [--name=name] [--types=image,video,...]
  backup-update <drive-path>
  backup-verify <drive-path>
  backup-status <drive-path>
`);
}

function requireToken() {
  if (!TOKEN) throw new Error('MOCHIMONO_TOKEN is required');
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      flags[key] = rest.length ? rest.join('=') : true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function api(path, options = {}) {
  requireToken();
  const headers = { authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== 'string' && !body.pipe && !body[Symbol.asyncIterator]) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const streaming = body?.pipe || body?.[Symbol.asyncIterator];
  const response = await fetch(`${SERVER}${path}`, { ...options, headers, body, duplex: streaming ? 'half' : undefined });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response;
}

async function* filesUnder(root, directory = root) {
  const { opendir } = await import('node:fs/promises');
  const dir = await opendir(directory);
  for await (const entry of dir) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(root, path);
    else if (entry.isFile()) yield path;
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const MIME = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.heic', 'image/heic'], ['.avif', 'image/avif'],
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.mkv', 'video/x-matroska'], ['.webm', 'video/webm'], ['.avi', 'video/x-msvideo'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.flac', 'audio/flac'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.json', 'application/json'], ['.csv', 'text/csv'], ['.html', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'],
  ['.pdf', 'application/pdf'], ['.zip', 'application/zip'], ['.7z', 'application/x-7z-compressed'], ['.rar', 'application/vnd.rar']
]);

function mimeFor(path) {
  return MIME.get(extname(path).toLowerCase()) || 'application/octet-stream';
}

async function uploadFile(record) {
  await api(`/api/objects/${record.hash}`, {
    method: 'PUT',
    headers: {
      'content-length': String(record.size),
      'x-mochimono-mime': record.mime
    },
    body: createReadStream(record.path)
  });
}

async function importBatch(importId, records, totals) {
  const firstByHash = new Map();
  for (const record of records) if (!firstByHash.has(record.hash)) firstByHash.set(record.hash, record);

  const check = await api('/api/objects/check', { method: 'POST', body: { hashes: [...firstByHash.keys()] } });
  const missing = new Set(check.missing);
  const ignored = new Set(check.ignored);
  let uploadedObjects = 0;

  for (const hash of missing) {
    const record = firstByHash.get(hash);
    process.stdout.write(`upload  ${record.relative}\n`);
    await uploadFile(record);
    totals.new++;
    totals.uploadedBytes += record.size;
    uploadedObjects++;
  }

  const accepted = records.filter(record => !ignored.has(record.hash));
  totals.ignored += records.length - accepted.length;
  totals.duplicates += accepted.length - uploadedObjects;

  const sources = accepted.map(record => ({ hash: record.hash, path: record.relative, filename: basename(record.path), mtime: record.mtime }));
  if (sources.length) await api('/api/sources', { method: 'POST', body: { importId, sources } });
}

async function importFolder(folder, flags) {
  const root = resolve(folder);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`${root} is not a directory`);
  const sourceName = String(flags.source || basename(root));
  const created = await api('/api/imports', { method: 'POST', body: { sourceName } });
  const totals = { scanned: 0, new: 0, duplicates: 0, ignored: 0, uploadedBytes: 0 };
  let batch = [];

  console.log(`Import #${created.id}: ${sourceName}`);
  for await (const path of filesUnder(root)) {
    const info = await stat(path);
    const hash = await hashFile(path);
    totals.scanned++;
    batch.push({
      path,
      relative: relative(root, path).replaceAll('\\', '/'),
      hash,
      size: info.size,
      mtime: info.mtime.toISOString(),
      mime: mimeFor(path)
    });
    if (batch.length >= BATCH) {
      await importBatch(created.id, batch, totals);
      batch = [];
      console.log(`scanned ${totals.scanned} | new ${totals.new} | duplicate ${totals.duplicates} | ignored ${totals.ignored}`);
    }
  }
  if (batch.length) await importBatch(created.id, batch, totals);
  console.log(`Done. ${totals.scanned} files scanned; ${totals.new} uploaded; ${totals.duplicates} already stored; ${totals.ignored} ignored; ${formatBytes(totals.uploadedBytes)} uploaded.`);
}

function driveMetaPath(root) { return join(root, '.mochimono', 'drive.json'); }
function driveDbPath(root) { return join(root, '.mochimono', 'inventory.sqlite'); }
function driveObjectsRoot(root) { return join(root, '.mochimono'); }

function openInventory(root) {
  const db = new DatabaseSync(driveDbPath(root), { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS objects (
      hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      stored_at TEXT NOT NULL,
      verified_at TEXT
    ) STRICT;
  `);
  return db;
}

async function readDrive(root) {
  return JSON.parse(await readFile(driveMetaPath(root), 'utf8'));
}

async function registerDrive(meta) {
  return api('/api/drives/register', { method: 'POST', body: meta });
}

function parseTypes(value) {
  if (!value) return { all: true, types: [] };
  const types = String(value).split(',').map(value => value.trim()).filter(Boolean);
  return types.length ? { all: false, types } : { all: true, types: [] };
}

async function backupInit(path, flags) {
  const root = resolve(path);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`${root} is not a directory`);
  const control = join(root, '.mochimono');
  if (existsSync(driveMetaPath(root))) throw new Error('This path is already a Mochimono backup drive');
  await mkdir(control, { recursive: true });
  const meta = {
    format: 1,
    id: randomUUID(),
    name: String(flags.name || basename(root) || 'Mochimono Backup'),
    policy: parseTypes(flags.types),
    createdAt: new Date().toISOString()
  };
  await writeFile(driveMetaPath(root), `${JSON.stringify(meta, null, 2)}\n`);
  const db = openInventory(root);
  db.close();
  await registerDrive(meta);
  console.log(`Initialized ${meta.name}`);
  console.log(`Drive ID: ${meta.id}`);
  console.log(`Policy: ${meta.policy.all ? 'everything' : meta.policy.types.join(', ')}`);
}

function backupObjectPath(root, hash) {
  return join(driveObjectsRoot(root), 'objects', hash.slice(0, 2), hash);
}

async function downloadVerified(hash, expectedSize, destination) {
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
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temp, { flags: 'wx' }));
    const actual = digest.digest('hex');
    if (actual !== hash || size !== expectedSize) throw new Error(`Verification failed for ${hash}`);
    await rm(destination, { force: true });
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function saveCatalogSnapshot(root) {
  const response = await api('/api/catalog/export');
  const target = join(root, '.mochimono', 'catalog.sqlite');
  const temp = `${target}.tmp`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  await rm(target, { force: true });
  await rename(temp, target);
}

async function reportReplicas(driveId, replicas) {
  if (!replicas.length) return;
  await api(`/api/drives/${encodeURIComponent(driveId)}/replicas`, { method: 'POST', body: { replicas } });
}

async function backupUpdate(path) {
  const root = resolve(path);
  const meta = await readDrive(root);
  await registerDrive(meta);
  const db = openInventory(root);
  const find = db.prepare('SELECT hash, size, verified_at FROM objects WHERE hash = ?');
  const save = db.prepare(`INSERT INTO objects(hash, size, stored_at, verified_at) VALUES(?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET size=excluded.size, stored_at=excluded.stored_at, verified_at=excluded.verified_at`);
  let after = '';
  let copied = 0;
  let copiedBytes = 0;
  let already = 0;
  let reports = [];

  do {
    const page = await api(`/api/drives/${encodeURIComponent(meta.id)}/desired?after=${encodeURIComponent(after)}&limit=1000`);
    for (const object of page.objects) {
      const destination = backupObjectPath(root, object.hash);
      const local = find.get(object.hash);
      if (local && existsSync(destination)) {
        already++;
        reports.push({ hash: object.hash, verifiedAt: local.verified_at });
      } else {
        process.stdout.write(`backup  ${object.hash.slice(0, 12)}  ${formatBytes(object.size)}\n`);
        await downloadVerified(object.hash, object.size, destination);
        const timestamp = new Date().toISOString();
        save.run(object.hash, object.size, timestamp, timestamp);
        reports.push({ hash: object.hash, verifiedAt: timestamp });
        copied++;
        copiedBytes += object.size;
      }
      if (reports.length >= 1000) {
        await reportReplicas(meta.id, reports);
        reports = [];
      }
    }
    after = page.nextAfter || '';
  } while (after);

  await reportReplicas(meta.id, reports);
  await saveCatalogSnapshot(root);
  db.close();
  console.log(`Done. ${copied} objects copied (${formatBytes(copiedBytes)}); ${already} already present. Catalog snapshot updated.`);
}

async function backupVerify(path) {
  const root = resolve(path);
  const meta = await readDrive(root);
  await registerDrive(meta);
  const db = openInventory(root);
  const rows = db.prepare('SELECT hash, size FROM objects ORDER BY hash').all();
  const mark = db.prepare('UPDATE objects SET verified_at = ? WHERE hash = ?');
  const forget = db.prepare('DELETE FROM objects WHERE hash = ?');
  const good = [];
  const bad = [];
  let badCount = 0;
  let checked = 0;

  for (const row of rows) {
    const path = backupObjectPath(root, row.hash);
    let ok = false;
    try {
      const info = await stat(path);
      ok = info.size === row.size && await hashFile(path) === row.hash;
    } catch {}
    checked++;
    if (ok) {
      const timestamp = new Date().toISOString();
      mark.run(timestamp, row.hash);
      good.push({ hash: row.hash, verifiedAt: timestamp });
    } else {
      forget.run(row.hash);
      bad.push(row.hash);
      badCount++;
      console.log(`BAD     ${row.hash}`);
    }
    if (good.length >= 1000) await reportReplicas(meta.id, good.splice(0));
    if (bad.length >= 1000) await api(`/api/drives/${encodeURIComponent(meta.id)}/replicas/remove`, { method: 'POST', body: { hashes: bad.splice(0) } });
    if (checked % 100 === 0) process.stdout.write(`verified ${checked}/${rows.length}\r`);
  }
  await reportReplicas(meta.id, good);
  if (bad.length) await api(`/api/drives/${encodeURIComponent(meta.id)}/replicas/remove`, { method: 'POST', body: { hashes: bad } });
  db.close();
  console.log(`\nVerification complete: ${rows.length - badCount} healthy; ${badCount} missing/corrupt.`);
}

async function backupStatus(path) {
  const root = resolve(path);
  const meta = await readDrive(root);
  const db = openInventory(root);
  const local = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes, MIN(verified_at) AS oldestVerification FROM objects').get();
  db.close();
  const remote = await registerDrive(meta);
  console.log(`${meta.name} (${meta.id})`);
  console.log(`Local inventory: ${local.count} objects, ${formatBytes(local.bytes)}`);
  console.log(`Server policy: ${remote.policy.all ? 'everything' : remote.policy.types.join(', ')}`);
  console.log(`Coverage known by server: ${remote.protectedCount}/${remote.desiredCount} objects (${formatBytes(remote.protectedBytes)} / ${formatBytes(remote.desiredBytes)})`);
  if (local.oldestVerification) console.log(`Oldest verification: ${local.oldestVerification}`);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

const [command, ...rawArgs] = process.argv.slice(2);
const { positional, flags } = parseArgs(rawArgs);

try {
  switch (command) {
    case 'import':
      if (!positional[0]) throw new Error('import requires a folder');
      await importFolder(positional[0], flags);
      break;
    case 'backup-init':
      if (!positional[0]) throw new Error('backup-init requires a drive path');
      await backupInit(positional[0], flags);
      break;
    case 'backup-update':
      if (!positional[0]) throw new Error('backup-update requires a drive path');
      await backupUpdate(positional[0]);
      break;
    case 'backup-verify':
      if (!positional[0]) throw new Error('backup-verify requires a drive path');
      await backupVerify(positional[0]);
      break;
    case 'backup-status':
      if (!positional[0]) throw new Error('backup-status requires a drive path');
      await backupStatus(positional[0]);
      break;
    default:
      usage();
      if (command) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
