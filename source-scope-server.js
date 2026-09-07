import { db, json, readJson } from './lib/server-context.js';

// Folder scope is server-aware so old non-media references from a folder can be
// retired from the active catalog without deleting their stored bytes. Imports
// without an explicit scope remain eligible for all files (for direct/manual imports).
db.exec(`
  CREATE TABLE IF NOT EXISTS import_scopes (
    import_id INTEGER PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('media','all'))
  ) STRICT;
`);

function recomputeNonMedia(importId) {
  db.prepare(`
    UPDATE objects AS o
    SET state = CASE
      WHEN EXISTS (
        SELECT 1
        FROM sources s
        LEFT JOIN import_scopes sc ON sc.import_id = s.import_id
        WHERE s.object_hash = o.hash AND COALESCE(sc.scope, 'all') = 'all'
      ) THEN 'active'
      ELSE 'deleted'
    END
    WHERE o.mime NOT LIKE 'image/%'
      AND o.mime NOT LIKE 'video/%'
      AND o.hash IN (SELECT object_hash FROM sources WHERE import_id = ?)
  `).run(importId);
}

export async function handleSourceScopeServer(req, res, url) {
  if (req.method !== 'POST' || url.pathname !== '/api/import-scope') return false;
  const body = await readJson(req, 64 * 1024);
  const importId = Number(body.importId);
  const scope = String(body.scope || '').toLowerCase() === 'all' ? 'all' : 'media';
  if (!Number.isInteger(importId) || importId < 1 || !db.prepare('SELECT 1 FROM imports WHERE id = ?').get(importId)) {
    json(res, 400, { error: 'Valid importId is required' });
    return true;
  }

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT INTO import_scopes(import_id, scope) VALUES(?, ?)
      ON CONFLICT(import_id) DO UPDATE SET scope = excluded.scope
    `).run(importId, scope);
    recomputeNonMedia(importId);
    db.exec('COMMIT');
    json(res, 200, { ok: true, importId, scope });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    json(res, 400, { error: error.message });
  }
  return true;
}
