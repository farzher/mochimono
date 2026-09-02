import { db, json, readJson } from './lib/server-context.js';

const cleanName = value => String(value || '').trim().slice(0, 120);

export async function handleDeviceIdentity(req, res, url) {
  if (url.pathname !== '/api/device-identity/rename') return false;
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const body = await readJson(req);
  const from = cleanName(body.from);
  const to = cleanName(body.to);
  if (!from || !to) {
    json(res, 400, { error: 'from and to are required' });
    return true;
  }
  if (from.toLowerCase() === to.toLowerCase()) {
    json(res, 200, { ok: true, changed: false });
    return true;
  }

  const oldLocationId = `source:${from}`;
  const newLocationId = `source:${to}`;
  const oldLocation = db.prepare('SELECT * FROM storage_locations WHERE lower(id)=lower(?)').get(oldLocationId);
  const newLocation = db.prepare('SELECT * FROM storage_locations WHERE lower(id)=lower(?)').get(newLocationId);

  try {
    db.exec('BEGIN IMMEDIATE');

    db.prepare(`
      DELETE FROM source_replicas AS old
      WHERE lower(old.device_name)=lower(?)
        AND EXISTS (
          SELECT 1 FROM source_replicas AS current
          WHERE current.object_hash=old.object_hash AND lower(current.device_name)=lower(?)
        )
    `).run(from, to);
    db.prepare('UPDATE source_replicas SET device_name=? WHERE lower(device_name)=lower(?)').run(to, from);

    db.prepare(`
      DELETE FROM source_deletions AS old
      WHERE lower(old.device_name)=lower(?)
        AND EXISTS (
          SELECT 1 FROM source_deletions AS current
          WHERE current.object_hash=old.object_hash AND lower(current.device_name)=lower(?)
        )
    `).run(from, to);
    db.prepare('UPDATE source_deletions SET device_name=? WHERE lower(device_name)=lower(?)').run(to, from);

    db.prepare('DELETE FROM storage_locations WHERE lower(id)=lower(?)').run(oldLocationId);

    const base = newLocation || oldLocation;
    if (base) {
      const site = String(base.site || '').trim();
      const renamedSite = site.toLowerCase() === from.toLowerCase() ? to : site;
      db.prepare(`
        INSERT INTO storage_locations(id,name,kind,device_name,site,reliability,remote,encrypted,last_seen)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, kind=excluded.kind, device_name=excluded.device_name,
          site=excluded.site, reliability=excluded.reliability, remote=excluded.remote,
          encrypted=excluded.encrypted, last_seen=excluded.last_seen
      `).run(
        newLocationId,
        to,
        'source',
        to,
        renamedSite || to,
        base.reliability || 'normal',
        Number(base.remote) || 0,
        Number(base.encrypted) || 0,
        base.last_seen || new Date().toISOString()
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  json(res, 200, { ok: true, changed: true, from, to });
  return true;
}
