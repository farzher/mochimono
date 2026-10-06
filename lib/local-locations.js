import { createHash } from 'node:crypto';
import { existsSync, statfsSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { CONFIG_DIR, pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { backupThumbnailCandidates } from './backup-thumb-candidates.js';
import { browseStageByHashes, browseStageRows } from './browse-staging.js';
import { localDisplayDate } from './local-date.js';
import { isSourceExcluded } from './source-exclusions.js';
import { mimeFor } from './mime.js';
import { syncIndexRevision } from './sync-index.js';

const MEDIA_EXTENSIONS = [
  'jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff',
  'mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp'
];
const MEDIA_PATH_SQL = `(${MEDIA_EXTENSIONS.map(() => 'lower(path) LIKE ?').join(' OR ')}) AND lower(path) NOT LIKE '%.d.mts'`;
const MEDIA_PATH_ARGS = MEDIA_EXTENSIONS.map(extension => `%.${extension}`);
const CACHE_STATS_PATH = '@mochimono:cache';
const CACHE_STATS_TTL = 5 * 60_000;

const configuredPath = value => {
  const raw = typeof value === 'string' ? value : value?.path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
};
const browseRootKey = root => `browse:${pathKey(root)}`;
const locationId = root => `local:${createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 16)}`;
const catalogHashSql = "COALESCE(NULLIF(content_hash,''), id)";
let sampleCacheKey = '';
let sampleCacheAt = 0;
let sampleCache = [];
let cacheStatsAt = 0;
let cacheStatsBytes = 0;
let cacheStatsFiles = 0;
let cacheStatsWorker = null;

process.on('mochimono:preview-cache-changed', () => {
  cacheStatsAt = 0;
});

function localFolders() {
  const protectedFolders = (settings.folders || [])
    .map(folder => {
      const path=configuredPath(folder);
      return path ? { path, rootKey:pathKey(path), protected:true, importId:Number(folder?.importId)||0 } : null;
    })
    .filter(Boolean);
  const browseFolders = (settings.browseFolders || [])
    .map(path => configuredPath(path))
    .filter(Boolean)
    .map(path => ({ path, rootKey:browseRootKey(path), protected:false }));
  return [...protectedFolders, ...browseFolders].map(folder => ({
    id:locationId(folder.path),
    kind:'local',
    name:basename(folder.path) || folder.path,
    deviceName:settings.device,
    rootPath:folder.path,
    available:existsSync(folder.path),
    protected:folder.protected,
    importId:Number(folder.importId)||0,
    rootKey:folder.rootKey
  }));
}

function refreshCacheBytes() {
  if (cacheStatsWorker || (cacheStatsAt && Date.now() - cacheStatsAt < CACHE_STATS_TTL)) return;
  const worker = new Worker(new URL('./cache-stats-worker.js', import.meta.url), { workerData:{ root:CONFIG_DIR } });
  cacheStatsWorker = worker;
  worker.once('message', value => {
    cacheStatsBytes = Number(value?.bytes) || 0;
    cacheStatsFiles = Number(value?.files) || 0;
    cacheStatsAt = Date.now();
  });
  worker.once('error', () => {});
  worker.once('exit', () => {
    if (cacheStatsWorker === worker) cacheStatsWorker = null;
  });
}

function localCacheStats() {
  refreshCacheBytes();

  let indexedFiles = 0;
  if (existsSync(SYNC_INDEX_PATH)) {
    let db;
    try {
      db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1500 });
      indexedFiles = Number(db.prepare('SELECT COUNT(*) AS count FROM files').get()?.count) || 0;
    } catch {
    } finally {
      try { db?.close(); } catch {}
    }
  }

  let capacityBytes = 0;
  let freeBytes = 0;
  try {
    const fs = statfsSync(CONFIG_DIR);
    capacityBytes = Number(fs.blocks) * Number(fs.bsize);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {}

  return {
    path:CONFIG_DIR,
    bytes:cacheStatsBytes,
    cacheFiles:cacheStatsFiles,
    indexedFiles,
    capacityBytes,
    freeBytes,
    scanning:Boolean(cacheStatsWorker),
    measuredAt:cacheStatsAt ? new Date(cacheStatsAt).toISOString() : null
  };
}

function safeLocalPath(root, relativePath) {
  if (typeof root !== 'string' || !root.trim()) return null;
  if (typeof relativePath !== 'string' || !relativePath.trim()) return null;
  let base;
  let target;
  try {
    base = resolve(root);
    target = resolve(base, ...relativePath.replaceAll('\\', '/').split('/').filter(Boolean));
  } catch {
    return null;
  }
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  const prefix = baseKey.endsWith(sep) ? baseKey : `${baseKey}${sep}`;
  return targetKey === baseKey || targetKey.startsWith(prefix) ? target : null;
}

function candidateFor(row, folder) {
  const root = folder?.rootPath || folder?.path || '';
  if (!row || !folder || folder.available === false || !root || !row.path || !row.hash) return null;
  const path = safeLocalPath(root, row.path);
  if (!path) return null;
  return {
    kind:'local',
    hash:String(row.hash),
    path,
    size:Number(row.size) || 0,
    mtimeMs:Number(row.mtimeMs),
    mime:mimeFor(row.path),
    filename:basename(row.path),
    root,
    protected:folder.protected
  };
}

export function localLocations(hash = '') {
  const folders = localFolders();
  if (!folders.length) return { locations:[], files:[] };

  const byRoot = new Map(folders.map(folder => [folder.rootKey, folder]));
  const rows = hash ? browseStageByHashes([hash]) : browseStageRows(4000);
  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:5000 });
    try {
      if (hash) {
        rows.push(...db.prepare(`
          SELECT root,path,? AS hash
          FROM files
          WHERE (content_hash <> '' AND content_hash = ?) OR id = ?
        `).all(String(hash), String(hash), String(hash)));
      } else {
        const query = db.prepare(`
          SELECT root,path,${catalogHashSql} AS hash
          FROM files
          ORDER BY root,path
        `);
        for (const row of query.iterate()) rows.push(row);
      }
    } finally {
      db.close();
    }
  }

  const seen = new Set();
  return {
    locations:folders.map(({ rootKey, ...item }) => item),
    files:rows.map(row => {
      const location = byRoot.get(row.root);
      if (!location || location.available === false) return null;
      const key = `${row.hash}\u0000${location.id}\u0000${row.path}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return [row.hash, location.id, row.path];
    }).filter(Boolean)
  };
}

export function localCandidates(hashes) {
  const wanted = [...new Set((hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  const result = new Map();
  if (!wanted.length) return result;
  const folders = localFolders();
  const byRoot = new Map(folders.map(folder => [folder.rootKey, folder]));

  for (const row of browseStageByHashes(wanted)) {
    const folder = byRoot.get(row.root);
    const candidate = folder && candidateFor(row, folder);
    if (candidate) result.set(candidate.hash, candidate);
  }

  if (!existsSync(SYNC_INDEX_PATH) || result.size === wanted.length) return result;
  const unresolved = wanted.filter(hash => !result.has(hash));
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1500 });
  try {
    for (let offset = 0; offset < unresolved.length; offset += 400) {
      const chunk = unresolved.slice(offset, offset + 400);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT root,path,size,mtime_ms AS mtimeMs,id,content_hash AS contentHash
        FROM files
        WHERE (content_hash <> '' AND content_hash IN (${placeholders})) OR id IN (${placeholders})
        ORDER BY root,path
      `).all(...chunk, ...chunk);
      const wantedSet = new Set(wanted);
      for (const row of rows) {
        const folder = byRoot.get(row.root);
        for (const hash of new Set([row.id, row.contentHash])) {
          if (!hash || !wantedSet.has(hash) || result.has(hash)) continue;
          const candidate = folder && candidateFor({ ...row, hash }, folder);
          if (candidate) result.set(hash, candidate);
        }
      }
    }
  } finally {
    db.close();
  }
  return result;
}

export function localCandidate(hash) {
  const wanted = String(hash || '');
  const local = localCandidates([wanted]).get(wanted);
  if (local) return local;
  return backupThumbnailCandidates([wanted]).get(wanted)?.candidate || null;
}

function catalogFile(row, folder) {
  const timeline = localDisplayDate(row.path, row.mtimeMs);
  const date = timeline.ms ? new Date(timeline.ms).toISOString() : null;
  const contentHash=String(row.contentHash || '');
  const intended=folder.protected===true;
  return {
    hash:row.hash,
    localId:String(row.id || ''),
    size:Number(row.size) || 0,
    mime:mimeFor(row.path),
    createdAt:date,
    filename:basename(row.path),
    originalPath:row.path,
    fileDate:date,
    addedAt:date,
    dateSource:timeline.source,
    searchText:`${folder.name} ${folder.rootPath} ${row.path}`,
    rootPath:folder.rootPath,
    localAvailable:folder.available !== false,
    backupIntent:intended,
    lifecycle:intended?'current':'local',
    protectionState:intended?(contentHash?'pending':'preparing'):'',
    contentHashReady:Boolean(contentHash)
  };
}

export function protectionIntents() {
  const folders=localFolders().filter(folder=>folder.protected);
  if(!folders.length||!existsSync(SYNC_INDEX_PATH))return [];
  const db=new DatabaseSync(SYNC_INDEX_PATH,{readOnly:true,timeout:5000});
  try{
    const query=db.prepare(`
      SELECT path,size,content_hash AS contentHash
      FROM files WHERE root=?
      ORDER BY path
    `);
    const entries=[];
    for(const folder of folders){
      for(const row of query.iterate(folder.rootKey)){
        const hash=String(row.contentHash||'');
        entries.push({
          rootPath:folder.rootPath,
          path:String(row.path||''),
          hash:/^[a-f0-9]{64}$/.test(hash)?hash:'',
          size:Number(row.size)||0,
          importId:Number(folder.importId)||0
        });
      }
    }
    return entries;
  }finally{db.close();}
}

export function localFolderPreview(path, limit = 5) {
  const wanted = pathKey(String(path || ''));
  const folder = localFolders().find(item => pathKey(item.rootPath) === wanted);
  const safeLimit = Math.max(1, Math.min(120, Number(limit) || 5));
  if (!folder) return { path:String(path || ''), files:[] };

  const rows = folder.available === false
    ? []
    : browseStageRows(Math.max(240, safeLimit * 4)).filter(row => {
      if (row.root !== folder.rootKey) return false;
      const mime = mimeFor(row.path);
      return mime.startsWith('image/') || mime.startsWith('video/');
    });
  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1000 });
    try {
      const candidateLimit = safeLimit * 2;
      rows.push(...db.prepare(`
        SELECT root,path,size,mtime_ms AS mtimeMs,id,content_hash AS contentHash,${catalogHashSql} AS hash
        FROM files
        WHERE root = ? AND (${MEDIA_PATH_SQL})
        ORDER BY mtime_ms DESC,path
        LIMIT ?
      `).all(folder.rootKey, ...MEDIA_PATH_ARGS, candidateLimit));
    } catch {} finally {
      db.close();
    }
  }

  rows.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  const seen = new Set();
  const files = [];
  for (const row of rows) {
    if (!row?.hash || seen.has(row.hash)) continue;
    seen.add(row.hash);
    files.push(catalogFile(row, folder));
    if (files.length >= safeLimit) break;
  }
  return {
    path:folder.rootPath,
    available:folder.available,
    protected:folder.protected,
    files
  };
}

function folderSamples(folders) {
  const key = `${syncIndexRevision(SYNC_INDEX_PATH)}|${folders.map(folder => `${folder.rootKey}:${folder.available ? 1 : 0}`).join('|')}`;
  if (key === sampleCacheKey && Date.now() - sampleCacheAt < 15_000) return sampleCache;
  sampleCacheKey = key;
  sampleCacheAt = Date.now();
  sampleCache = folders.map(folder => localFolderPreview(folder.rootPath, 80));
  return sampleCache;
}

function catalogFolders(path = '') {
  const folders = localFolders();
  const wanted = path ? pathKey(String(path)) : '';
  return wanted ? folders.filter(folder => pathKey(folder.rootPath) === wanted) : folders;
}

export function localCatalogState() {
  const folders = localFolders();
  return {
    version:JSON.stringify([syncIndexRevision(SYNC_INDEX_PATH), folders.map(folder =>
      [folder.rootKey, folder.importId, folder.protected, folder.available])]),
    sources:folders.map(folder => ({ path:folder.rootPath, importId:folder.importId }))
  };
}

export function localCatalog(limit = 720, path = '', after = null, mediaOnly = false) {
  if (String(path || '') === CACHE_STATS_PATH) {
    return { files:[], folderSamples:[], nextCursor:null, cacheStats:localCacheStats() };
  }

  const folders = catalogFolders(path);
  // The index and cached previews remain browsable when a drive is offline.
  const sourceFolders = folders;
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 720));
  const paged = after !== null;
  let cursor = null;
  if (after) {
    try {
      cursor = JSON.parse(after);
      if (!Array.isArray(cursor) || cursor.length !== 3 || !Number.isFinite(cursor[0]) || typeof cursor[1] !== 'string' || typeof cursor[2] !== 'string') throw new Error();
    } catch { throw Object.assign(new Error('Invalid catalog cursor'), { status:400 }); }
  }
  if (!sourceFolders.length) return { files:[], folderSamples:!paged && !path ? folderSamples(folders) : [], nextCursor:null };

  const byRoot = new Map(sourceFolders.map(folder => [folder.rootKey, folder]));
  const rows = paged ? [] : browseStageRows(safeLimit * 2).filter(row => byRoot.has(row.root));
  let nextCursor = null;

  if (existsSync(SYNC_INDEX_PATH)) {
    const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1500 });
    try {
      const roots = [...byRoot.keys()];
      const placeholders = roots.map(() => '?').join(',');
      if (roots.length) {
        const sqlLimit = paged ? safeLimit : safeLimit * 2;
        const fetched = db.prepare(`
          SELECT root,path,size,mtime_ms AS mtimeMs,id,content_hash AS contentHash,${catalogHashSql} AS hash
          FROM files INDEXED BY ${roots.length === 1 ? 'files_root_timeline' : 'files_timeline'}
          WHERE root IN (${placeholders})
          ${mediaOnly ? `AND (${MEDIA_PATH_SQL})` : ''}
          ${cursor ? roots.length === 1 ? 'AND (mtime_ms,path) < (?,?)' : 'AND (mtime_ms,root,path) < (?,?,?)' : ''}
          ORDER BY mtime_ms DESC,root DESC,path DESC
          LIMIT ?
        `).all(...roots, ...(mediaOnly ? MEDIA_PATH_ARGS : []), ...(cursor ? roots.length === 1 ? [cursor[0], cursor[2]] : cursor : []), sqlLimit);
        if (paged && fetched.length === sqlLimit) {
          const last = fetched.at(-1);
          nextCursor = JSON.stringify([last.mtimeMs, last.root, last.path]);
        }
        rows.push(...fetched);
      }
    } finally {
      db.close();
    }
  }

  rows.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  const seen = new Set();
  const files = [];
  for (const row of rows) {
    const folder = byRoot.get(row.root);
    if (!folder || seen.has(row.hash) || isSourceExcluded(folder.rootPath, row.path)) continue;
    seen.add(row.hash);
    files.push(catalogFile(row, folder));
    if (!paged && files.length >= safeLimit) break;
  }

  return {
    files,
    folderSamples:!paged && !path && safeLimit <= 720 ? folderSamples(folders) : [],
    nextCursor
  };
}
