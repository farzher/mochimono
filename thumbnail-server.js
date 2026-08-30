import { timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import http from 'node:http';
import { openCatalog } from './lib/db.js';
import { validHash } from './lib/store.js';

const DATA_DIR = resolve(process.env.MOCHIMONO_DATA || new URL('./data', import.meta.url).pathname);
const TOKEN = process.env.MOCHIMONO_TOKEN || '';
const THUMB_VERSION = 1;
const MAX_THUMB_BYTES = 5 * 1024 * 1024;
const db = openCatalog(join(DATA_DIR, 'catalog.sqlite'));

const thumbPath = hash => join(DATA_DIR, 'thumbs', hash.slice(0, 2), `${hash}.webp`);
const now = () => new Date().toISOString();

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function sameToken(value) {
  if (!TOKEN || typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req) {
  const auth = String(req.headers.authorization || '');
  return (auth.startsWith('Bearer ') && sameToken(auth.slice(7))) || sameToken(cookie(req, 'mochimono_session'));
}

function integerHeader(req, name) {
  const value = Number(req.headers[name]);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function durationHeader(req) {
  const value = Number(req.headers['x-mochimono-duration']);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function writeThumbnail(req, destination) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_THUMB_BYTES) throw Object.assign(new Error('Thumbnail too large'), { status: 413 });

  await mkdir(join(DATA_DIR, 'thumbs', destination.split(/[/\\]/).at(-2)), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  let size = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > MAX_THUMB_BYTES) callback(Object.assign(new Error('Thumbnail too large'), { status: 413 }));
      else callback(null, chunk);
    }
  });

  try {
    await pipeline(req, limiter, createWriteStream(temp, { flags: 'wx' }));
    await rm(destination, { force: true });
    await rename(temp, destination);
    return size;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function serveThumbnail(req, res, hash) {
  const row = db.prepare('SELECT * FROM thumbnails WHERE object_hash = ? AND version = ?').get(hash, THUMB_VERSION);
  if (!row) return json(res, 404, { error: 'Thumbnail not found' });

  const path = thumbPath(hash);
  let info;
  try { info = await stat(path); }
  catch {
    db.prepare('DELETE FROM thumbnails WHERE object_hash = ?').run(hash);
    return json(res, 404, { error: 'Thumbnail not found' });
  }

  const etag = `"${hash}-thumb-${THUMB_VERSION}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'private, max-age=31536000, immutable' });
    return res.end();
  }

  res.writeHead(200, {
    'content-type': row.mime,
    'content-length': info.size,
    'cache-control': 'private, max-age=31536000, immutable',
    etag,
    'x-mochimono-width': row.width,
    'x-mochimono-height': row.height,
    ...(row.duration == null ? {} : { 'x-mochimono-duration': row.duration })
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
}

function missingThumbnails(res, url) {
  const imports = [...new Set(String(url.searchParams.get('imports') || '')
    .split(',')
    .map(Number)
    .filter(value => Number.isInteger(value) && value > 0))];
  if (!imports.length) return json(res, 400, { error: 'imports is required' });
  if (imports.length > 100) return json(res, 400, { error: 'Too many imports' });
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
  const placeholders = imports.map(() => '?').join(',');
  const extensionSql = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.bmp', '.tif', '.tiff',
    '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.m2v', '.mts', '.m2ts', '.3gp'
  ].map(extension => `lower(s.filename) LIKE '%${extension}'`).join(' OR ');

  const rows = db.prepare(`
    WITH candidates AS (
      SELECT o.hash, o.size, o.mime, s.import_id AS importId, s.original_path AS originalPath,
             s.filename, s.mtime,
             ROW_NUMBER() OVER (PARTITION BY o.hash ORDER BY s.import_id, s.id) AS choice
      FROM sources s
      JOIN objects o ON o.hash = s.object_hash
      LEFT JOIN thumbnails t ON t.object_hash = o.hash AND t.version = ?
      WHERE s.import_id IN (${placeholders})
        AND o.state = 'active'
        AND t.object_hash IS NULL
        AND (o.mime LIKE 'image/%' OR o.mime LIKE 'video/%' OR ${extensionSql})
    )
    SELECT hash, size, mime, importId, originalPath, filename, mtime
    FROM candidates
    WHERE choice = 1
    ORDER BY size DESC, hash
    LIMIT ?
  `).all(THUMB_VERSION, ...imports, limit);

  return json(res, 200, { version: THUMB_VERSION, files: rows });
}

async function uploadThumbnail(req, res, hash) {
  if (!db.prepare("SELECT 1 FROM objects WHERE hash = ? AND state = 'active'").get(hash)) return json(res, 404, { error: 'Object not found' });
  const version = Number(req.headers['x-mochimono-thumb-version'] || THUMB_VERSION);
  if (version !== THUMB_VERSION) return json(res, 400, { error: 'Unsupported thumbnail version' });
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (mime !== 'image/webp') return json(res, 415, { error: 'Thumbnail must be image/webp' });

  const path = thumbPath(hash);
  const size = await writeThumbnail(req, path);
  const width = integerHeader(req, 'x-mochimono-width');
  const height = integerHeader(req, 'x-mochimono-height');
  const duration = durationHeader(req);
  db.prepare(`
    INSERT INTO thumbnails(object_hash, version, mime, size, width, height, duration, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(object_hash) DO UPDATE SET
      version = excluded.version,
      mime = excluded.mime,
      size = excluded.size,
      width = excluded.width,
      height = excluded.height,
      duration = excluded.duration,
      created_at = excluded.created_at
  `).run(hash, THUMB_VERSION, mime, size, width, height, duration, now());

  const sourceMime = String(req.headers['x-mochimono-source-mime'] || '').slice(0, 200);
  if (sourceMime && sourceMime !== 'application/octet-stream') {
    db.prepare("UPDATE objects SET mime = ? WHERE hash = ? AND mime = 'application/octet-stream'").run(sourceMime, hash);
  }
  return json(res, 201, { ok: true, hash, version: THUMB_VERSION, size, width, height, duration });
}

async function cleanupThumbnail(hash) {
  db.prepare('DELETE FROM thumbnails WHERE object_hash = ?').run(hash);
  await rm(thumbPath(hash), { force: true }).catch(() => {});
}

async function handleThumbnailRequest(req, res, url) {
  if (!url.pathname.startsWith('/api/thumbs')) return false;
  if (!authorized(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/thumbs/missing') {
    missingThumbnails(res, url);
    return true;
  }

  const match = /^\/api\/thumbs\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match || !validHash(match[1])) {
    json(res, 404, { error: 'Not found' });
    return true;
  }

  if (req.method === 'GET' || req.method === 'HEAD') await serveThumbnail(req, res, match[1]);
  else if (req.method === 'PUT') await uploadThumbnail(req, res, match[1]);
  else json(res, 405, { error: 'Method not allowed' });
  return true;
}

const originalCreateServer = http.createServer;
http.createServer = function (...args) {
  const index = args.findIndex(value => typeof value === 'function');
  if (index < 0) return originalCreateServer.apply(this, args);
  const listener = args[index];
  args[index] = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (await handleThumbnailRequest(req, res, url)) return;
    } catch (error) {
      console.error('Thumbnail server:', error);
      if (!res.headersSent) return json(res, error.status || 500, { error: error.status ? error.message : 'Thumbnail error' });
      return res.destroy();
    }

    const deleted = req.method === 'POST' ? /^\/api\/objects\/([a-f0-9]{64})\/delete$/.exec(url.pathname) : null;
    if (deleted) {
      res.once('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) cleanupThumbnail(deleted[1]).catch(console.error);
      });
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(this, args);
};
