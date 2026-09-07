import { db, json, catalogVersion, readJson } from './lib/server-context.js';
import { handleSourceScopeServer } from './source-scope-server.js';

let cachedVersion = '';
let cachedNodes = null;

const cleanParts = value => String(value || '')
  .replaceAll('\\', '/')
  .split('/')
  .map(part => part.trim())
  .filter(part => part && part !== '.' && part !== '..');

function rootParts(row) {
  const raw = String(row.rootPath || '').trim();
  const normalized = raw.replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(normalized)) {
    const parts = cleanParts(normalized);
    if (parts.length) parts[0] = parts[0].toUpperCase();
    return parts;
  }
  if (normalized.startsWith('/')) return ['/', ...cleanParts(normalized)];
  if (raw) return ['Browser', ...cleanParts(raw)];
  return ['Browser', String(row.sourceName || row.deviceName || `Source ${row.importId}`)];
}

const keyFor = parts => parts.join('/');

function freshTree() {
  const version = catalogVersion();
  if (cachedNodes && cachedVersion === version) return cachedNodes;

  const nodes = new Map();
  const node = parts => {
    const key = keyFor(parts);
    let value = nodes.get(key);
    if (!value) {
      value = { path:key, folders:new Map(), files:[], fileKeys:new Set() };
      nodes.set(key, value);
    }
    return value;
  };
  node([]);

  const rows = db.prepare(`
    SELECT s.id AS sourceId, s.import_id AS importId, s.object_hash AS hash,
           s.original_path AS originalPath, s.filename, s.mtime,
           o.size, o.mime, o.created_at AS createdAt,
           COALESCE(NULLIF(mm.width,0), NULLIF(t.width,0), 0) AS width,
           COALESCE(NULLIF(mm.height,0), NULLIF(t.height,0), 0) AS height,
           COALESCE(mm.captured_at, s.mtime, o.created_at) AS fileDate,
           i.source_name AS sourceName,
           COALESCE(ir.device_name, i.source_name) AS deviceName,
           COALESCE(ir.root_path, '') AS rootPath
    FROM sources s
    JOIN objects o ON o.hash=s.object_hash AND o.state='active'
    JOIN imports i ON i.id=s.import_id
    LEFT JOIN import_roots ir ON ir.import_id=s.import_id
    LEFT JOIN media_metadata mm ON mm.object_hash=o.hash
    LEFT JOIN thumbnails t ON t.object_hash=o.hash
    ORDER BY s.id
  `).all();

  for (const row of rows) {
    const root = rootParts(row);
    const relative = cleanParts(row.originalPath || row.filename);
    if (!relative.length && row.filename) relative.push(String(row.filename));
    if (!relative.length) continue;
    const full = [...root, ...relative];
    const parent = full.slice(0, -1);

    for (let depth = 0; depth < parent.length; depth++) {
      const parentParts = parent.slice(0, depth);
      const childName = parent[depth];
      const parentNode = node(parentParts);
      const childPath = keyFor(parent.slice(0, depth + 1));
      const existing = parentNode.folders.get(childName) || { name:childName, path:childPath, references:0 };
      existing.references++;
      parentNode.folders.set(childName, existing);
      node(parent.slice(0, depth + 1));
    }

    const parentNode = node(parent);
    const virtualPath = keyFor(full);
    const exactKey = `${row.hash}\u0000${virtualPath}`;
    if (parentNode.fileKeys.has(exactKey)) continue;
    parentNode.fileKeys.add(exactKey);
    parentNode.files.push({
      hash:row.hash,
      size:Number(row.size) || 0,
      mime:row.mime,
      filename:row.filename || relative.at(-1) || row.hash,
      originalPath:row.originalPath || '',
      virtualPath,
      rootPath:row.rootPath || '',
      sourceName:row.sourceName || '',
      deviceName:row.deviceName || '',
      importId:Number(row.importId) || 0,
      sourceId:Number(row.sourceId) || 0,
      createdAt:row.createdAt,
      fileDate:row.fileDate || row.mtime || row.createdAt,
      width:Number(row.width) || 0,
      height:Number(row.height) || 0
    });
  }

  for (const value of nodes.values()) {
    value.files.sort((a, b) => String(a.filename).localeCompare(String(b.filename), undefined, { numeric:true, sensitivity:'base' }));
  }

  cachedVersion = version;
  cachedNodes = nodes;
  return nodes;
}

function folderTree(url) {
  const parts = cleanParts(url.searchParams.get('path'));
  const path = keyFor(parts);
  const current = freshTree().get(path);
  if (!current) return { path, folders:[], files:[] };
  const folders = [...current.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' }));
  return { path, folders, files:current.files };
}

function importRoots() {
  return db.prepare(`
    SELECT i.id AS importId, i.source_name AS sourceName,
           COALESCE(ir.device_name, i.source_name) AS deviceName,
           COALESCE(ir.root_path, '') AS rootPath,
           COUNT(s.id) AS references,
           COUNT(DISTINCT s.object_hash) AS files
    FROM imports i
    LEFT JOIN import_roots ir ON ir.import_id=i.id
    LEFT JOIN sources s ON s.import_id=i.id
    GROUP BY i.id
    HAVING COUNT(s.id) > 0
    ORDER BY lower(COALESCE(NULLIF(ir.root_path,''), i.source_name)), i.id
  `).all();
}

const sourcePathMatch = pathname => /^\/api\/imports\/(\d+)\/source-paths(?:\/remove)?$/.exec(pathname);

export async function handleFolderTreeServer(req, res, url) {
  if (await handleSourceScopeServer(req, res, url)) return true;

  if (req.method === 'GET' && url.pathname === '/api/folder-tree') {
    json(res, 200, folderTree(url));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/import-roots') {
    json(res, 200, { roots:importRoots() });
    return true;
  }

  const match = sourcePathMatch(url.pathname);
  if (!match) return false;
  const importId = Number(match[1]);
  if (!db.prepare('SELECT 1 FROM imports WHERE id=?').get(importId)) {
    json(res, 404, { error:'Import not found' });
    return true;
  }

  if (req.method === 'GET' && !url.pathname.endsWith('/remove')) {
    const paths = db.prepare('SELECT original_path AS path FROM sources WHERE import_id=? ORDER BY id').all(importId).map(row => row.path);
    json(res, 200, { importId, paths });
    return true;
  }

  if (req.method === 'POST' && url.pathname.endsWith('/remove')) {
    const body = await readJson(req, 2 * 1024 * 1024);
    if (!Array.isArray(body.paths) || body.paths.length > 2000) {
      json(res, 400, { error:'paths must be an array of at most 2000 entries' });
      return true;
    }
    const remove = db.prepare('DELETE FROM sources WHERE import_id=? AND original_path=?');
    let count = 0;
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const path of body.paths) count += Number(remove.run(importId, String(path)).changes || 0);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    cachedVersion = '';
    json(res, 200, { ok:true, count });
    return true;
  }

  json(res, 405, { error:'Method not allowed' });
  return true;
}
