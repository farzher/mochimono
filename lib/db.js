import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

export function openCatalog(path) {
  mkdirSync(dirname(path), { recursive:true });
  const db = new DatabaseSync(path, { timeout:5000 });

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
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

    CREATE TABLE IF NOT EXISTS import_roots (
      import_id INTEGER PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,
      device_name TEXT NOT NULL DEFAULT '',
      root_path TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS media_metadata (
      object_hash TEXT PRIMARY KEY REFERENCES objects(hash) ON DELETE CASCADE,
      captured_at TEXT,
      source TEXT NOT NULL,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      geometry_checked INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ignored_hashes (
      hash TEXT PRIMARY KEY,
      ignored_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS reviewed_hashes (
      hash TEXT PRIMARY KEY,
      reviewed_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS collection_members (
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      object_hash TEXT NOT NULL REFERENCES objects(hash),
      added_at TEXT NOT NULL,
      PRIMARY KEY(collection_id, object_hash)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS smart_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      query_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      ai_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_enabled IN (0, 1)),
      builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tag_members (
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      object_hash TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'ai', 'system')),
      confidence REAL,
      added_at TEXT NOT NULL,
      PRIMARY KEY(tag_id, object_hash)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tag_examples (
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      object_hash TEXT NOT NULL,
      polarity INTEGER NOT NULL CHECK (polarity IN (-1, 1)),
      added_at TEXT NOT NULL,
      PRIMARY KEY(tag_id, object_hash)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tag_suppressions (
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      object_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tag_id, object_hash)
    ) STRICT;

    INSERT OR IGNORE INTO tags(name, description, ai_enabled, builtin, created_at, updated_at)
    VALUES('Sensitive', 'Potentially explicit or sensitive media', 1, 1, datetime('now'), datetime('now'));

    CREATE TABLE IF NOT EXISTS thumbnails (
      object_hash TEXT PRIMARY KEY REFERENCES objects(hash),
      version INTEGER NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      duration REAL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS thumbnail_requests (
      object_hash TEXT PRIMARY KEY REFERENCES objects(hash),
      requested_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS drives (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_seen TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS replicas (
      object_hash TEXT NOT NULL REFERENCES objects(hash),
      drive_id TEXT NOT NULL REFERENCES drives(id),
      verified_at TEXT,
      PRIMARY KEY(object_hash, drive_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS object_integrity (
      hash TEXT PRIMARY KEY REFERENCES objects(hash) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('healthy', 'corrupt', 'missing')),
      checked_at TEXT NOT NULL,
      verified_at TEXT,
      error TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS integrity_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS catalog_revision (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO catalog_revision(singleton, revision) VALUES(1, 1);

    CREATE INDEX IF NOT EXISTS objects_active_hash ON objects(hash) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS imports_source_name ON imports(source_name);
    CREATE INDEX IF NOT EXISTS sources_object_hash ON sources(object_hash);
    CREATE INDEX IF NOT EXISTS sources_import_object ON sources(import_id, object_hash);
    CREATE INDEX IF NOT EXISTS sources_filename ON sources(filename);
    CREATE INDEX IF NOT EXISTS sources_original_path ON sources(original_path);
    CREATE INDEX IF NOT EXISTS collection_members_object_hash ON collection_members(object_hash);
    CREATE INDEX IF NOT EXISTS tag_members_object_hash ON tag_members(object_hash);
    CREATE INDEX IF NOT EXISTS tag_examples_object_hash ON tag_examples(object_hash);
    CREATE INDEX IF NOT EXISTS tag_suppressions_object_hash ON tag_suppressions(object_hash);
    CREATE INDEX IF NOT EXISTS thumbnail_requests_requested_at ON thumbnail_requests(requested_at);
    CREATE INDEX IF NOT EXISTS replicas_drive_id ON replicas(drive_id);
    CREATE INDEX IF NOT EXISTS object_integrity_status ON object_integrity(status);

    CREATE TRIGGER IF NOT EXISTS catalog_objects_insert AFTER INSERT ON objects BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_objects_delete AFTER DELETE ON objects BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_objects_update AFTER UPDATE OF size, mime, state, created_at ON objects
    WHEN OLD.size IS NOT NEW.size OR OLD.mime IS NOT NEW.mime OR OLD.state IS NOT NEW.state OR OLD.created_at IS NOT NEW.created_at BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_imports_insert AFTER INSERT ON imports BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_imports_delete AFTER DELETE ON imports BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_imports_update AFTER UPDATE OF source_name, created_at ON imports
    WHEN OLD.source_name IS NOT NEW.source_name OR OLD.created_at IS NOT NEW.created_at BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_import_roots_insert AFTER INSERT ON import_roots BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_import_roots_delete AFTER DELETE ON import_roots BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_import_roots_update AFTER UPDATE OF device_name, root_path ON import_roots
    WHEN OLD.device_name IS NOT NEW.device_name OR OLD.root_path IS NOT NEW.root_path BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_sources_insert AFTER INSERT ON sources BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_sources_delete AFTER DELETE ON sources BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_sources_update AFTER UPDATE OF object_hash, import_id, original_path, filename, mtime, created_at ON sources
    WHEN OLD.object_hash IS NOT NEW.object_hash OR OLD.import_id IS NOT NEW.import_id OR OLD.original_path IS NOT NEW.original_path OR OLD.filename IS NOT NEW.filename OR OLD.mtime IS NOT NEW.mtime OR OLD.created_at IS NOT NEW.created_at BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_media_metadata_insert AFTER INSERT ON media_metadata BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_media_metadata_delete AFTER DELETE ON media_metadata BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_media_metadata_update AFTER UPDATE OF captured_at, source, width, height ON media_metadata
    WHEN OLD.captured_at IS NOT NEW.captured_at OR OLD.source IS NOT NEW.source OR OLD.width IS NOT NEW.width OR OLD.height IS NOT NEW.height BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_reviewed_insert AFTER INSERT ON reviewed_hashes BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_reviewed_delete AFTER DELETE ON reviewed_hashes BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_tags_insert AFTER INSERT ON tags BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_tags_delete AFTER DELETE ON tags BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_tags_update AFTER UPDATE OF name ON tags
    WHEN OLD.name IS NOT NEW.name BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_tag_members_insert AFTER INSERT ON tag_members BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_tag_members_delete AFTER DELETE ON tag_members BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_tag_members_update AFTER UPDATE OF tag_id, object_hash, source, confidence ON tag_members
    WHEN OLD.tag_id IS NOT NEW.tag_id OR OLD.object_hash IS NOT NEW.object_hash OR OLD.source IS NOT NEW.source OR OLD.confidence IS NOT NEW.confidence BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_replicas_insert AFTER INSERT ON replicas BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_replicas_delete AFTER DELETE ON replicas BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_replicas_update AFTER UPDATE OF object_hash, drive_id ON replicas
    WHEN OLD.object_hash IS NOT NEW.object_hash OR OLD.drive_id IS NOT NEW.drive_id BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS catalog_integrity_insert AFTER INSERT ON object_integrity BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_integrity_delete AFTER DELETE ON object_integrity BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS catalog_integrity_update AFTER UPDATE OF status ON object_integrity
    WHEN OLD.status IS NOT NEW.status BEGIN
      UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
    END;

    PRAGMA user_version = 1;
    PRAGMA optimize;
  `);
  return db;
}

export async function backupCatalog(db, destination) {
  await backup(db, destination);
}
