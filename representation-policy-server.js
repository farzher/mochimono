import { db, json, now, readJson } from './lib/server-context.js';

// Destructive retention is deliberately separate from representation preference.
// Absence of a row means originals are retained. This makes the safe default
// impossible to flip accidentally by merely choosing the Compact representation.
db.exec(`
  CREATE TABLE IF NOT EXISTS representation_retention (
    location_id TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
    allow_original_removal INTEGER NOT NULL DEFAULT 0 CHECK(allow_original_removal IN (0,1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(location_id, media_type)
  ) STRICT;
  UPDATE representation_retention SET allow_original_removal=0
  WHERE allow_original_removal=1 AND location_id NOT LIKE 'backup:%';
`);

function rows() {
  return db.prepare(`
    SELECT location_id AS locationId, media_type AS mediaType,
           allow_original_removal AS allowOriginalRemoval, updated_at AS updatedAt
    FROM representation_retention
    ORDER BY location_id, media_type
  `).all().map(row => ({ ...row, allowOriginalRemoval:Boolean(row.allowOriginalRemoval) }));
}

function setRetention(locationId, mediaType, allow) {
  db.prepare(`
    INSERT INTO representation_retention(location_id,media_type,allow_original_removal,updated_at)
    VALUES(?,?,?,?)
    ON CONFLICT(location_id,media_type) DO UPDATE SET
      allow_original_removal=excluded.allow_original_removal,
      updated_at=excluded.updated_at
  `).run(locationId, mediaType, allow ? 1 : 0, now());
}

export async function handleRepresentationPolicyServer(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/compression/retention') {
    return json(res, 200, { retention:rows() });
  }

  if (req.method === 'GET' && url.pathname === '/api/compression/storage-snapshot') {
    return json(res, 200, {
      policies:db.prepare(`
        SELECT location_id AS locationId, media_type AS mediaType, representation, updated_at AS updatedAt
        FROM representation_policies ORDER BY location_id, media_type
      `).all(),
      retention:rows()
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/compression/storage-policy') {
    const body = await readJson(req, 64 * 1024);
    const locationId = String(body.locationId || '').trim().slice(0, 240);
    const mediaType = ['image','video'].includes(String(body.mediaType || '')) ? String(body.mediaType) : '';
    const representation = ['original','compact'].includes(String(body.representation || '')) ? String(body.representation) : '';
    if (!locationId || !mediaType || !representation) return json(res, 400, { error:'Location, media type, and representation are required' });
    db.prepare(`INSERT INTO representation_policies(location_id,media_type,representation,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(location_id,media_type) DO UPDATE SET representation=excluded.representation,updated_at=excluded.updated_at`)
      .run(locationId, mediaType, representation, now());
    // Returning to Original is always conservative: any prior deletion opt-in is
    // revoked immediately rather than waiting for a second UI request.
    if (representation === 'original') setRetention(locationId, mediaType, false);
    return json(res, 200, { ok:true, representation });
  }

  if (req.method === 'POST' && url.pathname === '/api/compression/retention') {
    const body = await readJson(req, 64 * 1024);
    const locationId = String(body.locationId || '').trim().slice(0, 240);
    const mediaType = ['image','video'].includes(String(body.mediaType || '')) ? String(body.mediaType) : '';
    const allow = body.allowOriginalRemoval === true;
    if (!locationId || !mediaType) return json(res, 400, { error:'Location and media type are required' });

    if (allow) {
      if (body.confirmation !== 'compact-only') {
        return json(res, 400, { error:'Compact only requires explicit confirmation' });
      }
      // Only managed backup object stores are reversible today: switching them
      // back to Original makes normal backup reconciliation download the object
      // again. Never delete user source-folder files or server primary objects.
      if (!locationId.startsWith('backup:')) {
        return json(res, 409, { error:'Compact only is currently available only for managed backup drives' });
      }
      const policy = db.prepare('SELECT representation FROM representation_policies WHERE location_id=? AND media_type=?').get(locationId, mediaType);
      if (policy?.representation !== 'compact') {
        return json(res, 409, { error:'Choose Compact for this backup before enabling Compact only' });
      }
    }

    setRetention(locationId, mediaType, allow);
    return json(res, 200, { ok:true, allowOriginalRemoval:allow });
  }

  const removePresence = /^\/api\/representations\/([a-f0-9]{64})\/presence$/.exec(url.pathname);
  if (removePresence && req.method === 'DELETE') {
    const locationId = String(url.searchParams.get('locationId') || '').trim().slice(0, 240);
    const representation = ['original','compact'].includes(String(url.searchParams.get('representation') || ''))
      ? String(url.searchParams.get('representation')) : '';
    if (!locationId || !representation) return json(res, 400, { error:'Location and representation are required' });
    db.prepare('DELETE FROM representation_presence WHERE original_hash=? AND location_id=? AND representation=?')
      .run(removePresence[1], locationId, representation);
    return json(res, 200, { ok:true });
  }

  return false;
}
