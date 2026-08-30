import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

export function openCatalog(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS objects (
      hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleted')),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      object_hash TEXT NOT NULL REFERENCES objects(hash),
      import_id INTEGER NOT NULL REFERENCES imports(id),
      original_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      mtime TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(import_id, original_path)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ignored_hashes (
      hash TEXT PRIMARY KEY,
      ignored_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS drives (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      last_seen TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS replicas (
      object_hash TEXT NOT NULL REFERENCES objects(hash),
      drive_id TEXT NOT NULL REFERENCES drives(id),
      verified_at TEXT,
      PRIMARY KEY(object_hash, drive_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS sources_object_hash ON sources(object_hash);
    CREATE INDEX IF NOT EXISTS sources_filename ON sources(filename);
    CREATE INDEX IF NOT EXISTS sources_original_path ON sources(original_path);
    CREATE INDEX IF NOT EXISTS replicas_drive_id ON replicas(drive_id);
  `);
  return db;
}

export async function backupCatalog(db, destination) {
  await backup(db, destination);
}
