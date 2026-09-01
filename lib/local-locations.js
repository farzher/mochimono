import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { browseRootKey } from './browse-folders.js';
import { browseStageByHashes, browseStageRows } from './browse-staging.js';
import { mimeFor } from './mime.js';

const configuredPath = value => {
  const raw = typeof value === 'string' ? value : value?.path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
};
const locationId = root => `local:${createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 16)}`;
let sampleCacheKey = '';
let sampleCacheAt = 0;
let sampleCache = [];

function localFolders() {
  const protectedFolders = (settings.folders || [])
    .map(folder => configuredPath(folder))
    .filter(Boolean)
    .map(path => ({ path, rootKey: pathKey(path), protected: true }));
  const browseFolders = (settings.browseFolders || [])
    .map(path => configuredPath(path))
    .filter(Boolean)
    .map(path => ({ path, rootKey: browseRootKey(path), protected: false }));
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

function safeLocalPath(root, relativePath) {
  if (typeof root !== 'string' || !root.trim()) return null;
  if (typeof relativePath !== 'string' || !relativePath.trim()) return null;
  let base;
  let target;
  try {
    base = resolve(root);
    target = resolve(base, ...relativePath.replaceAll('\\', '/').split('/').filter(Boolean));
  } catch {
    return null;
  }
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  return targetKey === baseKey || targetKey.startsWith(`${baseKey}${sep}`) ? target : null;
}

function candidateFor(row, folder) {
  const root = folder?.rootPath || folder?.path || '';
  if (!row || !root || !row.path || !row.hash) return null;
  const path = safeLocalPath(root, row.path);
  if (!path) return null;
  return {
    kind: 'local',
    hash: String(row.hash),
    path,
    size: Number(row.size) || 0,
    mime: mimeFor(row.path),
    filename: basename(row.path),
    root,
    protected: folder.protected
  };
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

export function localCandidates(hashes) {
  const wanted = [...new Set((hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  const result = new Map();
  if (!wanted.length) return result;
  const folders = localFolders();
  const byRoot = new Map(folders.map(folder => [folder.rootKey, folder]));

  for (const row of browseStageByHashes(wanted)) {
    const folder = byRoot.get(row.root);
    const candidate = folder && candidateFor(row, folder);
    if (candidate) result.set(candidate.hash, candidate);
  }

  if (!existsSync(SYNC_INDEX_PATH) || result.size === wanted.length) return result;
  const unresolved = wanted.filter(hash => !result.has(hash));
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 1500 });
  try {
    // Thumbnail checks arrive in batches of up to 500 hashes. Query those hashes
    // in chunks instead of issuing one SQLite statement per file.
    for (let offset = 0; offset < unresolved.length; offset += 400) {
      const chunk = unresolved.slice(offset, offset + 400);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT root, path, size, mtime_ms AS mtimeMs, hash
        FROM file_hashes
        WHERE hash IN (${placeholders})
        ORDER BY hash, root, path
      `).all(...chunk);
      for (const row of rows) {
        if (result.has(row.hash)) continue;
        const folder = byRoot.get(row.root);
        const candidate = folder && candidateFor(row, folder);
        if (candidate) result.set(row.hash, candidate);
      }
    }
  } finally {
    db.close();
  }
  return result;
}

export function localCandidate(hash) {
  return localCandidates([hash]).get(String(hash)) || null;
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
    searchText: `${folder.name} ${folder.rootPath} ${row.path}`,
    rootPath: folder.rootPath,
    localAvailable: true
  };
}

export function localFolderPreview(path, limit = 5) {
  const wanted = pathKey(String(path || ''));
  const folder = localFolders().find(item => pathKey(item.rootPath) === wanted);
  const safeLimit = Math.max(1, Math.min(8, Number(limit) || 5));
  if (!folder) return { path: String(path || ''), files: [] };

  const rows = browseStageRows(240).filter(row => row.root === folder.rootKey);
  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 1000 });
    try {
      rows.push(...db.prepare(`
        SELECT root, path, size, mtime_ms AS mtimeMs, hash
        FROM file_hashes
        WHERE root = ?
        LIMIT 120
      `).all(folder.rootKey));
    } catch {} finally {
      db.close();
    }
  }

  const seen = new Set();
  const files = [];
  for (const row of rows) {
    if (!row?.hash || seen.has(row.hash)) continue;
    seen.add(row.hash);
    const file = catalogFile(row, folder);
    const media = String(file.mime || '').startsWith('image/') || String(file.mime || '').startsWith('video/');
    files.push({ ...file, media });
  }
  files.sort((a, b) => Number(b.media) - Number(a.media) || new Date(b.fileDate).getTime() - new Date(a.fileDate).getTime());
  return {
    path: folder.rootPath,
    available: folder.available,
    protected: folder.protected,
    files: files.slice(0, safeLimit).map(({ media, ...file }) => file)
  };
}

function folderSamples(folders) {
  const key = folders.map(folder => folder.rootKey).join('|');
  if (key === sampleCacheKey && Date.now() - sampleCacheAt < 15_000) return sampleCache;
  sampleCacheKey = key;
  sampleCacheAt = Date.now();
  sampleCache = folders.map(folder => localFolderPreview(folder.rootPath, 5));
  return sampleCache;
}

function catalogFolders(path = '') {
  const folders = localFolders();
  const wanted = pathKey(String(path || ''));
  return wanted ? folders.filter(folder => pathKey(folder.rootPath) === wanted) : folders;
}

export function localCatalog(limit = 720, path = '', offset = null) {
  const folders = catalogFolders(path);
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 720));
  const paged = offset !== null && offset !== undefined && offset !== '';
  const safeOffset = paged ? Math.max(0, Number(offset) || 0) : 0;
  if (!folders.length) return { files: [], folderSamples: [], nextOffset: null };

  const byRoot = new Map(folders.map(folder => [folder.rootKey, folder]));
  const rows = paged ? [] : browseStageRows(safeLimit * 2);
  let fetchedRows = 0;

  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 1500 });
    try {
      const roots = [...byRoot.keys()];
      const placeholders = roots.map(() => '?').join(',');
      if (roots.length) {
        const sqlLimit = paged ? safeLimit : safeLimit * 2;
        const sqlOffset = paged ? safeOffset : 0;
        const fetched = db.prepare(`
          SELECT root, path, size, mtime_ms AS mtimeMs, hash
          FROM file_hashes
          WHERE root IN (${placeholders})
          ORDER BY mtime_ms DESC, root, path
          LIMIT ? OFFSET ?
        `).all(...roots, sqlLimit, sqlOffset);
        fetchedRows = fetched.length;
        rows.push(...fetched);
      }
    } finally {
      db.close();
    }
  }

  rows.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  const seen = new Set();
  const files = [];
  for (const row of rows) {
    const folder = byRoot.get(row.root);
    if (!folder || seen.has(row.hash)) continue;
    seen.add(row.hash);
    files.push(catalogFile(row, folder));
    if (!paged && files.length >= safeLimit) break;
  }

  // Paged reads intentionally skip Browse staging and return indexed SQLite rows
  // directly. They are used to fill the complete local timeline and by the
  // explicit background preview warmer without rescanning or rehashing files.
  const nextOffset = paged && fetchedRows === safeLimit ? safeOffset + fetchedRows : null;
  return {
    files,
    folderSamples: !paged && !path && safeLimit <= 720 ? folderSamples(folders) : [],
    nextOffset
  };
}
