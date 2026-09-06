import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, db, json, now, readJson } from './lib/server-context.js';
import { objectPath, readObject, removeObject, validHash, writeVerifiedObject } from './lib/store.js';

const RENDITION_ROOT = join(DATA_DIR, 'renditions');
await mkdir(RENDITION_ROOT, { recursive:true });

db.exec(`
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

  CREATE TABLE IF NOT EXISTS renditions (
    original_hash TEXT PRIMARY KEY REFERENCES objects(hash) ON DELETE CASCADE,
    rendition_hash TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
    preset_id TEXT,
    preset_name TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    source_size INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    duration REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS renditions_hash ON renditions(rendition_hash);

  CREATE TABLE IF NOT EXISTS representation_policies (
    location_id TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
    representation TEXT NOT NULL CHECK(representation IN ('original','compact')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(location_id, media_type)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS representation_presence (
    original_hash TEXT NOT NULL REFERENCES objects(hash) ON DELETE CASCADE,
    location_id TEXT NOT NULL,
    representation TEXT NOT NULL CHECK(representation IN ('original','compact')),
    verified_at TEXT NOT NULL,
    PRIMARY KEY(original_hash, location_id, representation)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS representation_presence_location ON representation_presence(location_id, representation);

  CREATE TRIGGER IF NOT EXISTS catalog_renditions_insert AFTER INSERT ON renditions BEGIN
    UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS catalog_renditions_delete AFTER DELETE ON renditions BEGIN
    UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
  END;
  CREATE TRIGGER IF NOT EXISTS catalog_renditions_update AFTER UPDATE OF rendition_hash,preset_name,options_json,mime,size,source_size,width,height,duration ON renditions
  WHEN OLD.rendition_hash IS NOT NEW.rendition_hash OR OLD.preset_name IS NOT NEW.preset_name OR OLD.options_json IS NOT NEW.options_json OR OLD.mime IS NOT NEW.mime OR OLD.size IS NOT NEW.size OR OLD.source_size IS NOT NEW.source_size OR OLD.width IS NOT NEW.width OR OLD.height IS NOT NEW.height OR OLD.duration IS NOT NEW.duration BEGIN
    UPDATE catalog_revision SET revision = revision + 1 WHERE singleton = 1;
  END;
`);

const parse = value => {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
};

function preset(row) {
  if (!row) return null;
  return {
    id:row.id,
    name:row.name,
    mediaType:row.media_type,
    options:parse(row.options_json),
    isDefault:Boolean(row.is_default),
    createdAt:row.created_at,
    updatedAt:row.updated_at
  };
}

function rendition(row) {
  if (!row) return null;
  return {
    originalHash:row.original_hash,
    hash:row.rendition_hash,
    mediaType:row.media_type,
    presetId:row.preset_id || '',
    presetName:row.preset_name,
    options:parse(row.options_json),
    mime:row.mime,
    size:Number(row.size) || 0,
    sourceSize:Number(row.source_size) || 0,
    width:Number(row.width) || 0,
    height:Number(row.height) || 0,
    duration:row.duration == null ? null : Number(row.duration),
    createdAt:row.created_at,
    updatedAt:row.updated_at,
    url:`/api/renditions/${row.original_hash}/file`
  };
}

const cleanName = value => String(value || '').trim().slice(0, 80);
const cleanMediaType = value => ['image','video'].includes(String(value || '')) ? String(value) : '';

function upsertPreset(body) {
  const mediaType = cleanMediaType(body.mediaType);
  const name = cleanName(body.name);
  if (!mediaType || !name || !body.options || typeof body.options !== 'object') throw Object.assign(new Error('Preset name, type, and settings are required'), { status:400 });
  const stamp = String(body.updatedAt || now());
  const existing = db.prepare('SELECT * FROM compression_presets WHERE media_type=? AND name=? COLLATE NOCASE').get(mediaType, name);
  const id = existing?.id || (validHash(String(body.id || '')) ? String(body.id) : String(body.id || '').trim().slice(0, 120)) || crypto.randomUUID();
  if (body.makeDefault === true || body.isDefault === true) db.prepare('UPDATE compression_presets SET is_default=0,updated_at=? WHERE media_type=?').run(stamp, mediaType);
  if (existing) {
    db.prepare('UPDATE compression_presets SET options_json=?,is_default=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(body.options), body.makeDefault === true || body.isDefault === true ? 1 : Number(existing.is_default) || 0, stamp, existing.id);
    return preset(db.prepare('SELECT * FROM compression_presets WHERE id=?').get(existing.id));
  }
  const created = String(body.createdAt || stamp);
  db.prepare('INSERT INTO compression_presets(id,name,media_type,options_json,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, name, mediaType, JSON.stringify(body.options), body.makeDefault === true || body.isDefault === true ? 1 : 0, created, stamp);
  return preset(db.prepare('SELECT * FROM compression_presets WHERE id=?').get(id));
}

async function serveRendition(req, res, row) {
  const path = objectPath(RENDITION_ROOT, row.rendition_hash);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || Number(info.size) !== Number(row.size)) return json(res, 404, { error:'Squished version is unavailable' });
  const headers = { 'content-type':row.mime, 'accept-ranges':'bytes', 'cache-control':'private, max-age=3600' };
  const range = String(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length':info.size });
    if (req.method === 'HEAD') return res.end();
    return readObject(RENDITION_ROOT, row.rendition_hash).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'content-range':`bytes */${info.size}` }); return res.end(); }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : info.size - 1;
  if (!match[1] && match[2]) { start = Math.max(0, info.size - Number(match[2])); end = info.size - 1; }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= info.size) { res.writeHead(416, { 'content-range':`bytes */${info.size}` }); return res.end(); }
  end = Math.min(end, info.size - 1);
  res.writeHead(206, { ...headers, 'content-range':`bytes ${start}-${end}/${info.size}`, 'content-length':end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  return readObject(RENDITION_ROOT, row.rendition_hash, { start, end }).pipe(res);
}

function knownOriginal(hash) {
  return Boolean(db.prepare("SELECT 1 FROM objects WHERE hash=? AND state='active'").get(hash));
}

function representationState(hash) {
  const locations = [];
  const primary = db.prepare("SELECT 1 FROM objects WHERE hash=? AND state='active'").get(hash);
  if (primary) locations.push({ locationId:'server', representation:'original', verifiedAt:null, source:'primary' });
  const compact = db.prepare('SELECT updated_at FROM renditions WHERE original_hash=?').get(hash);
  if (compact) locations.push({ locationId:'server', representation:'compact', verifiedAt:compact.updated_at, source:'rendition' });
  for (const row of db.prepare('SELECT drive_id AS locationId,verified_at AS verifiedAt FROM replicas WHERE object_hash=?').all(hash)) {
    locations.push({ locationId:`backup:${row.locationId}`, representation:'original', verifiedAt:row.verifiedAt, source:'backup' });
  }
  for (const row of db.prepare('SELECT location_id AS locationId,representation,verified_at AS verifiedAt FROM representation_presence WHERE original_hash=?').all(hash)) {
    if (!locations.some(item => item.locationId === row.locationId && item.representation === row.representation)) locations.push({ ...row, source:'agent' });
  }
  return locations;
}

export async function handleCompressionServer(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/compression/presets') {
    return json(res, 200, { presets:db.prepare('SELECT * FROM compression_presets ORDER BY media_type,is_default DESC,name COLLATE NOCASE').all().map(preset) });
  }

  if (req.method === 'POST' && url.pathname === '/api/compression/presets') {
    try { return json(res, 200, { preset:upsertPreset(await readJson(req, 256 * 1024)) }); }
    catch (error) { return json(res, error.status || 400, { error:error.message }); }
  }

  const defaultPreset = /^\/api\/compression\/presets\/([^/]+)\/default$/.exec(url.pathname);
  if (defaultPreset && req.method === 'POST') {
    const row = db.prepare('SELECT * FROM compression_presets WHERE id=?').get(decodeURIComponent(defaultPreset[1]));
    if (!row) return json(res, 404, { error:'Preset not found' });
    const stamp = now();
    db.prepare('UPDATE compression_presets SET is_default=0,updated_at=? WHERE media_type=?').run(stamp, row.media_type);
    db.prepare('UPDATE compression_presets SET is_default=1,updated_at=? WHERE id=?').run(stamp, row.id);
    return json(res, 200, { ok:true });
  }

  const deletePreset = /^\/api\/compression\/presets\/([^/]+)$/.exec(url.pathname);
  if (deletePreset && req.method === 'DELETE') {
    const id = decodeURIComponent(deletePreset[1]);
    const row = db.prepare('SELECT * FROM compression_presets WHERE id=?').get(id);
    if (!row) return json(res, 404, { error:'Preset not found' });
    if (row.is_default) return json(res, 409, { error:'Choose another default before deleting this preset' });
    db.prepare('DELETE FROM compression_presets WHERE id=?').run(id);
    return json(res, 200, { ok:true });
  }

  if (req.method === 'GET' && url.pathname === '/api/compression/snapshot') {
    return json(res, 200, {
      presets:db.prepare('SELECT * FROM compression_presets ORDER BY media_type,is_default DESC,name COLLATE NOCASE').all().map(preset),
      policies:db.prepare('SELECT location_id AS locationId,media_type AS mediaType,representation,updated_at AS updatedAt FROM representation_policies ORDER BY location_id,media_type').all()
    });
  }

  const upload = /^\/api\/renditions\/([a-f0-9]{64})\/upload\/([a-f0-9]{64})$/.exec(url.pathname);
  if (upload && req.method === 'PUT') {
    const [originalHash, renditionHash] = upload.slice(1);
    if (!knownOriginal(originalHash)) return json(res, 404, { error:'Original object not found' });
    try {
      const stored = await writeVerifiedObject({ root:RENDITION_ROOT, hash:renditionHash, input:req, replace:true });
      return json(res, 201, { hash:renditionHash, size:stored.size });
    } catch (error) { return json(res, 400, { error:error.message }); }
  }

  const renditionMatch = /^\/api\/renditions\/([a-f0-9]{64})$/.exec(url.pathname);
  if (renditionMatch && req.method === 'GET') {
    return json(res, 200, { rendition:rendition(db.prepare('SELECT * FROM renditions WHERE original_hash=?').get(renditionMatch[1])) });
  }

  if (renditionMatch && req.method === 'POST') {
    const originalHash = renditionMatch[1];
    if (!knownOriginal(originalHash)) return json(res, 404, { error:'Original object not found' });
    const body = await readJson(req, 512 * 1024);
    const renditionHash = String(body.hash || '');
    const mediaType = cleanMediaType(body.mediaType);
    if (!validHash(renditionHash) || !mediaType) return json(res, 400, { error:'Valid rendition hash and media type are required' });
    const file = await stat(objectPath(RENDITION_ROOT, renditionHash)).catch(() => null);
    if (!file?.isFile() || (body.size && Number(file.size) !== Number(body.size))) return json(res, 409, { error:'Upload the Squished version before registering it' });
    const old = db.prepare('SELECT rendition_hash FROM renditions WHERE original_hash=?').get(originalHash);
    const stamp = now();
    db.prepare(`INSERT INTO renditions(original_hash,rendition_hash,media_type,preset_id,preset_name,options_json,mime,size,source_size,width,height,duration,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(original_hash) DO UPDATE SET rendition_hash=excluded.rendition_hash,media_type=excluded.media_type,preset_id=excluded.preset_id,preset_name=excluded.preset_name,options_json=excluded.options_json,mime=excluded.mime,size=excluded.size,source_size=excluded.source_size,width=excluded.width,height=excluded.height,duration=excluded.duration,updated_at=excluded.updated_at`)
      .run(originalHash, renditionHash, mediaType, String(body.presetId || '') || null, cleanName(body.presetName), JSON.stringify(body.options || {}), String(body.mime || 'application/octet-stream').slice(0,200), Number(file.size), Math.max(0, Number(body.sourceSize) || 0), Math.max(0, Number(body.width) || 0), Math.max(0, Number(body.height) || 0), body.duration == null ? null : Math.max(0, Number(body.duration) || 0), stamp, stamp);
    if (old?.rendition_hash && old.rendition_hash !== renditionHash) await removeObject(RENDITION_ROOT, old.rendition_hash).catch(() => {});
    return json(res, 200, { rendition:rendition(db.prepare('SELECT * FROM renditions WHERE original_hash=?').get(originalHash)) });
  }

  if (renditionMatch && req.method === 'DELETE') {
    const row = db.prepare('SELECT rendition_hash FROM renditions WHERE original_hash=?').get(renditionMatch[1]);
    db.prepare('DELETE FROM renditions WHERE original_hash=?').run(renditionMatch[1]);
    if (row?.rendition_hash) await removeObject(RENDITION_ROOT, row.rendition_hash).catch(() => {});
    return json(res, 200, { ok:true });
  }

  const renditionFile = /^\/api\/renditions\/([a-f0-9]{64})\/file$/.exec(url.pathname);
  if (renditionFile && (req.method === 'GET' || req.method === 'HEAD')) {
    const row = db.prepare('SELECT * FROM renditions WHERE original_hash=?').get(renditionFile[1]);
    if (!row) return json(res, 404, { error:'Squished version not found' });
    return serveRendition(req, res, row);
  }

  if (req.method === 'POST' && url.pathname === '/api/renditions/check') {
    const body = await readJson(req, 512 * 1024);
    if (!Array.isArray(body.hashes) || body.hashes.length > 2000) return json(res, 400, { error:'hashes must contain at most 2000 items' });
    const hashes = [...new Set(body.hashes.map(String).filter(validHash))];
    if (!hashes.length) return json(res, 200, { renditions:[] });
    const marks = hashes.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM renditions WHERE original_hash IN (${marks})`).all(...hashes);
    return json(res, 200, { renditions:rows.map(rendition) });
  }

  if (req.method === 'GET' && url.pathname === '/api/compression/policies') {
    return json(res, 200, { policies:db.prepare('SELECT location_id AS locationId,media_type AS mediaType,representation,updated_at AS updatedAt FROM representation_policies ORDER BY location_id,media_type').all() });
  }

  if (req.method === 'POST' && url.pathname === '/api/compression/policies') {
    const body = await readJson(req, 128 * 1024);
    const locationId = String(body.locationId || '').trim().slice(0,240);
    const mediaType = cleanMediaType(body.mediaType);
    const representation = ['original','compact'].includes(String(body.representation || '')) ? String(body.representation) : '';
    if (!locationId || !mediaType || !representation) return json(res, 400, { error:'Location, media type, and representation are required' });
    db.prepare(`INSERT INTO representation_policies(location_id,media_type,representation,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(location_id,media_type) DO UPDATE SET representation=excluded.representation,updated_at=excluded.updated_at`)
      .run(locationId, mediaType, representation, now());
    return json(res, 200, { ok:true });
  }

  if (req.method === 'POST' && url.pathname === '/api/representations/report') {
    const body = await readJson(req, 4 * 1024 * 1024);
    const locationId = String(body.locationId || '').trim().slice(0,240);
    const representation = ['original','compact'].includes(String(body.representation || '')) ? String(body.representation) : '';
    if (!locationId || !representation || !Array.isArray(body.hashes) || body.hashes.length > 10000) return json(res, 400, { error:'Location, representation, and hashes are required' });
    const hashes = [...new Set(body.hashes.map(String).filter(validHash))];
    const known = new Set();
    for (let offset = 0; offset < hashes.length; offset += 500) {
      const chunk = hashes.slice(offset, offset + 500);
      if (!chunk.length) continue;
      const marks = chunk.map(() => '?').join(',');
      for (const row of db.prepare(`SELECT hash FROM objects WHERE state='active' AND hash IN (${marks})`).all(...chunk)) known.add(row.hash);
    }
    const insert = db.prepare(`INSERT INTO representation_presence(original_hash,location_id,representation,verified_at) VALUES(?,?,?,?)
      ON CONFLICT(original_hash,location_id,representation) DO UPDATE SET verified_at=excluded.verified_at`);
    const stamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (body.complete === true) db.prepare('DELETE FROM representation_presence WHERE location_id=? AND representation=?').run(locationId, representation);
      for (const hash of known) insert.run(hash, locationId, representation, stamp);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return json(res, 200, { ok:true, count:known.size });
  }

  const representationMatch = /^\/api\/representations\/([a-f0-9]{64})$/.exec(url.pathname);
  if (representationMatch && req.method === 'GET') {
    const locations = representationState(representationMatch[1]);
    const originals = locations.filter(item => item.representation === 'original');
    return json(res, 200, { locations, originalCopies:originals.length, safeToRemoveOneOriginal:originals.length > 1 });
  }

  return false;
}
