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
import { handleImageOptimizeApi } from './image-optimize.js';

const ROOT = join(CONFIG_DIR, 'image-optimize-cloud');
const TTL = 30 * 60 * 1000;
const IMAGE_EXTENSIONS = new Set(['.jpg','.jpeg','.png','.webp','.avif','.bmp','.gif','.tif','.tiff']);
const sourceCache = new Map();
const cloudSessions = new Map();
const stage = openBrowseStage();

await rm(ROOT, { recursive:true, force:true }).catch(() => {});
await mkdir(ROOT, { recursive:true });

function safeFilename(value, hash) {
  const name = basename(String(value || '').replaceAll('\\', '/')) || `${hash}.image`;
  return name === '.' || name === '..' ? `${hash}.image` : name;
}

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function captureImageApi(method, pathname, body = null, search = '') {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = body == null ? {} : { 'content-type':'application/json' };
  let status = 200;
  const chunks = [];
  const res = {
    headersSent:false,
    destroyed:false,
    writeHead(code) { status = Number(code) || 200; this.headersSent = true; return this; },
    setHeader() {},
    end(chunk) { if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.headersSent = true; },
    destroy() { this.destroyed = true; }
  };
  const url = new URL(`http://127.0.0.1${pathname}${search}`);
  await handleImageOptimizeApi(req, res, url);
  const text = Buffer.concat(chunks).toString('utf8');
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error:text || 'Invalid optimizer response' }; }
  return { status, data };
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
  if (!String(details.object.mime || '').startsWith('image/')) throw Object.assign(new Error('Unsupported image format'), { status:415 });

  const firstSource = details.sources?.[0] || {};
  const filename = safeFilename(firstSource.filename || firstSource.path, hash);
  const extension = extname(filename).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw Object.assign(new Error('Unsupported image format'), { status:415 });

  const root = join(ROOT, hash);
  const path = join(root, filename);
  const temp = `${path}.download-${process.pid}-${Date.now()}`;
  await mkdir(root, { recursive:true });

  const response = await api(`/api/objects/${hash}`);
  if (!response.body) throw Object.assign(new Error('Cloud image download failed'), { status:502 });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags:'wx' }));
    const info = await stat(temp);
    if (!info.isFile() || Number(info.size) !== Number(details.object.size) || await sha256(temp) !== hash) {
      throw new Error('Cloud image failed SHA-256 verification after download');
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
  return result?.format === 'avif' ? '.avif' : '.webp';
}

function mimeFor(extension) {
  return extension === '.avif' ? 'image/avif' : 'image/webp';
}

function replaceExtension(value, extension) {
  const text = String(value || '');
  const current = extname(text);
  return `${current ? text.slice(0, -current.length) : text}${extension}`;
}

async function uniqueKeepPath(source, extension, cache) {
  const original = String(source.path || source.filename || 'image');
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
  if (result.hash && String(result.hash) !== digest) throw new Error('Squished image failed SHA-256 verification');
  const extension = outputExtension(result);
  const mime = mimeFor(extension);
  const fresh = await api(`/api/files/${state.hash}/details`);
  if (!fresh?.object || !fresh.serverStored) throw Object.assign(new Error('The original Cloud image changed or became unavailable'), { status:409 });
  const sources = fresh.sources || [];
  if (!sources.length) throw new Error('Cloud image source metadata is missing');

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
        path = String(source.path || source.filename || 'image');
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
    if (!grouped.size) throw new Error('Cloud image has no writable source references');
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
  const captured = await withTemporaryCandidate(source, () => captureImageApi('POST', '/api/image-optimize/start', body));
  if (captured.status >= 400) return json(res, captured.status, captured.data);
  const id = String(captured.data.id || '');
  if (id) cloudSessions.set(id, { id, hash, source, mode:'', localResult:null, finalized:null, finalizing:null, updatedAt:Date.now() });
  json(res, captured.status, captured.data);
}

async function statusCloud(req, res, url) {
  const id = String(url.searchParams.get('id') || '');
  const state = cloudSessions.get(id);
  if (!state) return json(res, 404, { error:'Cloud Squish preview expired' });
  state.updatedAt = Date.now();
  const captured = await captureImageApi('GET', '/api/image-optimize/status', null, `?id=${encodeURIComponent(id)}`);
  json(res, captured.status, captured.data);
}

async function commitCloud(req, res) {
  const body = await readJson(req, 32768);
  const state = cloudSessions.get(String(body.id || ''));
  if (!state) return json(res, 404, { error:'Cloud Squish preview expired' });
  const mode = String(body.mode || '');
  if (!['keep','replace'].includes(mode)) return json(res, 400, { error:'Choose Save squished or replace original' });
  if (state.mode && state.mode !== mode) return json(res, 409, { error:'This Squish result is already being saved another way' });
  state.mode = mode;
  state.updatedAt = Date.now();
  if (state.finalized) return json(res, 200, state.finalized);

  if (!state.localResult) {
    const captured = await captureImageApi('POST', '/api/image-optimize/commit', body);
    if (captured.status >= 400) return json(res, captured.status, captured.data);
    state.localResult = captured.data;
  }

  if (!state.finalizing) state.finalizing = (async () => {
    const result = await uploadCloudResult(state, state.localResult);
    state.finalized = { ok:true, result };
    state.updatedAt = Date.now();
    return state.finalized;
  })().finally(() => { state.finalizing = null; });

  try { return json(res, 200, await state.finalizing); }
  catch (error) {
    return json(res, error.status || 500, { error:error.message || 'Could not save Squished Cloud image' });
  }
}

export async function handleCloudImageOptimizeApi(req, res, url) {
  if (url.pathname === '/api/image-optimize/cloud-start' && req.method === 'POST') { await startCloud(req, res); return true; }
  if (url.pathname === '/api/image-optimize/cloud-status' && req.method === 'GET') { await statusCloud(req, res, url); return true; }
  if (url.pathname === '/api/image-optimize/cloud-commit' && req.method === 'POST') { await commitCloud(req, res); return true; }
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
