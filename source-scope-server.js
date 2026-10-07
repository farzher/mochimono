import { db, json, readJson } from './lib/server-context.js';

// Scope describes future folder selection, not deletion. Copies outside the
// current intent stay stored and visible for review.
db.exec(`
  CREATE TABLE IF NOT EXISTS import_scopes (
    import_id INTEGER PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('media','all'))
  ) STRICT;
`);

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
    db.exec('COMMIT');
    json(res, 200, { ok: true, importId, scope });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    json(res, 400, { error: error.message });
  }
  return true;
}
