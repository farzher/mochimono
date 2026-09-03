import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const filesystemRoot = root => String(root).startsWith('browse:') ? String(root).slice('browse:'.length) : String(root);
const indexedPath = (root, relativePath) => join(filesystemRoot(root), ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));

function confirmedAbsent(root, relativePath) {
  try {
    statSync(indexedPath(root, relativePath));
    return false;
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  }
}

export function openSyncIndex(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS file_hashes (
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY(root, path)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS file_hashes_hash ON file_hashes(hash);
    CREATE INDEX IF NOT EXISTS file_hashes_mtime ON file_hashes(mtime_ms DESC, root);
    CREATE TABLE IF NOT EXISTS root_meta (
      root TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS preview_meta (
      root TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL
    ) STRICT;
    PRAGMA optimize;
  `);

  const load = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE root = ?');
  const get = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE root = ? AND path = ?');
  const pageAfter = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE root = ? AND path > ? ORDER BY path LIMIT ?');
  const prefixEntry = db.prepare('SELECT 1 AS found FROM file_hashes WHERE root = ? AND path >= ? AND path < ? LIMIT 1');
  const save = db.prepare(`
    INSERT INTO file_hashes(root, path, size, mtime_ms, hash)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(root,path) DO UPDATE SET
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      hash = excluded.hash
  `);
  const removeEntry = db.prepare('DELETE FROM file_hashes WHERE root = ? AND path = ?');
  const removeRoot = db.prepare('DELETE FROM file_hashes WHERE root = ?');
  const stats = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM file_hashes WHERE root = ?');
  const loadMeta = db.prepare('SELECT indexed_at AS indexedAt FROM root_meta WHERE root = ?');
  const saveMeta = db.prepare(`
    INSERT INTO root_meta(root,indexed_at)
    VALUES(?,?)
    ON CONFLICT(root) DO UPDATE SET indexed_at = excluded.indexed_at
  `);
  const removeMeta = db.prepare('DELETE FROM root_meta WHERE root = ?');
  const loadPreviewMeta = db.prepare('SELECT indexed_at AS indexedAt FROM preview_meta WHERE root = ?');
  const savePreviewMeta = db.prepare(`
    INSERT INTO preview_meta(root,indexed_at)
    VALUES(?,?)
    ON CONFLICT(root) DO UPDATE SET indexed_at = excluded.indexed_at
  `);
  const removePreviewMeta = db.prepare('DELETE FROM preview_meta WHERE root = ?');

  return {
    load(root) {
      return new Map(load.all(root).map(row => [row.path,row]));
    },
    get(root,path) {
      return get.get(root,String(path || '')) || null;
    },
    hasPrefix(root,prefix) {
      const start = String(prefix || '');
      if (!start) return false;
      return Boolean(prefixEntry.get(root,start,`${start}\uffff`)?.found);
    },
    pageAfter(root,afterPath = '',limit = 256) {
      const safeLimit = Math.max(1,Math.min(1000,Number(limit) || 256));
      return pageAfter.all(root,String(afterPath || ''),safeLimit);
    },
    save(root,path,size,mtimeMs,hash) {
      save.run(root,path,Number(size),Math.trunc(Number(mtimeMs)),hash);
    },
    saveMany(root,rows) {
      if (!rows?.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) save.run(root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs)),row.hash);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    markIndexed(root,value = new Date().toISOString()) {
      saveMeta.run(root,String(value));
    },
    lastIndexed(root) {
      return loadMeta.get(root)?.indexedAt || null;
    },
    markPreviewed(root,value) {
      const indexedAt = String(value || loadMeta.get(root)?.indexedAt || '');
      if (!indexedAt) return false;
      savePreviewMeta.run(root,indexedAt);
      return true;
    },
    lastPreviewed(root) {
      return loadPreviewMeta.get(root)?.indexedAt || null;
    },
    clearPreviewed(root) {
      removePreviewMeta.run(root);
    },
    forget(root,path) {
      if (!confirmedAbsent(root,path)) return 0;
      return Number(removeEntry.run(root,path).changes) || 0;
    },
    prune(root,currentPaths) {
      const keep = currentPaths instanceof Set ? currentPaths : new Set(currentPaths);
      const stale = load.all(root).filter(row => !keep.has(row.path) && confirmedAbsent(root,row.path));
      if (!stale.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of stale) removeEntry.run(root,row.path);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return stale.length;
    },
    moveRoot(from,to) {
      if (from === to) return 0;
      const rows = load.all(from);
      const meta = loadMeta.get(from);
      const previewMeta = loadPreviewMeta.get(from);
      if (!rows.length && !meta && !previewMeta) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) save.run(to,row.path,row.size,row.mtimeMs,row.hash);
        if (meta?.indexedAt) saveMeta.run(to,meta.indexedAt);
        if (previewMeta?.indexedAt) savePreviewMeta.run(to,previewMeta.indexedAt);
        removeRoot.run(from);
        removeMeta.run(from);
        removePreviewMeta.run(from);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    forgetRoot(root) {
      removeRoot.run(root);
      removeMeta.run(root);
      removePreviewMeta.run(root);
    },
    stats(root) {
      const row = stats.get(root);
      return { files:Number(row?.files) || 0,bytes:Number(row?.bytes) || 0 };
    },
    close() {
      db.exec('PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize');
      db.close();
    }
  };
}
