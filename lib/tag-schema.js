function hasObjectForeignKey(db, table) {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .some(row => String(row.table) === 'objects' && String(row.from) === 'object_hash');
}

export function ensureTagSchema(db) {
  const tables = ['tag_members', 'tag_examples', 'tag_suppressions'];
  if (!tables.some(table => hasObjectForeignKey(db, table))) return;

  // Tags belong to content hashes, not storage records. A file can exist only on
  // a connected client and still be taggable, so object_hash must not depend on
  // the Server's objects table.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS catalog_tag_members_insert;
      DROP TRIGGER IF EXISTS catalog_tag_members_delete;
      DROP TRIGGER IF EXISTS catalog_tag_members_update;

      ALTER TABLE tag_members RENAME TO tag_members_object_bound;
      ALTER TABLE tag_examples RENAME TO tag_examples_object_bound;
      ALTER TABLE tag_suppressions RENAME TO tag_suppressions_object_bound;

      CREATE TABLE tag_members (
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        object_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'ai', 'system')),
        confidence REAL,
        added_at TEXT NOT NULL,
        PRIMARY KEY(tag_id, object_hash)
      ) STRICT;

      CREATE TABLE tag_examples (
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        object_hash TEXT NOT NULL,
        polarity INTEGER NOT NULL CHECK (polarity IN (-1, 1)),
        added_at TEXT NOT NULL,
        PRIMARY KEY(tag_id, object_hash)
      ) STRICT;

      CREATE TABLE tag_suppressions (
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        object_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tag_id, object_hash)
      ) STRICT;

      INSERT INTO tag_members(tag_id, object_hash, source, confidence, added_at)
        SELECT tag_id, object_hash, source, confidence, added_at FROM tag_members_object_bound;
      INSERT INTO tag_examples(tag_id, object_hash, polarity, added_at)
        SELECT tag_id, object_hash, polarity, added_at FROM tag_examples_object_bound;
      INSERT INTO tag_suppressions(tag_id, object_hash, created_at)
        SELECT tag_id, object_hash, created_at FROM tag_suppressions_object_bound;

      DROP TABLE tag_members_object_bound;
      DROP TABLE tag_examples_object_bound;
      DROP TABLE tag_suppressions_object_bound;

      CREATE INDEX IF NOT EXISTS tag_members_object_hash ON tag_members(object_hash);
      CREATE INDEX IF NOT EXISTS tag_examples_object_hash ON tag_examples(object_hash);
      CREATE INDEX IF NOT EXISTS tag_suppressions_object_hash ON tag_suppressions(object_hash);

      CREATE TRIGGER catalog_tag_members_insert AFTER INSERT ON tag_members BEGIN
        UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER catalog_tag_members_delete AFTER DELETE ON tag_members BEGIN
        UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER catalog_tag_members_update AFTER UPDATE OF tag_id, object_hash, source, confidence ON tag_members
      WHEN OLD.tag_id IS NOT NEW.tag_id OR OLD.object_hash IS NOT NEW.object_hash OR OLD.source IS NOT NEW.source OR OLD.confidence IS NOT NEW.confidence BEGIN
        UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
