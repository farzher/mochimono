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

  CREATE TABLE IF NOT EXISTS protection_intents (
    device_name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    object_hash TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    import_id INTEGER NOT NULL DEFAULT 0,
    scan_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(device_name, root_path, relative_path)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS object_lifecycle (
    object_hash TEXT PRIMARY KEY REFERENCES objects(hash) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('remote-only')),
    updated_at TEXT NOT NULL
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
  CREATE INDEX IF NOT EXISTS protection_intents_hash ON protection_intents(object_hash) WHERE object_hash <> '';
  CREATE INDEX IF NOT EXISTS protection_intents_device ON protection_intents(device_name, root_path);
  CREATE INDEX IF NOT EXISTS replica_deletions_drive ON replica_deletions(drive_id, requested_at);
  CREATE INDEX IF NOT EXISTS source_deletions_device ON source_deletions(device_name, requested_at);
`);

let snapshot = null;
let snapshotAt = 0;
const invalidate = () => { snapshot = null; snapshotAt = 0; };
const bumpCatalog = () => db.prepare('UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1').run();

function locationJson(row) {
  if (!row) return null;
  const lastSeen = row.kind === 'backup'
    ? db.prepare('SELECT last_seen AS lastSeen FROM drives WHERE id=?').get(row.id)?.lastSeen || row.last_seen
    : row.last_seen;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    deviceName: row.device_name,
    site: row.site,
    reliability: row.reliability,
    remote: Boolean(row.remote),
    encrypted: Boolean(row.encrypted),
    lastSeen
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

function levelForImport(importId) {
  if (!Number(importId)) return 'normal';
  return db.prepare("SELECT level FROM protection_rules WHERE scope_type='import' AND scope_id=?").get(String(importId))?.level || 'normal';
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
    verifiedAt: row.verifiedAt,
    representation: 'original'
  }));
}

function backupCopies(hash) {
  return db.prepare(`
    SELECT r.drive_id AS id,r.verified_at AS verifiedAt,d.name AS name,d.last_seen AS lastSeen,
           sl.kind,sl.device_name AS deviceName,sl.site,sl.reliability,sl.remote,sl.encrypted,
           'original' AS representation
    FROM replicas r JOIN drives d ON d.id=r.drive_id
    LEFT JOIN storage_locations sl ON sl.id=r.drive_id
    WHERE r.object_hash=?

    UNION ALL

    SELECT substr(rp.location_id,8) AS id,rp.verified_at AS verifiedAt,d.name AS name,d.last_seen AS lastSeen,
           sl.kind,sl.device_name AS deviceName,sl.site,sl.reliability,sl.remote,sl.encrypted,
           'compact' AS representation
    FROM representation_presence rp
    JOIN drives d ON rp.location_id=('backup:' || d.id)
    JOIN objects o ON o.hash=rp.original_hash
    JOIN representation_policies p ON p.location_id=rp.location_id
      AND p.media_type=CASE WHEN o.mime LIKE 'image/%' THEN 'image' WHEN o.mime LIKE 'video/%' THEN 'video' ELSE '' END
      AND p.representation='compact'
    JOIN representation_retention rr ON rr.location_id=p.location_id AND rr.media_type=p.media_type AND rr.allow_original_removal=1
    LEFT JOIN storage_locations sl ON sl.id=d.id
    LEFT JOIN replicas existing ON existing.object_hash=rp.original_hash AND existing.drive_id=d.id
    WHERE rp.original_hash=? AND rp.representation='compact' AND rp.verified_at IS NOT NULL AND existing.object_hash IS NULL
    ORDER BY name
  `).all(hash, hash).map(row => ({
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
    lastSeen: row.lastSeen,
    representation: row.representation,
    reducedFidelity: row.representation === 'compact'
  }));
}

function primaryCopy(hash) {
  const integrity = db.prepare('SELECT status,verified_at AS verifiedAt FROM object_integrity WHERE hash=?').get(hash);
  if (integrity && integrity.status !== 'healthy') return null;
  return { ...primaryLocation(), verified: true, verifiedAt: integrity?.verifiedAt || null, representation: 'original' };
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
    originals: qualified.filter(copy => copy.representation !== 'compact').length,
    reducedFidelity: qualified.filter(copy => copy.representation === 'compact').length,
    devices: devices.size,
    sites: sites.size,
    remote
  };
  const missing = {
    copies: Math.max(0, target.copies - status.qualifyingCopies),
    originals: Math.max(0, 1 - status.originals),
    devices: Math.max(0, target.devices - status.devices),
    remote: Math.max(0, target.remote - status.remote),
    sites: Math.max(0, target.sites - status.sites)
  };
  return { target, status, missing, meets: !missing.copies && !missing.originals && !missing.devices && !missing.remote && !missing.sites };
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
  const intended = Boolean(db.prepare("SELECT 1 FROM protection_intents WHERE object_hash=? LIMIT 1").get(hash));
  const remoteOnly = Boolean(db.prepare("SELECT 1 FROM object_lifecycle WHERE object_hash=? AND mode='remote-only'").get(hash));
  const evaluated = evaluate(level, copies);
  const lifecycle = intended ? 'current' : remoteOnly ? 'remote-only' : 'unlinked';
  const protectionState = lifecycle === 'current' ? (evaluated.meets ? 'protected' : 'needs-backup') : lifecycle;
  return { object: { ...object, size: Number(object.size) || 0 }, level, overrideLevel, lifecycle, protectionState, ...evaluated, copies };
}

function protectionSnapshot(force = false) {
  if (!force && snapshot && Date.now() - snapshotAt < 10_000) return snapshot;

  const objects = db.prepare("SELECT hash,size FROM objects WHERE state='active' ORDER BY hash").all();
  const objectByHash = new Map(objects.map(row => [row.hash,row]));
  const intents = db.prepare(`
    SELECT device_name AS deviceName,root_path AS rootPath,relative_path AS relativePath,
           object_hash AS hash,size,import_id AS importId
    FROM protection_intents
    ORDER BY device_name,root_path,relative_path
  `).all();
  const remoteOnly = new Set(db.prepare("SELECT object_hash AS hash FROM object_lifecycle WHERE mode='remote-only'").all().map(row=>row.hash));

  const levelsByHash = new Map(objects.map(row => [row.hash, 'normal']));
  const overridden = new Set();
  for (const row of db.prepare('SELECT object_hash AS hash,level FROM object_protection').all()) {
    overridden.add(row.hash);
    levelsByHash.set(row.hash,row.level);
  }

  const inherited = new Map();
  for (const row of db.prepare(`
    SELECT DISTINCT s.object_hash AS hash,s.import_id,COALESCE(pr.level,'normal') AS level
    FROM sources s
    LEFT JOIN protection_rules pr ON pr.scope_type='import' AND pr.scope_id=CAST(s.import_id AS TEXT)
  `).all()) {
    const current=inherited.get(row.hash);
    if(!current||rank(row.level)>rank(current))inherited.set(row.hash,row.level);
  }
  for(const [hash,level] of inherited)if(!overridden.has(hash))levelsByHash.set(hash,level);

  const intentLevelByHash=new Map();
  for(const intent of intents){
    if(!validHash(intent.hash))continue;
    const level=levelForImport(intent.importId);
    const current=intentLevelByHash.get(intent.hash);
    if(!current||rank(level)>rank(current))intentLevelByHash.set(intent.hash,level);
  }
  for(const [hash,level] of intentLevelByHash)if(!overridden.has(hash))levelsByHash.set(hash,level);

  const copiesByHash=new Map();
  const addCopy=(hash,copy)=>{
    let copies=copiesByHash.get(hash);
    if(!copies)copiesByHash.set(hash,copies=[]);
    if(!copies.some(existing=>existing.id===copy.id))copies.push(copy);
  };
  const primary=primaryLocation();
  const bad=new Set(db.prepare("SELECT hash FROM object_integrity WHERE status!='healthy'").all().map(row=>row.hash));
  for(const object of objects)if(!bad.has(object.hash))addCopy(object.hash,{...primary,verified:true,representation:'original'});

  for(const row of db.prepare(`
    SELECT sr.object_hash AS hash,sr.device_name AS deviceName,sr.site,sr.reliability,sr.verified_at AS verifiedAt,
           sl.name,sl.remote,sl.encrypted
    FROM source_replicas sr LEFT JOIN storage_locations sl ON sl.id=('source:' || sr.device_name)
  `).all())addCopy(row.hash,{
    id:`source:${row.deviceName}`,kind:'source',name:row.name||row.deviceName,
    deviceName:row.deviceName,site:row.site||row.deviceName,reliability:row.reliability||'normal',
    remote:Boolean(row.remote),encrypted:Boolean(row.encrypted),verified:Boolean(row.verifiedAt),representation:'original'
  });

  for(const row of db.prepare(`
    SELECT r.object_hash AS hash,r.drive_id AS id,r.verified_at AS verifiedAt,d.name,
           sl.kind,sl.device_name AS deviceName,sl.site,sl.reliability,sl.remote,sl.encrypted
    FROM replicas r JOIN drives d ON d.id=r.drive_id LEFT JOIN storage_locations sl ON sl.id=r.drive_id
  `).all())addCopy(row.hash,{
    id:row.id,kind:row.kind||'backup',name:row.name,deviceName:row.deviceName||row.name,
    site:row.site||row.deviceName||row.name,reliability:row.reliability||'normal',
    remote:Boolean(row.remote),encrypted:Boolean(row.encrypted),verified:Boolean(row.verifiedAt),representation:'original'
  });

  for(const row of db.prepare(`
    SELECT rp.original_hash AS hash,substr(rp.location_id,8) AS id,rp.verified_at AS verifiedAt,d.name,
           sl.kind,sl.device_name AS deviceName,sl.site,sl.reliability,sl.remote,sl.encrypted
    FROM representation_presence rp
    JOIN drives d ON rp.location_id=('backup:' || d.id)
    JOIN objects o ON o.hash=rp.original_hash AND o.state='active'
    JOIN representation_policies p ON p.location_id=rp.location_id
      AND p.media_type=CASE WHEN o.mime LIKE 'image/%' THEN 'image' WHEN o.mime LIKE 'video/%' THEN 'video' ELSE '' END
      AND p.representation='compact'
    JOIN representation_retention rr ON rr.location_id=p.location_id AND rr.media_type=p.media_type AND rr.allow_original_removal=1
    LEFT JOIN storage_locations sl ON sl.id=d.id
    LEFT JOIN replicas existing ON existing.object_hash=rp.original_hash AND existing.drive_id=d.id
    WHERE rp.representation='compact' AND rp.verified_at IS NOT NULL AND existing.object_hash IS NULL
  `).all())addCopy(row.hash,{
    id:row.id,kind:row.kind||'backup',name:row.name,deviceName:row.deviceName||row.name,
    site:row.site||row.deviceName||row.name,reliability:row.reliability||'normal',
    remote:Boolean(row.remote),encrypted:Boolean(row.encrypted),verified:true,verifiedAt:row.verifiedAt,
    representation:'compact',reducedFidelity:true
  });

  const currentHashes=new Set(intents.map(item=>item.hash).filter(validHash));
  const states=new Map();
  for(const object of objects){
    const level=levelsByHash.get(object.hash)||'normal';
    const evaluated=evaluate(level,copiesByHash.get(object.hash)||[]);
    const lifecycle=currentHashes.has(object.hash)?'current':remoteOnly.has(object.hash)?'remote-only':'unlinked';
    states.set(object.hash,{
      hash:object.hash, lifecycle,
      protectionState:lifecycle==='current'?(evaluated.meets?'protected':'needs-backup'):lifecycle,
      level, meets:evaluated.meets, status:evaluated.status, missing:evaluated.missing
    });
  }

  const levels=Object.fromEntries(LEVELS.map(level=>[level,{files:0,bytes:0,needsProtection:0,protectedFiles:0}]));
  const imports=new Map();
  const desired=new Map();
  for(const intent of intents){
    const hash=validHash(intent.hash)?intent.hash:'';
    const key=hash||`${intent.deviceName}\0${intent.rootPath}\0${intent.relativePath}`;
    const level=hash?(levelsByHash.get(hash)||levelForImport(intent.importId)):levelForImport(intent.importId);
    const previous=desired.get(key);
    if(!previous||rank(level)>rank(previous.level))desired.set(key,{...intent,hash,level});
    const importKey=Number(intent.importId)||0;
    let group=imports.get(importKey);
    if(!group)imports.set(importKey,group={importId:importKey,files:0,protectedFiles:0,needsProtection:0,pendingFiles:0,preparingFiles:0});
  }

  let protectedFiles=0,protectedBytes=0,needsProtection=0,needsBytes=0,pendingFiles=0,preparingFiles=0,storedFiles=0,totalBytes=0;
  const importSeen=new Map();
  for(const item of desired.values()){
    const size=Math.max(0,Number(item.size)||0);
    const bucket=levels[item.level]||levels.normal;
    bucket.files++;bucket.bytes+=size;totalBytes+=size;
    let state='preparing';
    if(validHash(item.hash)){
      const object=objectByHash.get(item.hash);
      if(!object){state='pending';pendingFiles++;}
      else{
        storedFiles++;
        const evaluated=states.get(item.hash);
        state=evaluated?.meets?'protected':'needs-backup';
      }
    }else preparingFiles++;

    if(state==='protected'){protectedFiles++;protectedBytes+=size;bucket.protectedFiles++;}
    else if(state!=='preparing'){needsProtection++;needsBytes+=size;bucket.needsProtection++;}

    const importId=Number(item.importId)||0;
    const importKey=`${importId}\0${item.hash||item.rootPath+'\0'+item.relativePath}`;
    if(!importSeen.has(importKey)){
      importSeen.set(importKey,true);
      const group=imports.get(importId);
      if(group){
        group.files++;
        if(state==='protected')group.protectedFiles++;
        else if(state==='preparing')group.preparingFiles++;
        else{
          group.needsProtection++;
          if(state==='pending')group.pendingFiles++;
        }
      }
    }
  }

  const unlinked=objects.filter(object=>!currentHashes.has(object.hash)&&!remoteOnly.has(object.hash));
  const remote=objects.filter(object=>remoteOnly.has(object.hash)&&!currentHashes.has(object.hash));
  const trash=Number(db.prepare('SELECT COUNT(*) AS count FROM protection_trash').get().count)||0;
  const summary={
    files:desired.size,bytes:totalBytes,storedFiles,protectedFiles,protectedBytes,
    needsProtection,needsBytes,pendingFiles,preparingFiles,
    unlinkedFiles:unlinked.length,unlinkedBytes:unlinked.reduce((sum,row)=>sum+(Number(row.size)||0),0),
    remoteOnlyFiles:remote.length,remoteOnlyBytes:remote.reduce((sum,row)=>sum+(Number(row.size)||0),0),
    levels,imports:[...imports.values()].filter(item=>item.importId||item.files),trash,generatedAt:now()
  };
  snapshot={summary,states};
  snapshotAt=Date.now();
  return snapshot;
}

function protectionSummary(force=false){
  return protectionSnapshot(force).summary;
}

export function protectionCatalogStates(hashes=[]){
  const states=protectionSnapshot().states;
  return (hashes||[]).map(hash=>states.get(String(hash))).filter(Boolean);
}

function improvesWithTarget(state, target) {
  if (!state || !target || target.reliability === 'low' || state.copies.some(copy => copy.id === target.id)) return false;
  const candidate = { ...target, verified: true, deviceName: target.deviceName || target.id, site: target.site || target.deviceName || target.id, representation: 'original' };
  const next = evaluate(state.level, [...state.copies, candidate]);
  return next.missing.copies < state.missing.copies || next.missing.originals < state.missing.originals || next.missing.devices < state.missing.devices ||
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

export function removeProtectionStorage(id) {
  db.prepare('DELETE FROM storage_locations WHERE id=?').run(String(id));
  invalidate();
}

export async function handleProtectionServer(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/objects/check') {
    const body = await readJson(req);
    if (!Array.isArray(body.hashes) || body.hashes.length > 1000) {
      json(res, 400, { error: 'hashes must be an array of at most 1000 SHA-256 hashes' });
      return true;
    }
    const hashes = body.hashes.map(String);
    for (const hash of hashes) {
      if (!validHash(hash)) {
        json(res, 400, { error: `Invalid hash: ${hash}` });
        return true;
      }
    }
    const unique = [...new Set(hashes)];
    const suppressed = new Set();
    const active = new Set();
    for (let offset = 0; offset < unique.length; offset += 400) {
      const chunk = unique.slice(offset, offset + 400);
      if (!chunk.length) continue;
      const marks = chunk.map(() => '?').join(',');
      for (const row of db.prepare(`
        SELECT o.hash FROM objects o
        WHERE o.hash IN (${marks}) AND (
          EXISTS(SELECT 1 FROM ignored_hashes ih WHERE ih.hash=o.hash) OR
          EXISTS(SELECT 1 FROM protection_trash pt WHERE pt.object_hash=o.hash) OR
          EXISTS(SELECT 1 FROM source_deletions sd WHERE sd.object_hash=o.hash)
        )
      `).all(...chunk)) suppressed.add(row.hash);
      for (const row of db.prepare(`
        SELECT o.hash FROM objects o
        WHERE o.state='active' AND o.hash IN (${marks})
          AND NOT EXISTS(SELECT 1 FROM object_integrity oi WHERE oi.hash=o.hash AND oi.status!='healthy')
      `).all(...chunk)) active.add(row.hash);
    }
    const result = { known: [], missing: [], ignored: [] };
    for (const hash of hashes) {
      if (suppressed.has(hash)) result.ignored.push(hash);
      else if (active.has(hash)) result.known.push(hash);
      else result.missing.push(hash);
    }
    json(res, 200, result);
    return true;
  }

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
