import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SYNC_INDEX_PATH } from './agent-context.js';

const STAGING_PATH = `${SYNC_INDEX_PATH}.browse-staging.sqlite`;

export function openBrowseStage() {
  const db = new DatabaseSync(STAGING_PATH, { timeout: 2000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS browse_staging (
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(root, path)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS browse_staging_hash ON browse_staging(hash);
  `);
  const save = db.prepare(`
    INSERT INTO browse_staging(root, path, size, mtime_ms, hash, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(root, path) DO UPDATE SET
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      hash = excluded.hash,
      updated_at = excluded.updated_at
  `);
  const clear = db.prepare('DELETE FROM browse_staging WHERE root = ?');
  return {
    saveMany(root, rows) {
      if (!rows?.length) return;
      const base = Date.now();
      try {
        db.exec('BEGIN IMMEDIATE');
        rows.forEach((row, index) => save.run(root, row.path, Number(row.size), Math.trunc(Number(row.mtimeMs)), row.hash, base + index));
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },
    clear(root) { clear.run(root); },
    close() { db.close(); }
  };
}

export function browseStageRows(limit = 720) {
  if (!existsSync(STAGING_PATH)) return [];
  const safeLimit = Math.max(1, Math.min(4000, Number(limit) || 720));
  const db = new DatabaseSync(STAGING_PATH, { readOnly: true, timeout: 1000 });
  try {
    return db.prepare(`
      SELECT root, path, size, mtime_ms AS mtimeMs, hash
      FROM browse_staging
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(safeLimit);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function browseStageByHashes(hashes) {
  if (!existsSync(STAGING_PATH) || !hashes?.length) return [];
  const db = new DatabaseSync(STAGING_PATH, { readOnly: true, timeout: 1000 });
  try {
    const get = db.prepare(`
      SELECT root, path, size, mtime_ms AS mtimeMs, hash
      FROM browse_staging
      WHERE hash = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `);
    return hashes.map(hash => get.get(String(hash))).filter(Boolean);
  } catch {
    return [];
  } finally {
    db.close();
  }
}
