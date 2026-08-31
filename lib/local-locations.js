import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';

const locationId = root => `local:${createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 16)}`;

export function localLocations(hash = '') {
  const folders = settings.folders.map(folder => ({
    id: locationId(folder.path),
    kind: 'local',
    name: basename(folder.path) || folder.path,
    deviceName: settings.device,
    rootPath: folder.path,
    available: existsSync(folder.path),
    rootKey: pathKey(folder.path)
  }));

  if (!folders.length || !existsSync(SYNC_INDEX_PATH)) return { locations: folders.map(({ rootKey, ...item }) => item), files: [] };

  const byRoot = new Map(folders.map(folder => [folder.rootKey, folder]));
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 5000 });
  try {
    const rows = hash
      ? db.prepare('SELECT root, path, hash FROM file_hashes WHERE hash = ?').all(String(hash))
      : db.prepare('SELECT root, path, hash FROM file_hashes ORDER BY root, path').all();
    return {
      locations: folders.map(({ rootKey, ...item }) => item),
      files: rows
        .map(row => {
          const location = byRoot.get(row.root);
          return location ? [row.hash, location.id, row.path] : null;
        })
        .filter(Boolean)
    };
  } finally {
    db.close();
  }
}
