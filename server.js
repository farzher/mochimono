import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { openCatalog, backupCatalog } from './lib/db.js';
import { normalizePolicy, policySql } from './lib/policy.js';
import { objectPath, readObject, removeObject, validHash, writeVerifiedObject } from './lib/store.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(ROOT, 'web');
const DATA_DIR = resolve(process.env.MOCHIMONO_DATA || join(ROOT, 'data'));
const PORT = Number(process.env.PORT || 8642);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.MOCHIMONO_TOKEN || '';

if (!TOKEN) {
  console.error('MOCHIMONO_TOKEN is required.');
  process.exit(1);
}

await mkdir(DATA_DIR, { recursive: true });
const db = openCatalog(join(DATA_DIR, 'catalog.sqlite'));
const now = () => new Date().toISOString();

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

async function readJson(req, max = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function sameToken(value) {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req) {
  const auth = String(req.headers.authorization || '');
  return (auth.startsWith('Bearer ') && sameToken(auth.slice(7))) || sameToken(cookie(req, 'mochimono_session'));
}

function requireAuth(req, res) {
  if (authorized(req)) return true;
  json(res, 401, { error: 'Unauthorized' });
  return false;
}

function parsePolicy(row) {
  try { return normalizePolicy(JSON.parse(row.policy_json)); }
  catch { return normalizePolicy(null); }
}

function getDrive(id) {
  return db.prepare('SELECT * FROM drives WHERE id = ?').get(id);
}

function driveCoverage(row) {
  const policy = parsePolicy(row);
  const filter = policySql(policy, 'o');
  const desired = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(o.size), 0) AS bytes
    FROM objects o WHERE o.state = 'active' AND ${filter.sql}
  `).get(...filter.params);
  const protectedRow = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(o.size), 0) AS bytes
    FROM objects o
    JOIN replicas r ON r.object_hash = o.hash AND r.drive_id = ?
    WHERE o.state = 'active' AND ${filter.sql}
  `).get(row.id, ...filter.params);
  return {
    id: row.id,
    name: row.name,
    policy,
    lastSeen: row.last_seen,
    desiredCount: desired.count,
    desiredBytes: desired.bytes,
    protectedCount: protectedRow.count,
    protectedBytes: protectedRow.bytes
  };
}

function fileTypeSql(type, alias = 'o') {
  if (!type) return { sql: '1=1', params: [] };
  if (type === 'application') return { sql: `(${alias}.mime LIKE 'application/%' OR ${alias}.mime LIKE 'text/%')`, params: [] };
  if (type === 'other') {
    return { sql: `(${alias}.mime NOT LIKE 'image/%' AND ${alias}.mime NOT LIKE 'video/%' AND ${alias}.mime NOT LIKE 'audio/%' AND ${alias}.mime NOT LIKE 'text/%' AND ${alias}.mime NOT LIKE 'application/%')`, params: [] };
  }
  if (['image', 'video', 'audio', 'text'].includes(type)) return { sql: `${alias}.mime LIKE ?`, params: [`${type}/%`] };
  return { sql: '1=0', params: [] };
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

  const headers = {
    'content-type': row.mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600'
  };
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
  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${info.size}`,
    'content-length': end - start + 1
  });
  if (req.method === 'HEAD') return res.end();
  readObject(DATA_DIR, hash, { start, end }).pipe(res);
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req);
    if (!sameToken(body.token)) return json(res, 401, { error: 'Invalid token' });
    return json(res, 200, { ok: true }, {
      'set-cookie': `mochimono_session=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/`
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    return json(res, 200, { ok: true }, {
      'set-cookie': 'mochimono_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    });
  }

  if (!requireAuth(req, res)) return;

  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const objects = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM objects WHERE state = 'active'").get();
    const sources = db.prepare("SELECT COUNT(*) AS count FROM sources s JOIN objects o ON o.hash = s.object_hash WHERE o.state = 'active'").get();
    const ignored = db.prepare('SELECT COUNT(*) AS count FROM ignored_hashes').get();
    const drives = db.prepare('SELECT COUNT(*) AS count FROM drives').get();
    return json(res, 200, { objects: objects.count, bytes: objects.bytes, sources: sources.count, ignored: ignored.count, drives: drives.count });
  }

  if (req.method === 'GET' && url.pathname === '/api/imports') {
    const rows = db.prepare(`
      SELECT i.id, i.source_name AS sourceName, i.created_at AS createdAt,
             COUNT(s.id) AS files, COALESCE(SUM(o.size), 0) AS referencedBytes
      FROM imports i
      LEFT JOIN sources s ON s.import_id = i.id
      LEFT JOIN objects o ON o.hash = s.object_hash AND o.state = 'active'
      GROUP BY i.id ORDER BY i.id DESC LIMIT 100
    `).all();
    return json(res, 200, { imports: rows });
  }

  if (req.method === 'POST' && url.pathname === '/api/imports') {
    const body = await readJson(req);
    const sourceName = String(body.sourceName || '').trim();
    if (!sourceName) return json(res, 400, { error: 'sourceName is required' });
    const result = db.prepare('INSERT INTO imports(source_name, created_at) VALUES(?, ?)').run(sourceName, now());
    return json(res, 201, { id: Number(result.lastInsertRowid), sourceName });
  }

  if (req.method === 'POST' && url.pathname === '/api/objects/check') {
    const body = await readJson(req);
    if (!Array.isArray(body.hashes) || body.hashes.length > 1000) return json(res, 400, { error: 'hashes must be an array of at most 1000 SHA-256 hashes' });
    const active = db.prepare("SELECT 1 FROM objects WHERE hash = ? AND state = 'active'");
    const ignored = db.prepare('SELECT 1 FROM ignored_hashes WHERE hash = ?');
    const result = { known: [], missing: [], ignored: [] };
    for (const hash of body.hashes) {
      if (!validHash(hash)) return json(res, 400, { error: `Invalid hash: ${hash}` });
      if (ignored.get(hash)) result.ignored.push(hash);
      else if (active.get(hash)) result.known.push(hash);
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

  const deleteMatch = /^\/api\/objects\/([a-f0-9]{64})\/delete$/.exec(url.pathname);
  if (deleteMatch && req.method === 'POST') {
    const hash = deleteMatch[1];
    const body = await readJson(req);
    if (!db.prepare('SELECT 1 FROM objects WHERE hash = ?').get(hash)) return json(res, 404, { error: 'Object not found' });
    db.prepare("UPDATE objects SET state = 'deleted' WHERE hash = ?").run(hash);
    if (body.ignore === true) db.prepare('INSERT OR IGNORE INTO ignored_hashes(hash, ignored_at) VALUES(?, ?)').run(hash, now());
    await removeObject(DATA_DIR, hash);
    return json(res, 200, { ok: true, ignored: body.ignore === true });
  }

  if (req.method === 'POST' && url.pathname === '/api/sources') {
    const body = await readJson(req);
    const importId = Number(body.importId);
    if (!Number.isInteger(importId) || !db.prepare('SELECT 1 FROM imports WHERE id = ?').get(importId)) return json(res, 400, { error: 'Valid importId is required' });
    if (!Array.isArray(body.sources) || body.sources.length > 1000) return json(res, 400, { error: 'sources must be an array of at most 1000 records' });

    const insert = db.prepare(`
      INSERT INTO sources(object_hash, import_id, original_path, filename, mtime, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(import_id, original_path) DO UPDATE SET object_hash = excluded.object_hash, filename = excluded.filename, mtime = excluded.mtime
    `);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const source of body.sources) {
        if (!validHash(source.hash) || !db.prepare("SELECT 1 FROM objects WHERE hash = ? AND state = 'active'").get(source.hash)) throw new Error(`Unknown active object: ${source.hash}`);
        insert.run(source.hash, importId, String(source.path), String(source.filename), source.mtime ? String(source.mtime) : null, now());
      }
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
    const importId = Math.max(0, Number(url.searchParams.get('import') || 0) || 0);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const filter = fileTypeSql(type, 'o');
    const like = `%${q}%`;
    const rows = db.prepare(`
      SELECT o.hash, o.size, o.mime, o.created_at AS createdAt,
             COALESCE(MIN(s.filename), o.hash) AS filename,
             COALESCE(MIN(s.original_path), '') AS originalPath,
             COUNT(s.id) AS referencesCount,
             (SELECT COUNT(*) FROM replicas r WHERE r.object_hash = o.hash) AS backupCount
      FROM objects o
      LEFT JOIN sources s ON s.object_hash = o.hash
      WHERE o.state = 'active' AND ${filter.sql}
        AND (? = 0 OR EXISTS (
          SELECT 1 FROM sources si WHERE si.object_hash = o.hash AND si.import_id = ?
        ))
        AND (? = '' OR EXISTS (
          SELECT 1 FROM sources sx JOIN imports ix ON ix.id = sx.import_id
          WHERE sx.object_hash = o.hash AND (sx.filename LIKE ? OR sx.original_path LIKE ? OR ix.source_name LIKE ?)
        ))
      GROUP BY o.hash
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...filter.params, importId, importId, q, like, like, like, limit, offset);
    return json(res, 200, { files: rows, limit, offset, hasMore: rows.length === limit });
  }

  const detailsMatch = /^\/api\/files\/([a-f0-9]{64})\/details$/.exec(url.pathname);
  if (detailsMatch && req.method === 'GET') {
    const hash = detailsMatch[1];
    const object = db.prepare("SELECT hash, size, mime, created_at AS createdAt FROM objects WHERE hash = ? AND state = 'active'").get(hash);
    if (!object) return json(res, 404, { error: 'File not found' });
    const sources = db.prepare(`
      SELECT s.original_path AS path, s.filename, s.mtime, i.source_name AS sourceName, i.created_at AS importedAt
      FROM sources s JOIN imports i ON i.id = s.import_id
      WHERE s.object_hash = ? ORDER BY i.created_at DESC, s.original_path
    `).all(hash);
    const backups = db.prepare(`
      SELECT d.id, d.name, d.last_seen AS lastSeen, r.verified_at AS verifiedAt
      FROM replicas r JOIN drives d ON d.id = r.drive_id
      WHERE r.object_hash = ? ORDER BY d.name
    `).all(hash);
    return json(res, 200, { object, sources, backups });
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

  if (req.method === 'POST' && url.pathname === '/api/drives/register') {
    const body = await readJson(req);
    const id = String(body.id || '').trim();
    const name = String(body.name || '').trim();
    if (!id || !name) return json(res, 400, { error: 'id and name are required' });
    const policy = normalizePolicy(body.policy);
    db.prepare(`
      INSERT INTO drives(id, name, policy_json, last_seen) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, policy_json = excluded.policy_json, last_seen = excluded.last_seen
    `).run(id, name, JSON.stringify(policy), now());
    return json(res, 200, driveCoverage(getDrive(id)));
  }

  if (req.method === 'GET' && url.pathname === '/api/drives') {
    const rows = db.prepare('SELECT * FROM drives ORDER BY name').all();
    return json(res, 200, { drives: rows.map(driveCoverage) });
  }

  const desiredMatch = /^\/api\/drives\/([^/]+)\/desired$/.exec(url.pathname);
  if (desiredMatch && req.method === 'GET') {
    const id = decodeURIComponent(desiredMatch[1]);
    const drive = getDrive(id);
    if (!drive) return json(res, 404, { error: 'Backup not registered' });
    const filter = policySql(parsePolicy(drive), 'o');
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 1000)));
    const rows = db.prepare(`
      SELECT o.hash, o.size, o.mime FROM objects o
      WHERE o.state = 'active' AND o.hash > ? AND ${filter.sql}
      ORDER BY o.hash LIMIT ?
    `).all(after, ...filter.params, limit);
    db.prepare('UPDATE drives SET last_seen = ? WHERE id = ?').run(now(), id);
    return json(res, 200, { objects: rows, nextAfter: rows.length === limit ? rows.at(-1).hash : null });
  }

  const replicasMatch = /^\/api\/drives\/([^/]+)\/replicas$/.exec(url.pathname);
  if (replicasMatch && req.method === 'POST') {
    const id = decodeURIComponent(replicasMatch[1]);
    if (!getDrive(id)) return json(res, 404, { error: 'Backup not registered' });
    const body = await readJson(req);
    if (!Array.isArray(body.replicas) || body.replicas.length > 5000) return json(res, 400, { error: 'replicas must be an array of at most 5000 records' });
    const insert = db.prepare(`
      INSERT INTO replicas(object_hash, drive_id, verified_at) VALUES(?, ?, ?)
      ON CONFLICT(object_hash, drive_id) DO UPDATE SET verified_at = excluded.verified_at
    `);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const replica of body.replicas) {
        if (!validHash(replica.hash) || !db.prepare('SELECT 1 FROM objects WHERE hash = ?').get(replica.hash)) continue;
        insert.run(replica.hash, id, replica.verifiedAt || null);
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
    const temp = join(DATA_DIR, 'tmp', `catalog-export-${Date.now()}-${process.pid}.sqlite`);
    await mkdir(join(DATA_DIR, 'tmp'), { recursive: true });
    await backupCatalog(db, temp);
    const info = await stat(temp);
    res.writeHead(200, { 'content-type': 'application/vnd.sqlite3', 'content-length': info.size, 'content-disposition': 'attachment; filename="catalog.sqlite"' });
    const stream = createReadStream(temp);
    stream.on('close', () => rm(temp, { force: true }).catch(() => {}));
    return stream.pipe(res);
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
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
