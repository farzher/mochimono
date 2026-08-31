import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { openCatalog } from './lib/db.js';

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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function tokenize(raw) {
  const tokens = [];
  const regex = /(?:^|\s)(?:(name|path|source|type|ext|year):(?:"([^"]*)"|'([^']*)'|([^\s]+))|"([^"]*)"|'([^']*)'|([^\s]+))/giu;
  let match;
  while ((match = regex.exec(String(raw || '')))) {
    const field = match[1]?.toLowerCase() || '';
    const text = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? '';
    if (text.trim()) tokens.push({ field, text: text.trim() });
  }
  return tokens;
}

function pathQueryText(value) {
  const raw = String(value || '').trim();
  const absolute = /^[a-z]:[\\/]/i.test(raw) || /^[\\/]{1,2}/.test(raw);
  if (!absolute) return raw;
  const parts = raw.split(/[\\/]+/).map(part => part.trim()).filter(Boolean);
  return parts.at(-1) || raw;
}

function typeName(value) {
  const aliases = new Map([
    ['photo', 'image'], ['photos', 'image'], ['picture', 'image'], ['pictures', 'image'], ['images', 'image'],
    ['videos', 'video'], ['movies', 'video'], ['music', 'audio'], ['documents', 'application'], ['document', 'application'], ['docs', 'application']
  ]);
  const normalized = normalizeText(value);
  return aliases.get(normalized) || normalized;
}

function typeClause(value, alias = 'o') {
  const type = typeName(value);
  if (type === 'media') return { sql: `(${alias}.mime LIKE 'image/%' OR ${alias}.mime LIKE 'video/%')`, params: [] };
  if (type === 'application') return { sql: `(${alias}.mime LIKE 'application/%' OR ${alias}.mime LIKE 'text/%')`, params: [] };
  if (['image', 'video', 'audio', 'text'].includes(type)) return { sql: `${alias}.mime LIKE ?`, params: [`${type}/%`] };
  if (type === 'other') return {
    sql: `(${alias}.mime NOT LIKE 'image/%' AND ${alias}.mime NOT LIKE 'video/%' AND ${alias}.mime NOT LIKE 'audio/%' AND ${alias}.mime NOT LIKE 'text/%' AND ${alias}.mime NOT LIKE 'application/%')`,
    params: []
  };
  return { sql: '0=1', params: [] };
}

function like(value) {
  return `%${String(value || '').toLowerCase()}%`;
}

function tokenClause(token, alias = 'o') {
  let text = token.text;
  if (token.field === 'path' || (!token.field && /[\\/]/.test(text))) text = pathQueryText(text);
  const terms = words(text);
  if (!terms.length) return { sql: '1=1', params: [] };

  if (token.field === 'type') return typeClause(text, alias);
  if (token.field === 'ext') {
    const ext = normalizeText(String(text).replace(/^\./, ''));
    return {
      sql: `EXISTS (SELECT 1 FROM sources sx WHERE sx.object_hash = ${alias}.hash AND lower(sx.filename) LIKE ?)`,
      params: [`%.${ext}`]
    };
  }
  if (token.field === 'year') {
    const year = String(text).trim();
    return {
      sql: `(EXISTS (SELECT 1 FROM media_metadata mm WHERE mm.object_hash = ${alias}.hash AND mm.captured_at LIKE ?) OR EXISTS (SELECT 1 FROM sources sy WHERE sy.object_hash = ${alias}.hash AND sy.mtime LIKE ?))`,
      params: [`${year}%`, `${year}%`]
    };
  }

  const clauses = [];
  const params = [];
  for (const term of terms) {
    if (token.field === 'name') {
      clauses.push(`EXISTS (SELECT 1 FROM sources sn WHERE sn.object_hash = ${alias}.hash AND lower(sn.filename) LIKE ?)`);
      params.push(like(term));
      continue;
    }
    if (token.field === 'path') {
      clauses.push(`EXISTS (SELECT 1 FROM sources sp LEFT JOIN import_roots rp ON rp.import_id = sp.import_id WHERE sp.object_hash = ${alias}.hash AND (lower(sp.original_path) LIKE ? OR lower(rp.root_path) LIKE ?))`);
      params.push(like(term), like(term));
      continue;
    }
    if (token.field === 'source') {
      clauses.push(`EXISTS (SELECT 1 FROM sources ss JOIN imports ix ON ix.id = ss.import_id LEFT JOIN import_roots rs ON rs.import_id = ss.import_id WHERE ss.object_hash = ${alias}.hash AND (lower(ix.source_name) LIKE ? OR lower(rs.device_name) LIKE ?))`);
      params.push(like(term), like(term));
      continue;
    }

    const type = typeClause(term, alias);
    const typeSearch = type.sql === '0=1' ? '0=1' : type.sql;
    clauses.push(`(
      EXISTS (
        SELECT 1 FROM sources sa
        JOIN imports ia ON ia.id = sa.import_id
        LEFT JOIN import_roots ra ON ra.import_id = sa.import_id
        WHERE sa.object_hash = ${alias}.hash AND (
          lower(sa.filename) LIKE ? OR lower(sa.original_path) LIKE ? OR lower(ia.source_name) LIKE ? OR lower(ra.root_path) LIKE ? OR lower(ra.device_name) LIKE ?
        )
      ) OR ${typeSearch}
    )`);
    params.push(like(term), like(term), like(term), like(term), like(term), ...type.params);
  }
  return { sql: `(${clauses.join(' AND ')})`, params };
}

function smartFilter(spec = {}, alias = 'o') {
  const clauses = [];
  const params = [];
  if (spec.type) {
    const type = typeClause(spec.type, alias);
    clauses.push(type.sql);
    params.push(...type.params);
  }
  if (spec.sourceName) {
    clauses.push(`EXISTS (SELECT 1 FROM sources sc JOIN imports ic ON ic.id = sc.import_id WHERE sc.object_hash = ${alias}.hash AND lower(ic.source_name) = lower(?))`);
    params.push(String(spec.sourceName));
  }
  for (const token of tokenize(spec.query || '')) {
    const condition = tokenClause(token, alias);
    clauses.push(condition.sql);
    params.push(...condition.params);
  }
  return { sql: clauses.length ? `(${clauses.join(' AND ')})` : '1=1', params };
}

function normalizedPolicy(value) {
  const policy = value && typeof value === 'object' ? value : {};
  if (policy.all !== false) return { all: true, collectionId: null };
  const collectionId = Number(policy.collectionId) || 0;
  if (!collectionId) return { all: true, collectionId: null };
  return {
    all: false,
    collectionId,
    collectionName: String(policy.collectionName || '').slice(0, 80)
  };
}

function resolvePolicy(value, alias = 'o') {
  const policy = normalizedPolicy(value);
  if (policy.all) return { policy, filter: { sql: '1=1', params: [] } };
  const row = db.prepare('SELECT id, name, query_json AS queryJson FROM smart_collections WHERE id = ?').get(policy.collectionId);
  if (!row) return {
    policy: { ...policy, missing: true },
    filter: { sql: '0=1', params: [] }
  };
  let spec = {};
  try { spec = JSON.parse(row.queryJson || '{}'); } catch {}
  return {
    policy: { all: false, collectionId: row.id, collectionName: row.name },
    filter: smartFilter(spec, alias)
  };
}

function parseDrivePolicy(row) {
  try { return JSON.parse(row.policy_json || '{}'); }
  catch { return {}; }
}

function getDrive(id) {
  return db.prepare('SELECT * FROM drives WHERE id = ?').get(id);
}

function driveCoverage(row) {
  const { policy, filter } = resolvePolicy(parseDrivePolicy(row), 'o');
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
    desiredCount: Number(desired.count) || 0,
    desiredBytes: Number(desired.bytes) || 0,
    protectedCount: Number(protectedRow.count) || 0,
    protectedBytes: Number(protectedRow.bytes) || 0
  };
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
    const driveRoute = url.pathname === '/api/drives/register' || url.pathname === '/api/drives' || /^\/api\/drives\/[^/]+\/desired$/.test(url.pathname);
    if (!driveRoute) return listener(req, res);
    if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' });

    try {
      if (req.method === 'POST' && url.pathname === '/api/drives/register') {
        const body = await readJson(req);
        const id = String(body.id || '').trim();
        const name = String(body.name || '').trim();
        if (!id || !name) return json(res, 400, { error: 'id and name are required' });
        const policy = normalizedPolicy(body.policy);
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

      const desired = /^\/api\/drives\/([^/]+)\/desired$/.exec(url.pathname);
      if (desired && req.method === 'GET') {
        const id = decodeURIComponent(desired[1]);
        const drive = getDrive(id);
        if (!drive) return json(res, 404, { error: 'Backup not registered' });
        const { filter } = resolvePolicy(parseDrivePolicy(drive), 'o');
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

      return listener(req, res);
    } catch (error) {
      console.error('Backup policy server:', error);
      if (!res.headersSent) return json(res, error.status || 500, { error: error.status ? error.message : 'Backup policy error' });
      return res.destroy();
    }
  };
  return originalCreateServer.apply(context, args);
};