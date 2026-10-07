// Shared by background metadata sync and the lazily loaded compression UI.
export function ensureRepresentationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS renditions (
      original_hash TEXT PRIMARY KEY,
      rendition_hash TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
      preset_id TEXT,
      preset_name TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL,
      path TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      source_size INTEGER NOT NULL,
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      duration REAL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS representation_policies (
      location_id TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
      representation TEXT NOT NULL CHECK(representation IN ('original','compact')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(location_id, media_type)
    ) STRICT;
  `);
}
