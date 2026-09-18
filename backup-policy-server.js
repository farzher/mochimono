import { db, json, now, readJson } from './lib/server-context.js';
import { handleDeviceIdentity } from './device-identity-server.js';
import { handleProtectionServer, registerProtectionStorage, removeProtectionStorage } from './protection-server.js';
import { verifyServerPassword } from './server-auth.js';

export function getDrive(id) {
  return db.prepare('SELECT * FROM drives WHERE id = ?').get(id);
}

function driveSummary(row) {
  const stored = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(o.size),0) AS bytes,
           COALESCE(SUM(CASE WHEN r.verified_at IS NOT NULL THEN 1 ELSE 0 END),0) AS verifiedCount,
           MIN(r.verified_at) AS oldestVerifiedAt,
           MAX(r.verified_at) AS lastVerifiedAt
    FROM replicas r
    JOIN objects o ON o.hash=r.object_hash
    WHERE r.drive_id=? AND o.state='active'
  `).get(row.id);
  return {
    id:row.id,
    name:row.name,
    lastSeen:row.last_seen,
    storedCount:Number(stored.count) || 0,
    storedBytes:Number(stored.bytes) || 0,
    verifiedCount:Number(stored.verifiedCount) || 0,
    oldestVerifiedAt:stored.oldestVerifiedAt || null,
    lastVerifiedAt:stored.lastVerifiedAt || null
  };
}

function destructivePassword(req) {
  try { return decodeURIComponent(String(req.headers['x-mochimono-delete-password'] || '')); }
  catch { return ''; }
}

export async function handleBackupPolicy(req, res, url) {
  if (await handleDeviceIdentity(req, res, url)) return true;
  if (req.method === 'POST' && url.pathname === '/api/protection/purge' && !verifyServerPassword(destructivePassword(req))) {
    json(res, 401, { error:'Password required for permanent deletion' });
    return true;
  }
  if (await handleProtectionServer(req, res, url)) return true;

  const drive = /^\/api\/drives\/([^/]+)$/.exec(url.pathname);
  const files = /^\/api\/drives\/([^/]+)\/files$/.exec(url.pathname);
  const file = /^\/api\/drives\/([^/]+)\/files\/([a-f0-9]{64})$/.exec(url.pathname);
  const driveRoute = url.pathname === '/api/drives/register' || url.pathname === '/api/drives' || Boolean(drive) || Boolean(files) || Boolean(file);
  if (!driveRoute) return false;

  if (req.method === 'POST' && url.pathname === '/api/drives/register') {
    const body = await readJson(req, 256 * 1024);
    const id = String(body.id || '').trim();
    const name = String(body.name || '').trim();
    if (!id || !name) throw Object.assign(new Error('id and name are required'), { status:400 });
    db.prepare(`
      INSERT INTO drives(id,name,last_seen) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen
    `).run(id, name, now());
    if (body.storage && typeof body.storage === 'object') registerProtectionStorage(id, { ...body.storage, name });
    json(res, 200, driveSummary(getDrive(id)));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/drives') {
    json(res, 200, { drives:db.prepare('SELECT * FROM drives ORDER BY name').all().map(driveSummary) });
    return true;
  }

  if (drive && req.method === 'DELETE') {
    const id = decodeURIComponent(drive[1]);
    db.prepare('DELETE FROM replicas WHERE drive_id=?').run(id);
    removeProtectionStorage(id);
    db.prepare('DELETE FROM drives WHERE id=?').run(id);
    json(res, 200, { ok:true, id });
    return true;
  }

  if (file && req.method === 'GET') {
    const id = decodeURIComponent(file[1]);
    const drive = getDrive(id);
    if (!drive) {
      json(res, 404, { error:'Backup not registered' });
      return true;
    }
    const row = db.prepare(`
      SELECT r.object_hash AS hash,r.verified_at AS verifiedAt,o.size
      FROM replicas r JOIN objects o ON o.hash=r.object_hash
      WHERE r.drive_id=? AND r.object_hash=? AND o.state='active'
    `).get(id, file[2]);
    if (!row) {
      json(res, 404, { error:'Replica not found' });
      return true;
    }
    json(res, 200, { hash:row.hash, verifiedAt:row.verifiedAt || null, size:Number(row.size) || 0, lastSeen:drive.last_seen || null });
    return true;
  }

  if (files && req.method === 'GET') {
    const id = decodeURIComponent(files[1]);
    if (!getDrive(id)) {
      json(res, 404, { error:'Backup not registered' });
      return true;
    }
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 5000)));
    const rows = db.prepare(`
      SELECT r.object_hash AS hash,r.verified_at AS verifiedAt,o.size
      FROM replicas r JOIN objects o ON o.hash=r.object_hash
      WHERE r.drive_id=? AND o.state='active' AND r.object_hash>?
      ORDER BY r.object_hash LIMIT ?
    `).all(id, after, limit).map(row => ({ ...row, size:Number(row.size) || 0 }));
    json(res, 200, { files:rows, nextAfter:rows.length === limit ? rows.at(-1).hash : null });
    return true;
  }

  json(res, 405, { error:'Method not allowed' });
  return true;
}
