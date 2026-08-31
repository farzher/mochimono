import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const controlPath = root => join(root, '.mochimono');
const objectPath = (root, hash) => join(controlPath(root), 'objects', hash.slice(0, 2), hash);

function openBackup(root) {
  const catalogPath = join(controlPath(root), 'catalog.sqlite');
  const inventoryPath = join(controlPath(root), 'inventory.sqlite');
  if (!existsSync(catalogPath)) throw new Error('This backup has no catalog snapshot yet. Run Update first.');
  if (!existsSync(inventoryPath)) throw new Error('This backup has no inventory.');
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  db.exec(`ATTACH DATABASE '${inventoryPath.replaceAll("'", "''")}' AS backup_inventory`);
  return db;
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
    const summary = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM backup_inventory.objects').get();
    const sources = db.prepare(`
      SELECT i.source_name AS sourceName, COUNT(DISTINCT s.object_hash) AS files
      FROM sources s JOIN imports i ON i.id = s.import_id
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      GROUP BY i.source_name ORDER BY files DESC, lower(i.source_name)
    `).all();
    const sample = db.prepare(`
      SELECT s.object_hash AS hash, s.filename, s.original_path AS path,
             i.source_name AS sourceName, o.size
      FROM sources s JOIN imports i ON i.id = s.import_id
      JOIN objects o ON o.hash = s.object_hash
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      ORDER BY i.id, s.original_path LIMIT 20
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
  } finally { db.close(); }
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
  const response = await fetch(`${config.server}${path}`, { ...options, headers, body, duplex: streaming ? 'half' : undefined });
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
  if (!info?.isFile() || Number(info.size) !== Number(object.size)) throw new Error(`Backup object missing or wrong size: ${object.hash}`);
  await api(config, `/api/objects/${object.hash}`, {
    method: 'PUT',
    headers: { 'content-length': String(object.size), 'x-mochimono-mime': String(object.mime || 'application/octet-stream') },
    body: createReadStream(path)
  });
}

async function restoreSources(config, db, ignored) {
  const imports = (await api(config, '/api/imports')).imports || [];
  const importIds = new Map(imports.map(item => [String(item.sourceName), Number(item.id)]));
  const created = new Set();
  const sourceNames = db.prepare(`
    SELECT DISTINCT i.source_name AS sourceName
    FROM sources s JOIN imports i ON i.id = s.import_id
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
      FROM sources s JOIN imports i ON i.id = s.import_id
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      WHERE i.source_name = ? ORDER BY s.original_path
    `).all(sourceName).filter(row => !ignored.has(row.hash));
    for (let offset = 0; offset < rows.length; offset += 1000) {
      await api(config, '/api/sources', { method: 'POST', body: { importId: importIds.get(sourceName), sources: rows.slice(offset, offset + 1000) } });
    }
  }

  const roots = db.prepare(`
    SELECT i.source_name AS sourceName, COALESCE(MAX(ir.device_name), '') AS deviceName,
           COALESCE(MAX(ir.root_path), '') AS rootPath
    FROM imports i JOIN sources s ON s.import_id = i.id
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

async function restoreMetadata(config, db) {
  const rows = db.prepare(`
    SELECT mm.object_hash AS hash, mm.captured_at AS capturedAt, mm.source
    FROM media_metadata mm JOIN backup_inventory.objects b ON b.hash = mm.object_hash
  `).all();
  for (let offset = 0; offset < rows.length; offset += 20) {
    await Promise.all(rows.slice(offset, offset + 20).map(row => api(config, `/api/media-metadata/${row.hash}`, {
      method: 'POST', body: { capturedAt: row.capturedAt, source: row.source }
    }).catch(() => null)));
  }
}

export async function restoreBackup(backupFolder, destination, update = () => {}) {
  if (destination !== 'Mochimono') throw new Error('Restore destination must be Mochimono');
  const root = resolve(backupFolder);
  const config = await settings();
  const db = openBackup(root);
  try {
    const objects = db.prepare(`
      SELECT b.hash, b.size, COALESCE(o.mime, 'application/octet-stream') AS mime
      FROM backup_inventory.objects b
      LEFT JOIN objects o ON o.hash = b.hash
      ORDER BY b.hash
    `).all();
    const missing = new Set();
    const ignored = new Set();
    for (let offset = 0; offset < objects.length; offset += 1000) {
      const batch = objects.slice(offset, offset + 1000);
      const result = await api(config, '/api/objects/check', { method: 'POST', body: { hashes: batch.map(item => item.hash) } });
      for (const hash of result.missing || []) missing.add(hash);
      for (const hash of result.ignored || []) ignored.add(hash);
    }

    const totalBytes = objects.filter(item => missing.has(item.hash)).reduce((sum, item) => sum + Number(item.size), 0);
    const already = objects.length - missing.size - ignored.size;
    let restored = 0;
    let restoredBytes = 0;
    let checked = 0;
    update({ phase: 'Restoring to Mochimono', checked, total: objects.length, restored, already, ignored: ignored.size, doneBytes: 0, totalBytes });

    for (const object of objects) {
      if (missing.has(object.hash)) {
        await uploadObject(config, root, object);
        restored++;
        restoredBytes += Number(object.size);
      }
      update({
        phase: 'Restoring to Mochimono', checked: ++checked, total: objects.length,
        restored, already, ignored: ignored.size, current: object.hash.slice(0, 12),
        doneBytes: restoredBytes, totalBytes
      });
    }

    update({ phase: 'Restoring file information', checked: 0, total: objects.length, restored, already, ignored: ignored.size });
    await restoreSources(config, db, ignored);
    await restoreMetadata(config, db);
    update({ phase: 'Done', checked: objects.length, total: objects.length, restored, already, ignored: ignored.size, doneBytes: restoredBytes, totalBytes });
    return { destination: 'Mochimono', total: objects.length, restored, already, ignored: ignored.size, restoredBytes };
  } finally { db.close(); }
}
