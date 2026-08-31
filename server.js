import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { backupCatalog } from './lib/db.js';
import { objectPath, readObject, removeObject, validHash, writeVerifiedObject } from './lib/store.js';
import { DATA_DIR, TOKEN, db, json, now, readJson, requireAuth } from './lib/server-context.js';
import { handleServerAuth } from './server-auth.js';
import { handleThumbnails, cleanupThumbnail } from './thumbnail-server.js';
import { handleCollections } from './collections-server.js';
import { handleBackupPolicy, getDrive } from './backup-policy-server.js';
import { handleMetadata } from './metadata-server.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8642);
const HOST = process.env.HOST || '127.0.0.1';
const featureRoutes = [handleThumbnails, handleCollections, handleBackupPolicy, handleMetadata];

if (!TOKEN) {
  console.error('MOCHIMONO_TOKEN is required.');
  process.exit(1);
}

function fileTypeSql(type, alias = 'o') {
  if (!type) return { sql: '1=1', params: [] };
  if (type === 'application') return { sql: `(${alias}.mime LIKE 'application/%' OR ${alias}.mime LIKE 'text/%')`, params: [] };
  if (type === 'other') return {
    sql: `(${alias}.mime NOT LIKE 'image/%' AND ${alias}.mime NOT LIKE 'video/%' AND ${alias}.mime NOT LIKE 'audio/%' AND ${alias}.mime NOT LIKE 'text/%' AND ${alias}.mime NOT LIKE 'application/%')`,
    params: []
  };
  if (['image', 'video', 'audio', 'text'].includes(type)) return { sql: `${alias}.mime LIKE ?`, params: [`${type}/%`] };
  return { sql: '1=0', params: [] };
}

function reviewSql(review, alias = 'o') {
  if (review === 'unreviewed') return `NOT EXISTS (SELECT 1 FROM reviewed_hashes rh WHERE rh.hash = ${alias}.hash)`;
  if (review === 'reviewed') return `EXISTS (SELECT 1 FROM reviewed_hashes rh WHERE rh.hash = ${alias}.hash)`;
  return '1=1';
}

function fileSortSql(sort) {
  if (sort === 'date-asc') return 'fileDate ASC, o.hash';
  if (sort === 'name') return 'filename COLLATE NOCASE ASC, o.hash';
  if (sort === 'size-desc') return 'o.size DESC, filename COLLATE NOCASE ASC';
  return 'fileDate DESC, o.hash';
}

function cleanRelativePath(value) {
  const parts = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw Object.assign(new Error('Invalid folder path'), { status: 400 });
  return parts.join('/');
}

function staticType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const path = resolve(WEB_DIR, `.${relative}`);
  if (path !== WEB_DIR && !path.startsWith(`${WEB_DIR}${sep}`)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    res.writeHead(200, { 'content-type': staticType(path), 'content-length': info.size, 'cache-control': 'no-cache' });
    createReadStream(path).pipe(res);
    return true;
  } catch { return false; }
}

async function serveObject(req, res, hash) {
  const row = db.prepare("SELECT size, mime FROM objects WHERE hash = ? AND state = 'active'").get(hash);
  if (!row) return json(res, 404, { error: 'Object not found' });
  let info;
  try { info = await stat(objectPath(DATA_DIR, hash)); }
  catch { return json(res, 503, { error: 'Object is cataloged but missing from primary storage' }); }

  const headers = { 'content-type': row.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': info.size });
    if (req.method === 'HEAD') return res.end();
    return readObject(DATA_DIR, hash).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` });
    return res.end();
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : info.size - 1;
  if (!match[1] && match[2]) {
    start = Math.max(0, info.size - Number(match[2]));
    end = info.size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= info.size) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` });
    return res.end();
  }
  end = Math.min(end, info.size - 1);
  res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  readObject(DATA_DIR, hash, { start, end }).pipe(res);
}

function hashSet(sql, hashes) {
  if (!hashes.length) return new Set();
  const marks = hashes.map(() => '?').join(',');
  return new Set(db.prepare(`${sql} (${marks})`).all(...hashes).map(row => row.hash));
}

async function handleCoreApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const objects = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM objects WHERE state = 'active'").get();
    const sources = db.prepare("SELECT COUNT(*) AS count FROM sources s JOIN objects o ON o.hash = s.object_hash WHERE o.state = 'active'").get();
    const ignored = db.prepare('SELECT COUNT(*) AS count FROM ignored_hashes').get();
    const unreviewed = db.prepare("SELECT COUNT(*) AS count FROM objects o WHERE o.state = 'active' AND NOT EXISTS (SELECT 1 FROM reviewed_hashes rh WHERE rh.hash = o.hash)").get();
    const unbacked = db.prepare("SELECT COUNT(*) AS count FROM objects o WHERE o.state = 'active' AND NOT EXISTS (SELECT 1 FROM replicas r WHERE r.object_hash = o.hash)").get();
    const drives = db.prepare('SELECT COUNT(*) AS count FROM drives').get();
    const storage = await statfs(DATA_DIR);
    return json(res, 200, {
      objects: Number(objects.count) || 0,
      bytes: Number(objects.bytes) || 0,
      capacityBytes: Number(storage.blocks) * Number(storage.bsize),
      freeBytes: Number(storage.bavail) * Number(storage.bsize),
      sources: Number(sources.count) || 0,
      ignored: Number(ignored.count) || 0,
      unreviewed: Number(unreviewed.count) || 0,
      unbacked: Number(unbacked.count) || 0,
      drives: Number(drives.count) || 0
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/imports') {
    const rows = db.prepare(`
      SELECT MIN(i.id) AS id, i.source_name AS sourceName, MIN(i.created_at) AS createdAt,
             COUNT(DISTINCT o.hash) AS files, COALESCE(SUM(o.size), 0) AS referencedBytes
      FROM imports i
      LEFT JOIN sources s ON s.import_id = i.id
      LEFT JOIN objects o ON o.hash = s.object_hash AND o.state = 'active'
      GROUP BY i.source_name
      HAVING COUNT(DISTINCT o.hash) > 0
      ORDER BY MAX(i.id) DESC
      LIMIT 100
    `).all();
    return json(res, 200, { imports: rows });
  }

  if (req.method === 'POST' && url.pathname === '/api/imports') {
    const sourceName = String((await readJson(req)).sourceName || '').trim();
    if (!sourceName) return json(res, 400, { error: 'sourceName is required' });
    const result = db.prepare('INSERT INTO imports(source_name, created_at) VALUES(?, ?)').run(sourceName, now());
    return json(res, 201, { id: Number(result.lastInsertRowid), sourceName });
  }

  const importMatch = /^\/api\/imports\/(\d+)$/.exec(url.pathname);
  if (importMatch && req.method === 'POST') {
    const sourceName = String((await readJson(req)).sourceName || '').trim();
    if (!sourceName) return json(res, 400, { error: 'sourceName is required' });
    const result = db.prepare('UPDATE imports SET source_name = ? WHERE id = ?').run(sourceName, Number(importMatch[1]));
    return result.changes ? json(res, 200, { ok: true, sourceName }) : json(res, 404, { error: 'Import not found' });
  }

  if (req.method === 'GET' && url.pathname === '/api/folders') {
    const importId = Number(url.searchParams.get('import'));
    if (!Number.isInteger(importId) || importId < 1) return json(res, 400, { error: 'Valid import is required' });
    const source = db.prepare('SELECT id, source_name AS sourceName, created_at AS createdAt FROM imports WHERE id = ?').get(importId);
    if (!source) return json(res, 404, { error: 'Source not found' });
    const path = cleanRelativePath(url.searchParams.get('path'));
    const prefix = path ? `${path}/` : '';
    const prefixLength = prefix.length;
    const folders = db.prepare(`
      WITH scoped AS (
        SELECT substr(s.original_path, ? + 1) AS rest
        FROM sources s JOIN objects o ON o.hash = s.object_hash
        WHERE s.import_id IN (SELECT id FROM imports WHERE source_name = ?) AND o.state = 'active'
          AND substr(s.original_path, 1, ?) = ?
      )
      SELECT substr(rest, 1, instr(rest, '/') - 1) AS name, COUNT(*) AS files
      FROM scoped WHERE instr(rest, '/') > 0
      GROUP BY name ORDER BY lower(name), name
    `).all(prefixLength, source.sourceName, prefixLength, prefix);
    const files = db.prepare(`
      SELECT o.hash, o.size, o.mime, o.created_at AS createdAt,
             MIN(s.filename) AS filename, MIN(s.original_path) AS originalPath, MAX(s.mtime) AS mtime,
             EXISTS (SELECT 1 FROM reviewed_hashes rh WHERE rh.hash = o.hash) AS reviewed,
             (SELECT COUNT(*) FROM replicas r WHERE r.object_hash = o.hash) AS backupCount
      FROM sources s JOIN objects o ON o.hash = s.object_hash
      WHERE s.import_id IN (SELECT id FROM imports WHERE source_name = ?) AND o.state = 'active'
        AND substr(s.original_path, 1, ?) = ?
        AND instr(substr(s.original_path, ? + 1), '/') = 0
      GROUP BY o.hash, s.original_path
      ORDER BY lower(filename), filename
    `).all(source.sourceName, prefixLength, prefix, prefixLength);
    return json(res, 200, { source, path, folders, files });
  }

  if (req.method === 'POST' && url.pathname === '/api/objects/check') {
    const body = await readJson(req);
    if (!Array.isArray(body.hashes) || body.hashes.length > 1000) return json(res, 400, { error: 'hashes must be an array of at most 1000 SHA-256 hashes' });
    const hashes = body.hashes.map(String);
    for (const hash of hashes) if (!validHash(hash)) return json(res, 400, { error: `Invalid hash: ${hash}` });
    const unique = [...new Set(hashes)];
    const ignored = hashSet('SELECT hash FROM ignored_hashes WHERE hash IN', unique);
    const active = hashSet("SELECT hash FROM objects WHERE state = 'active' AND hash IN", unique);
    const result = { known: [], missing: [], ignored: [] };
    for (const hash of hashes) {
      if (ignored.has(hash)) result.ignored.push(hash);
      else if (active.has(hash)) result.known.push(hash);
      else result.missing.push(hash);
    }
    return json(res, 200, result);
  }

  const objectMatch = /^\/api\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
  if (objectMatch && req.method === 'PUT') {
    const hash = objectMatch[1];
    try {
      const stored = await writeVerifiedObject({ root: DATA_DIR, hash, input: req });
      const mime = String(req.headers['x-mochimono-mime'] || 'application/octet-stream').slice(0, 200);
      db.prepare(`
        INSERT INTO objects(hash, size, mime, state, created_at) VALUES(?, ?, ?, 'active', ?)
        ON CONFLICT(hash) DO UPDATE SET size = excluded.size, mime = excluded.mime, state = 'active'
      `).run(hash, stored.size, mime, now());
      return json(res, 201, { hash, size: stored.size });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  if (objectMatch && (req.method === 'GET' || req.method === 'HEAD')) return serveObject(req, res, objectMatch[1]);

  const reviewMatch = /^\/api\/objects\/([a-f0-9]{64})\/review$/.exec(url.pathname);
  if (reviewMatch && req.method === 'POST') {
    const hash = reviewMatch[1];
    const body = await readJson(req);
    if (!db.prepare("SELECT 1 FROM objects WHERE hash = ? AND state = 'active'").get(hash)) return json(res, 404, { error: 'Object not found' });
    if (body.reviewed === false) db.prepare('DELETE FROM reviewed_hashes WHERE hash = ?').run(hash);
    else db.prepare('INSERT OR REPLACE INTO reviewed_hashes(hash, reviewed_at) VALUES(?, ?)').run(hash, now());
    return json(res, 200, { ok: true, reviewed: body.reviewed !== false });
  }

  const deleteMatch = /^\/api\/objects\/([a-f0-9]{64})\/delete$/.exec(url.pathname);
  if (deleteMatch && req.method === 'POST') {
    const hash = deleteMatch[1];
    const body = await readJson(req);
    if (!db.prepare('SELECT 1 FROM objects WHERE hash = ?').get(hash)) return json(res, 404, { error: 'Object not found' });
    db.prepare("UPDATE objects SET state = 'deleted' WHERE hash = ?").run(hash);
    db.prepare('DELETE FROM reviewed_hashes WHERE hash = ?').run(hash);
    if (body.ignore === true) db.prepare('INSERT OR IGNORE INTO ignored_hashes(hash, ignored_at) VALUES(?, ?)').run(hash, now());
    await Promise.all([removeObject(DATA_DIR, hash), cleanupThumbnail(hash)]);
    return json(res, 200, { ok: true, ignored: body.ignore === true });
  }

  if (req.method === 'POST' && url.pathname === '/api/sources') {
    const body = await readJson(req);
    const importId = Number(body.importId);
    if (!Number.isInteger(importId) || !db.prepare('SELECT 1 FROM imports WHERE id = ?').get(importId)) return json(res, 400, { error: 'Valid importId is required' });
    if (!Array.isArray(body.sources) || body.sources.length > 1000) return json(res, 400, { error: 'sources must be an array of at most 1000 records' });
    const hashes = body.sources.map(source => String(source.hash));
    for (const hash of hashes) if (!validHash(hash)) return json(res, 400, { error: `Invalid hash: ${hash}` });
    const active = hashSet("SELECT hash FROM objects WHERE state = 'active' AND hash IN", [...new Set(hashes)]);
    for (const hash of hashes) if (!active.has(hash)) return json(res, 400, { error: `Unknown active object: ${hash}` });
    const insert = db.prepare(`
      INSERT INTO sources(object_hash, import_id, original_path, filename, mtime, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(import_id, original_path) DO UPDATE SET object_hash = excluded.object_hash, filename = excluded.filename, mtime = excluded.mtime
    `);
    try {
      db.exec('BEGIN IMMEDIATE');
      const timestamp = now();
      for (const source of body.sources) insert.run(String(source.hash), importId, String(source.path), String(source.filename), source.mtime ? String(source.mtime) : null, timestamp);
      db.exec('COMMIT');
      return json(res, 200, { ok: true, count: body.sources.length });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/files') {
    const q = String(url.searchParams.get('q') || '').slice(0, 200);
    const type = String(url.searchParams.get('type') || '');
    const review = String(url.searchParams.get('review') || '');
    const backup = String(url.searchParams.get('backup') || '');
    const sort = String(url.searchParams.get('sort') || 'date-desc');
    const importId = Math.max(0, Number(url.searchParams.get('import') || 0) || 0);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const filter = fileTypeSql(type, 'o');
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT o.hash, o.size, o.mime, o.created_at AS createdAt,
             COALESCE(MIN(s.filename), o.hash) AS filename,
             COALESCE(MIN(s.original_path), '') AS originalPath,
             COALESCE(MAX(s.mtime), o.created_at) AS fileDate,
             COUNT(s.id) AS referencesCount,
             EXISTS (SELECT 1 FROM reviewed_hashes rh WHERE rh.hash = o.hash) AS reviewed,
             (SELECT COUNT(*) FROM replicas r WHERE r.object_hash = o.hash) AS backupCount
      FROM objects o
      LEFT JOIN sources s ON s.object_hash = o.hash
      WHERE o.state = 'active' AND ${filter.sql} AND ${reviewSql(review, 'o')}
        AND (? != 'missing' OR NOT EXISTS (SELECT 1 FROM replicas rb WHERE rb.object_hash = o.hash))
        AND (? = 0 OR EXISTS (
          SELECT 1 FROM sources si JOIN imports ii ON ii.id = si.import_id
          WHERE si.object_hash = o.hash AND ii.source_name = (SELECT source_name FROM imports WHERE id = ?)
        ))
        AND (? = '' OR EXISTS (
          SELECT 1 FROM sources sx JOIN imports ix ON ix.id = sx.import_id
          WHERE sx.object_hash = o.hash AND (sx.filename LIKE ? OR sx.original_path LIKE ? OR ix.source_name LIKE ?)
        ))
      GROUP BY o.hash
      ORDER BY ${fileSortSql(sort)}
      LIMIT ? OFFSET ?
    `).all(...filter.params, backup, importId, importId, q, like, like, like, limit, offset);
    return json(res, 200, { files: rows, limit, offset, hasMore: rows.length === limit });
  }

  const sourcesMatch = /^\/api\/files\/([a-f0-9]{64})\/sources$/.exec(url.pathname);
  if (sourcesMatch && req.method === 'GET') {
    const rows = db.prepare(`
      SELECT s.original_path AS path, s.filename, s.mtime, i.source_name AS sourceName, i.created_at AS importedAt
      FROM sources s JOIN imports i ON i.id = s.import_id
      WHERE s.object_hash = ? ORDER BY i.created_at DESC, s.original_path
    `).all(sourcesMatch[1]);
    return json(res, 200, { sources: rows });
  }

  const replicasMatch = /^\/api\/drives\/([^/]+)\/replicas$/.exec(url.pathname);
  if (replicasMatch && req.method === 'POST') {
    const id = decodeURIComponent(replicasMatch[1]);
    if (!getDrive(id)) return json(res, 404, { error: 'Backup not registered' });
    const body = await readJson(req);
    if (!Array.isArray(body.replicas) || body.replicas.length > 5000) return json(res, 400, { error: 'replicas must be an array of at most 5000 records' });
    const hashes = [...new Set(body.replicas.map(replica => String(replica.hash)).filter(validHash))];
    const known = hashSet('SELECT hash FROM objects WHERE hash IN', hashes);
    const insert = db.prepare(`
      INSERT INTO replicas(object_hash, drive_id, verified_at) VALUES(?, ?, ?)
      ON CONFLICT(object_hash, drive_id) DO UPDATE SET verified_at = excluded.verified_at
    `);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const replica of body.replicas) {
        const hash = String(replica.hash);
        if (known.has(hash)) insert.run(hash, id, replica.verifiedAt || null);
      }
      db.prepare('UPDATE drives SET last_seen = ? WHERE id = ?').run(now(), id);
      db.exec('COMMIT');
      return json(res, 200, { ok: true });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  const removeReplicasMatch = /^\/api\/drives\/([^/]+)\/replicas\/remove$/.exec(url.pathname);
  if (removeReplicasMatch && req.method === 'POST') {
    const id = decodeURIComponent(removeReplicasMatch[1]);
    const body = await readJson(req);
    if (!Array.isArray(body.hashes) || body.hashes.length > 5000) return json(res, 400, { error: 'hashes must be an array of at most 5000 hashes' });
    const remove = db.prepare('DELETE FROM replicas WHERE drive_id = ? AND object_hash = ?');
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of body.hashes) if (validHash(hash)) remove.run(id, hash);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/catalog/export') {
    const tempDir = join(DATA_DIR, 'tmp');
    const temp = join(tempDir, `catalog-export-${Date.now()}-${process.pid}.sqlite`);
    await mkdir(tempDir, { recursive: true });
    await backupCatalog(db, temp);
    const info = await stat(temp);
    res.writeHead(200, { 'content-type': 'application/vnd.sqlite3', 'content-length': info.size, 'content-disposition': 'attachment; filename="catalog.sqlite"' });
    const stream = createReadStream(temp);
    stream.on('close', () => rm(temp, { force: true }).catch(() => {}));
    return stream.pipe(res);
  }

  json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (await handleServerAuth(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) {
      if (!requireAuth(req, res)) return;
      for (const route of featureRoutes) if (await route(req, res, url)) return;
      return await handleCoreApi(req, res, url);
    }
    if (await serveStatic(res, decodeURIComponent(url.pathname))) return;
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mochimono listening on http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
