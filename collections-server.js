import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { openCatalog } from './lib/db.js';
import { validHash } from './lib/store.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = resolve(process.env.MOCHIMONO_DATA || join(ROOT, 'data'));
const TOKEN = process.env.MOCHIMONO_TOKEN || '';
const db = openCatalog(join(DATA_DIR, 'catalog.sqlite'));
const now = () => new Date().toISOString();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req, max = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Request too large'), { status: 413 });
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
  if (!TOKEN || typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req) {
  const auth = String(req.headers.authorization || '');
  return (auth.startsWith('Bearer ') && sameToken(auth.slice(7))) || sameToken(cookie(req, 'mochimono_session'));
}

function collection(id) {
  return db.prepare(`
    SELECT c.id, c.name, c.created_at AS createdAt, COUNT(o.hash) AS count
    FROM collections c
    LEFT JOIN collection_members cm ON cm.collection_id = c.id
    LEFT JOIN objects o ON o.hash = cm.object_hash AND o.state = 'active'
    WHERE c.id = ?
    GROUP BY c.id
  `).get(id);
}

function listCollections() {
  return db.prepare(`
    SELECT c.id, c.name, c.created_at AS createdAt, COUNT(o.hash) AS count
    FROM collections c
    LEFT JOIN collection_members cm ON cm.collection_id = c.id
    LEFT JOIN objects o ON o.hash = cm.object_hash AND o.state = 'active'
    GROUP BY c.id
    ORDER BY lower(c.name), c.id
  `).all();
}

function cleanHashes(body) {
  if (!Array.isArray(body.hashes) || body.hashes.length > 1000) {
    throw Object.assign(new Error('hashes must be an array of at most 1000 SHA-256 hashes'), { status: 400 });
  }
  const hashes = [...new Set(body.hashes.map(String))];
  if (hashes.some(hash => !validHash(hash))) throw Object.assign(new Error('Invalid SHA-256 hash'), { status: 400 });
  return hashes;
}

function activeHashes(hashes) {
  if (!hashes.length) return new Set();
  const marks = hashes.map(() => '?').join(',');
  return new Set(db.prepare(`SELECT hash FROM objects WHERE state = 'active' AND hash IN (${marks})`).all(...hashes).map(row => row.hash));
}

async function handleCollectionRequest(req, res, url) {
  if (!url.pathname.startsWith('/api/collections')) return false;
  if (!authorized(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return true;
  }

  if (url.pathname === '/api/collections') {
    if (req.method === 'GET') {
      json(res, 200, { collections: listCollections() });
      return true;
    }
    if (req.method === 'POST') {
      const name = String((await readJson(req)).name || '').trim();
      if (!name) throw Object.assign(new Error('Collection name is required'), { status: 400 });
      if (name.length > 80) throw Object.assign(new Error('Collection name is too long'), { status: 400 });
      const existing = db.prepare('SELECT id FROM collections WHERE name = ? COLLATE NOCASE').get(name);
      if (existing) {
        json(res, 200, { ...collection(existing.id), existing: true });
        return true;
      }
      const result = db.prepare('INSERT INTO collections(name, created_at) VALUES(?, ?)').run(name, now());
      json(res, 201, { ...collection(Number(result.lastInsertRowid)), existing: false });
      return true;
    }
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const fileMatch = /^\/api\/collections\/file\/([a-f0-9]{64})$/.exec(url.pathname);
  if (fileMatch) {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const rows = db.prepare(`
      SELECT c.id, c.name
      FROM collection_members cm
      JOIN collections c ON c.id = cm.collection_id
      JOIN objects o ON o.hash = cm.object_hash AND o.state = 'active'
      WHERE cm.object_hash = ?
      ORDER BY lower(c.name), c.id
    `).all(fileMatch[1]);
    json(res, 200, { collections: rows });
    return true;
  }

  const hashesMatch = /^\/api\/collections\/(\d+)\/hashes$/.exec(url.pathname);
  if (hashesMatch) {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const id = Number(hashesMatch[1]);
    const item = collection(id);
    if (!item) {
      json(res, 404, { error: 'Collection not found' });
      return true;
    }
    const hashes = db.prepare(`
      SELECT cm.object_hash AS hash
      FROM collection_members cm
      JOIN objects o ON o.hash = cm.object_hash AND o.state = 'active'
      WHERE cm.collection_id = ?
      ORDER BY cm.added_at, cm.object_hash
    `).all(id).map(row => row.hash);
    json(res, 200, { collection: item, hashes });
    return true;
  }

  const itemsMatch = /^\/api\/collections\/(\d+)\/items$/.exec(url.pathname);
  if (itemsMatch) {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const id = Number(itemsMatch[1]);
    if (!collection(id)) {
      json(res, 404, { error: 'Collection not found' });
      return true;
    }
    const hashes = cleanHashes(await readJson(req));
    const active = activeHashes(hashes);
    if (active.size !== hashes.length) throw Object.assign(new Error('One or more files are unavailable'), { status: 400 });
    const insert = db.prepare('INSERT OR IGNORE INTO collection_members(collection_id, object_hash, added_at) VALUES(?, ?, ?)');
    const timestamp = now();
    let added = 0;
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const hash of hashes) added += Number(insert.run(id, hash, timestamp).changes || 0);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    json(res, 200, { ok: true, added, collection: collection(id) });
    return true;
  }

  const itemMatch = /^\/api\/collections\/(\d+)\/items\/([a-f0-9]{64})$/.exec(url.pathname);
  if (itemMatch) {
    if (req.method !== 'DELETE') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const id = Number(itemMatch[1]);
    db.prepare('DELETE FROM collection_members WHERE collection_id = ? AND object_hash = ?').run(id, itemMatch[2]);
    json(res, 200, { ok: true, collection: collection(id) });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}

const originalCreateServer = http.createServer;
http.createServer = function (...args) {
  const context = this;
  http.createServer = originalCreateServer;
  const index = args.findIndex(value => typeof value === 'function');
  if (index < 0) return originalCreateServer.apply(context, args);
  const listener = args[index];
  args[index] = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (await handleCollectionRequest(req, res, url)) return;
    } catch (error) {
      console.error('Collections server:', error);
      if (!res.headersSent) return json(res, error.status || 500, { error: error.status ? error.message : 'Collection error' });
      return res.destroy();
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};
