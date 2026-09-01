import { db, json, now, readJson } from './lib/server-context.js';
import { handleProtectionServer, registerProtectionStorage } from './protection-server.js';

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const words = value => normalizeText(value).split(' ').filter(Boolean);

function tokenize(raw) {
  const tokens = [];
  const regex = /(?:^|\s)(?:(name|path|source|type|ext|year):(?:"([^"]*)"|'([^']*)'|([^\s]+))|"([^"]*)"|'([^']*)'|([^\s]+))/giu;
  let match;
  while ((match = regex.exec(String(raw || '')))) {
    const text = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7] ?? '';
    if (text.trim()) tokens.push({ field: match[1]?.toLowerCase() || '', text: text.trim() });
  }
  return tokens;
}

function pathQueryText(value) {
  const raw = String(value || '').trim();
  if (!/^[a-z]:[\\/]/i.test(raw) && !/^[\\/]{1,2}/.test(raw)) return raw;
  return raw.split(/[\\/]+/).map(part => part.trim()).filter(Boolean).at(-1) || raw;
}

function typeName(value) {
  const aliases = new Map([
    ['photo', 'image'], ['photos', 'image'], ['picture', 'image'], ['pictures', 'image'], ['images', 'image'],
    ['videos', 'video'], ['movies', 'video'], ['music', 'audio'],
    ['documents', 'application'], ['document', 'application'], ['docs', 'application']
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

const like = value => `%${String(value || '').toLowerCase()}%`;

function tokenClause(token, alias = 'o') {
  let text = token.text;
  if (token.field === 'path' || (!token.field && /[\\/]/.test(text))) text = pathQueryText(text);
  const terms = words(text);
  if (!terms.length) return { sql: '1=1', params: [] };
  if (token.field === 'type') return typeClause(text, alias);
  if (token.field === 'ext') return {
    sql: `EXISTS (SELECT 1 FROM sources sx WHERE sx.object_hash = ${alias}.hash AND lower(sx.filename) LIKE ?)`,
    params: [`%.${normalizeText(String(text).replace(/^\./, ''))}`]
  };
  if (token.field === 'year') return {
    sql: `(EXISTS (SELECT 1 FROM media_metadata mm WHERE mm.object_hash = ${alias}.hash AND mm.captured_at LIKE ?) OR EXISTS (SELECT 1 FROM sources sy WHERE sy.object_hash = ${alias}.hash AND sy.mtime LIKE ?))`,
    params: [`${String(text).trim()}%`, `${String(text).trim()}%`]
  };

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
    clauses.push(`(
      EXISTS (
        SELECT 1 FROM sources sa
        JOIN imports ia ON ia.id = sa.import_id
        LEFT JOIN import_roots ra ON ra.import_id = sa.import_id
        WHERE sa.object_hash = ${alias}.hash AND (
          lower(sa.filename) LIKE ? OR lower(sa.original_path) LIKE ? OR lower(ia.source_name) LIKE ? OR lower(ra.root_path) LIKE ? OR lower(ra.device_name) LIKE ?
        )
      ) OR ${type.sql === '0=1' ? '0=1' : type.sql}
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
  return collectionId ? {
    all: false,
    collectionId,
    collectionName: String(policy.collectionName || '').slice(0, 80)
  } : { all: true, collectionId: null };
}

function resolvePolicy(value, alias = 'o') {
  const policy = normalizedPolicy(value);
  if (policy.all) return { policy, filter: { sql: '1=1', params: [] } };
  const row = db.prepare('SELECT id, name, query_json AS queryJson FROM smart_collections WHERE id = ?').get(policy.collectionId);
  if (!row) return { policy: { ...policy, missing: true }, filter: { sql: '0=1', params: [] } };
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

export function getDrive(id) {
  return db.prepare('SELECT * FROM drives WHERE id = ?').get(id);
}

export function driveCoverage(row) {
  const { policy, filter } = resolvePolicy(parseDrivePolicy(row), 'o');
  const desired = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(o.size), 0) AS bytes
    FROM objects o WHERE o.state = 'active' AND ${filter.sql}
  `).get(...filter.params);
  const protectedRow = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(o.size), 0) AS bytes,
           COALESCE(SUM(CASE WHEN r.verified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS verifiedCount,
           MIN(r.verified_at) AS oldestVerifiedAt,
           MAX(r.verified_at) AS lastVerifiedAt
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
    protectedBytes: Number(protectedRow.bytes) || 0,
    verifiedCount: Number(protectedRow.verifiedCount) || 0,
    oldestVerifiedAt: protectedRow.oldestVerifiedAt || null,
    lastVerifiedAt: protectedRow.lastVerifiedAt || null
  };
}

export async function handleBackupPolicy(req, res, url) {
  if (await handleProtectionServer(req, res, url)) return true;

  const desired = /^\/api\/drives\/([^/]+)\/desired$/.exec(url.pathname);
  const files = /^\/api\/drives\/([^/]+)\/files$/.exec(url.pathname);
  const driveRoute = url.pathname === '/api/drives/register' || url.pathname === '/api/drives' || Boolean(desired) || Boolean(files);
  if (!driveRoute) return false;

  if (req.method === 'POST' && url.pathname === '/api/drives/register') {
    const body = await readJson(req, 256 * 1024);
    const id = String(body.id || '').trim();
    const name = String(body.name || '').trim();
    if (!id || !name) throw Object.assign(new Error('id and name are required'), { status: 400 });
    const policy = normalizedPolicy(body.policy);
    db.prepare(`
      INSERT INTO drives(id, name, policy_json, last_seen) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, policy_json = excluded.policy_json, last_seen = excluded.last_seen
    `).run(id, name, JSON.stringify(policy), now());
    if (body.storage && typeof body.storage === 'object') registerProtectionStorage(id, { ...body.storage, name });
    json(res, 200, driveCoverage(getDrive(id)));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/drives') {
    json(res, 200, { drives: db.prepare('SELECT * FROM drives ORDER BY name').all().map(driveCoverage) });
    return true;
  }

  if (files && req.method === 'GET') {
    const id = decodeURIComponent(files[1]);
    if (!getDrive(id)) {
      json(res, 404, { error: 'Backup not registered' });
      return true;
    }
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 5000)));
    const rows = db.prepare(`
      SELECT r.object_hash AS hash, r.verified_at AS verifiedAt, o.size
      FROM replicas r JOIN objects o ON o.hash = r.object_hash
      WHERE r.drive_id = ? AND o.state = 'active' AND r.object_hash > ?
      ORDER BY r.object_hash LIMIT ?
    `).all(id, after, limit).map(row => ({ ...row, size: Number(row.size) || 0 }));
    json(res, 200, { files: rows, nextAfter: rows.length === limit ? rows.at(-1).hash : null });
    return true;
  }

  if (desired && req.method === 'GET') {
    const id = decodeURIComponent(desired[1]);
    const drive = getDrive(id);
    if (!drive) {
      json(res, 404, { error: 'Backup not registered' });
      return true;
    }
    const { filter } = resolvePolicy(parseDrivePolicy(drive), 'o');
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 1000)));
    const rows = db.prepare(`
      SELECT o.hash, o.size, o.mime FROM objects o
      WHERE o.state = 'active' AND o.hash > ? AND ${filter.sql}
      ORDER BY o.hash LIMIT ?
    `).all(after, ...filter.params, limit);
    db.prepare('UPDATE drives SET last_seen = ? WHERE id = ?').run(now(), id);
    json(res, 200, { objects: rows, nextAfter: rows.length === limit ? rows.at(-1).hash : null });
    return true;
  }

  json(res, 405, { error: 'Method not allowed' });
  return true;
}
