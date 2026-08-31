import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const filesystemRoot = root => String(root).startsWith('browse:') ? String(root).slice('browse:'.length) : String(root);
const indexedPath = (root, relativePath) => join(filesystemRoot(root), ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));

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
    PRAGMA optimize;
  `);

  const load = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE root = ?');
  const save = db.prepare(`
    INSERT INTO file_hashes(root, path, size, mtime_ms, hash)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(root, path) DO UPDATE SET
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      hash = excluded.hash
  `);
  const removeEntry = db.prepare('DELETE FROM file_hashes WHERE root = ? AND path = ?');
  const removeRoot = db.prepare('DELETE FROM file_hashes WHERE root = ?');
  const stats = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM file_hashes WHERE root = ?');

  return {
    load(root) {
      return new Map(load.all(root).map(row => [row.path, row]));
    },
    save(root, path, size, mtimeMs, hash) {
      save.run(root, path, Number(size), Math.trunc(Number(mtimeMs)), hash);
    },
    forget(root, path) {
      removeEntry.run(root, path);
    },
    prune(root, currentPaths) {
      const keep = currentPaths instanceof Set ? currentPaths : new Set(currentPaths);
      // A partial scan can miss a subtree because of a transient permission/read
      // error. Never turn that into a false "local copy is gone" result. Only
      // prune an unseen index row when its path is actually absent on disk.
      const stale = load.all(root).filter(row => !keep.has(row.path) && !existsSync(indexedPath(root, row.path)));
      if (!stale.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of stale) removeEntry.run(root, row.path);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return stale.length;
    },
    moveRoot(from, to) {
      if (from === to) return 0;
      const rows = load.all(from);
      if (!rows.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) save.run(to, row.path, row.size, row.mtimeMs, row.hash);
        removeRoot.run(from);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    forgetRoot(root) {
      removeRoot.run(root);
    },
    stats(root) {
      const row = stats.get(root);
      return { files: Number(row?.files) || 0, bytes: Number(row?.bytes) || 0 };
    },
    close() {
      db.exec('PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize');
      db.close();
    }
  };
}
