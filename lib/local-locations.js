import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { browseRootKey } from './browse-folders.js';
import { browseStageRows } from './browse-staging.js';
import { mimeFor } from './mime.js';

const locationId = root => `local:${createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 16)}`;

function localFolders() {
  const protectedFolders = settings.folders.map(folder => ({ path: folder.path, rootKey: pathKey(folder.path), protected: true }));
  const browseFolders = settings.browseFolders.map(path => ({ path, rootKey: browseRootKey(path), protected: false }));
  return [...protectedFolders, ...browseFolders].map(folder => ({
    id: locationId(folder.path),
    kind: 'local',
    name: basename(folder.path) || folder.path,
    deviceName: settings.device,
    rootPath: folder.path,
    available: existsSync(folder.path),
    protected: folder.protected,
    rootKey: folder.rootKey
  }));
}

export function localLocations(hash = '') {
  const folders = localFolders();
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

function catalogFile(row, folder) {
  const date = new Date(Number(row.mtimeMs) || 0).toISOString();
  return {
    hash: row.hash,
    size: Number(row.size) || 0,
    mime: mimeFor(row.path),
    createdAt: date,
    filename: basename(row.path),
    originalPath: row.path,
    fileDate: date,
    addedAt: date,
    dateSource: 'filesystem.mtime',
    capturedAt: null,
    width: 0,
    height: 0,
    importIds: [],
    exactImportIds: [],
    searchText: `${folder.name} ${folder.rootPath} ${row.path}`,
    reviewed: false,
    backupCount: 0,
    serverStored: false,
    localAvailable: true
  };
}

// Small, index-only catalog used to paint local files while the full merged
// server/backup/provider catalog is still loading. Rows from an active Browse
// scan's separate staging DB come first, so a brand-new huge folder starts
// appearing progressively without invalidating the canonical provider cache.
export function localCatalog(limit = 720) {
  const folders = localFolders();
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 720));
  if (!folders.length) return { files: [] };

  const byRoot = new Map(folders.map(folder => [folder.rootKey, folder]));
  const rows = browseStageRows(safeLimit * 2);

  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 1500 });
    try {
      rows.push(...db.prepare(`
        SELECT root, path, size, mtime_ms AS mtimeMs, hash
        FROM file_hashes
        ORDER BY root, path
        LIMIT ?
      `).all(safeLimit * 2));
    } finally {
      db.close();
    }
  }

  const seen = new Set();
  const files = [];
  for (const row of rows) {
    const folder = byRoot.get(row.root);
    if (!folder || seen.has(row.hash)) continue;
    seen.add(row.hash);
    files.push(catalogFile(row, folder));
    if (files.length >= safeLimit) break;
  }
  return { files };
}
