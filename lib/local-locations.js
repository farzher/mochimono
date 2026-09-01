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
  if (!row || !folder?.path || !row.path || !row.hash) return null;
  const path = safeLocalPath(folder.path, row.path);
  if (!path) return null;
  return {
    kind: 'local',
    hash: String(row.hash),
    path,
    size: Number(row.size) || 0,
    mime: mimeFor(row.path),
    filename: basename(row.path),
    root: folder.path,
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
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 1500 });
  try {
    const get = db.prepare('SELECT root, path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE hash = ? ORDER BY root, path');
    for (const hash of wanted) {
      if (result.has(hash)) continue;
      for (const row of get.all(hash)) {
        const folder = byRoot.get(row.root);
        const candidate = folder && candidateFor(row, folder);
        if (!candidate) continue;
        result.set(hash, candidate);
        break;
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
    localAvailable: true
  };
}

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
