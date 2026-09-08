import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { backupThumbnailCandidates } from './backup-thumb-candidates.js';
import { browseRootKey } from './browse-folders.js';
import { browseStageByHashes, browseStageRows } from './browse-staging.js';
import { localDisplayDate } from './local-date.js';
import { mimeFor } from './mime.js';

const MEDIA_EXTENSIONS = [
  'jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff',
  'mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp'
];
const MEDIA_PATH_SQL = MEDIA_EXTENSIONS.map(() => 'lower(path) LIKE ?').join(' OR ');
const MEDIA_PATH_ARGS = MEDIA_EXTENSIONS.map(extension => `%.${extension}`);

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
  if (!row || !folder || folder.available === false || !root || !row.path || !row.hash) return null;
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
  if (!folders.length) return { locations: [], files: [] };

  const byRoot = new Map(folders.map(folder => [folder.rootKey, folder]));
  const rows = hash ? browseStageByHashes([hash]) : browseStageRows(4000);
  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 5000 });
    try {
      if (hash) {
        rows.push(...db.prepare('SELECT root, path, hash FROM file_hashes WHERE hash = ?').all(String(hash)));
      } else {
        const query = db.prepare('SELECT root, path, hash FROM file_hashes ORDER BY root, path');
        for (const row of query.iterate()) rows.push(row);
      }
    } finally {
      db.close();
    }
  }

  const seen = new Set();
  return {
    locations: folders.map(({ rootKey, ...item }) => item),
    files: rows.map(row => {
      const location = byRoot.get(row.root);
      if (!location || location.available === false) return null;
      const key = `${row.hash}\u0000${location.id}\u0000${row.path}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return [row.hash, location.id, row.path];
    }).filter(Boolean)
  };
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
  const wanted = String(hash || '');
  const local = localCandidates([wanted]).get(wanted);
  if (local) return local;
  // A connected offline backup is also a valid byte source for a content hash.
  // This makes the normal /api/objects/<hash> viewer path work with no Cloud.
  // localLocations() intentionally remains Source-only, so Reveal in Explorer
  // never exposes Mochimono's internal backup object paths as user files.
  return backupThumbnailCandidates([wanted]).get(wanted)?.candidate || null;
}

function catalogFile(row, folder) {
  const timeline = localDisplayDate(row.path, row.mtimeMs);
  const date = new Date(timeline.ms).toISOString();
  return {
    hash: row.hash,
    size: Number(row.size) || 0,
    mime: mimeFor(row.path),
    createdAt: date,
    filename: basename(row.path),
    originalPath: row.path,
    fileDate: date,
    addedAt: date,
    dateSource: timeline.source,
    searchText: `${folder.name} ${folder.rootPath} ${row.path}`,
    rootPath: folder.rootPath,
    localAvailable: folder.available !== false
  };
}

export function localFolderPreview(path, limit = 5) {
  const wanted = pathKey(String(path || ''));
  const folder = localFolders().find(item => pathKey(item.rootPath) === wanted);
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 5));
  if (!folder) return { path: String(path || ''), files: [] };

  // Folder previews are metadata views. They must keep working from the persisted
  // index even when the source drive is unplugged. Query media rows directly so a
  // large node_modules/build tree cannot crowd every photo/video out of the sample.
  const rows = folder.available === false
    ? []
    : browseStageRows(Math.max(240, safeLimit * 4)).filter(row => {
      if (row.root !== folder.rootKey) return false;
      const mime = mimeFor(row.path);
      return mime.startsWith('image/') || mime.startsWith('video/');
    });
  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 1000 });
    try {
      const candidateLimit = Math.max(240, safeLimit * 4);
      rows.push(...db.prepare(`
        SELECT root, path, size, mtime_ms AS mtimeMs, hash
        FROM file_hashes
        WHERE root = ? AND (${MEDIA_PATH_SQL})
        ORDER BY mtime_ms DESC, path
        LIMIT ?
      `).all(folder.rootKey, ...MEDIA_PATH_ARGS, candidateLimit));
    } catch {} finally {
      db.close();
    }
  }

  rows.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  const seen = new Set();
  const files = [];
  for (const row of rows) {
    if (!row?.hash || seen.has(row.hash)) continue;
    seen.add(row.hash);
    files.push(catalogFile(row, folder));
    if (files.length >= safeLimit) break;
  }
  return {
    path: folder.rootPath,
    available: folder.available,
    protected: folder.protected,
    files
  };
}

function folderSamples(folders) {
  const key = folders.map(folder => `${folder.rootKey}:${folder.available ? 1 : 0}`).join('|');
  if (key === sampleCacheKey && Date.now() - sampleCacheAt < 15_000) return sampleCache;
  sampleCacheKey = key;
  sampleCacheAt = Date.now();
  sampleCache = folders.map(folder => localFolderPreview(folder.rootPath, 80));
  return sampleCache;
}

function catalogFolders(path = '') {
  const folders = localFolders();
  const wanted = pathKey(String(path || ''));
  return wanted ? folders.filter(folder => pathKey(folder.rootPath) === wanted) : folders;
}

export function localCatalog(limit = 720, path = '', offset = null) {
  const folders = catalogFolders(path);
  // A path-specific request is allowed to read persisted metadata for an offline
  // folder. Broad catalog browsing still excludes unavailable locations.
  const sourceFolders = path ? folders : folders.filter(folder => folder.available !== false);
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 720));
  const paged = offset !== null && offset !== undefined && offset !== '';
  const safeOffset = paged ? Math.max(0, Number(offset) || 0) : 0;
  if (!sourceFolders.length) return { files: [], folderSamples: !paged && !path ? folderSamples(folders) : [], nextOffset: null };

  const byRoot = new Map(sourceFolders.map(folder => [folder.rootKey, folder]));
  const rows = paged ? [] : browseStageRows(safeLimit * 2).filter(row => byRoot.has(row.root));
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

  const nextOffset = paged && fetchedRows === safeLimit ? safeOffset + fetchedRows : null;
  return {
    files,
    folderSamples: !paged && !path && safeLimit <= 720 ? folderSamples(folders) : [],
    nextOffset
  };
}
