import { db, json, now, readJson } from './lib/server-context.js';
import { validHash } from './lib/store.js';

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

function parseSmart(row) {
  if (!row) return null;
  let spec = {};
  try { spec = JSON.parse(row.queryJson || '{}'); } catch {}
  return { id: row.id, name: row.name, createdAt: row.createdAt, spec };
}

function smartCollection(id) {
  return parseSmart(db.prepare(`
    SELECT id, name, query_json AS queryJson, created_at AS createdAt
    FROM smart_collections WHERE id = ?
  `).get(id));
}

function listSmartCollections() {
  return db.prepare(`
    SELECT id, name, query_json AS queryJson, created_at AS createdAt
    FROM smart_collections ORDER BY lower(name), id
  `).all().map(parseSmart);
}

function cleanSmartSpec(value) {
  const spec = value && typeof value === 'object' ? value : {};
  const query = String(spec.query || '').slice(0, 500);
  const type = String(spec.type || '');
  const sourceName = String(spec.sourceName || '').slice(0, 200);
  const sort = String(spec.sort || 'date-desc');
  const allowedTypes = new Set(['', 'media', 'image', 'video', 'audio', 'application', 'other']);
  const allowedSorts = new Set(['date-desc', 'date-asc', 'size-desc']);
  return {
    query,
    type: allowedTypes.has(type) ? type : '',
    sourceName,
    sort: allowedSorts.has(sort) ? sort : 'date-desc'
  };
}

function nameTaken(name, exceptSmartId = 0) {
  if (db.prepare('SELECT 1 FROM collections WHERE name = ? COLLATE NOCASE').get(name)) return true;
  return Boolean(db.prepare('SELECT 1 FROM smart_collections WHERE name = ? COLLATE NOCASE AND id != ?').get(name, exceptSmartId));
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

export async function handleCollections(req, res, url) {
  if (!url.pathname.startsWith('/api/collections') && !url.pathname.startsWith('/api/smart-collections')) return false;

  if (url.pathname === '/api/smart-collections') {
    if (req.method === 'GET') json(res, 200, { collections: listSmartCollections() });
    else if (req.method === 'POST') {
      const body = await readJson(req, 256 * 1024);
      const name = String(body.name || '').trim();
      if (!name) throw Object.assign(new Error('Collection name is required'), { status: 400 });
      if (name.length > 80) throw Object.assign(new Error('Collection name is too long'), { status: 400 });
      if (nameTaken(name)) throw Object.assign(new Error('A collection with that name already exists'), { status: 409 });
      const spec = cleanSmartSpec(body.spec);
      if (!spec.query && !spec.type && !spec.sourceName) throw Object.assign(new Error('Nothing to save in this view'), { status: 400 });
      const result = db.prepare('INSERT INTO smart_collections(name, query_json, created_at) VALUES(?, ?, ?)').run(name, JSON.stringify(spec), now());
      json(res, 201, smartCollection(Number(result.lastInsertRowid)));
    } else json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const smartMatch = /^\/api\/smart-collections\/(\d+)$/.exec(url.pathname);
  if (smartMatch) {
    const id = Number(smartMatch[1]);
    const item = smartCollection(id);
    if (!item) json(res, 404, { error: 'Collection not found' });
    else if (req.method === 'GET') json(res, 200, item);
    else if (req.method === 'DELETE') {
      db.prepare('DELETE FROM smart_collections WHERE id = ?').run(id);
      json(res, 200, { ok: true });
    } else json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  if (url.pathname === '/api/collections') {
    if (req.method === 'GET') json(res, 200, { collections: listCollections() });
    else if (req.method === 'POST') {
      const name = String((await readJson(req, 256 * 1024)).name || '').trim();
      if (!name) throw Object.assign(new Error('Collection name is required'), { status: 400 });
      if (name.length > 80) throw Object.assign(new Error('Collection name is too long'), { status: 400 });
      const existing = db.prepare('SELECT id FROM collections WHERE name = ? COLLATE NOCASE').get(name);
      if (existing) json(res, 200, { ...collection(existing.id), existing: true });
      else {
        if (db.prepare('SELECT 1 FROM smart_collections WHERE name = ? COLLATE NOCASE').get(name)) {
          throw Object.assign(new Error('A collection with that name already exists'), { status: 409 });
        }
        const result = db.prepare('INSERT INTO collections(name, created_at) VALUES(?, ?)').run(name, now());
        json(res, 201, { ...collection(Number(result.lastInsertRowid)), existing: false });
      }
    } else json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const fileMatch = /^\/api\/collections\/file\/([a-f0-9]{64})$/.exec(url.pathname);
  if (fileMatch) {
    if (req.method !== 'GET') json(res, 405, { error: 'Method not allowed' });
    else {
      const rows = db.prepare(`
        SELECT c.id, c.name
        FROM collection_members cm
        JOIN collections c ON c.id = cm.collection_id
        JOIN objects o ON o.hash = cm.object_hash AND o.state = 'active'
        WHERE cm.object_hash = ?
        ORDER BY lower(c.name), c.id
      `).all(fileMatch[1]);
      json(res, 200, { collections: rows });
    }
    return true;
  }

  const hashesMatch = /^\/api\/collections\/(\d+)\/hashes$/.exec(url.pathname);
  if (hashesMatch) {
    if (req.method !== 'GET') json(res, 405, { error: 'Method not allowed' });
    else {
      const id = Number(hashesMatch[1]);
      const item = collection(id);
      if (!item) json(res, 404, { error: 'Collection not found' });
      else {
        const hashes = db.prepare(`
          SELECT cm.object_hash AS hash
          FROM collection_members cm
          JOIN objects o ON o.hash = cm.object_hash AND o.state = 'active'
          WHERE cm.collection_id = ?
          ORDER BY cm.added_at, cm.object_hash
        `).all(id).map(row => row.hash);
        json(res, 200, { collection: item, hashes });
      }
    }
    return true;
  }

  const itemsMatch = /^\/api\/collections\/(\d+)\/items$/.exec(url.pathname);
  if (itemsMatch) {
    if (req.method !== 'POST') json(res, 405, { error: 'Method not allowed' });
    else {
      const id = Number(itemsMatch[1]);
      if (!collection(id)) json(res, 404, { error: 'Collection not found' });
      else {
        const hashes = cleanHashes(await readJson(req, 256 * 1024));
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
      }
    }
    return true;
  }

  const itemMatch = /^\/api\/collections\/(\d+)\/items\/([a-f0-9]{64})$/.exec(url.pathname);
  if (itemMatch) {
    if (req.method !== 'DELETE') json(res, 405, { error: 'Method not allowed' });
    else {
      const id = Number(itemMatch[1]);
      db.prepare('DELETE FROM collection_members WHERE collection_id = ? AND object_hash = ?').run(id, itemMatch[2]);
      json(res, 200, { ok: true, collection: collection(id) });
    }
    return true;
  }

  const collectionMatch = /^\/api\/collections\/(\d+)$/.exec(url.pathname);
  if (collectionMatch) {
    if (req.method !== 'DELETE') json(res, 405, { error: 'Method not allowed' });
    else {
      const id = Number(collectionMatch[1]);
      const item = db.prepare('SELECT id, name FROM collections WHERE id = ?').get(id);
      if (!item) json(res, 404, { error: 'Collection not found' });
      else {
        db.prepare('DELETE FROM collections WHERE id = ?').run(id);
        json(res, 200, { ok: true, id, name: item.name });
      }
    }
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
