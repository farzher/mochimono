import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR, now } from './agent-context.js';

mkdirSync(CONFIG_DIR, { recursive:true });
const db = new DatabaseSync(join(CONFIG_DIR, 'work.sqlite'), { timeout:5000 });
try {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS compression_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
      options_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(media_type, name)
    ) STRICT;
  `);

  const seed = (mediaType, name, options) => {
    if (db.prepare('SELECT 1 FROM compression_presets WHERE media_type=? LIMIT 1').get(mediaType)) return;
    const stamp = now();
    db.prepare('INSERT INTO compression_presets(id,name,media_type,options_json,is_default,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
      .run(randomUUID(), name, mediaType, JSON.stringify(options), stamp, stamp);
  };

  seed('image', 'Default Image', {
    format:'avif', quality:69, content:'auto', effort:4,
    lossless:false, resizeMax:2560, resizePercent:0
  });
  seed('video', 'Default Video', {
    encoder:'auto', quality:72, effort:7, maxEdge:0, fps:0,
    audio:'normal', videoBitrateKbps:0
  });
} finally {
  db.close();
}
