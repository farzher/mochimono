import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { openSyncIndex } from './sync-index.js';
import { publishLocalCatalogChange } from './local-catalog-events.js';

let db, getPath, getAliases;
function database() {
  if (!db) {
    if (!existsSync(SYNC_INDEX_PATH)) return false;
    db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1000 });
    getPath = db.prepare('SELECT id,content_hash AS hash FROM files WHERE root=? AND path=? AND size=? AND mtime_ms=?');
    getAliases = db.prepare("SELECT root,path,size,mtime_ms AS mtimeMs,id,content_hash AS hash FROM files WHERE id=? OR (content_hash<>'' AND content_hash=?) LIMIT 32");
  }
  return db;
}
function roots() {
  return [...settings.folders.map(folder => ({ root:pathKey(folder.path), path:folder.path, protected:true })),
    ...settings.browseFolders.map(path => ({ root:`browse:${pathKey(path)}`, path, protected:false }))];
}
export function contentForPath(path, size, mtimeMs) {
  const absolute = resolve(path);
  if (!database()) return '';
  for (const source of roots()) {
    const rel = relative(resolve(source.path), absolute);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) continue;
    const key = rel.replaceAll('\\', '/');
    const row = getPath.get(source.root, process.platform === 'win32' && !source.root.startsWith('browse:') ? key.toLowerCase() : key, size, Math.trunc(mtimeMs));
    if (row?.hash) return row.hash;
  }
  return '';
}

// Only call after a complete read and a matching post-read stat. A thumbnail
// decoder can supply the digest from its input instead of reading an image twice.
export function commitReadHash(path, size, mtimeMs, hash) {
  const index = openSyncIndex(SYNC_INDEX_PATH);
  try {
    for (const source of roots()) {
      const rel = relative(resolve(source.path), resolve(path));
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) continue;
      const key = rel.replaceAll('\\', '/');
      const cachePath = process.platform === 'win32' && source.protected ? key.toLowerCase() : key;
      const row = index.get(source.root, cachePath);
      if (!row || row.contentHash || row.size !== size || row.mtimeMs !== Math.trunc(mtimeMs)) continue;
      if (!index.saveBrowseContentHashes(source.root, [{ path:cachePath, size, mtimeMs, contentHash:hash }])) continue;
      publishLocalCatalogChange({ rootPath:source.path, relativePath:cachePath, size, mtimeMs,
        id:row.id, hash, replacesHash:row.id, contentHashReady:true, backupIntent:source.protected });
    }
  } finally { index.close(); }
}

export function previewAliases(hash) {
  if (!database()) return [];
  const sources = new Map(roots().map(source => [source.root, source.path]));
  const rows = getAliases.all(hash, hash);
  const aliases = new Set();
  for (const row of rows) {
    if (row.id !== hash) aliases.add(row.id);
    if (row.hash && row.hash !== hash) aliases.add(row.hash);
    const root = sources.get(row.root);
    if (root) {
      const content = contentForPath(resolve(root, row.path), row.size, row.mtimeMs);
      if (content && content !== hash) aliases.add(content);
    }
  }
  return [...aliases];
}
