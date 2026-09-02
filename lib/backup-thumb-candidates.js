import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { settings } from './agent-context.js';

const CONTROL = '.mochimono';
const objectPath = (root, hash) => join(root, CONTROL, 'objects', hash.slice(0, 2), hash);

function openBackup(root) {
  const catalog = join(root, CONTROL, 'catalog.sqlite');
  const inventory = join(root, CONTROL, 'inventory.sqlite');
  if (!existsSync(catalog) || !existsSync(inventory)) return null;
  let db;
  try {
    db = new DatabaseSync(catalog, { readOnly: true, timeout: 1000 });
    db.exec(`ATTACH DATABASE '${inventory.replaceAll("'", "''")}' AS backup_inventory`);
    return db;
  } catch {
    try { db?.close(); } catch {}
    return null;
  }
}

export function backupThumbnailCandidates(hashes) {
  const wanted = [...new Set((hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  const result = new Map();
  if (!wanted.length) return result;

  for (const root of settings.backups) {
    const unresolved = wanted.filter(hash => !result.has(hash));
    if (!unresolved.length) break;
    const db = openBackup(root);
    if (!db) continue;
    try {
      for (let offset = 0; offset < unresolved.length; offset += 300) {
        const chunk = unresolved.slice(offset, offset + 300);
        const marks = chunk.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT b.hash, b.size,
                 COALESCE(o.mime, 'application/octet-stream') AS mime,
                 COALESCE(MIN(s.filename), b.hash) AS filename
          FROM backup_inventory.objects b
          LEFT JOIN objects o ON o.hash = b.hash
          LEFT JOIN sources s ON s.object_hash = b.hash
          WHERE b.hash IN (${marks})
          GROUP BY b.hash, b.size, o.mime
        `).all(...chunk);
        for (const row of rows) if (!result.has(row.hash)) {
          result.set(row.hash, {
            hash: row.hash,
            filename: row.filename || row.hash,
            mime: row.mime || 'application/octet-stream',
            candidate: {
              kind: 'backup', path: objectPath(root, row.hash), size: Number(row.size) || 0,
              mime: row.mime || 'application/octet-stream', root
            }
          });
        }
      }
    } finally {
      db.close();
    }
  }
  return result;
}
