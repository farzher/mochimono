import { db, json, now, readJson, DATA_DIR } from './lib/server-context.js';
import { removeObject } from './lib/store.js';
import { cleanupThumbnail } from './thumbnail-server.js';

const LEVELS = ['disposable', 'normal', 'important', 'critical'];
const TARGETS = {
  disposable: { copies: 1, devices: 1, remote: 0, sites: 1 },
  normal: { copies: 2, devices: 2, remote: 0, sites: 1 },
  important: { copies: 3, devices: 2, remote: 1, sites: 2 },
  critical: { copies: 3, devices: 3, remote: 1, sites: 2 }
};
const rank = level => Math.max(0, LEVELS.indexOf(level));
const validLevel = level => LEVELS.includes(String(level || ''));

db.exec(`
  CREATE TABLE IF NOT EXISTS protection_rules (
    scope_type TEXT NOT NULL CHECK (scope_type IN ('import')),
    scope_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('disposable','normal','important','critical')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(scope_type, scope_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS object_protection (
    object_hash TEXT PRIMARY KEY REFERENCES objects(hash) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('disposable','normal','important','critical')),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS storage_locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('primary','source','backup','peer')),
    device_name TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    reliability TEXT NOT NULL DEFAULT 'normal' CHECK (reliability IN ('low','normal','high')),
    remote INTEGER NOT NULL DEFAULT 0 CHECK (remote IN (0,1)),
    encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0,1)),
    last_seen TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS protection_trash (
    object_hash TEXT PRIMARY KEY REFERENCES objects(hash) ON DELETE CASCADE,
    trashed_at TEXT NOT NULL,
    purge_after TEXT,
    ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0,1))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS replica_deletions (
    object_hash TEXT NOT NULL REFERENCES objects(hash) ON DELETE CASCADE,
    drive_id TEXT NOT NULL REFERENCES drives(id) ON DELETE CASCADE,
    requested_at TEXT NOT NULL,
    PRIMARY KEY(object_hash, drive_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS source_deletions (
    object_hash TEXT NOT NULL REFERENCES objects(hash) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    PRIMARY KEY(object_hash, device_name)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS protection_rules_scope ON protection_rules(scope_type, scope_id);
  CREATE INDEX IF NOT EXISTS replica_deletions_drive ON replica_deletions(drive_id, requested_at);
  CREATE INDEX IF NOT EXISTS source_deletions_device ON source_deletions(device_name, requested_at);
`);

function locationJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    deviceName: row.device_name,
    site: row.site,
    reliability: row.reliability,
    remote: Boolean(row.remote),
    encrypted: Boolean(row.encrypted),
    lastSeen: row.last_seen
  };
}

function primaryLocation() {
  let row = db.prepare("SELECT * FROM storage_locations WHERE id = 'primary'").get();
  if (!row) {
    db.prepare(`
      INSERT INTO storage_locations(id, name, kind, device_name, site, reliability, remote, encrypted, last_seen)
      VALUES('primary', 'Mochimono', 'primary', '', '', 'normal', 0, 0, ?)
    `).run(now());
    row = db.prepare("SELECT * FROM storage_locations WHERE id = 'primary'").get();
  }
  return locationJson(row);
}

function normalizeLocation(id, input = {}) {
  const previous = db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(id);
  const kind = ['primary','source','backup','peer'].includes(input.kind) ? input.kind : previous?.kind || (id === 'primary' ? 'primary' : 'backup');
  const reliability = ['low','normal','high'].includes(input.reliability) ? input.reliability : previous?.reliability || 'normal';
  return {
    id,
    name: String(input.name ?? previous?.name ?? (id === 'primary' ? 'Mochimono' : id)).trim().slice(0, 120) || id,
    kind,
    deviceName: String(input.deviceName ?? previous?.device_name ?? '').trim().slice(0, 120),
    site: String(input.site ?? previous?.site ?? '').trim().slice(0, 120),
    reliability,
    remote: input.remote === undefined ? Boolean(previous?.remote) : Boolean(input.remote),
    encrypted: input.encrypted === undefined ? Boolean(previous?.encrypted) : Boolean(input.encrypted)
  };
}

function saveLocation(id, input = {}) {
  const value = normalizeLocation(id, input);
  db.prepare(`
    INSERT INTO storage_locations(id, name, kind, device_name, site, reliability, remote, encrypted, last_seen)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, kind=excluded.kind, device_name=excluded.device_name, site=excluded.site,
      reliability=excluded.reliability, remote=excluded.remote, encrypted=excluded.encrypted, last_seen=excluded.last_seen
  `).run(value.id, value.name, value.kind, value.deviceName, value.site, value.reliability, Number(value.remote), Number(value.encrypted), now());
  return locationJson(db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(id));
}

function levelFor(hash) {
  const override = db.prepare('SELECT level FROM object_protection WHERE object_hash = ?').get(hash)?.level;
  if (override) return override;
  const rows = db.prepare(`
    SELECT pr.level
    FROM sources s JOIN protection_rules pr ON pr.scope_type = 'import' AND pr.scope_id = CAST(s.import_id AS TEXT)
    WHERE s.object_hash = ?
  `).all(hash);
  let best = 'normal';
  for (const row of rows) if (rank(row.level) > rank(best)) best = row.level;
  return best;
}

function sourceCopies(hash) {
  return db.prepare(`
    SELECT COALESCE(NULLIF(ir.device_name, ''), i.source_name) AS deviceName,
           COALESCE(NULLIF(ir.root_path, ''), '') AS rootPath,
           COUNT(*) AS paths
    FROM sources s
    JOIN imports i ON i.id = s.import_id
    LEFT JOIN import_roots ir ON ir.import_id = i.id
    WHERE s.object_hash = ?
    GROUP BY COALESCE(NULLIF(ir.device_name, ''), i.source_name), COALESCE(NULLIF(ir.root_path, ''), '')
    ORDER BY deviceName, rootPath
  `).all(hash).map(row => {
    const storage = db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(`source:${row.deviceName}`);
    return {
      kind: 'source',
      id: `source:${row.deviceName}:${row.rootPath}`,
      name: row.rootPath || row.deviceName,
      deviceName: row.deviceName,
      site: storage?.site || row.deviceName,
      remote: false,
      encrypted: false,
      reliability: storage?.reliability || 'normal',
      verified: true,
      paths: Number(row.paths) || 0
    };
  });
}

function backupCopies(hash) {
  return db.prepare(`
    SELECT r.drive_id AS id, r.verified_at AS verifiedAt, d.name, d.last_seen AS lastSeen,
           sl.kind, sl.device_name AS deviceName, sl.site, sl.reliability, sl.remote, sl.encrypted
    FROM replicas r JOIN drives d ON d.id = r.drive_id
    LEFT JOIN storage_locations sl ON sl.id = r.drive_id
    WHERE r.object_hash = ?
    ORDER BY d.name
  `).all(hash).map(row => ({
    kind: row.kind || 'backup',
    id: row.id,
    name: row.name,
    deviceName: row.deviceName || row.name,
    site: row.site || row.deviceName || row.name,
    reliability: row.reliability || 'normal',
    remote: Boolean(row.remote),
    encrypted: Boolean(row.encrypted),
    verified: Boolean(row.verifiedAt),
    verifiedAt: row.verifiedAt,
    lastSeen: row.lastSeen
  }));
}

function primaryCopy(hash) {
  const state = db.prepare('SELECT status, verified_at AS verifiedAt FROM object_integrity WHERE hash = ?').get(hash);
  if (state && state.status !== 'healthy') return null;
  const location = primaryLocation();
  return { ...location, kind: 'primary', verified: !state || state.status === 'healthy', verifiedAt: state?.verifiedAt || null };
}

function protectionState(hash, { excludeSourceDevice = '' } = {}) {
  const object = db.prepare('SELECT hash, size, mime, state FROM objects WHERE hash = ?').get(hash);
  if (!object) return null;
  const overrideLevel = db.prepare('SELECT level FROM object_protection WHERE object_hash = ?').get(hash)?.level || null;
  const level = overrideLevel || levelFor(hash);
  const target = TARGETS[level];
  const copies = [];
  const primary = object.state === 'active' ? primaryCopy(hash) : null;
  if (primary) copies.push(primary);
  for (const source of sourceCopies(hash)) if (!excludeSourceDevice || source.deviceName !== excludeSourceDevice) copies.push(source);
  if (object.state === 'active') copies.push(...backupCopies(hash));

  const deviceKeys = new Set();
  const siteKeys = new Set();
  let remote = 0;
  let verified = 0;
  for (const copy of copies) {
    const device = String(copy.deviceName || copy.id || copy.name || '').trim();
    if (device) deviceKeys.add(device.toLowerCase());
    const site = String(copy.site || device || '').trim();
    if (site) siteKeys.add(site.toLowerCase());
    if (copy.remote) remote++;
    if (copy.verified) verified++;
  }
  const status = { copies: copies.length, devices: deviceKeys.size, sites: siteKeys.size, remote, verified };
  const missing = {
    copies: Math.max(0, target.copies - status.copies),
    devices: Math.max(0, target.devices - status.devices),
    remote: Math.max(0, target.remote - status.remote),
    sites: Math.max(0, target.sites - status.sites)
  };
  const meets = !missing.copies && !missing.devices && !missing.remote && !missing.sites;
  return {
    object: { hash: object.hash, size: Number(object.size) || 0, mime: object.mime, state: object.state },
    level,
    overrideLevel,
    target,
    status,
    missing,
    meets,
    copies
  };
}

let summaryCache = null;
let summaryCacheAt = 0;
function protectionSummary(force = false) {
  if (!force && summaryCache && Date.now() - summaryCacheAt < 10_000) return summaryCache;
  const rows = db.prepare("SELECT hash, size FROM objects WHERE state = 'active' ORDER BY hash").all();
  const levels = Object.fromEntries(LEVELS.map(level => [level, { files: 0, bytes: 0, needsProtection: 0 }]));
  let protectedFiles = 0;
  let protectedBytes = 0;
  let needsProtection = 0;
  let needsBytes = 0;
  for (const row of rows) {
    const state = protectionState(row.hash);
    if (!state) continue;
    const bucket = levels[state.level];
    bucket.files++;
    bucket.bytes += Number(row.size) || 0;
    if (state.meets) {
      protectedFiles++;
      protectedBytes += Number(row.size) || 0;
    } else {
      bucket.needsProtection++;
      needsProtection++;
      needsBytes += Number(row.size) || 0;
    }
  }
  const trashed = db.prepare('SELECT COUNT(*) AS count FROM protection_trash').get();
  summaryCache = {
    files: rows.length,
    protectedFiles,
    protectedBytes,
    needsProtection,
    needsBytes,
    levels,
    trash: Number(trashed.count) || 0,
    generatedAt: now()
  };
  summaryCacheAt = Date.now();
  return summaryCache;
}

function invalidateSummary() {
  summaryCache = null;
  summaryCacheAt = 0;
}

function improvesWithTarget(state, target) {
  if (!target) return false;
  if (state.copies.some(copy => copy.id === target.id)) return false;
  const before = state.missing;
  const devices = new Set(state.copies.map(copy => String(copy.deviceName || copy.id || '').toLowerCase()).filter(Boolean));
  const sites = new Set(state.copies.map(copy => String(copy.site || copy.deviceName || copy.id || '').toLowerCase()).filter(Boolean));
  if (target.deviceName || target.id) devices.add(String(target.deviceName || target.id).toLowerCase());
  if (target.site || target.deviceName || target.id) sites.add(String(target.site || target.deviceName || target.id).toLowerCase());
  const after = {
    copies: Math.max(0, state.target.copies - (state.status.copies + 1)),
    devices: Math.max(0, state.target.devices - devices.size),
    remote: Math.max(0, state.target.remote - (state.status.remote + Number(Boolean(target.remote)))),
    sites: Math.max(0, state.target.sites - sites.size)
  };
  return after.copies < before.copies || after.devices < before.devices || after.remote < before.remote || after.sites < before.sites;
}

async function trashObjects(hashes, ignore) {
  const unique = [...new Set((hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  const stamp = now();
  const mark = db.prepare("UPDATE objects SET state = 'deleted' WHERE hash = ?");
  const save = db.prepare(`
    INSERT INTO protection_trash(object_hash, trashed_at, purge_after, ignored) VALUES(?, ?, NULL, ?)
    ON CONFLICT(object_hash) DO UPDATE SET trashed_at=excluded.trashed_at, ignored=excluded.ignored
  `);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const hash of unique) {
      if (!db.prepare('SELECT 1 FROM objects WHERE hash = ?').get(hash)) continue;
      mark.run(hash);
      save.run(hash, stamp, Number(Boolean(ignore)));
      db.prepare('DELETE FROM reviewed_hashes WHERE hash = ?').run(hash);
      if (ignore) db.prepare('INSERT OR REPLACE INTO ignored_hashes(hash, ignored_at) VALUES(?, ?)').run(hash, stamp);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  invalidateSummary();
  return unique.length;
}

async function purgeObjects(hashes) {
  const unique = [...new Set((hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  for (const hash of unique) {
    const drives = db.prepare('SELECT drive_id FROM replicas WHERE object_hash = ?').all(hash);
    const sourceDevices = db.prepare(`
      SELECT DISTINCT COALESCE(NULLIF(ir.device_name, ''), i.source_name) AS deviceName
      FROM sources s JOIN imports i ON i.id=s.import_id
      LEFT JOIN import_roots ir ON ir.import_id=i.id
      WHERE s.object_hash=?
    `).all(hash).map(row => String(row.deviceName || '').trim()).filter(Boolean);
    const stamp = now();
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const drive of drives) db.prepare('INSERT OR REPLACE INTO replica_deletions(object_hash, drive_id, requested_at) VALUES(?, ?, ?)').run(hash, drive.drive_id, stamp);
      for (const device of sourceDevices) db.prepare('INSERT OR REPLACE INTO source_deletions(object_hash, device_name, requested_at) VALUES(?, ?, ?)').run(hash, device, stamp);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    await Promise.allSettled([removeObject(DATA_DIR, hash), cleanupThumbnail(hash)]);
    db.prepare('DELETE FROM object_integrity WHERE hash = ?').run(hash);
  }
  invalidateSummary();
  return unique.length;
}

export function registerProtectionStorage(id, input) {
  return saveLocation(String(id), input);
}

export async function handleProtectionServer(req, res, url) {
  if (!url.pathname.startsWith('/api/protection/')) return false;

  if (req.method === 'GET' && url.pathname === '/api/protection/summary') {
    json(res, 200, protectionSummary());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/protection/rules') {
    json(res, 200, {
      rules: db.prepare('SELECT scope_type AS scopeType, scope_id AS scopeId, level, updated_at AS updatedAt FROM protection_rules ORDER BY scope_type, scope_id').all()
    });
    return true;
  }

  const importRule = /^\/api\/protection\/rules\/import\/(\d+)$/.exec(url.pathname);
  if (importRule && req.method === 'POST') {
    const importId = Number(importRule[1]);
    if (!db.prepare('SELECT 1 FROM imports WHERE id = ?').get(importId)) return void json(res, 404, { error: 'Import not found' });
    const body = await readJson(req);
    const level = String(body.level || 'normal');
    if (!validLevel(level)) return void json(res, 400, { error: 'Invalid protection level' });
    if (level === 'normal') db.prepare("DELETE FROM protection_rules WHERE scope_type='import' AND scope_id=?").run(String(importId));
    else db.prepare(`
      INSERT INTO protection_rules(scope_type, scope_id, level, updated_at) VALUES('import', ?, ?, ?)
      ON CONFLICT(scope_type, scope_id) DO UPDATE SET level=excluded.level, updated_at=excluded.updated_at
    `).run(String(importId), level, now());
    invalidateSummary();
    json(res, 200, { ok: true, level });
    return true;
  }

  const importCleanup = /^\/api\/protection\/imports\/(\d+)\/cleanup$/.exec(url.pathname);
  if (importCleanup) {
    const importId = Number(importCleanup[1]);
    if (!db.prepare('SELECT 1 FROM imports WHERE id = ?').get(importId)) return void json(res, 404, { error: 'Import not found' });
    const exclusive = db.prepare(`
      SELECT DISTINCT o.hash, o.size
      FROM sources s JOIN objects o ON o.hash=s.object_hash
      WHERE s.import_id=? AND o.state='active'
        AND NOT EXISTS (SELECT 1 FROM sources sx WHERE sx.object_hash=s.object_hash AND sx.import_id<>?)
    `).all(importId, importId);
    const total = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM (SELECT DISTINCT o.hash, o.size FROM sources s JOIN objects o ON o.hash=s.object_hash WHERE s.import_id=? AND o.state='active')`).get(importId);
    const result = {
      importId,
      files: Number(total.count) || 0,
      bytes: Number(total.bytes) || 0,
      exclusiveFiles: exclusive.length,
      exclusiveBytes: exclusive.reduce((sum, row) => sum + (Number(row.size) || 0), 0)
    };
    if (req.method === 'GET') return void json(res, 200, result);
    if (req.method === 'POST') {
      const body = await readJson(req);
      db.prepare("DELETE FROM protection_rules WHERE scope_type='import' AND scope_id=?").run(String(importId));
      const trashed = body.trashExclusive === true ? await trashObjects(exclusive.map(row => row.hash), false) : 0;
      invalidateSummary();
      return void json(res, 200, { ...result, trashed });
    }
    return void json(res, 405, { error: 'Method not allowed' });
  }

  const objectLevel = /^\/api\/protection\/objects\/([a-f0-9]{64})\/level$/.exec(url.pathname);
  if (objectLevel && req.method === 'POST') {
    const hash = objectLevel[1];
    if (!db.prepare('SELECT 1 FROM objects WHERE hash = ?').get(hash)) return void json(res, 404, { error: 'Object not found' });
    const body = await readJson(req);
    const level = String(body.level || '');
    if (!level || level === 'inherit') db.prepare('DELETE FROM object_protection WHERE object_hash = ?').run(hash);
    else {
      if (!validLevel(level)) return void json(res, 400, { error: 'Invalid protection level' });
      db.prepare(`
        INSERT INTO object_protection(object_hash, level, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(object_hash) DO UPDATE SET level=excluded.level, updated_at=excluded.updated_at
      `).run(hash, level, now());
    }
    invalidateSummary();
    json(res, 200, protectionState(hash));
    return true;
  }

  const objectDetail = /^\/api\/protection\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
  if (objectDetail && req.method === 'GET') {
    const state = protectionState(objectDetail[1], { excludeSourceDevice: String(url.searchParams.get('excludeSourceDevice') || '') });
    if (!state) json(res, 404, { error: 'Object not found' });
    else json(res, 200, state);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/protection/locations') {
    primaryLocation();
    const drives = db.prepare('SELECT id, name, last_seen AS lastSeen FROM drives ORDER BY name').all();
    for (const drive of drives) if (!db.prepare('SELECT 1 FROM storage_locations WHERE id = ?').get(drive.id)) saveLocation(drive.id, { name: drive.name, kind: 'backup' });
    json(res, 200, { locations: db.prepare('SELECT * FROM storage_locations ORDER BY kind, name').all().map(locationJson) });
    return true;
  }

  const locationRoute = /^\/api\/protection\/locations\/([^/]+)$/.exec(url.pathname);
  if (locationRoute && req.method === 'POST') {
    const id = decodeURIComponent(locationRoute[1]);
    const body = await readJson(req);
    json(res, 200, saveLocation(id, body));
    invalidateSummary();
    return true;
  }

  const plan = /^\/api\/protection\/plan\/([^/]+)$/.exec(url.pathname);
  if (plan && req.method === 'GET') {
    const id = decodeURIComponent(plan[1]);
    const target = locationJson(db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(id));
    if (!target) return void json(res, 404, { error: 'Storage location not found' });
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
    const scan = Math.max(limit * 5, 500);
    const candidates = db.prepare(`
      SELECT o.hash, o.size, o.mime FROM objects o
      WHERE o.state='active' AND o.hash > ?
        AND NOT EXISTS (SELECT 1 FROM replicas r WHERE r.object_hash=o.hash AND r.drive_id=?)
      ORDER BY o.hash LIMIT ?
    `).all(after, id, scan);
    const objects = [];
    for (const object of candidates) {
      const state = protectionState(object.hash);
      if (state && !state.meets && improvesWithTarget(state, target)) objects.push({ ...object, level: state.level });
      if (objects.length >= limit) break;
    }
    const nextAfter = candidates.length === scan ? candidates.at(-1).hash : null;
    json(res, 200, { objects, nextAfter });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/protection/trash') {
    const body = await readJson(req, 2 * 1024 * 1024);
    if (!Array.isArray(body.hashes) || body.hashes.length > 5000) return void json(res, 400, { error: 'hashes must be an array of at most 5000 hashes' });
    json(res, 200, { ok: true, count: await trashObjects(body.hashes, body.ignore === true) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/protection/trash') {
    const rows = db.prepare(`
      SELECT t.object_hash AS hash, t.trashed_at AS trashedAt, t.ignored, o.size, o.mime,
             COALESCE((SELECT MIN(filename) FROM sources s WHERE s.object_hash=o.hash), o.hash) AS filename
      FROM protection_trash t JOIN objects o ON o.hash=t.object_hash
      ORDER BY t.trashed_at DESC LIMIT 1000
    `).all().map(row => ({ ...row, ignored: Boolean(row.ignored) }));
    json(res, 200, { files: rows });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/protection/restore') {
    const body = await readJson(req, 2 * 1024 * 1024);
    const hashes = [...new Set((body.hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of hashes) {
        if (!db.prepare('SELECT 1 FROM protection_trash WHERE object_hash = ?').get(hash)) continue;
        db.prepare("UPDATE objects SET state='active' WHERE hash=?").run(hash);
        db.prepare('DELETE FROM protection_trash WHERE object_hash=?').run(hash);
        db.prepare('DELETE FROM ignored_hashes WHERE hash=?').run(hash);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    invalidateSummary();
    json(res, 200, { ok: true, count: hashes.length });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/protection/purge') {
    const body = await readJson(req, 2 * 1024 * 1024);
    if (body.confirm !== 'DELETE') return void json(res, 400, { error: 'Permanent deletion requires confirmation' });
    if (!Array.isArray(body.hashes) || body.hashes.length > 5000) return void json(res, 400, { error: 'hashes must be an array of at most 5000 hashes' });
    const count = await purgeObjects(body.hashes);
    json(res, 200, { ok: true, count });
    return true;
  }

  const sourceDeletions = /^\/api\/protection\/source-deletions\/([^/]+)$/.exec(url.pathname);
  if (sourceDeletions && req.method === 'GET') {
    const device = decodeURIComponent(sourceDeletions[1]);
    const rows = db.prepare('SELECT object_hash AS hash, requested_at AS requestedAt FROM source_deletions WHERE lower(device_name)=lower(?) ORDER BY requested_at LIMIT 1000').all(device);
    json(res, 200, { deletions: rows });
    return true;
  }

  const sourceDeletionAck = /^\/api\/protection\/source-deletions\/([^/]+)\/ack$/.exec(url.pathname);
  if (sourceDeletionAck && req.method === 'POST') {
    const device = decodeURIComponent(sourceDeletionAck[1]);
    const body = await readJson(req);
    const hashes = [...new Set((body.hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of hashes) db.prepare('DELETE FROM source_deletions WHERE lower(device_name)=lower(?) AND object_hash=?').run(device, hash);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    json(res, 200, { ok: true, count: hashes.length });
    return true;
  }

  const deletions = /^\/api\/protection\/deletions\/([^/]+)$/.exec(url.pathname);
  if (deletions && req.method === 'GET') {
    const id = decodeURIComponent(deletions[1]);
    const rows = db.prepare('SELECT object_hash AS hash, requested_at AS requestedAt FROM replica_deletions WHERE drive_id=? ORDER BY requested_at LIMIT 1000').all(id);
    json(res, 200, { deletions: rows });
    return true;
  }

  const deletionAck = /^\/api\/protection\/deletions\/([^/]+)\/ack$/.exec(url.pathname);
  if (deletionAck && req.method === 'POST') {
    const id = decodeURIComponent(deletionAck[1]);
    const body = await readJson(req);
    const hashes = [...new Set((body.hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of hashes) {
        db.prepare('DELETE FROM replicas WHERE drive_id=? AND object_hash=?').run(id, hash);
        db.prepare('DELETE FROM replica_deletions WHERE drive_id=? AND object_hash=?').run(id, hash);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    invalidateSummary();
    json(res, 200, { ok: true, count: hashes.length });
    return true;
  }

  json(res, 405, { error: 'Method not allowed' });
  return true;
}
