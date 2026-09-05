import { db, json, now, readJson, catalogVersion } from './lib/server-context.js';
import { validHash } from './lib/store.js';

function catalogPage(url) {
  const after = String(url.searchParams.get('after') || '');
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 5000)));
  const rows = db.prepare(`
    SELECT o.hash, o.size, o.mime, o.created_at AS createdAt,
           COALESCE(MIN(s.filename), o.hash) AS filename,
           COALESCE(MIN(s.original_path), '') AS originalPath,
           COALESCE(MAX(s.mtime), o.created_at) AS fileDate,
           COALESCE(MAX(s.created_at), o.created_at) AS addedAt,
           COALESCE(MAX(t.width), 0) AS width,
           COALESCE(MAX(t.height), 0) AS height,
           GROUP_CONCAT(DISTINCT (SELECT MIN(i2.id) FROM imports i2 WHERE i2.source_name = i.source_name)) AS importIds,
           GROUP_CONCAT(DISTINCT s.import_id) AS exactImportIds,
           COALESCE(GROUP_CONCAT(DISTINCT s.filename || ' ' || s.original_path || ' ' || COALESCE(ir.root_path, '')), '') AS searchText,
           EXISTS (SELECT 1 FROM reviewed_hashes rh WHERE rh.hash = o.hash) AS reviewed,
           (SELECT COUNT(*) FROM replicas r WHERE r.object_hash = o.hash) AS backupCount,
           NOT EXISTS (SELECT 1 FROM object_integrity oi WHERE oi.hash = o.hash AND oi.status != 'healthy') AS serverStored,
           COALESCE((SELECT oi.status FROM object_integrity oi WHERE oi.hash = o.hash), 'unknown') AS integrityStatus
    FROM objects o
    LEFT JOIN sources s ON s.object_hash = o.hash
    LEFT JOIN imports i ON i.id = s.import_id
    LEFT JOIN import_roots ir ON ir.import_id = s.import_id
    LEFT JOIN thumbnails t ON t.object_hash = o.hash
    WHERE o.state = 'active' AND o.hash > ?
    GROUP BY o.hash
    ORDER BY o.hash
    LIMIT ?
  `).all(after, limit);
  return {
    files: rows,
    nextAfter: rows.length === limit ? rows.at(-1).hash : null,
    version: catalogVersion()
  };
}

function saneDate(value) {
  if (!value) return null;
  const date = new Date(value);
  const year = date.getFullYear();
  if (Number.isNaN(date.getTime()) || year < 1980 || year > new Date().getFullYear() + 1) return null;
  return String(value).slice(0, 64);
}

function dateRows(hashes) {
  if (!hashes.length) return [];
  const marks = hashes.map(() => '?').join(',');
  return db.prepare(`
    SELECT o.hash, o.created_at AS createdAt,
           mm.captured_at AS capturedAt, mm.source AS embeddedSource,
           MIN(CASE
             WHEN CAST(strftime('%Y', s.mtime) AS INTEGER) BETWEEN 1980 AND CAST(strftime('%Y', 'now') AS INTEGER) + 1
             THEN s.mtime
           END) AS earliestMtime
    FROM objects o
    LEFT JOIN sources s ON s.object_hash = o.hash
    LEFT JOIN media_metadata mm ON mm.object_hash = o.hash
    WHERE o.state = 'active' AND o.hash IN (${marks})
    GROUP BY o.hash, o.created_at, mm.captured_at, mm.source
  `).all(...hashes).map(row => {
    if (row.capturedAt) return { hash: row.hash, fileDate: row.capturedAt, dateSource: row.embeddedSource, capturedAt: row.capturedAt };
    if (row.earliestMtime) return { hash: row.hash, fileDate: row.earliestMtime, dateSource: 'filesystem.mtime', capturedAt: null };
    return { hash: row.hash, fileDate: row.createdAt, dateSource: 'imported', capturedAt: null };
  });
}

function cleanHashes(body) {
  if (!Array.isArray(body.hashes) || body.hashes.length > 5000) {
    throw Object.assign(new Error('hashes must be an array of at most 5000 SHA-256 hashes'), { status: 400 });
  }
  const hashes = [...new Set(body.hashes.map(String))];
  if (hashes.some(hash => !validHash(hash))) throw Object.assign(new Error('Invalid SHA-256 hash'), { status: 400 });
  return hashes;
}

function mediaExtensionsSql() {
  return ['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff','mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']
    .map(ext => `lower(s.filename) LIKE '%.${ext}'`).join(' OR ');
}

function missingMetadata(url) {
  const imports = [...new Set(String(url.searchParams.get('imports') || '').split(',').map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!imports.length) throw Object.assign(new Error('imports is required'), { status: 400 });
  if (imports.length > 100) throw Object.assign(new Error('Too many imports'), { status: 400 });
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
  const marks = imports.map(() => '?').join(',');
  const objects = db.prepare(`
    SELECT o.hash, o.size, o.mime
    FROM sources s
    JOIN objects o ON o.hash = s.object_hash
    LEFT JOIN media_metadata mm ON mm.object_hash = o.hash
    WHERE s.import_id IN (${marks}) AND o.state = 'active' AND mm.object_hash IS NULL
      AND (o.mime LIKE 'image/%' OR o.mime LIKE 'video/%' OR ${mediaExtensionsSql()})
    GROUP BY o.hash, o.size, o.mime
    ORDER BY o.size ASC, o.hash
    LIMIT ?
  `).all(...imports, limit);
  if (!objects.length) return [];

  const hashes = objects.map(item => item.hash);
  const hashMarks = hashes.map(() => '?').join(',');
  const sourceRows = db.prepare(`
    SELECT s.object_hash AS hash, s.import_id AS importId, s.original_path AS originalPath, s.filename, s.mtime
    FROM sources s
    WHERE s.object_hash IN (${hashMarks}) AND s.import_id IN (${marks})
    ORDER BY s.object_hash, s.import_id, s.id
  `).all(...hashes, ...imports);
  const byHash = new Map();
  for (const source of sourceRows) {
    if (!byHash.has(source.hash)) byHash.set(source.hash, []);
    byHash.get(source.hash).push(source);
  }
  return objects.map(item => ({ ...item, sources: byHash.get(item.hash) || [] }));
}

function details(hash) {
  const object = db.prepare(`
    SELECT o.hash, o.size, o.mime, o.created_at AS createdAt,
           EXISTS (SELECT 1 FROM reviewed_hashes rh WHERE rh.hash = o.hash) AS reviewed,
           COALESCE((SELECT oi.status FROM object_integrity oi WHERE oi.hash = o.hash), 'unknown') AS integrityStatus,
           (SELECT oi.verified_at FROM object_integrity oi WHERE oi.hash = o.hash) AS integrityVerifiedAt
    FROM objects o WHERE o.hash = ? AND o.state = 'active'
  `).get(hash);
  if (!object) return null;
  const sources = db.prepare(`
    SELECT s.import_id AS importId, s.original_path AS path, s.filename, s.mtime,
           i.source_name AS sourceName, i.created_at AS importedAt,
           COALESCE(ir.device_name, i.source_name) AS deviceName, COALESCE(ir.root_path, '') AS rootPath
    FROM sources s
    JOIN imports i ON i.id = s.import_id
    LEFT JOIN import_roots ir ON ir.import_id = i.id
    WHERE s.object_hash = ? ORDER BY i.created_at DESC, s.original_path
  `).all(hash);
  const backups = db.prepare(`
    SELECT d.id, d.name, d.last_seen AS lastSeen, r.verified_at AS verifiedAt
    FROM replicas r JOIN drives d ON d.id = r.drive_id
    WHERE r.object_hash = ? ORDER BY d.name
  `).all(hash);
  const date = dateRows([hash])[0] || { hash, fileDate: object.createdAt, dateSource: 'imported', capturedAt: null };
  return {
    object,
    sources,
    backups,
    date,
    serverStored: !['corrupt', 'missing'].includes(object.integrityStatus)
  };
}

export async function handleMetadata(req, res, url) {
  const detailsMatch = /^\/api\/files\/([a-f0-9]{64})\/details$/.exec(url.pathname);
  const isRoute = url.pathname === '/api/catalog' ||
    url.pathname === '/api/catalog/version' ||
    url.pathname === '/api/file-dates' ||
    url.pathname === '/api/import-roots' ||
    url.pathname.startsWith('/api/media-metadata') ||
    url.pathname.startsWith('/api/provenance/') ||
    Boolean(detailsMatch);
  if (!isRoute) return false;

  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    json(res, 200, catalogPage(url));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog/version') {
    json(res, 200, { version: catalogVersion() });
    return true;
  }
  if (detailsMatch && req.method === 'GET') {
    const data = details(detailsMatch[1]);
    json(res, data ? 200 : 404, data || { error: 'File not found' });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/file-dates') {
    json(res, 200, { dates: dateRows(cleanHashes(await readJson(req, 512 * 1024))) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/import-roots') {
    const body = await readJson(req, 128 * 1024);
    if (!Array.isArray(body.roots) || body.roots.length > 100) throw Object.assign(new Error('roots must be an array of at most 100 entries'), { status: 400 });
    const upsert = db.prepare(`
      INSERT INTO import_roots(import_id, device_name, root_path, updated_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(import_id) DO UPDATE SET device_name=excluded.device_name, root_path=excluded.root_path, updated_at=excluded.updated_at
    `);
    const timestamp = now();
    let changed = 0;
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const item of body.roots) {
        const importId = Number(item.importId);
        if (!Number.isInteger(importId) || importId < 1 || !db.prepare('SELECT 1 FROM imports WHERE id = ?').get(importId)) continue;
        changed += Number(upsert.run(importId, String(item.deviceName || '').slice(0, 200), String(item.rootPath || '').slice(0, 2000), timestamp).changes || 0);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    json(res, 200, { ok: true, count: changed });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/media-metadata/missing') {
    json(res, 200, { files: missingMetadata(url) });
    return true;
  }

  const metadataMatch = /^\/api\/media-metadata\/([a-f0-9]{64})$/.exec(url.pathname);
  if (metadataMatch && req.method === 'POST') {
    const hash = metadataMatch[1];
    if (!db.prepare("SELECT 1 FROM objects WHERE hash = ? AND state = 'active'").get(hash)) {
      json(res, 404, { error: 'File not found' });
      return true;
    }
    const body = await readJson(req, 16 * 1024);
    const capturedAt = body.capturedAt == null ? null : saneDate(body.capturedAt);
    if (body.capturedAt && !capturedAt) throw Object.assign(new Error('Invalid captured date'), { status: 400 });
    const source = String(body.source || 'none').slice(0, 80);
    db.prepare(`
      INSERT INTO media_metadata(object_hash, captured_at, source, checked_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(object_hash) DO UPDATE SET captured_at=excluded.captured_at, source=excluded.source, checked_at=excluded.checked_at
    `).run(hash, capturedAt, source, now());
    json(res, 200, { ok: true, hash, capturedAt, source });
    return true;
  }

  const provenanceMatch = /^\/api\/provenance\/([a-f0-9]{64})$/.exec(url.pathname);
  if (provenanceMatch && req.method === 'GET') {
    const data = details(provenanceMatch[1]);
    json(res, data ? 200 : 404, data || { error: 'File not found' });
    return true;
  }

  json(res, 405, { error: 'Method not allowed' });
  return true;
}
