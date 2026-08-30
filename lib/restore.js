import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

function objectPath(root, hash) {
  return join(root, '.mochimono', 'objects', hash.slice(0, 2), hash);
}

function safePart(value, fallback = 'Recovered') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || fallback;
}

function relativeParts(value, fallback) {
  const parts = String(value || '')
    .split(/[\\/]+/)
    .filter(part => part && part !== '.')
    .map(part => part === '..' ? '_' : safePart(part, '_'));
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
  const verifier = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    }
  });

  try {
    await pipeline(createReadStream(source), verifier, createWriteStream(temp, { flags: 'wx' }));
    if (size !== expectedSize || digest.digest('hex') !== hash) throw new Error(`Backup object failed verification: ${hash}`);
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function restoreBackup(backupFolder, destinationFolder, update = () => {}) {
  const backup = resolve(backupFolder);
  const destination = resolve(destinationFolder);
  const catalogPath = join(backup, '.mochimono', 'catalog.sqlite');
  const inventoryPath = join(backup, '.mochimono', 'inventory.sqlite');
  if (!existsSync(catalogPath)) throw new Error('This backup has no catalog snapshot yet. Run Update Backup first.');
  if (!existsSync(inventoryPath)) throw new Error('This backup has no inventory.');

  await mkdir(destination, { recursive: true });
  const destinationInfo = await stat(destination);
  if (!destinationInfo.isDirectory()) throw new Error(`${destination} is not a directory`);

  const catalog = new DatabaseSync(catalogPath, { readOnly: true });
  const allRows = catalog.prepare(`
    SELECT s.object_hash AS hash, s.original_path AS originalPath, s.filename,
           s.mtime, i.source_name AS sourceName, o.size
    FROM sources s
    JOIN imports i ON i.id = s.import_id
    JOIN objects o ON o.hash = s.object_hash
    WHERE o.state = 'active'
    ORDER BY i.id, s.original_path
  `).all();
  catalog.close();

  // The catalog snapshot describes the whole library. The local inventory tells us
  // which subset this particular backup intentionally contains.
  const inventory = new DatabaseSync(inventoryPath, { readOnly: true });
  const hasObject = inventory.prepare('SELECT 1 FROM objects WHERE hash = ?');
  const rows = allRows.filter(row => hasObject.get(row.hash));
  inventory.close();

  let restored = 0;
  let skipped = 0;
  let missing = 0;
  let conflicts = 0;
  let restoredBytes = 0;

  update({ phase: 'Preparing restore', total: rows.length, restored, skipped, missing, conflicts });

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const source = objectPath(backup, row.hash);
    if (!existsSync(source)) {
      missing++;
      update({ phase: 'Restoring', checked: index + 1, total: rows.length, restored, skipped, missing, conflicts, current: row.originalPath });
      continue;
    }

    const sourceFolder = safePart(row.sourceName, 'Recovered');
    let target = join(destination, sourceFolder, ...relativeParts(row.originalPath, row.filename));

    if (existsSync(target)) {
      const existing = await stat(target).catch(() => null);
      if (existing?.isFile() && existing.size === row.size && await hashFile(target) === row.hash) {
        skipped++;
        update({ phase: 'Restoring', checked: index + 1, total: rows.length, restored, skipped, missing, conflicts, current: row.originalPath });
        continue;
      }
      target = collisionPath(target, row.hash);
      conflicts++;
      if (existsSync(target)) {
        const existingCollision = await stat(target).catch(() => null);
        if (existingCollision?.isFile() && existingCollision.size === row.size && await hashFile(target) === row.hash) {
          skipped++;
          update({ phase: 'Restoring', checked: index + 1, total: rows.length, restored, skipped, missing, conflicts, current: row.originalPath });
          continue;
        }
        throw new Error(`Restore destination already contains conflicting files for ${row.originalPath}`);
      }
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
}
