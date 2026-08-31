import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const LIBRARY_DESTINATION = '@library';

const controlPath = root => join(root, '.mochimono');
const catalogPath = root => join(controlPath(root), 'catalog.sqlite');
const inventoryPath = root => join(controlPath(root), 'inventory.sqlite');
const objectPath = (root, hash) => join(controlPath(root), 'objects', hash.slice(0, 2), hash);

function openBackup(root) {
  const catalogFile = catalogPath(root);
  const inventoryFile = inventoryPath(root);
  if (!existsSync(catalogFile)) throw new Error('This backup has no catalog snapshot yet. Run Update first.');
  if (!existsSync(inventoryFile)) throw new Error('This backup has no inventory.');

  const catalog = new DatabaseSync(catalogFile, { readOnly: true });
  const escaped = inventoryFile.replaceAll("'", "''");
  catalog.exec(`ATTACH DATABASE '${escaped}' AS backup_inventory`);
  return catalog;
}

async function readMeta(root) {
  try { return JSON.parse(await readFile(join(controlPath(root), 'drive.json'), 'utf8')); }
  catch { return {}; }
}

export async function inspectBackup(backupFolder) {
  const root = resolve(backupFolder);
  const meta = await readMeta(root);
  const db = openBackup(root);
  try {
    const summary = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
      FROM backup_inventory.objects
    `).get();
    const sources = db.prepare(`
      SELECT i.source_name AS sourceName, COUNT(DISTINCT s.object_hash) AS files
      FROM sources s
      JOIN imports i ON i.id = s.import_id
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      GROUP BY i.source_name
      ORDER BY files DESC, lower(i.source_name)
    `).all();
    const sample = db.prepare(`
      SELECT s.object_hash AS hash, s.filename, s.original_path AS path,
             i.source_name AS sourceName, o.size
      FROM sources s
      JOIN imports i ON i.id = s.import_id
      JOIN objects o ON o.hash = s.object_hash
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      ORDER BY i.id, s.original_path
      LIMIT 20
    `).all();
    return {
      path: root,
      name: meta.name || basename(root),
      count: Number(summary.count) || 0,
      bytes: Number(summary.bytes) || 0,
      sources: sources.map(item => ({ ...item, files: Number(item.files) || 0 })),
      sample,
      policy: meta.policy || { all: true },
      createdAt: meta.createdAt || null,
      lastBackupAt: meta.lastBackupAt || null,
      lastVerifiedAt: meta.lastVerifiedAt || null
    };
  } finally {
    db.close();
  }
}

async function settings() {
  let saved = {};
  try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
  return {
    server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
    token: String(process.env.MOCHIMONO_TOKEN || saved.token || '')
  };
}

async function api(config, path, options = {}) {
  if (!config.token) throw new Error('Connect to the Mochimono server first');
  const headers = { authorization: `Bearer ${config.token}`, ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== 'string' && !body.pipe && !body[Symbol.asyncIterator]) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const streaming = body?.pipe || body?.[Symbol.asyncIterator];
  const response = await fetch(`${config.server}${path}`, {
    ...options,
    headers,
    body,
    duplex: streaming ? 'half' : undefined
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return (response.headers.get('content-type') || '').includes('application/json') ? response.json() : response;
}

async function uploadObject(config, root, object) {
  const path = objectPath(root, object.hash);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || Number(info.size) !== Number(object.size)) {
    throw new Error(`Backup object missing or wrong size: ${object.hash}`);
  }
  await api(config, `/api/objects/${object.hash}`, {
    method: 'PUT',
    headers: {
      'content-length': String(object.size),
      'x-mochimono-mime': String(object.mime || 'application/octet-stream')
    },
    body: createReadStream(path)
  });
}

async function restoreMetadata(config, db) {
  const rows = db.prepare(`
    SELECT mm.object_hash AS hash, mm.captured_at AS capturedAt, mm.source
    FROM media_metadata mm
    JOIN backup_inventory.objects b ON b.hash = mm.object_hash
  `).all();
  for (let offset = 0; offset < rows.length; offset += 20) {
    await Promise.all(rows.slice(offset, offset + 20).map(row =>
      api(config, `/api/media-metadata/${row.hash}`, {
        method: 'POST',
        body: { capturedAt: row.capturedAt, source: row.source }
      }).catch(() => null)
    ));
  }
}

async function restoreSources(config, db, ignored) {
  const existing = (await api(config, '/api/imports')).imports || [];
  const importIds = new Map(existing.map(item => [String(item.sourceName), Number(item.id)]));
  const created = new Set();
  const sourceNames = db.prepare(`
    SELECT DISTINCT i.source_name AS sourceName
    FROM sources s
    JOIN imports i ON i.id = s.import_id
    JOIN backup_inventory.objects b ON b.hash = s.object_hash
    ORDER BY lower(i.source_name)
  `).all().map(item => String(item.sourceName));

  for (const sourceName of sourceNames) {
    if (!importIds.has(sourceName)) {
      const imported = await api(config, '/api/imports', { method: 'POST', body: { sourceName } });
      importIds.set(sourceName, Number(imported.id));
      created.add(sourceName);
    }

    const rows = db.prepare(`
      SELECT s.object_hash AS hash, s.original_path AS path, s.filename, s.mtime
      FROM sources s
      JOIN imports i ON i.id = s.import_id
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      WHERE i.source_name = ?
      ORDER BY s.original_path
    `).all(sourceName).filter(row => !ignored.has(row.hash));

    for (let offset = 0; offset < rows.length; offset += 1000) {
      await api(config, '/api/sources', {
        method: 'POST',
        body: { importId: importIds.get(sourceName), sources: rows.slice(offset, offset + 1000) }
      });
    }
  }

  const roots = db.prepare(`
    SELECT i.source_name AS sourceName,
           COALESCE(MAX(ir.device_name), '') AS deviceName,
           COALESCE(MAX(ir.root_path), '') AS rootPath
    FROM imports i
    JOIN sources s ON s.import_id = i.id
    JOIN backup_inventory.objects b ON b.hash = s.object_hash
    LEFT JOIN import_roots ir ON ir.import_id = i.id
    GROUP BY i.source_name
  `).all().filter(item => created.has(String(item.sourceName)) && (item.deviceName || item.rootPath));
  if (roots.length) {
    await api(config, '/api/import-roots', {
      method: 'POST',
      body: { roots: roots.map(item => ({ importId: importIds.get(String(item.sourceName)), deviceName: item.deviceName, rootPath: item.rootPath })) }
    }).catch(() => null);
  }
}

async function restoreToLibrary(backupFolder, update) {
  const root = resolve(backupFolder);
  const config = await settings();
  const db = openBackup(root);
  try {
    const objects = db.prepare(`
      SELECT o.hash, o.size, o.mime
      FROM objects o
      JOIN backup_inventory.objects b ON b.hash = o.hash
      WHERE o.state = 'active'
      ORDER BY o.hash
    `).all();
    const inventory = db.prepare('SELECT COUNT(*) AS count FROM backup_inventory.objects').get();
    if (Number(inventory.count) !== objects.length) throw new Error('Backup catalog and inventory do not match. Verify this backup before restoring.');

    const missing = new Set();
    const ignored = new Set();
    for (let offset = 0; offset < objects.length; offset += 1000) {
      const batch = objects.slice(offset, offset + 1000);
      const result = await api(config, '/api/objects/check', { method: 'POST', body: { hashes: batch.map(item => item.hash) } });
      for (const hash of result.missing || []) missing.add(hash);
      for (const hash of result.ignored || []) ignored.add(hash);
    }

    const totalBytes = objects.filter(item => missing.has(item.hash)).reduce((sum, item) => sum + Number(item.size), 0);
    let restored = 0;
    let restoredBytes = 0;
    let checked = 0;
    const already = objects.length - missing.size - ignored.size;
    update({ phase: 'Restoring to Mochimono', checked, total: objects.length, restored, already, ignored: ignored.size, doneBytes: 0, totalBytes });

    for (const object of objects) {
      if (missing.has(object.hash)) {
        await uploadObject(config, root, object);
        restored++;
        restoredBytes += Number(object.size);
      }
      checked++;
      update({
        phase: 'Restoring to Mochimono',
        checked,
        total: objects.length,
        restored,
        already,
        ignored: ignored.size,
        current: object.hash.slice(0, 12),
        doneBytes: restoredBytes,
        totalBytes
      });
    }

    update({ phase: 'Restoring file information', checked: 0, total: objects.length, restored, already, ignored: ignored.size });
    await restoreSources(config, db, ignored);
    await restoreMetadata(config, db);
    update({ phase: 'Done', checked: objects.length, total: objects.length, restored, already, ignored: ignored.size, doneBytes: restoredBytes, totalBytes });
    return { destination: 'Mochimono', total: objects.length, restored, already, ignored: ignored.size, restoredBytes };
  } finally {
    db.close();
  }
}

function safePart(value, fallback = 'Recovered') {
  const cleaned = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || fallback;
}

function relativeParts(value, fallback) {
  const parts = String(value || '').split(/[\\/]+/).filter(part => part && part !== '.').map(part => part === '..' ? '_' : safePart(part, '_'));
  return parts.length ? parts : [safePart(fallback, 'file')];
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function collisionPath(path, hash) {
  const extension = extname(path);
  const stem = basename(path, extension);
  return join(dirname(path), `${stem} (${hash.slice(0, 8)})${extension}`);
}

async function copyVerified(source, destination, hash, expectedSize) {
  const temp = `${destination}.mochimono-${process.pid}-${Date.now()}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  const digest = createHash('sha256');
  let size = 0;
  const verifier = new Transform({ transform(chunk, encoding, callback) { digest.update(chunk); size += chunk.length; callback(null, chunk); } });
  try {
    await pipeline(createReadStream(source), verifier, createWriteStream(temp, { flags: 'wx' }));
    if (size !== expectedSize || digest.digest('hex') !== hash) throw new Error(`Backup object failed verification: ${hash}`);
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function restoreToFolder(backupFolder, destinationFolder, update) {
  const backup = resolve(backupFolder);
  const destination = resolve(destinationFolder);
  const db = openBackup(backup);
  await mkdir(destination, { recursive: true });
  const destinationInfo = await stat(destination);
  if (!destinationInfo.isDirectory()) throw new Error(`${destination} is not a directory`);

  try {
    const rows = db.prepare(`
      SELECT s.object_hash AS hash, s.original_path AS originalPath, s.filename,
             s.mtime, i.source_name AS sourceName, o.size
      FROM sources s
      JOIN imports i ON i.id = s.import_id
      JOIN objects o ON o.hash = s.object_hash
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      WHERE o.state = 'active'
      ORDER BY i.id, s.original_path
    `).all();
    let restored = 0;
    let skipped = 0;
    let missing = 0;
    let conflicts = 0;
    let restoredBytes = 0;
    update({ phase: 'Preparing restore', total: rows.length, restored, skipped, missing, conflicts });

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const source = objectPath(backup, row.hash);
      if (!existsSync(source)) { missing++; update({ phase: 'Restoring', checked: index + 1, total: rows.length, restored, skipped, missing, conflicts, current: row.originalPath }); continue; }
      let target = join(destination, safePart(row.sourceName, 'Recovered'), ...relativeParts(row.originalPath, row.filename));
      if (existsSync(target)) {
        const existing = await stat(target).catch(() => null);
        if (existing?.isFile() && existing.size === row.size && await hashFile(target) === row.hash) {
          skipped++;
          update({ phase: 'Restoring', checked: index + 1, total: rows.length, restored, skipped, missing, conflicts, current: row.originalPath });
          continue;
        }
        target = collisionPath(target, row.hash);
        conflicts++;
      }
      update({ phase: 'Restoring', checked: index + 1, total: rows.length, restored, skipped, missing, conflicts, current: row.originalPath });
      await copyVerified(source, target, row.hash, row.size);
      if (row.mtime) {
        const date = new Date(row.mtime);
        if (!Number.isNaN(date.getTime())) await utimes(target, date, date).catch(() => {});
      }
      restored++;
      restoredBytes += row.size;
    }
    update({ phase: 'Done', checked: rows.length, total: rows.length, restored, skipped, missing, conflicts, restoredBytes });
    return { destination, total: rows.length, restored, skipped, missing, conflicts, restoredBytes };
  } finally {
    db.close();
  }
}

export async function restoreBackup(backupFolder, destinationFolder, update = () => {}) {
  return destinationFolder === LIBRARY_DESTINATION
    ? restoreToLibrary(backupFolder, update)
    : restoreToFolder(backupFolder, destinationFolder, update);
}
