import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONFIG_DIR, api, json, readJson, settings } from './lib/agent-context.js';
import { decodeHeic } from './lib/heic.js';
import { localFolderTree } from './lib/local-folder-tree.js';
import { mimeFor } from './lib/mime.js';

const TMP_DIR = join(CONFIG_DIR, 'tmp');
const BROWSER_THUMB_DIR = join(homedir(), '.mochimono', 'provider-thumbs');
const BROWSER_THUMB_VERSION = 3;
const MAX_BROWSER_THUMB_BYTES = 8 * 1024 * 1024;
const MAX_BROWSER_HEIC_BYTES = 128 * 1024 * 1024;
const BROWSER_HEIC_EDGE = 768;
const sessions = new Map();

function cleanRelative(value) {
  const parts = String(value || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) throw Object.assign(new Error('Invalid file path'), { status: 400 });
  return parts.join('/');
}

async function browseLocalFolders(res, url) {
  const requested = String(url.searchParams.get('path') || '').trim() || homedir();
  const target = resolve(requested);
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) return json(res, 404, { error: 'Folder is unavailable' });

  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    return json(res, 403, { error: error?.message || 'Folder cannot be opened' });
  }

  const root = parse(target).root;
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return json(res, 200, {
    path: target,
    parent: target === root ? null : dirname(target),
    root,
    directories
  });
}

async function importIdentity(body) {
  const requested = Number(body.importId) || 0;
  if (requested > 0) {
    try {
      await api(`/api/imports/${requested}`, { method: 'POST', body: { sourceName: settings.device } });
      return requested;
    } catch {}
  }
  const created = await api('/api/imports', { method: 'POST', body: { sourceName: settings.device } });
  return Number(created.id);
}

async function startImport(req, res) {
  const body = await readJson(req, 128 * 1024);
  const localOnly = body.browser === true && body.cloud !== true;
  const importId = localOnly ? 0 : await importIdentity(body);
  const label = String(body.label || 'Drop').slice(0, 200);
  const rootPath = String(body.rootPath || label).slice(0, 2000);
  const scope = String(body.scope || '').toLowerCase() === 'all' ? 'all' : 'media';
  const id = randomUUID();
  sessions.set(id, { importId, localOnly, createdAt: Date.now(), label, seen:new Set() });

  if (!localOnly) {
    await api('/api/import-roots', {
      method: 'POST',
      body: { roots: [{ importId, deviceName: settings.device, rootPath }] }
    }).catch(() => {});
    if (body.browser === true || body.scope !== undefined) {
      await api('/api/import-scope', { method: 'POST', body: { importId, scope } }).catch(() => {});
    }
  }

  return json(res, 200, { session: id, importId, scope, localOnly });
}

async function importFile(req, res, url) {
  const session = sessions.get(String(url.searchParams.get('session') || ''));
  if (!session) return json(res, 410, { error: 'Import session expired' });
  const relative = cleanRelative(url.searchParams.get('path'));
  const name = basename(relative);
  const mtime = String(url.searchParams.get('mtime') || '') || new Date().toISOString();
  const mime = mimeFor(relative, req.headers['x-mochimono-file-mime']);

  await mkdir(TMP_DIR, { recursive: true });
  const temp = join(TMP_DIR, `drop-${process.pid}-${Date.now()}-${randomUUID()}`);
  const digest = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    }
  });

  try {
    await pipeline(req, meter, createWriteStream(temp, { flags: 'wx' }));
    const hash = digest.digest('hex');
    session.seen.add(relative);

    if (session.localOnly) {
      return json(res, 200, {
        hash, name, path:relative, size, mime, mtime,
        existing:false, ignored:false, previous:[], localOnly:true
      });
    }

    const checked = await api('/api/objects/check', { method: 'POST', body: { hashes: [hash] } });
    const missing = (checked.missing || []).includes(hash);
    const ignored = (checked.ignored || []).includes(hash);
    let previous = [];

    if (!missing) {
      try { previous = (await api(`/api/files/${hash}/details`)).sources || []; } catch {}
    }

    if (missing && !ignored) {
      await api(`/api/objects/${hash}`, {
        method: 'PUT',
        headers: { 'content-length': String(size), 'x-mochimono-mime': mime },
        body: createReadStream(temp)
      });
    }

    if (!ignored) {
      await api('/api/sources', {
        method: 'POST',
        body: { importId: session.importId, sources: [{ hash, path: relative, filename: name, mtime }] }
      });
    }

    return json(res, 200, { hash, name, path: relative, size, mime, mtime, existing: !missing, ignored, previous });
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function markSeen(req, res, url) {
  const session = sessions.get(String(url.searchParams.get('session') || ''));
  if (!session) return json(res, 410, { error: 'Import session expired' });
  const body = await readJson(req, 2 * 1024 * 1024);
  if (!Array.isArray(body.paths) || body.paths.length > 4000) return json(res, 400, { error: 'paths must be an array of at most 4000 entries' });
  for (const path of body.paths) session.seen.add(cleanRelative(path));
  json(res, 200, { ok:true, count:body.paths.length });
}

async function finishImport(req, res, url) {
  const sessionId = String(url.searchParams.get('session') || '');
  const session = sessions.get(sessionId);
  if (!session) return json(res, 410, { error: 'Import session expired' });

  if (session.localOnly) {
    sessions.delete(sessionId);
    return json(res, 200, { ok:true, importId:0, seen:session.seen.size, removed:0, localOnly:true });
  }

  let removed = 0;
  try {
    const current = await api(`/api/imports/${session.importId}/source-paths`);
    const missing = (current.paths || []).filter(path => !session.seen.has(String(path)));
    for (let offset = 0; offset < missing.length; offset += 2000) {
      const batch = missing.slice(offset, offset + 2000);
      const result = await api(`/api/imports/${session.importId}/source-paths/remove`, { method:'POST', body:{ paths:batch } });
      removed += Number(result.count) || 0;
    }
    sessions.delete(sessionId);
    json(res, 200, { ok:true, importId:session.importId, seen:session.seen.size, removed });
  } catch (error) {
    json(res, error.status || 500, { error:error.message || 'Could not finish folder sync' });
  }
}

function browserThumbnailPath(hash) {
  return join(BROWSER_THUMB_DIR, hash.slice(0, 2), `${hash}.webp`);
}

async function serveBrowserThumbnail(req, res, hash) {
  const path = browserThumbnailPath(hash);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || !info.size) return false;
  const headers = {
    'content-type':'image/webp',
    'content-length':info.size,
    'cache-control':'private, max-age=31536000, immutable',
    etag:`\"${hash}-provider-thumb-${BROWSER_THUMB_VERSION}\"`
  };
  if (req.headers['if-none-match'] === headers.etag) {
    res.writeHead(304, { etag:headers.etag, 'cache-control':headers['cache-control'] });
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(path).pipe(res);
  return true;
}

async function saveBrowserThumbnail(req, res, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return json(res, 400, { error:'Invalid SHA-256 hash' });
  const width = Math.max(0, Math.round(Number(req.headers['x-mochimono-width']) || 0));
  const height = Math.max(0, Math.round(Number(req.headers['x-mochimono-height']) || 0));
  const bucket = join(BROWSER_THUMB_DIR, hash.slice(0, 2));
  const destination = browserThumbnailPath(hash);
  const info = join(bucket, `${hash}.json`);
  const temp = join(bucket, `${hash}.${process.pid}.${Date.now()}.tmp.webp`);
  await mkdir(bucket, { recursive:true });

  let size = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > MAX_BROWSER_THUMB_BYTES) return callback(Object.assign(new Error('Thumbnail is too large'), { status:413 }));
      callback(null, chunk);
    }
  });

  try {
    await pipeline(req, limit, createWriteStream(temp, { flags:'wx' }));
    if (!size) throw Object.assign(new Error('Empty thumbnail'), { status:400 });
    await rm(destination, { force:true });
    await rename(temp, destination);
    await writeFile(info, `${JSON.stringify({ version:BROWSER_THUMB_VERSION, width, height })}\n`);
    json(res, 201, { ok:true, hash, size, width, height });
  } catch (error) {
    await rm(temp, { force:true }).catch(() => {});
    if (!res.headersSent) json(res, error.status || 500, { error:error.message || 'Could not save thumbnail' });
  }
}

async function saveBrowserHeicThumbnail(req, res, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return json(res, 400, { error:'Invalid SHA-256 hash' });
  await mkdir(TMP_DIR, { recursive:true });
  const source = join(TMP_DIR, `browser-heic-${process.pid}-${Date.now()}-${randomUUID()}`);
  let size = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > MAX_BROWSER_HEIC_BYTES) return callback(Object.assign(new Error('HEIC image is too large'), { status:413 }));
      callback(null, chunk);
    }
  });

  try {
    await pipeline(req, limit, createWriteStream(source, { flags:'wx' }));
    if (!size) throw Object.assign(new Error('Empty HEIC image'), { status:400 });
    const result = await decodeHeic(source, { edge:BROWSER_HEIC_EDGE, quality:82, effort:2 });
    if (!result.data?.length) throw new Error('Could not decode HEIC preview');
    if (result.data.length > MAX_BROWSER_THUMB_BYTES) throw Object.assign(new Error('HEIC thumbnail is too large'), { status:413 });

    const width = Math.max(1, Math.round(Number(result.info?.width) || 1));
    const height = Math.max(1, Math.round(Number(result.info?.height) || 1));
    const bucket = join(BROWSER_THUMB_DIR, hash.slice(0, 2));
    const destination = browserThumbnailPath(hash);
    const info = join(bucket, `${hash}.json`);
    const temp = join(bucket, `${hash}.${process.pid}.${Date.now()}.tmp.webp`);
    await mkdir(bucket, { recursive:true });
    await writeFile(temp, result.data, { flag:'wx' });
    await rm(destination, { force:true });
    await rename(temp, destination);
    await writeFile(info, `${JSON.stringify({ version:BROWSER_THUMB_VERSION, width, height })}\n`);
    json(res, 201, { ok:true, hash, size:result.data.length, width, height });
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error:error.message || 'Could not decode HEIC thumbnail' });
  } finally {
    await rm(source, { force:true }).catch(() => {});
  }
}

export async function handleClientImport(req, res, url) {
  if (url.pathname.startsWith('/api/video-optimize/cloud-')) {
    const { handleCloudVideoOptimizeApi } = await import('./lib/video-optimize-cloud.js');
    if (await handleCloudVideoOptimizeApi(req, res, url)) return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/client/folder-browser') {
    await browseLocalFolders(res, url);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/client/folder-tree') {
    json(res, 200, localFolderTree(url.searchParams.get('path') || ''));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/client/import/start') {
    await startImport(req, res);
    return true;
  }
  if (req.method === 'PUT' && url.pathname === '/api/client/import/file') {
    await importFile(req, res, url);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/client/import/seen') {
    await markSeen(req, res, url);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/client/import/finish') {
    await finishImport(req, res, url);
    return true;
  }
  const browserHeicThumb = /^\/api\/client\/browser-heic-thumb\/([a-f0-9]{64})$/.exec(url.pathname);
  if (browserHeicThumb && req.method === 'PUT') {
    await saveBrowserHeicThumbnail(req, res, browserHeicThumb[1]);
    return true;
  }
  const browserThumb = /^\/api\/client\/browser-thumb\/([a-f0-9]{64})$/.exec(url.pathname);
  if (browserThumb && req.method === 'PUT') {
    await saveBrowserThumbnail(req, res, browserThumb[1]);
    return true;
  }
  const thumb = /^\/api\/thumbs\/([a-f0-9]{64})$/.exec(url.pathname);
  if (thumb && (req.method === 'GET' || req.method === 'HEAD')) {
    if (await serveBrowserThumbnail(req, res, thumb[1])) return true;
  }
  return false;
}

function cleanupSessions() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, value] of sessions) if (value.createdAt < cutoff) sessions.delete(id);
}
const cleanupTimer = setInterval(cleanupSessions, 10 * 60 * 1000);
cleanupTimer.unref?.();
