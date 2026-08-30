import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openSyncIndex(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS file_hashes (
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY(root, path)
    ) STRICT;
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
  const forgetRoot = db.prepare('DELETE FROM file_hashes WHERE root = ?');

  return {
    load(root) {
      return new Map(load.all(root).map(row => [row.path, row]));
    },
    save(root, path, size, mtimeMs, hash) {
      save.run(root, path, Number(size), Math.trunc(Number(mtimeMs)), hash);
    },
    forgetRoot(root) {
      forgetRoot.run(root);
    },
    close() {
      db.close();
    }
  };
}
