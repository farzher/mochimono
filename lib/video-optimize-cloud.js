import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONFIG_DIR, api, json, pathKey, readJson, settings } from './agent-context.js';
import { browseRootKey } from './browse-folders.js';
import { openBrowseStage } from './browse-staging.js';
import { invalidateClientProviders } from './client-providers.js';
import { handleVideoOptimizeApi } from './video-optimize.js';

const ROOT = join(CONFIG_DIR, 'video-optimize-cloud');
const TTL = 30 * 60 * 1000;
const VIDEO_EXTENSIONS = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);
const sourceCache = new Map();
const cloudSessions = new Map();
const stage = openBrowseStage();

await rm(ROOT, { recursive:true, force:true }).catch(() => {});
await mkdir(ROOT, { recursive:true });

function safeFilename(value, hash) {
  const name = basename(String(value || '').replaceAll('\\', '/')) || `${hash}.video`;
  return name === '.' || name === '..' ? `${hash}.video` : name;
}

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function captureVideoApi(method, pathname, body = null, search = '') {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = body == null ? {} : { 'content-type':'application/json' };
  let status = 200;
  let headers = {};
  const chunks = [];
  const res = {
    headersSent:false,
    destroyed:false,
    writeHead(code, values = {}) { status = Number(code) || 200; headers = { ...values }; this.headersSent = true; return this; },
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    end(chunk) { if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.headersSent = true; },
    destroy() { this.destroyed = true; }
  };
  const url = new URL(`http://127.0.0.1${pathname}${search}`);
  await handleVideoOptimizeApi(req, res, url);
  const text = Buffer.concat(chunks).toString('utf8');
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error:text || 'Invalid optimizer response' }; }
  return { status, headers, data };
}

async function ensureCloudSource(hash) {
  const cached = sourceCache.get(hash);
  if (cached) {
    const info = await stat(cached.path).catch(() => null);
    if (info?.isFile() && Number(info.size) === Number(cached.size)) {
      cached.updatedAt = Date.now();
      return cached;
    }
    sourceCache.delete(hash);
  }

  const details = await api(`/api/files/${hash}/details`);
  if (!details?.serverStored || !details?.object) throw Object.assign(new Error('The Cloud copy is unavailable'), { status:404 });
  if (!String(details.object.mime || '').startsWith('video/')) throw Object.assign(new Error('Unsupported video format'), { status:415 });

  const firstSource = details.sources?.[0] || {};
  const filename = safeFilename(firstSource.filename || firstSource.path, hash);
  const extension = extname(filename).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(extension)) throw Object.assign(new Error('Unsupported video format'), { status:415 });

  const root = join(ROOT, hash);
  const path = join(root, filename);
  const temp = `${path}.download-${process.pid}-${Date.now()}`;
  await mkdir(root, { recursive:true });

  const response = await api(`/api/objects/${hash}`);
  if (!response.body) throw Object.assign(new Error('Cloud video download failed'), { status:502 });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags:'wx' }));
    const info = await stat(temp);
    if (!info.isFile() || Number(info.size) !== Number(details.object.size) || await sha256(temp) !== hash) {
      throw new Error('Cloud video failed SHA-256 verification after download');
    }
    await rm(path, { force:true });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force:true }).catch(() => {});
    throw error;
  }

  const mtimeMs = firstSource.mtime ? new Date(firstSource.mtime).getTime() : Date.now();
  const item = {
    hash,
    path,
    root,
    rootKey:browseRootKey(root),
    relative:filename,
    filename,
    extension,
    size:Number(details.object.size) || 0,
    mtimeMs:Number.isFinite(mtimeMs) ? mtimeMs : Date.now(),
    details,
    updatedAt:Date.now()
  };
  sourceCache.set(hash, item);
  return item;
}

async function withTemporaryCandidate(source, work) {
  const already = settings.browseFolders.some(path => pathKey(path) === pathKey(source.root));
  if (!already) settings.browseFolders.push(source.root);
  stage.saveMany(source.rootKey, [{ path:source.relative, size:source.size, mtimeMs:source.mtimeMs, hash:source.hash }]);
  try { return await work(); }
  finally {
    if (!already) {
      const index = settings.browseFolders.findIndex(path => pathKey(path) === pathKey(source.root));
      if (index >= 0) settings.browseFolders.splice(index, 1);
    }
  }
}

function outputExtension(result) {
  return result?.container === 'mkv' ? '.mkv' : '.webm';
}

function replaceExtension(value, extension) {
  const text = String(value || '');
  const current = extname(text);
  return `${current ? text.slice(0, -current.length) : text}${extension}`;
}

async function uniqueKeepPath(source, extension, cache) {
  const original = String(source.path || source.filename || 'video');
  const current = extname(original);
  const stem = current ? original.slice(0, -current.length) : original;
  let candidate = current.toLowerCase() === extension ? `${stem}.compressed${extension}` : `${stem}${extension}`;
  let paths = cache.get(source.importId);
  if (!paths) {
    const data = await api(`/api/imports/${Number(source.importId)}/source-paths`);
    paths = new Set((data.paths || []).map(String));
    cache.set(source.importId, paths);
  }
  if (!paths.has(candidate)) { paths.add(candidate); return candidate; }
  for (let index = 2; index < 1000; index++) {
    candidate = `${stem}.compressed-${index}${extension}`;
    if (!paths.has(candidate)) { paths.add(candidate); return candidate; }
  }
  throw new Error('Could not choose a Cloud filename for the Squished copy');
}

async function restoreSourceRecords(records, hash) {
  const grouped = new Map();
  for (const source of records) {
    const importId = Number(source.importId);
    if (!Number.isInteger(importId) || importId < 1) continue;
    if (!grouped.has(importId)) grouped.set(importId, []);
    grouped.get(importId).push({ hash, path:String(source.path), filename:String(source.filename), mtime:source.mtime || null });
  }
  for (const [importId, sources] of grouped) await api('/api/sources', { method:'POST', body:{ importId, sources } }).catch(() => {});
}

async function uploadCloudResult(state, data) {
  const result = data.result || {};
  const localPath = String(result.path || '');
  const info = localPath ? await stat(localPath).catch(() => null) : null;
  if (!info?.isFile() || !info.size) throw new Error('Squished Cloud result is unavailable');

  const digest = await sha256(localPath);
  const extension = outputExtension(result);
  const mime = extension === '.mkv' ? 'video/x-matroska' : 'video/webm';
  const fresh = await api(`/api/files/${state.hash}/details`);
  if (!fresh?.object || !fresh.serverStored) throw Object.assign(new Error('The original Cloud video changed or became unavailable'), { status:409 });
  const sources = fresh.sources || [];
  if (!sources.length) throw new Error('Cloud video source metadata is missing');

  const existing = await api('/api/objects/check', { method:'POST', body:{ hashes:[digest] } });
  const objectAlreadyExisted = (existing.known || []).includes(digest);
  if (!objectAlreadyExisted) {
    await api(`/api/objects/${digest}`, {
      method:'PUT',
      headers:{ 'content-length':String(info.size), 'x-mochimono-mime':mime },
      body:createReadStream(localPath)
    });
  }

  const pathCache = new Map();
  const grouped = new Map();
  const addedKeepPaths = new Map();
  try {
    for (const source of sources) {
      const importId = Number(source.importId);
      if (!Number.isInteger(importId) || importId < 1) continue;
      let path;
      let filename;
      if (state.mode === 'replace') {
        path = String(source.path || source.filename || 'video');
        filename = replaceExtension(source.filename || basename(path), extension);
      } else {
        path = await uniqueKeepPath(source, extension, pathCache);
        filename = basename(path);
        if (!addedKeepPaths.has(importId)) addedKeepPaths.set(importId, []);
        addedKeepPaths.get(importId).push(path);
      }
      if (!grouped.has(importId)) grouped.set(importId, []);
      grouped.get(importId).push({ hash:digest, path, filename, mtime:source.mtime || null });
    }
    if (!grouped.size) throw new Error('Cloud video has no writable source references');
    for (const [importId, records] of grouped) await api('/api/sources', { method:'POST', body:{ importId, sources:records } });
  } catch (error) {
    if (state.mode === 'replace') await restoreSourceRecords(sources, state.hash);
    else {
      for (const [importId, paths] of addedKeepPaths) {
        await api(`/api/imports/${importId}/source-paths/remove`, { method:'POST', body:{ paths } }).catch(() => {});
      }
    }
    if (!objectAlreadyExisted && digest !== state.hash) await api(`/api/objects/${digest}/delete`, { method:'POST', body:{ ignore:false } }).catch(() => {});
    throw error;
  }

  if (fresh.object.reviewed) await api(`/api/objects/${digest}/review`, { method:'POST', body:{ reviewed:true } }).catch(() => {});
  await api(`/api/media-metadata/${digest}`, {
    method:'POST',
    body:{ capturedAt:fresh.date?.capturedAt || null, source:fresh.date?.dateSource || 'squish', width:Number(result.width) || 0, height:Number(result.height) || 0 }
  }).catch(() => {});

  if (state.mode === 'replace' && digest !== state.hash) {
    try { await api(`/api/objects/${state.hash}/delete`, { method:'POST', body:{ ignore:false } }); }
    catch (error) {
      await restoreSourceRecords(sources, state.hash);
      throw error;
    }
  }

  invalidateClientProviders();
  state.source.updatedAt = Date.now();
  const visibleFilename = grouped.values().next().value?.[0]?.filename || replaceExtension(state.source.filename, extension);
  const cloudResult = {
    ...result,
    path:'',
    filename:visibleFilename,
    hash:digest,
    size:Number(info.size),
    cloud:true,
    saved:Math.max(0, Number(state.source.size) - Number(info.size))
  };
  await rm(localPath, { force:true }).catch(() => {});
  if (state.mode === 'replace') {
    sourceCache.delete(state.hash);
    stage.clear(state.source.rootKey);
    await rm(state.source.root, { recursive:true, force:true }).catch(() => {});
  }
  return cloudResult;
}

async function startCloud(req, res) {
  const body = await readJson(req, 32768);
  const hash = String(body.hash || '');
  if (!/^[a-f0-9]{64}$/.test(hash)) return json(res, 400, { error:'Invalid file' });
  const source = await ensureCloudSource(hash);
  const captured = await withTemporaryCandidate(source, () => captureVideoApi('POST', '/api/video-optimize/start', body));
  if (captured.status >= 400) return json(res, captured.status, captured.data);
  const id = String(captured.data.id || '');
  if (id) cloudSessions.set(id, { id, hash, source, mode:'', finalized:null, finalizing:null, updatedAt:Date.now() });
  json(res, captured.status, captured.data);
}

async function commitCloud(req, res) {
  const body = await readJson(req, 32768);
  const state = cloudSessions.get(String(body.id || ''));
  if (!state) return json(res, 404, { error:'Cloud Squish preview expired' });
  const mode = String(body.mode || '');
  if (!['keep','replace'].includes(mode)) return json(res, 400, { error:'Choose Save squished or replace original' });
  state.mode = mode;
  state.updatedAt = Date.now();
  const captured = await captureVideoApi('POST', '/api/video-optimize/commit', body);
  json(res, captured.status, captured.data);
}

async function statusCloud(req, res, url) {
  const id = String(url.searchParams.get('id') || '');
  const state = cloudSessions.get(id);
  if (!state) return json(res, 404, { error:'Cloud Squish preview expired' });
  state.updatedAt = Date.now();
  if (state.finalized) return json(res, 200, state.finalized);

  const captured = await captureVideoApi('GET', '/api/video-optimize/status', null, `?id=${encodeURIComponent(id)}`);
  if (captured.status >= 400) return json(res, captured.status, captured.data);
  if (captured.data.status !== 'committed' || !state.mode) return json(res, 200, captured.data);

  if (!state.finalizing) state.finalizing = (async () => {
    const result = await uploadCloudResult(state, captured.data);
    state.finalized = { ...captured.data, result };
    state.updatedAt = Date.now();
    return state.finalized;
  })().finally(() => { state.finalizing = null; });

  try { return json(res, 200, await state.finalizing); }
  catch (error) {
    return json(res, error.status || 500, { ...captured.data, status:'error', error:error.message || 'Could not save Squished Cloud video', progress:null });
  }
}

export async function handleCloudVideoOptimizeApi(req, res, url) {
  if (url.pathname === '/api/video-optimize/cloud-start' && req.method === 'POST') { await startCloud(req, res); return true; }
  if (url.pathname === '/api/video-optimize/cloud-commit' && req.method === 'POST') { await commitCloud(req, res); return true; }
  if (url.pathname === '/api/video-optimize/cloud-status' && req.method === 'GET') { await statusCloud(req, res, url); return true; }
  return false;
}

setInterval(() => {
  const cutoff = Date.now() - TTL;
  for (const [id, state] of cloudSessions) if (state.updatedAt < cutoff && !state.finalizing) cloudSessions.delete(id);
  for (const [hash, source] of sourceCache) {
    if (source.updatedAt >= cutoff) continue;
    if ([...cloudSessions.values()].some(state => state.hash === hash && state.updatedAt >= cutoff)) continue;
    sourceCache.delete(hash);
    stage.clear(source.rootKey);
    rm(source.root, { recursive:true, force:true }).catch(() => {});
  }
}, 60_000).unref?.();
