import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { api, json, pathKey, readJson, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { backupLocations } from './agent-backups.js';
import { browseRootKey } from './browse-folders.js';
import { mimeFor } from './mime.js';

const CONTROL = '.mochimono';
let cache = null;
let cacheGeneration = 0;

const cleanPath = value => String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
const lower = value => String(value || '').trim().toLocaleLowerCase();
const backupObjectPath = (root, hash) => join(root, CONTROL, 'objects', hash.slice(0, 2), hash);

function safeLocalPath(root, relativePath) {
  const base = resolve(root);
  const target = resolve(base, ...cleanPath(relativePath).split('/').filter(Boolean));
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  return targetKey === baseKey || targetKey.startsWith(`${baseKey}${sep}`) ? target : null;
}

async function fileStamp(path) {
  try {
    const info = await stat(path);
    return `${Math.trunc(info.mtimeMs)}:${info.size}`;
  } catch { return 'missing'; }
}

async function serverVersion() {
  try { return String((await api('/api/catalog/version')).version || ''); }
  catch { return 'offline'; }
}

async function backupRoots() {
  try { return (await backupLocations()).map(item => ({ path: item.path, meta: item.meta || {}, freeBytes: item.freeBytes || 0 })); }
  catch { return []; }
}

async function versionKey(roots = null) {
  const backups = roots || await backupRoots();
  const parts = [
    await serverVersion(),
    await fileStamp(SYNC_INDEX_PATH),
    await fileStamp(`${SYNC_INDEX_PATH}-wal`),
    settings.device,
    ...settings.folders.map(folder => `protected:${pathKey(folder.path)}`),
    ...settings.browseFolders.map(path => `browse:${pathKey(path)}`)
  ];
  for (const backup of backups) {
    parts.push(backup.path, await fileStamp(join(backup.path, CONTROL, 'catalog.sqlite')), await fileStamp(join(backup.path, CONTROL, 'inventory.sqlite')));
  }
  return parts.join('|');
}

async function serverSnapshot() {
  try {
    const [importsData, versionData, drivesData, stats] = await Promise.all([
      api('/api/imports'), api('/api/catalog/version'), api('/api/drives').catch(() => ({ drives: [] })), api('/api/stats').catch(() => null)
    ]);
    const files = [];
    let after = '';
    do {
      const page = await api(`/api/catalog?limit=5000&after=${encodeURIComponent(after)}`);
      files.push(...(page.files || []));
      after = page.nextAfter || '';
    } while (after);

    for (let offset = 0; offset < files.length; offset += 5000) {
      const batch = files.slice(offset, offset + 5000);
      try {
        const dates = await api('/api/file-dates', { method: 'POST', body: { hashes: batch.map(file => file.hash) } });
        const byHash = new Map((dates.dates || []).map(item => [item.hash, item]));
        for (const file of batch) Object.assign(file, byHash.get(file.hash) || {});
      } catch {}
    }
    return {
      online: true, version: String(versionData.version || ''), files,
      imports: importsData.imports || [], drives: drivesData.drives || [], stats
    };
  } catch {
    return { online: false, version: 'offline', files: [], imports: [], drives: [], stats: null };
  }
}

function openBackup(root) {
  const catalog = join(root, CONTROL, 'catalog.sqlite');
  const inventory = join(root, CONTROL, 'inventory.sqlite');
  if (!existsSync(catalog) || !existsSync(inventory)) return null;
  const db = new DatabaseSync(catalog, { readOnly: true, timeout: 5000 });
  db.exec(`ATTACH DATABASE '${inventory.replaceAll("'", "''")}' AS backup_inventory`);
  return db;
}

async function readBackupMeta(root) {
  try { return JSON.parse(await readFile(join(root, CONTROL, 'drive.json'), 'utf8')); }
  catch { return {}; }
}

function backupRows(root, meta) {
  const db = openBackup(root);
  if (!db) return { files: [], details: new Map(), candidates: new Map() };
  try {
    const files = db.prepare(`
      SELECT b.hash, b.size, b.verified_at AS verifiedAt,
             COALESCE(o.mime, 'application/octet-stream') AS mime,
             COALESCE(o.created_at, b.stored_at) AS createdAt,
             COALESCE(MIN(s.filename), b.hash) AS filename,
             COALESCE(MIN(s.original_path), '') AS originalPath,
             COALESCE(mm.captured_at, MIN(s.mtime), o.created_at, b.stored_at) AS fileDate,
             COALESCE(MAX(s.created_at), o.created_at, b.stored_at) AS addedAt,
             COALESCE(mm.source, CASE WHEN MIN(s.mtime) IS NOT NULL THEN 'filesystem.mtime' ELSE 'imported' END) AS dateSource,
             mm.captured_at AS capturedAt,
             COALESCE(t.width, 0) AS width, COALESCE(t.height, 0) AS height,
             EXISTS (SELECT 1 FROM reviewed_hashes rh WHERE rh.hash = b.hash) AS reviewed
      FROM backup_inventory.objects b
      LEFT JOIN objects o ON o.hash = b.hash
      LEFT JOIN sources s ON s.object_hash = b.hash
      LEFT JOIN media_metadata mm ON mm.object_hash = b.hash
      LEFT JOIN thumbnails t ON t.object_hash = b.hash
      GROUP BY b.hash, b.size, b.verified_at, o.mime, o.created_at, b.stored_at, mm.captured_at, mm.source, t.width, t.height
      ORDER BY b.hash
    `).all();
    const sources = db.prepare(`
      SELECT s.object_hash AS hash, s.original_path AS path, s.filename, s.mtime,
             i.source_name AS sourceName, i.created_at AS importedAt,
             COALESCE(ir.device_name, i.source_name) AS deviceName, COALESCE(ir.root_path, '') AS rootPath
      FROM sources s
      JOIN imports i ON i.id = s.import_id
      JOIN backup_inventory.objects b ON b.hash = s.object_hash
      LEFT JOIN import_roots ir ON ir.import_id = i.id
      ORDER BY s.object_hash, i.id, s.original_path
    `).all();
    const details = new Map();
    for (const source of sources) {
      if (!details.has(source.hash)) details.set(source.hash, []);
      details.get(source.hash).push(source);
    }
    const candidates = new Map(files.map(file => [file.hash, {
      kind: 'backup', path: backupObjectPath(root, file.hash), size: Number(file.size) || 0,
      mime: file.mime, name: meta.name || basename(root), root, verifiedAt: file.verifiedAt || null
    }]));
    return { files, details, candidates };
  } finally { db.close(); }
}

function localRows() {
  const protectedRoots = settings.folders.map(folder => ({
    key: pathKey(folder.path), path: folder.path, protected: true, name: basename(folder.path) || folder.path
  }));
  const browseRoots = settings.browseFolders.map(path => ({
    key: browseRootKey(path), path, protected: false, name: basename(path) || path
  }));
  const roots = [...protectedRoots, ...browseRoots];
  if (!roots.length || !existsSync(SYNC_INDEX_PATH)) return { rows: [], roots };
  const byKey = new Map(roots.map(root => [root.key, root]));
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly: true, timeout: 5000 });
  try {
    const rows = db.prepare('SELECT root, path, size, mtime_ms AS mtimeMs, hash FROM file_hashes ORDER BY root, path').all()
      .map(row => ({ ...row, provider: byKey.get(row.root) }))
      .filter(row => row.provider);
    return { rows, roots };
  } finally { db.close(); }
}

function cleanRelativePath(value) {
  const parts = cleanPath(value).split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw Object.assign(new Error('Invalid folder path'), { status: 400 });
  return parts.join('/');
}

function foldersForSource(sourceRows, source, path) {
  const clean = cleanRelativePath(path);
  const prefix = clean ? `${clean}/` : '';
  const folders = new Map();
  const files = [];
  for (const row of sourceRows || []) {
    const original = cleanPath(row.originalPath || row.path);
    if (!original.startsWith(prefix)) continue;
    const rest = original.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const name = rest.slice(0, slash);
      folders.set(name, (folders.get(name) || 0) + 1);
    } else files.push({
      hash: row.hash, size: Number(row.size) || 0, mime: row.mime || 'application/octet-stream',
      createdAt: row.createdAt, filename: row.filename || basename(original), originalPath: original,
      mtime: row.mtime || row.fileDate, reviewed: Boolean(row.reviewed), backupCount: Number(row.backupCount) || 0,
      serverStored: Boolean(row.serverStored)
    });
  }
  return {
    source, path: clean,
    folders: [...folders].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, files: count })),
    files: files.sort((a, b) => String(a.filename).localeCompare(String(b.filename)))
  };
}

function mergeFolderResponses(primary, extra) {
  if (!primary) return extra;
  const folders = new Map();
  for (const folder of [...(primary.folders || []), ...(extra.folders || [])]) folders.set(folder.name, (folders.get(folder.name) || 0) + Number(folder.files || 0));
  const files = new Map();
  for (const file of [...(primary.files || []), ...(extra.files || [])]) files.set(`${file.hash}:${file.originalPath || file.filename}`, file);
  return {
    source: primary.source || extra.source, path: primary.path || extra.path || '',
    folders: [...folders].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, files: count })),
    files: [...files.values()].sort((a, b) => String(a.filename).localeCompare(String(b.filename)))
  };
}

async function buildSnapshot(roots) {
  const server = await serverSnapshot();
  const files = new Map();
  const importRows = new Map();
  const sourceRows = new Map();
  const candidates = new Map();
  const details = new Map();
  const backupNames = new Map();
  const backupFiles = new Map();
  let synthetic = -1;

  const serverImportByName = new Map(server.imports.map(item => [lower(item.sourceName), Number(item.id)]));
  for (const item of server.imports) importRows.set(Number(item.id), { ...item, id: Number(item.id) });

  const syntheticImport = (key, name, createdAt = '') => {
    if (importRows.has(key)) return importRows.get(key).id;
    const id = synthetic--;
    const item = { id, sourceName: String(name || 'Source'), createdAt: createdAt || new Date(0).toISOString(), files: 0, referencedBytes: 0, providerKey: key };
    importRows.set(key, item);
    return id;
  };

  const addSourceRow = (importId, row) => {
    if (!sourceRows.has(importId)) sourceRows.set(importId, []);
    sourceRows.get(importId).push(row);
  };

  const ensureFile = raw => {
    const existing = files.get(raw.hash);
    if (existing) return existing;
    const file = {
      hash: String(raw.hash), size: Number(raw.size) || 0, mime: raw.mime || 'application/octet-stream',
      createdAt: raw.createdAt || raw.fileDate || new Date(0).toISOString(), filename: raw.filename || raw.hash,
      originalPath: raw.originalPath || '', fileDate: raw.fileDate || raw.createdAt || new Date(0).toISOString(),
      addedAt: raw.addedAt || raw.createdAt || raw.fileDate || new Date(0).toISOString(), dateSource: raw.dateSource || 'imported',
      capturedAt: raw.capturedAt || null, width: Number(raw.width) || 0, height: Number(raw.height) || 0,
      importIds: [], exactImportIds: [], searchText: String(raw.searchText || ''), reviewed: Boolean(raw.reviewed),
      backupCount: Number(raw.backupCount) || 0, serverStored: Boolean(raw.serverStored)
    };
    files.set(file.hash, file);
    return file;
  };

  for (const raw of server.files) {
    const file = ensureFile({ ...raw, serverStored: true });
    file.serverStored = true;
    file.importIds = Array.isArray(raw.importIds) ? raw.importIds.map(Number) : String(raw.importIds || '').split(',').map(Number).filter(Boolean);
    file.exactImportIds = Array.isArray(raw.exactImportIds) ? raw.exactImportIds.map(Number) : String(raw.exactImportIds || '').split(',').map(Number).filter(Boolean);
  }

  for (const backup of roots) {
    const meta = Object.keys(backup.meta || {}).length ? backup.meta : await readBackupMeta(backup.path);
    const data = backupRows(backup.path, meta);
    const backupId = String(meta.id || backup.path);
    backupNames.set(backupId, { id: backupId, name: meta.name || basename(backup.path), path: backup.path, lastSeen: meta.lastBackupAt || null });
    const hashes = new Set();
    backupFiles.set(backupId, hashes);
    for (const raw of data.files) {
      hashes.add(raw.hash);
      const file = ensureFile({ ...raw, serverStored: false });
      if (!file.width && raw.width) { file.width = Number(raw.width); file.height = Number(raw.height); }
      const backupSources = data.details.get(raw.hash) || [];
      if (backupSources.length) {
        file.searchText = `${file.searchText} ${backupSources.map(source => `${source.filename} ${source.path} ${source.sourceName} ${source.rootPath}`).join(' ')}`.trim();
        for (const source of backupSources) {
          const matched = serverImportByName.get(lower(source.sourceName));
          const importId = matched || syntheticImport(`backup-source:${lower(source.sourceName)}`, source.sourceName, source.importedAt);
          if (!file.importIds.includes(importId)) file.importIds.push(importId);
          addSourceRow(importId, { ...source, hash: raw.hash, size: raw.size, mime: raw.mime, createdAt: raw.createdAt, fileDate: raw.fileDate, reviewed: raw.reviewed, backupCount: file.backupCount, serverStored: file.serverStored, originalPath: source.path });
        }
      }
      if (!candidates.has(raw.hash)) candidates.set(raw.hash, []);
      candidates.get(raw.hash).push(data.candidates.get(raw.hash));
      const item = details.get(raw.hash) || { sources: [], backups: [] };
      item.sources.push(...backupSources);
      item.backups.push({ id: backupId, name: meta.name || basename(backup.path), lastSeen: meta.lastBackupAt || null, verifiedAt: raw.verifiedAt || meta.lastVerifiedAt || null });
      details.set(raw.hash, item);
    }
  }

  const local = localRows();
  for (const row of local.rows) {
    const provider = row.provider;
    const full = safeLocalPath(provider.path, row.path);
    const date = new Date(Number(row.mtimeMs) || 0).toISOString();
    const file = ensureFile({
      hash: row.hash, size: row.size, mime: mimeFor(row.path), filename: basename(row.path), originalPath: row.path,
      createdAt: date, fileDate: date, addedAt: date, dateSource: 'filesystem.mtime', serverStored: false
    });
    const shouldAddSource = !provider.protected || !file.serverStored;
    if (shouldAddSource) {
      const importId = syntheticImport(`local:${provider.key}`, provider.name, date);
      if (!file.importIds.includes(importId)) file.importIds.push(importId);
      const source = {
        hash: row.hash, path: row.path, originalPath: row.path, filename: basename(row.path), mtime: date,
        sourceName: provider.name, importedAt: null, deviceName: settings.device, rootPath: provider.path,
        size: row.size, mime: file.mime, createdAt: date, fileDate: date, reviewed: file.reviewed,
        backupCount: file.backupCount, serverStored: file.serverStored
      };
      addSourceRow(importId, source);
      const item = details.get(row.hash) || { sources: [], backups: [] };
      item.sources.push(source);
      details.set(row.hash, item);
    }
    file.searchText = `${file.searchText} ${provider.name} ${provider.path} ${row.path}`.trim();
    if (full) {
      if (!candidates.has(row.hash)) candidates.set(row.hash, []);
      candidates.get(row.hash).unshift({ kind: 'local', path: full, size: Number(row.size) || 0, mime: file.mime, name: provider.name, root: provider.path, protected: provider.protected });
    }
  }

  for (const [key, item] of importRows) {
    if (typeof key === 'number') continue;
    const rows = sourceRows.get(item.id) || [];
    item.files = new Set(rows.map(row => row.hash)).size;
    item.referencedBytes = [...new Map(rows.map(row => [row.hash, Number(row.size) || 0])).values()].reduce((sum, size) => sum + size, 0);
  }

  for (const [hash, item] of details) {
    const file = files.get(hash);
    if (file) file.backupCount = Math.max(file.backupCount, new Set(item.backups.map(backup => backup.id)).size);
  }

  const ordered = [...files.values()].sort((a, b) => a.hash.localeCompare(b.hash));
  const byHash = new Map(ordered.map(file => [file.hash, file]));
  return {
    version: [server.version, ordered.length, roots.length, local.rows.length].join(':'),
    serverOnline: server.online, serverStats: server.stats, serverDrives: server.drives,
    files: ordered, byHash,
    imports: [...importRows.values()].filter(item => Number(item.files) > 0).sort((a, b) => Number(b.id) - Number(a.id)),
    sourceRows, candidates, details,
    backups: [...backupNames.values()], backupFiles
  };
}

export function invalidateClientProviders() {
  cacheGeneration++;
  cache = null;
}

export async function clientProviders() {
  for (;;) {
    const generation = cacheGeneration;
    const roots = await backupRoots();
    const key = await versionKey(roots);
    if (cache?.generation === generation && cache.key === key) return cache.data;

    const data = await buildSnapshot(roots);
    if (generation !== cacheGeneration) continue;

    const currentKey = await versionKey(roots);
    if (generation !== cacheGeneration || currentKey !== key) continue;

    data.version = key;
    cache = { generation, key, data };
    return data;
  }
}

export async function providerCandidate(hash) {
  const snapshot = await clientProviders();
  for (const candidate of snapshot.candidates.get(String(hash)) || []) {
    try {
      const info = await stat(candidate.path);
      if (info.isFile() && Number(info.size) === Number(candidate.size)) return candidate;
    } catch {}
  }
  return null;
}

export async function providerDetails(hash) {
  const snapshot = await clientProviders();
  const file = snapshot.byHash.get(String(hash));
  if (!file) return null;
  const extra = snapshot.details.get(file.hash) || { sources: [], backups: [] };
  return {
    object: { hash: file.hash, size: file.size, mime: file.mime, createdAt: file.createdAt, filename: file.filename },
    sources: extra.sources,
    backups: extra.backups,
    date: { hash: file.hash, fileDate: file.fileDate, dateSource: file.dateSource, capturedAt: file.capturedAt || null },
    serverStored: file.serverStored
  };
}

async function servePath(req, res, candidate) {
  const info = await stat(candidate.path);
  const headers = { 'content-type': candidate.mime || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  const range = String(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': info.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(candidate.path).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); return res.end(); }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : info.size - 1;
  if (!match[1] && match[2]) { start = Math.max(0, info.size - Number(match[2])); end = info.size - 1; }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= info.size) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` }); return res.end();
  }
  end = Math.min(end, info.size - 1);
  res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  createReadStream(candidate.path, { start, end }).pipe(res);
}

export async function handleClientProviderApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const snapshot = await clientProviders();
    json(res, 200, { ok: true, serverOnline: snapshot.serverOnline });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const snapshot = await clientProviders();
    const bytes = snapshot.files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    json(res, 200, snapshot.serverStats || { objects: snapshot.files.length, bytes, capacityBytes: 0, freeBytes: 0, sources: snapshot.imports.length, ignored: 0, unreviewed: 0, unbacked: 0, drives: snapshot.backups.length });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog/version') {
    json(res, 200, { version: (await clientProviders()).version });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    const snapshot = await clientProviders();
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 5000)));
    const start = after ? snapshot.files.findIndex(file => file.hash > after) : 0;
    const safeStart = start < 0 ? snapshot.files.length : start;
    const files = snapshot.files.slice(safeStart, safeStart + limit);
    json(res, 200, { files, nextAfter: files.length === limit ? files.at(-1).hash : null, version: snapshot.version });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/imports') {
    json(res, 200, { imports: (await clientProviders()).imports });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/client/server-hashes') {
    const snapshot = await clientProviders();
    json(res, 200, { hashes: snapshot.files.filter(file => file.serverStored).map(file => file.hash) });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/drives') {
    const snapshot = await clientProviders();
    const drives = new Map((snapshot.serverDrives || []).map(drive => [String(drive.id), drive]));
    for (const backup of snapshot.backups) if (!drives.has(String(backup.id))) {
      const count = snapshot.backupFiles.get(String(backup.id))?.size || 0;
      drives.set(String(backup.id), { id: backup.id, name: backup.name, lastSeen: backup.lastSeen, desiredCount: count, protectedCount: count, desiredBytes: 0, protectedBytes: 0, policy: { all: true } });
    }
    json(res, 200, { drives: [...drives.values()] });
    return true;
  }
  const driveFiles = /^\/api\/drives\/([^/]+)\/files$/.exec(url.pathname);
  if (driveFiles && req.method === 'GET') {
    const snapshot = await clientProviders();
    const id = decodeURIComponent(driveFiles[1]);
    const hashes = [...(snapshot.backupFiles.get(id) || [])].sort();
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 5000)));
    const start = after ? hashes.findIndex(hash => hash > after) : 0;
    const safeStart = start < 0 ? hashes.length : start;
    const page = hashes.slice(safeStart, safeStart + limit).map(hash => ({ hash, verifiedAt: (snapshot.details.get(hash)?.backups || []).find(backup => String(backup.id) === id)?.verifiedAt || null }));
    json(res, 200, { files: page, nextAfter: page.length === limit ? page.at(-1).hash : null });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/file-dates') {
    const body = await readJson(req, 512 * 1024);
    const hashes = Array.isArray(body.hashes) ? body.hashes.map(String).slice(0, 5000) : [];
    const snapshot = await clientProviders();
    json(res, 200, { dates: hashes.map(hash => snapshot.byHash.get(hash)).filter(Boolean).map(file => ({
      hash: file.hash, fileDate: file.fileDate, dateSource: file.dateSource, capturedAt: file.capturedAt || null
    })) });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/folders') {
    const importId = Number(url.searchParams.get('import'));
    const snapshot = await clientProviders();
    const source = snapshot.imports.find(item => Number(item.id) === importId);
    if (!source) { json(res, 404, { error: 'Source not found' }); return true; }
    const provider = foldersForSource(snapshot.sourceRows.get(importId), source, url.searchParams.get('path'));
    if (importId >= 1 && snapshot.serverOnline) {
      let server = null;
      try { server = await api(`/api/folders?import=${encodeURIComponent(importId)}&path=${encodeURIComponent(url.searchParams.get('path') || '')}`); } catch {}
      json(res, 200, mergeFolderResponses(server, provider));
    } else json(res, 200, provider);
    return true;
  }
  const provenance = /^\/api\/provenance\/([a-f0-9]{64})$/.exec(url.pathname);
  if (provenance && req.method === 'GET') {
    const snapshot = await clientProviders();
    const file = snapshot.byHash.get(provenance[1]);
    if (file?.serverStored && snapshot.serverOnline) return false;
    const data = await providerDetails(provenance[1]);
    json(res, data ? 200 : 404, data || { error: 'File not found' });
    return true;
  }
  const deleteMatch = /^\/api\/objects\/([a-f0-9]{64})\/delete$/.exec(url.pathname);
  if (deleteMatch && req.method === 'POST') {
    const snapshot = await clientProviders();
    const file = snapshot.byHash.get(deleteMatch[1]);
    if (file && !file.serverStored) {
      json(res, 409, { error: 'This file is only in a local folder or backup. Delete it from that location directly.' });
      return true;
    }
    return false;
  }
  const object = /^\/api\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
  if (object && (req.method === 'GET' || req.method === 'HEAD')) {
    const candidate = await providerCandidate(object[1]);
    if (!candidate) return false;
    await servePath(req, res, candidate);
    return true;
  }
  return false;
}
