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
const validHash = hash => /^[a-f0-9]{64}$/.test(String(hash || ''));

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

  CREATE TABLE IF NOT EXISTS source_replicas (
    object_hash TEXT NOT NULL REFERENCES objects(hash) ON DELETE CASCADE,
    device_name TEXT NOT NULL,
    site TEXT NOT NULL DEFAULT '',
    reliability TEXT NOT NULL DEFAULT 'normal' CHECK (reliability IN ('low','normal','high')),
    verified_at TEXT NOT NULL,
    scan_id TEXT NOT NULL,
    PRIMARY KEY(object_hash, device_name)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS protection_trash (
    object_hash TEXT PRIMARY KEY REFERENCES objects(hash) ON DELETE CASCADE,
    trashed_at TEXT NOT NULL,
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
  CREATE INDEX IF NOT EXISTS source_replicas_device ON source_replicas(device_name, object_hash);
  CREATE INDEX IF NOT EXISTS replica_deletions_drive ON replica_deletions(drive_id, requested_at);
  CREATE INDEX IF NOT EXISTS source_deletions_device ON source_deletions(device_name, requested_at);
`);

let snapshot = null;
let snapshotAt = 0;
const invalidate = () => { snapshot = null; snapshotAt = 0; };

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

function normalizeLocation(id, input = {}) {
  const previous = db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(id);
  const kind = ['primary','source','backup','peer'].includes(input.kind)
    ? input.kind
    : previous?.kind || (id === 'primary' ? 'primary' : 'backup');
  const reliability = ['low','normal','high'].includes(input.reliability)
    ? input.reliability
    : previous?.reliability || 'normal';
  return {
    id,
    name: String(input.name ?? previous?.name ?? (id === 'primary' ? 'Mochimono' : id)).trim().slice(0, 120) || id,
    kind,
    deviceName: String(input.deviceName ?? previous?.device_name ?? (id === 'primary' ? 'Mochimono server' : '')).trim().slice(0, 120),
    site: String(input.site ?? previous?.site ?? (id === 'primary' ? 'Mochimono server' : '')).trim().slice(0, 120),
    reliability,
    remote: input.remote === undefined ? (previous ? Boolean(previous.remote) : id === 'primary') : Boolean(input.remote),
    encrypted: input.encrypted === undefined ? Boolean(previous?.encrypted) : Boolean(input.encrypted)
  };
}

function saveLocation(id, input = {}) {
  const value = normalizeLocation(id, input);
  db.prepare(`
    INSERT INTO storage_locations(id,name,kind,device_name,site,reliability,remote,encrypted,last_seen)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, kind=excluded.kind, device_name=excluded.device_name, site=excluded.site,
      reliability=excluded.reliability, remote=excluded.remote, encrypted=excluded.encrypted, last_seen=excluded.last_seen
  `).run(value.id, value.name, value.kind, value.deviceName, value.site, value.reliability, Number(value.remote), Number(value.encrypted), now());
  invalidate();
  return locationJson(db.prepare('SELECT * FROM storage_locations WHERE id=?').get(id));
}

function primaryLocation() {
  let row = db.prepare("SELECT * FROM storage_locations WHERE id='primary'").get();
  if (!row) {
    saveLocation('primary', {
      name: 'Mochimono', kind: 'primary', deviceName: 'Mochimono server',
      site: 'Mochimono server', reliability: 'normal', remote: true, encrypted: false
    });
    row = db.prepare("SELECT * FROM storage_locations WHERE id='primary'").get();
  }
  return locationJson(row);
}

function inheritedLevel(hash) {
  const rows = db.prepare(`
    SELECT DISTINCT COALESCE(pr.level, 'normal') AS level
    FROM sources s
    LEFT JOIN protection_rules pr ON pr.scope_type='import' AND pr.scope_id=CAST(s.import_id AS TEXT)
    WHERE s.object_hash=?
  `).all(hash);
  if (!rows.length) return 'normal';
  let best = rows[0].level;
  for (const row of rows.slice(1)) if (rank(row.level) > rank(best)) best = row.level;
  return best;
}

function levelFor(hash) {
  return db.prepare('SELECT level FROM object_protection WHERE object_hash=?').get(hash)?.level || inheritedLevel(hash);
}

function sourceCopies(hash) {
  return db.prepare(`
    SELECT sr.device_name AS deviceName,sr.site,sr.reliability,sr.verified_at AS verifiedAt,
           sl.name,sl.remote,sl.encrypted
    FROM source_replicas sr
    LEFT JOIN storage_locations sl ON sl.id=('source:' || sr.device_name)
    WHERE sr.object_hash=? ORDER BY sr.device_name
  `).all(hash).map(row => ({
    id: `source:${row.deviceName}`,
    kind: 'source',
    name: row.name || row.deviceName,
    deviceName: row.deviceName,
    site: row.site || row.deviceName,
    reliability: row.reliability || 'normal',
    remote: Boolean(row.remote),
    encrypted: Boolean(row.encrypted),
    verified: Boolean(row.verifiedAt),
    verifiedAt: row.verifiedAt
  }));
}

function backupCopies(hash) {
  return db.prepare(`
    SELECT r.drive_id AS id,r.verified_at AS verifiedAt,d.name,d.last_seen AS lastSeen,
           sl.kind,sl.device_name AS deviceName,sl.site,sl.reliability,sl.remote,sl.encrypted
    FROM replicas r JOIN drives d ON d.id=r.drive_id
    LEFT JOIN storage_locations sl ON sl.id=r.drive_id
    WHERE r.object_hash=? ORDER BY d.name
  `).all(hash).map(row => ({
    id: row.id,
    kind: row.kind || 'backup',
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
  const integrity = db.prepare('SELECT status,verified_at AS verifiedAt FROM object_integrity WHERE hash=?').get(hash);
  if (integrity && integrity.status !== 'healthy') return null;
  return { ...primaryLocation(), verified: true, verifiedAt: integrity?.verifiedAt || null };
}

function evaluate(level, copies) {
  const target = TARGETS[level];
  const qualified = copies.filter(copy => copy.verified && copy.reliability !== 'low');
  const devices = new Set();
  const sites = new Set();
  let remote = 0;
  for (const copy of qualified) {
    const device = String(copy.id || copy.deviceName || copy.name || '').trim().toLowerCase();
    const site = String(copy.site || copy.deviceName || copy.id || '').trim().toLowerCase();
    if (device) devices.add(device);
    if (site) sites.add(site);
    if (copy.remote) remote++;
  }
  const status = {
    copies: copies.length,
    verified: copies.filter(copy => copy.verified).length,
    qualifyingCopies: qualified.length,
    devices: devices.size,
    sites: sites.size,
    remote
  };
  const missing = {
    copies: Math.max(0, target.copies - status.qualifyingCopies),
    devices: Math.max(0, target.devices - status.devices),
    remote: Math.max(0, target.remote - status.remote),
    sites: Math.max(0, target.sites - status.sites)
  };
  return { target, status, missing, meets: !missing.copies && !missing.devices && !missing.remote && !missing.sites };
}

function protectionState(hash, { excludeSourceDevice = '' } = {}) {
  const object = db.prepare('SELECT hash,size,mime,state FROM objects WHERE hash=?').get(hash);
  if (!object) return null;
  const overrideLevel = db.prepare('SELECT level FROM object_protection WHERE object_hash=?').get(hash)?.level || null;
  const level = overrideLevel || inheritedLevel(hash);
  const copies = [];
  if (object.state === 'active') {
    const primary = primaryCopy(hash);
    if (primary) copies.push(primary);
    copies.push(...backupCopies(hash));
  }
  for (const source of sourceCopies(hash)) {
    if (!excludeSourceDevice || source.deviceName.toLowerCase() !== excludeSourceDevice.toLowerCase()) copies.push(source);
  }
  return { object: { ...object, size: Number(object.size) || 0 }, level, overrideLevel, ...evaluate(level, copies), copies };
}

function protectionSummary(force = false) {
  if (!force && snapshot && Date.now() - snapshotAt < 10_000) return snapshot;
  const objects = db.prepare("SELECT hash,size FROM objects WHERE state='active' ORDER BY hash").all();
  const levelsByHash = new Map(objects.map(row => [row.hash, 'normal']));
  const overridden = new Set();
  for (const row of db.prepare('SELECT object_hash AS hash,level FROM object_protection').all()) {
    overridden.add(row.hash);
    levelsByHash.set(row.hash, row.level);
  }

  const inherited = new Map();
  for (const row of db.prepare(`
    SELECT DISTINCT s.object_hash AS hash,s.import_id,COALESCE(pr.level,'normal') AS level
    FROM sources s
    LEFT JOIN protection_rules pr ON pr.scope_type='import' AND pr.scope_id=CAST(s.import_id AS TEXT)
  `).all()) {
    const current = inherited.get(row.hash);
    if (!current || rank(row.level) > rank(current)) inherited.set(row.hash, row.level);
  }
  for (const [hash, level] of inherited) if (!overridden.has(hash)) levelsByHash.set(hash, level);

  const copiesByHash = new Map();
  const addCopy = (hash, copy) => {
    let copies = copiesByHash.get(hash);
    if (!copies) copiesByHash.set(hash, copies = []);
    copies.push(copy);
  };
  const primary = primaryLocation();
  const bad = new Set(db.prepare("SELECT hash FROM object_integrity WHERE status!='healthy'").all().map(row => row.hash));
  for (const object of objects) if (!bad.has(object.hash)) addCopy(object.hash, { ...primary, verified: true });

  for (const row of db.prepare(`
    SELECT sr.object_hash AS hash,sr.device_name AS deviceName,sr.site,sr.reliability,sr.verified_at AS verifiedAt,
           sl.name,sl.remote,sl.encrypted
    FROM source_replicas sr LEFT JOIN storage_locations sl ON sl.id=('source:' || sr.device_name)
  `).all()) addCopy(row.hash, {
    id: `source:${row.deviceName}`, kind: 'source', name: row.name || row.deviceName,
    deviceName: row.deviceName, site: row.site || row.deviceName, reliability: row.reliability || 'normal',
    remote: Boolean(row.remote), encrypted: Boolean(row.encrypted), verified: Boolean(row.verifiedAt)
  });

  for (const row of db.prepare(`
    SELECT r.object_hash AS hash,r.drive_id AS id,r.verified_at AS verifiedAt,d.name,
           sl.kind,sl.device_name AS deviceName,sl.site,sl.reliability,sl.remote,sl.encrypted
    FROM replicas r JOIN drives d ON d.id=r.drive_id LEFT JOIN storage_locations sl ON sl.id=r.drive_id
  `).all()) addCopy(row.hash, {
    id: row.id, kind: row.kind || 'backup', name: row.name, deviceName: row.deviceName || row.name,
    site: row.site || row.deviceName || row.name, reliability: row.reliability || 'normal',
    remote: Boolean(row.remote), encrypted: Boolean(row.encrypted), verified: Boolean(row.verifiedAt)
  });

  const levels = Object.fromEntries(LEVELS.map(level => [level, { files: 0, bytes: 0, needsProtection: 0 }]));
  let protectedFiles = 0;
  let protectedBytes = 0;
  let needsProtection = 0;
  let needsBytes = 0;
  for (const object of objects) {
    const level = levelsByHash.get(object.hash) || 'normal';
    const state = evaluate(level, copiesByHash.get(object.hash) || []);
    const bucket = levels[level];
    const size = Number(object.size) || 0;
    bucket.files++;
    bucket.bytes += size;
    if (state.meets) {
      protectedFiles++;
      protectedBytes += size;
    } else {
      bucket.needsProtection++;
      needsProtection++;
      needsBytes += size;
    }
  }
  const trash = Number(db.prepare('SELECT COUNT(*) AS count FROM protection_trash').get().count) || 0;
  snapshot = { files: objects.length, protectedFiles, protectedBytes, needsProtection, needsBytes, levels, trash, generatedAt: now() };
  snapshotAt = Date.now();
  return snapshot;
}

function improvesWithTarget(state, target) {
  if (!state || !target || target.reliability === 'low' || state.copies.some(copy => copy.id === target.id)) return false;
  const candidate = { ...target, verified: true, deviceName: target.deviceName || target.id, site: target.site || target.deviceName || target.id };
  const next = evaluate(state.level, [...state.copies, candidate]);
  return next.missing.copies < state.missing.copies || next.missing.devices < state.missing.devices ||
    next.missing.remote < state.missing.remote || next.missing.sites < state.missing.sites;
}

async function trashObjects(hashes, ignore) {
  const unique = [...new Set((hashes || []).map(String).filter(validHash))];
  const stamp = now();
  const mark = db.prepare("UPDATE objects SET state='deleted' WHERE hash=?");
  const save = db.prepare(`
    INSERT INTO protection_trash(object_hash,trashed_at,ignored) VALUES(?,?,?)
    ON CONFLICT(object_hash) DO UPDATE SET trashed_at=excluded.trashed_at,ignored=excluded.ignored
  `);
  let count = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const hash of unique) {
      if (!db.prepare('SELECT 1 FROM objects WHERE hash=?').get(hash)) continue;
      mark.run(hash);
      save.run(hash, stamp, Number(Boolean(ignore)));
      db.prepare('DELETE FROM reviewed_hashes WHERE hash=?').run(hash);
      if (ignore) db.prepare('INSERT OR REPLACE INTO ignored_hashes(hash,ignored_at) VALUES(?,?)').run(hash, stamp);
      count++;
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  invalidate();
  return count;
}

async function purgeObjects(hashes) {
  const unique = [...new Set((hashes || []).map(String).filter(validHash))];
  let count = 0;
  for (const hash of unique) {
    if (!db.prepare('SELECT 1 FROM protection_trash WHERE object_hash=?').get(hash)) continue;
    const drives = db.prepare('SELECT drive_id FROM replicas WHERE object_hash=?').all(hash);
    const devices = db.prepare('SELECT device_name AS deviceName FROM source_replicas WHERE object_hash=?').all(hash);
    await removeObject(DATA_DIR, hash);
    await cleanupThumbnail(hash).catch(() => {});
    const stamp = now();
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const drive of drives) db.prepare('INSERT OR REPLACE INTO replica_deletions(object_hash,drive_id,requested_at) VALUES(?,?,?)').run(hash, drive.drive_id, stamp);
      for (const device of devices) db.prepare('INSERT OR REPLACE INTO source_deletions(object_hash,device_name,requested_at) VALUES(?,?,?)').run(hash, device.deviceName, stamp);
      db.prepare('DELETE FROM protection_trash WHERE object_hash=?').run(hash);
      db.prepare('DELETE FROM object_integrity WHERE hash=?').run(hash);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    count++;
  }
  invalidate();
  return count;
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
    json(res, 200, { rules: db.prepare('SELECT scope_type AS scopeType,scope_id AS scopeId,level,updated_at AS updatedAt FROM protection_rules ORDER BY scope_type,scope_id').all() });
    return true;
  }

  const importRule = /^\/api\/protection\/rules\/import\/(\d+)$/.exec(url.pathname);
  if (importRule && req.method === 'POST') {
    const importId = Number(importRule[1]);
    if (!db.prepare('SELECT 1 FROM imports WHERE id=?').get(importId)) return void json(res, 404, { error: 'Import not found' });
    const level = String((await readJson(req)).level || 'normal');
    if (!validLevel(level)) return void json(res, 400, { error: 'Invalid protection level' });
    if (level === 'normal') db.prepare("DELETE FROM protection_rules WHERE scope_type='import' AND scope_id=?").run(String(importId));
    else db.prepare(`
      INSERT INTO protection_rules(scope_type,scope_id,level,updated_at) VALUES('import',?,?,?)
      ON CONFLICT(scope_type,scope_id) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at
    `).run(String(importId), level, now());
    invalidate();
    json(res, 200, { ok: true, level });
    return true;
  }

  const importCleanup = /^\/api\/protection\/imports\/(\d+)\/cleanup$/.exec(url.pathname);
  if (importCleanup) {
    const importId = Number(importCleanup[1]);
    if (!db.prepare('SELECT 1 FROM imports WHERE id=?').get(importId)) return void json(res, 404, { error: 'Import not found' });
    const exclusive = db.prepare(`
      SELECT DISTINCT o.hash,o.size FROM sources s JOIN objects o ON o.hash=s.object_hash
      WHERE s.import_id=? AND o.state='active'
        AND NOT EXISTS(SELECT 1 FROM sources sx WHERE sx.object_hash=s.object_hash AND sx.import_id<>?)
    `).all(importId, importId);
    const total = db.prepare(`
      SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM (
        SELECT DISTINCT o.hash,o.size FROM sources s JOIN objects o ON o.hash=s.object_hash
        WHERE s.import_id=? AND o.state='active'
      )
    `).get(importId);
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
      invalidate();
      return void json(res, 200, { ...result, trashed });
    }
    return void json(res, 405, { error: 'Method not allowed' });
  }

  const objectLevel = /^\/api\/protection\/objects\/([a-f0-9]{64})\/level$/.exec(url.pathname);
  if (objectLevel && req.method === 'POST') {
    const hash = objectLevel[1];
    if (!db.prepare('SELECT 1 FROM objects WHERE hash=?').get(hash)) return void json(res, 404, { error: 'Object not found' });
    const level = String((await readJson(req)).level || '');
    if (!level || level === 'inherit') db.prepare('DELETE FROM object_protection WHERE object_hash=?').run(hash);
    else {
      if (!validLevel(level)) return void json(res, 400, { error: 'Invalid protection level' });
      db.prepare(`INSERT INTO object_protection(object_hash,level,updated_at) VALUES(?,?,?)
        ON CONFLICT(object_hash) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at`).run(hash, level, now());
    }
    invalidate();
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
    for (const drive of db.prepare('SELECT id,name FROM drives ORDER BY name').all()) {
      if (!db.prepare('SELECT 1 FROM storage_locations WHERE id=?').get(drive.id)) saveLocation(drive.id, { name: drive.name, kind: 'backup' });
    }
    json(res, 200, { locations: db.prepare('SELECT * FROM storage_locations ORDER BY kind,name').all().map(locationJson) });
    return true;
  }

  const locationRoute = /^\/api\/protection\/locations\/([^/]+)$/.exec(url.pathname);
  if (locationRoute && req.method === 'POST') {
    json(res, 200, saveLocation(decodeURIComponent(locationRoute[1]), await readJson(req)));
    return true;
  }

  const sourceReplicas = /^\/api\/protection\/source-replicas\/([^/]+)$/.exec(url.pathname);
  if (sourceReplicas && req.method === 'POST') {
    const device = decodeURIComponent(sourceReplicas[1]).trim().slice(0, 120);
    const body = await readJson(req, 4 * 1024 * 1024);
    const scanId = String(body.scanId || '').slice(0, 100);
    if (!device || !scanId) return void json(res, 400, { error: 'device and scanId are required' });
    const site = String(body.site || device).trim().slice(0, 120) || device;
    const reliability = ['low','normal','high'].includes(body.reliability) ? body.reliability : 'normal';
    saveLocation(`source:${device}`, { name: device, kind: 'source', deviceName: device, site, reliability, remote: false, encrypted: false });
    const hashes = [...new Set((body.hashes || []).map(String).filter(validHash))];
    const known = new Set();
    for (let offset = 0; offset < hashes.length; offset += 400) {
      const chunk = hashes.slice(offset, offset + 400);
      if (!chunk.length) continue;
      const marks = chunk.map(() => '?').join(',');
      for (const row of db.prepare(`SELECT hash FROM objects WHERE hash IN (${marks})`).all(...chunk)) known.add(row.hash);
    }
    const save = db.prepare(`
      INSERT INTO source_replicas(object_hash,device_name,site,reliability,verified_at,scan_id) VALUES(?,?,?,?,?,?)
      ON CONFLICT(object_hash,device_name) DO UPDATE SET site=excluded.site,reliability=excluded.reliability,verified_at=excluded.verified_at,scan_id=excluded.scan_id
    `);
    const verifiedAt = now();
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of hashes) if (known.has(hash)) save.run(hash, device, site, reliability, verifiedAt, scanId);
      if (body.final === true) db.prepare('DELETE FROM source_replicas WHERE lower(device_name)=lower(?) AND scan_id<>?').run(device, scanId);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    invalidate();
    json(res, 200, { ok: true, accepted: known.size, final: body.final === true });
    return true;
  }

  const sourceRemove = /^\/api\/protection\/source-replicas\/([^/]+)\/remove$/.exec(url.pathname);
  if (sourceRemove && req.method === 'POST') {
    const device = decodeURIComponent(sourceRemove[1]);
    const hashes = [...new Set(((await readJson(req)).hashes || []).map(String).filter(validHash))];
    const remove = db.prepare('DELETE FROM source_replicas WHERE lower(device_name)=lower(?) AND object_hash=?');
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of hashes) remove.run(device, hash);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    invalidate();
    json(res, 200, { ok: true, count: hashes.length });
    return true;
  }

  const plan = /^\/api\/protection\/plan\/([^/]+)$/.exec(url.pathname);
  if (plan && req.method === 'GET') {
    const id = decodeURIComponent(plan[1]);
    const target = locationJson(db.prepare('SELECT * FROM storage_locations WHERE id=?').get(id));
    if (!target) return void json(res, 404, { error: 'Storage location not found' });
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
    const scan = Math.max(500, limit * 5);
    const candidates = db.prepare(`
      SELECT o.hash,o.size,o.mime FROM objects o
      WHERE o.state='active' AND o.hash>? AND NOT EXISTS(SELECT 1 FROM replicas r WHERE r.object_hash=o.hash AND r.drive_id=?)
      ORDER BY o.hash LIMIT ?
    `).all(after, id, scan);
    const objects = [];
    let inspected = after;
    let exhausted = true;
    for (const object of candidates) {
      inspected = object.hash;
      const state = protectionState(object.hash);
      if (state && !state.meets && improvesWithTarget(state, target)) objects.push({ ...object, level: state.level });
      if (objects.length >= limit) { exhausted = false; break; }
    }
    const nextAfter = !candidates.length ? null : exhausted ? (candidates.length === scan ? candidates.at(-1).hash : null) : inspected;
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
      SELECT t.object_hash AS hash,t.trashed_at AS trashedAt,t.ignored,o.size,o.mime,
             COALESCE((SELECT MIN(filename) FROM sources s WHERE s.object_hash=o.hash),o.hash) AS filename
      FROM protection_trash t JOIN objects o ON o.hash=t.object_hash ORDER BY t.trashed_at DESC LIMIT 1000
    `).all().map(row => ({ ...row, ignored: Boolean(row.ignored) }));
    json(res, 200, { files: rows });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/protection/restore') {
    const hashes = [...new Set(((await readJson(req, 2 * 1024 * 1024)).hashes || []).map(String).filter(validHash))];
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of hashes) {
        if (!db.prepare('SELECT 1 FROM protection_trash WHERE object_hash=?').get(hash)) continue;
        db.prepare("UPDATE objects SET state='active' WHERE hash=?").run(hash);
        db.prepare('DELETE FROM protection_trash WHERE object_hash=?').run(hash);
        db.prepare('DELETE FROM ignored_hashes WHERE hash=?').run(hash);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    invalidate();
    json(res, 200, { ok: true, count: hashes.length });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/protection/purge') {
    const body = await readJson(req, 2 * 1024 * 1024);
    if (body.confirm !== 'DELETE') return void json(res, 400, { error: 'Permanent deletion requires confirmation' });
    if (!Array.isArray(body.hashes) || body.hashes.length > 5000) return void json(res, 400, { error: 'hashes must be an array of at most 5000 hashes' });
    json(res, 200, { ok: true, count: await purgeObjects(body.hashes) });
    return true;
  }

  const sourceDeletions = /^\/api\/protection\/source-deletions\/([^/]+)$/.exec(url.pathname);
  if (sourceDeletions && req.method === 'GET') {
    const device = decodeURIComponent(sourceDeletions[1]);
    const rows = db.prepare(`
      SELECT sd.object_hash AS hash,sd.requested_at AS requestedAt
      FROM source_deletions sd JOIN objects o ON o.hash=sd.object_hash
      WHERE lower(sd.device_name)=lower(?) AND o.state='deleted'
      ORDER BY sd.requested_at LIMIT 1000
    `).all(device);
    json(res, 200, { deletions: rows });
    return true;
  }

  const sourceAck = /^\/api\/protection\/source-deletions\/([^/]+)\/ack$/.exec(url.pathname);
  if (sourceAck && req.method === 'POST') {
    const device = decodeURIComponent(sourceAck[1]);
    const hashes = [...new Set(((await readJson(req)).hashes || []).map(String).filter(validHash))];
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of hashes) {
        db.prepare('DELETE FROM source_deletions WHERE lower(device_name)=lower(?) AND object_hash=?').run(device, hash);
        db.prepare('DELETE FROM source_replicas WHERE lower(device_name)=lower(?) AND object_hash=?').run(device, hash);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    invalidate();
    json(res, 200, { ok: true, count: hashes.length });
    return true;
  }

  const deletions = /^\/api\/protection\/deletions\/([^/]+)$/.exec(url.pathname);
  if (deletions && req.method === 'GET') {
    const id = decodeURIComponent(deletions[1]);
    const rows = db.prepare(`
      SELECT rd.object_hash AS hash,rd.requested_at AS requestedAt
      FROM replica_deletions rd JOIN objects o ON o.hash=rd.object_hash
      WHERE rd.drive_id=? AND o.state='deleted' ORDER BY rd.requested_at LIMIT 1000
    `).all(id);
    json(res, 200, { deletions: rows });
    return true;
  }

  const deletionAck = /^\/api\/protection\/deletions\/([^/]+)\/ack$/.exec(url.pathname);
  if (deletionAck && req.method === 'POST') {
    const id = decodeURIComponent(deletionAck[1]);
    const hashes = [...new Set(((await readJson(req)).hashes || []).map(String).filter(validHash))];
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
    invalidate();
    json(res, 200, { ok: true, count: hashes.length });
    return true;
  }

  json(res, 405, { error: 'Method not allowed' });
  return true;
}
