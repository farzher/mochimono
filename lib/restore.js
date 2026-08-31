import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const controlPath = root => join(root, '.mochimono');
const objectPath = (root, hash) => join(controlPath(root), 'objects', hash.slice(0, 2), hash);

function openBackup(root) {
  const catalogPath = join(controlPath(root), 'catalog.sqlite');
  const inventoryPath = join(controlPath(root), 'inventory.sqlite');
  if (!existsSync(catalogPath)) throw new Error('This backup has no catalog snapshot yet. Run Update first.');
  if (!existsSync(inventoryPath)) throw new Error('This backup has no inventory.');
  const db = new DatabaseSync(catalogPath, { readOnly: true, timeout: 5000 });
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
      lastVerifiedAt: meta.lastVerifiedAt || null,
      lastRestoreAt: meta.lastRestoreAt || null
    };
  } finally { db.close(); }
}

async function uploadObject(api, root, object) {
  const path = objectPath(root, object.hash);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || Number(info.size) !== Number(object.size)) throw new Error(`Backup object missing or wrong size: ${object.hash}`);
  await api(`/api/objects/${object.hash}`, {
    method: 'PUT',
    headers: { 'content-length': String(object.size), 'x-mochimono-mime': String(object.mime || 'application/octet-stream') },
    body: createReadStream(path)
  });
}

async function restoreSources(api, db, ignored) {
  const currentImports = (await api('/api/imports')).imports || [];
  const importIds = new Map(currentImports.map(item => [String(item.sourceName), Number(item.id)]));
  const sourceNames = db.prepare(`
    SELECT DISTINCT i.source_name AS sourceName
    FROM sources s JOIN imports i ON i.id = s.import_id
    JOIN backup_inventory.objects b ON b.hash = s.object_hash
    ORDER BY lower(i.source_name)
  `).all().map(item => String(item.sourceName));

  for (const sourceName of sourceNames) {
    if (!importIds.has(sourceName)) {
      const imported = await api('/api/imports', { method: 'POST', body: { sourceName } });
      importIds.set(sourceName, Number(imported.id));
    }
    const rows = db.prepare(`
      SELECT s.object_hash AS hash, s.original_path AS path, s.filename, s.mtime
      FROM sources s JOIN imports i ON i.id = s.import_id
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      WHERE i.source_name = ? ORDER BY s.original_path
    `).all(sourceName).filter(row => !ignored.has(row.hash));
    for (let offset = 0; offset < rows.length; offset += 1000) {
      await api('/api/sources', { method: 'POST', body: { importId: importIds.get(sourceName), sources: rows.slice(offset, offset + 1000) } });
    }
  }

  const roots = db.prepare(`
    SELECT i.source_name AS sourceName, COALESCE(MAX(ir.device_name), '') AS deviceName,
           COALESCE(MAX(ir.root_path), '') AS rootPath
    FROM imports i JOIN sources s ON s.import_id = i.id
    JOIN backup_inventory.objects b ON b.hash = s.object_hash
    LEFT JOIN import_roots ir ON ir.import_id = i.id
    GROUP BY i.source_name
  `).all().filter(item => item.deviceName || item.rootPath);
  if (roots.length) {
    await api('/api/import-roots', {
      method: 'POST',
      body: { roots: roots.map(item => ({ importId: importIds.get(String(item.sourceName)), deviceName: item.deviceName, rootPath: item.rootPath })) }
    });
  }
}

async function restoreMetadata(api, db) {
  const rows = db.prepare(`
    SELECT mm.object_hash AS hash, mm.captured_at AS capturedAt, mm.source
    FROM media_metadata mm JOIN backup_inventory.objects b ON b.hash = mm.object_hash
  `).all();
  for (let offset = 0; offset < rows.length; offset += 20) {
    await Promise.all(rows.slice(offset, offset + 20).map(row => api(`/api/media-metadata/${row.hash}`, {
      method: 'POST', body: { capturedAt: row.capturedAt, source: row.source }
    })));
  }
}

export async function restoreBackup(backupFolder, api, update = () => {}) {
  const root = resolve(backupFolder);
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
      const result = await api('/api/objects/check', { method: 'POST', body: { hashes: batch.map(item => item.hash) } });
      for (const hash of result.missing || []) missing.add(hash);
      for (const hash of result.ignored || []) ignored.add(hash);
    }

    const totalBytes = objects.filter(item => missing.has(item.hash)).reduce((sum, item) => sum + Number(item.size), 0);
    const already = Math.max(0, objects.length - missing.size - ignored.size);
    let restored = 0;
    let restoredBytes = 0;
    let checked = 0;
    update({ phase: 'Restoring to Mochimono', checked, total: objects.length, restored, already, ignored: ignored.size, doneBytes: 0, totalBytes });

    for (const object of objects) {
      if (missing.has(object.hash)) {
        await uploadObject(api, root, object);
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
    await restoreSources(api, db, ignored);
    await restoreMetadata(api, db);
    update({ phase: 'Done', checked: objects.length, total: objects.length, restored, already, ignored: ignored.size, doneBytes: restoredBytes, totalBytes });
    return { destination: 'Mochimono', total: objects.length, restored, already, ignored: ignored.size, restoredBytes };
  } finally { db.close(); }
}
