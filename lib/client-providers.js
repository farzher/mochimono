import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { api, json, pathKey, readJson, serverState, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { browseRootKey } from './browse-folders.js';
import { localDisplayDate } from './local-date.js';
import { isSourceExcluded } from './source-exclusions.js';
import { mimeFor } from './mime.js';
import { localCandidate } from './local-locations.js';
import { syncIndexRevision } from './sync-index.js';

const CONTROL = '.mochimono';
const CACHE_VALID_MS = 2000;
const PROVIDER_CATALOG_VERSION = 1;
const snapshots = new Map();
const builds = new Map();
let cacheGeneration = 0;
let serverCache = null;
let serverBuildPromise = null;

const cleanPath = value => String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
const lower = value => String(value || '').trim().toLocaleLowerCase();
const backupObjectPath = (root, hash) => join(root, CONTROL, 'objects', hash.slice(0, 2), hash);

function pageStart(items, after, hashFor) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (hashFor(items[mid]) <= after) low = mid + 1;
    else high = mid;
  }
  return low;
}

function safeLocalPath(root, relativePath) {
  const base = resolve(root);
  const target = resolve(base, ...cleanPath(relativePath).split('/').filter(Boolean));
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  const prefix = baseKey.endsWith(sep) ? baseKey : `${baseKey}${sep}`;
  return targetKey === baseKey || targetKey.startsWith(prefix) ? target : null;
}

async function fileStamp(path) {
  try {
    const info = await stat(path);
    return `${Math.trunc(info.mtimeMs)}:${info.size}`;
  } catch { return 'missing'; }
}

async function serverVersion() {
  try { return String((await api('/api/catalog/version', { signal:AbortSignal.timeout(1500) })).version || ''); }
  catch { return 'offline'; }
}

function backupRoots() {
  return settings.backups
    .filter(path => existsSync(join(path, CONTROL, 'catalog.sqlite')) && existsSync(join(path, CONTROL, 'inventory.sqlite')))
    .map(path => ({ path, meta: {}, freeBytes: 0 }));
}

async function versionKey(roots = null, remoteOnly = false) {
  const backups = roots || await backupRoots();
  const parts = [
    `provider:${PROVIDER_CATALOG_VERSION}`,
    await serverVersion(),
    settings.device,
    ...(!remoteOnly ? [
      `local:r${syncIndexRevision(SYNC_INDEX_PATH)}`,
      ...settings.folders.map(folder => `protected:${pathKey(folder.path)}`),
      ...settings.browseFolders.map(path => `browse:${pathKey(path)}`)
    ] : [])
  ];
  for (const backup of backups) {
    parts.push(backup.path, await fileStamp(join(backup.path, CONTROL, 'catalog.sqlite')), await fileStamp(join(backup.path, CONTROL, 'inventory.sqlite')));
  }
  return parts.join('|');
}

async function serverSnapshot() {
  const version = await serverVersion();
  const key = `${settings.server}\0${settings.token}\0${version}`;
  if (serverCache?.key === key) return serverCache.data;
  if (serverBuildPromise) return serverBuildPromise;
  const pending = readServerSnapshot();
  serverBuildPromise = pending;
  try {
    const data = await pending;
    if (data.online || version === 'offline') serverCache = { key, data };
    return data;
  } finally { if (serverBuildPromise === pending) serverBuildPromise = null; }
}

async function readServerSnapshot() {
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
    const rows = db.prepare(`
      SELECT root, path, size, mtime_ms AS mtimeMs,
             id, content_hash AS contentHash,
             COALESCE(NULLIF(content_hash,''), id) AS hash
      FROM files
      ORDER BY root, path
    `).all()
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

async function buildSnapshot(roots, remoteOnly = false) {
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
    if (file.dateSource === 'filesystem.unknown') file.createdAt = file.fileDate = file.addedAt = null;
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

  const local = remoteOnly ? { rows:[], roots:[] } : localRows();
  for (const row of local.rows) {
    const provider = row.provider;
    if (isSourceExcluded(provider.path, row.path)) continue;
    const full = safeLocalPath(provider.path, row.path);
    const timeline = localDisplayDate(row.path, row.mtimeMs);
    const date = timeline.ms ? new Date(timeline.ms).toISOString() : null;
    const modified = row.mtimeMs ? new Date(Number(row.mtimeMs)).toISOString() : null;
    const file = ensureFile({
      hash: row.hash, size: row.size, mime: mimeFor(row.path), filename: basename(row.path), originalPath: row.path,
      createdAt: date, fileDate: date, addedAt: date, dateSource: timeline.source, serverStored: false
    });
    const shouldAddSource = !provider.protected || !file.serverStored;
    if (shouldAddSource) {
      const sourceName = String(settings.device || 'This device');
      const importId = serverImportByName.get(lower(sourceName)) || syntheticImport(`local-device:${lower(sourceName)}`, sourceName, date);
      if (!file.importIds.includes(importId)) file.importIds.push(importId);
      const source = {
        hash: row.hash, path: row.path, originalPath: row.path, filename: basename(row.path), mtime: modified,
        sourceName, importedAt: null, deviceName: sourceName, rootPath: provider.path,
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
      candidates.get(row.hash).unshift({ kind: 'local', path: full, size: Number(row.size) || 0, mtimeMs:Number(row.mtimeMs), mime: file.mime, name: provider.name, root: provider.path, protected: provider.protected });
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
  snapshots.clear();
}

async function buildProviders(remoteOnly) {
  const generation = cacheGeneration;
  const roots = backupRoots();
  const key = await versionKey(roots, remoteOnly);
  const cache = snapshots.get(remoteOnly);
  if (cache?.generation === generation && cache.key === key) {
    cache.checkedAt = Date.now();
    return cache.data;
  }
  const data = await buildSnapshot(roots, remoteOnly);
  data.version = key;
  if (generation === cacheGeneration) snapshots.set(remoteOnly, { generation, key, data, checkedAt:Date.now() });
  return data;
}

export async function clientProviders(remoteOnly = false) {
  const cache = snapshots.get(remoteOnly);
  if (cache && Date.now() - cache.checkedAt < CACHE_VALID_MS) return cache.data;
  if (builds.has(remoteOnly)) return builds.get(remoteOnly);
  const pending = buildProviders(remoteOnly);
  builds.set(remoteOnly, pending);
  try { return await pending; }
  finally { if (builds.get(remoteOnly) === pending) builds.delete(remoteOnly); }
}

export async function clientProviderVersion(remoteOnly = false) {
  const cache = snapshots.get(remoteOnly);
  if (cache && Date.now() - cache.checkedAt < CACHE_VALID_MS) return cache.data.version;
  return versionKey(backupRoots(), remoteOnly);
}

export async function providerCandidate(hash) {
  const local = localCandidate(hash);
  if (local) {
    const info = await stat(local.path).catch(() => null);
    if (info?.isFile() && info.size === local.size && (!Number.isFinite(local.mtimeMs) || Math.trunc(info.mtimeMs) === local.mtimeMs)) return local;
  }
  const snapshot = await clientProviders(true);
  for (const candidate of snapshot.candidates.get(String(hash)) || []) {
    try {
      const info = await stat(candidate.path);
      if (info.isFile() && Number(info.size) === Number(candidate.size) &&
          (!Number.isFinite(candidate.mtimeMs) || Math.trunc(info.mtimeMs) === candidate.mtimeMs)) return candidate;
    } catch {}
  }
  return null;
}

export async function providerDetails(hash) {
  let remote = null;
  if ((await serverState()).online) {
    remote = await api(`/api/provenance/${hash}`, { signal:AbortSignal.timeout(2000) }).catch(() => null);
  }
  const sources = [...(remote?.sources || [])];
  const backups = [...(remote?.backups || [])];
  let object = remote?.object || null;
  let date = remote?.date || null;
  const roots = new Map([
    ...settings.folders.map(folder => [pathKey(folder.path), folder.path]),
    ...settings.browseFolders.map(path => [browseRootKey(path), path])
  ]);
  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1000 });
    try {
      const rows = db.prepare(`SELECT root,path,size,mtime_ms AS mtimeMs FROM files
        WHERE id=? OR (content_hash<>'' AND content_hash=?) LIMIT 200`).all(hash,hash);
      for (const row of rows) {
        const rootPath = roots.get(row.root);
        if (!rootPath || isSourceExcluded(rootPath,row.path)) continue;
        const timeline = localDisplayDate(row.path,row.mtimeMs);
        const fileDate = timeline.ms ? new Date(timeline.ms).toISOString() : null;
        object ||= { hash,size:row.size,mime:mimeFor(row.path),filename:basename(row.path),createdAt:fileDate };
        date ||= { hash,fileDate,dateSource:timeline.source,capturedAt:null };
        if (!sources.some(source => source.rootPath === rootPath && (source.path || source.originalPath) === row.path)) {
          sources.push({ hash,path:row.path,originalPath:row.path,filename:basename(row.path),
            mtime:new Date(row.mtimeMs).toISOString(),sourceName:settings.device,deviceName:settings.device,rootPath });
        }
      }
    } finally { db.close(); }
  }
  for (const root of settings.backups) {
    const db = openBackup(root);
    if (!db) continue;
    try {
      const row = db.prepare(`SELECT b.size,b.verified_at AS verifiedAt,o.mime,o.created_at AS createdAt
        FROM backup_inventory.objects b LEFT JOIN objects o ON o.hash=b.hash WHERE b.hash=?`).get(hash);
      if (!row) continue;
      const info = await stat(backupObjectPath(root,hash)).catch(() => null);
      if (!info?.isFile() || info.size !== row.size) continue;
      const meta = await readBackupMeta(root);
      object ||= { hash,size:row.size,mime:row.mime || 'application/octet-stream',createdAt:row.createdAt,filename:hash };
      if (!backups.some(backup => backup.id === meta.id)) backups.push({ id:meta.id,name:meta.name || basename(root),verifiedAt:row.verifiedAt });
    } finally { db.close(); }
  }
  return object ? { ...remote,object,sources,backups,date,serverStored:remote?.serverStored === true } : null;
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
    const server = await serverState();
    if (server.online) json(res, 200, server.stats);
    else {
      let totals = { objects:0, bytes:0 };
      if (existsSync(SYNC_INDEX_PATH)) {
        const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true });
        try { totals = db.prepare('SELECT COUNT(*) AS objects, COALESCE(SUM(size),0) AS bytes FROM files').get(); }
        finally { db.close(); }
      }
      json(res, 200, { ...totals, capacityBytes:0, freeBytes:0, sources:settings.folders.length+settings.browseFolders.length, ignored:0, unreviewed:0, unbacked:0, drives:settings.backups.length });
    }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog/version') {
    json(res, 200, { version: await clientProviderVersion(url.searchParams.get('remote') === '1') });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    const snapshot = await clientProviders(url.searchParams.get('remote') === '1');
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 5000)));
    const safeStart = after ? pageStart(snapshot.files, after, file => file.hash) : 0;
    const files = snapshot.files.slice(safeStart, safeStart + limit);
    json(res, 200, { files, nextAfter: files.length === limit ? files.at(-1).hash : null, version: snapshot.version });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/imports') {
    json(res, 200, { imports: (await clientProviders(url.searchParams.get('remote') === '1')).imports });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/client/server-hashes') {
    const snapshot = await clientProviders(true);
    json(res, 200, { hashes: snapshot.files.filter(file => file.serverStored).map(file => file.hash) });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/drives') {
    const snapshot = await clientProviders();
    const drives = new Map((snapshot.serverDrives || []).map(drive => [String(drive.id), drive]));
    for (const backup of snapshot.backups) if (!drives.has(String(backup.id))) {
      const hashes = [...(snapshot.backupFiles.get(String(backup.id)) || [])];
      let storedBytes = 0;
      const verified = [];
      for (const hash of hashes) {
        storedBytes += Number(snapshot.byHash.get(hash)?.size) || 0;
        const verifiedAt = (snapshot.details.get(hash)?.backups || []).find(item => String(item.id) === String(backup.id))?.verifiedAt;
        if (verifiedAt) verified.push(String(verifiedAt));
      }
      verified.sort();
      drives.set(String(backup.id), {
        id:backup.id,
        name:backup.name,
        lastSeen:backup.lastSeen || null,
        storedCount:hashes.length,
        storedBytes,
        verifiedCount:verified.length,
        oldestVerifiedAt:verified[0] || null,
        lastVerifiedAt:verified.at(-1) || null
      });
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
    const safeStart = after ? pageStart(hashes, after, hash => hash) : 0;
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