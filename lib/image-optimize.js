import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import { CONFIG_DIR, json, readJson } from './agent-context.js';
import { invalidateClientProviders } from './client-providers.js';
import { localCandidate } from './local-locations.js';

const TEMP_DIR = join(CONFIG_DIR, 'optimize');
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE = 1;
const RASTER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.gif', '.tif', '.tiff']);
const BROWSER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.gif']);
const LOSSLESS_FRIENDLY = new Set(['.png', '.bmp', '.tif', '.tiff', '.gif']);
const sessions = new Map();
let activeEncodes = 0;

await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
await mkdir(TEMP_DIR, { recursive: true });

const number = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));
const sameStamp = (info, source) => info?.isFile() && Number(info.size) === Number(source.size) && Math.trunc(info.mtimeMs) === Math.trunc(source.mtimeMs);
const exists = async path => Boolean(await stat(path).catch(() => null));

function normalizeOptions(raw = {}) {
  const format = ['auto', 'webp', 'avif'].includes(String(raw.format || '')) ? String(raw.format) : 'auto';
  const defaultQuality = format === 'avif' ? 92 : 94;
  return {
    format,
    quality: Math.round(number(raw.quality, defaultQuality, 50, 100)),
    effort: raw.effort === 'normal' ? 'normal' : 'max',
    lossless: raw.lossless === true && format === 'webp'
  };
}

function encodeLabel(spec) {
  if (spec.lossless) return 'Lossless WebP';
  return `${spec.format === 'avif' ? 'AVIF' : 'WebP'} ${spec.quality}`;
}

function outputMime(format) {
  return format === 'avif' ? 'image/avif' : 'image/webp';
}

function metadataPipeline(path) {
  let image = sharp(path, { failOn: 'warning', limitInputPixels: false, animated: false });
  image = typeof image.keepMetadata === 'function' ? image.keepMetadata() : image.withMetadata();
  return image;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function syncFile(path) {
  const file = await open(path, 'r');
  try { await file.sync(); }
  finally { await file.close(); }
}

async function encodeCandidate(session, spec) {
  const id = `c${session.candidates.length + 1}`;
  const suffix = spec.format === 'avif' ? 'avif' : 'webp';
  const path = join(TEMP_DIR, `${session.id}-${id}.${suffix}`);
  let image = metadataPipeline(session.source.path);
  if (spec.format === 'avif') {
    image = image.avif({
      quality: spec.quality,
      effort: session.options.effort === 'max' ? 9 : 4,
      chromaSubsampling: '4:4:4'
    });
  } else {
    image = image.webp(spec.lossless ? {
      lossless: true,
      effort: session.options.effort === 'max' ? 6 : 4
    } : {
      quality: spec.quality,
      effort: session.options.effort === 'max' ? 6 : 4,
      smartSubsample: true
    });
  }
  await image.toFile(path);
  const [info, metadata, hash] = await Promise.all([stat(path), sharp(path, { limitInputPixels: false }).metadata(), sha256(path)]);
  if (!info.isFile() || !info.size) throw new Error('Encoder produced an empty file');
  if (Number(metadata.width) !== Number(session.metadata.width) || Number(metadata.height) !== Number(session.metadata.height)) {
    throw new Error('Optimized image dimensions changed unexpectedly');
  }
  const item = {
    id,
    path,
    hash,
    format: spec.format,
    mime: outputMime(spec.format),
    quality: spec.lossless ? null : spec.quality,
    lossless: Boolean(spec.lossless),
    label: encodeLabel(spec),
    size: Number(info.size)
  };
  session.candidates.push(item);
  return item;
}

function selectSmallest(items) {
  return [...items].sort((a, b) => a.size - b.size)[0] || null;
}

async function makeOriginalPreview(session) {
  if (BROWSER_EXTENSIONS.has(session.source.extension)) return;
  const path = join(TEMP_DIR, `${session.id}-original.webp`);
  let image = metadataPipeline(session.source.path);
  image = image.webp({ lossless: true, effort: 4 });
  await image.toFile(path);
  session.originalPreviewPath = path;
}

async function encodeSession(session) {
  activeEncodes++;
  try {
    session.progress = { label: 'Reading image', done: 0, total: 1 };
    const metadata = await sharp(session.source.path, { failOn: 'warning', limitInputPixels: false, animated: false }).metadata();
    if (!metadata.width || !metadata.height) throw new Error('Could not read image dimensions');
    if (Number(metadata.pages || 1) > 1) throw Object.assign(new Error('Animated or multi-page images are not supported yet'), { status: 415 });
    if (metadata.depth && metadata.depth !== 'uchar') throw Object.assign(new Error('16-bit/HDR image replacement is not supported safely yet'), { status: 415 });
    if (String(metadata.space || '').toLowerCase() === 'cmyk') throw Object.assign(new Error('CMYK image replacement is not supported safely yet'), { status: 415 });
    session.metadata = { width: Number(metadata.width), height: Number(metadata.height) };
    await makeOriginalPreview(session);

    const requested = session.options;
    const specs = [];
    if (requested.format === 'webp') {
      specs.push({ format: 'webp', quality: requested.quality, lossless: requested.lossless });
    } else if (requested.format === 'avif') {
      specs.push({ format: 'avif', quality: requested.quality, lossless: false });
    } else {
      if (LOSSLESS_FRIENDLY.has(session.source.extension)) specs.push({ format: 'webp', quality: 100, lossless: true });
      specs.push({ format: 'webp', quality: 94, lossless: false });
      specs.push({ format: 'avif', quality: 92, lossless: false });
    }

    session.progress.total = specs.length;
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      session.progress = { label: `Encoding ${encodeLabel(spec)}`, done: index, total: specs.length };
      const item = await encodeCandidate(session, spec);
      session.progress.done = index + 1;

      // Auto is deliberately conservative for archival replacement: if a
      // lossless conversion already removes at least a quarter of the bytes,
      // keep it and avoid spending minutes looking for a smaller lossy result.
      if (requested.format === 'auto' && spec.lossless && item.size <= session.source.size * 0.75) break;
    }

    const lossless = session.candidates.find(item => item.lossless && item.size <= session.source.size * 0.90);
    session.selectedId = lossless?.id || selectSmallest(session.candidates)?.id || '';
    if (!session.selectedId) throw new Error('No optimized image was produced');
    session.status = 'ready';
    session.progress = null;
  } catch (error) {
    session.status = 'error';
    session.error = error?.message || String(error);
  } finally {
    session.updatedAt = Date.now();
    activeEncodes--;
  }
}

function publicCandidate(session, item) {
  if (!item) return null;
  const saved = Math.max(0, session.source.size - item.size);
  return {
    id: item.id,
    format: item.format,
    mime: item.mime,
    quality: item.quality,
    lossless: item.lossless,
    label: item.label,
    size: item.size,
    saved,
    percent: session.source.size ? saved / session.source.size * 100 : 0,
    url: `/api/image-optimize/file?id=${encodeURIComponent(session.id)}&kind=optimized&candidate=${encodeURIComponent(item.id)}`
  };
}

function publicSession(session) {
  const selected = session.candidates.find(item => item.id === session.selectedId) || null;
  return {
    id: session.id,
    status: session.status,
    error: session.error || '',
    hash: session.hash,
    filename: session.source.filename,
    sourceSize: session.source.size,
    sourceProtected: session.source.protected,
    width: session.metadata?.width || 0,
    height: session.metadata?.height || 0,
    options: session.options,
    progress: session.progress,
    originalUrl: `/api/image-optimize/file?id=${encodeURIComponent(session.id)}&kind=original`,
    selected: publicCandidate(session, selected),
    candidates: session.candidates.map(item => publicCandidate(session, item)),
    worthwhile: selected ? selected.size <= session.source.size * 0.95 && session.source.size - selected.size >= 256 * 1024 : false,
    result: session.result || null
  };
}

async function cleanupSession(session) {
  const paths = [session.originalPreviewPath, ...session.candidates.map(item => item.path)].filter(Boolean);
  await Promise.all(paths.map(path => unlink(path).catch(() => {})));
}

function cleanupExpired() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.updatedAt > cutoff || session.status === 'encoding') continue;
    sessions.delete(id);
    cleanupSession(session).catch(() => {});
  }
}
setInterval(cleanupExpired, 60_000).unref?.();

async function startSession(hash, rawOptions) {
  if (activeEncodes >= MAX_ACTIVE) throw Object.assign(new Error('Another image preview is still encoding'), { status: 409 });
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Object.assign(new Error('Invalid file'), { status: 400 });
  const candidate = localCandidate(hash);
  if (!candidate) throw Object.assign(new Error('Image optimization currently requires a local copy'), { status: 404 });
  const extension = extname(candidate.path).toLowerCase();
  if (!RASTER_EXTENSIONS.has(extension) || !String(candidate.mime || '').startsWith('image/')) {
    throw Object.assign(new Error('This image format is not supported for safe replacement yet'), { status: 415 });
  }
  const info = await stat(candidate.path).catch(() => null);
  if (!info?.isFile()) throw Object.assign(new Error('Local image is unavailable'), { status: 404 });

  const session = {
    id: randomUUID(),
    hash,
    status: 'encoding',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    options: normalizeOptions(rawOptions),
    metadata: null,
    candidates: [],
    selectedId: '',
    originalPreviewPath: '',
    source: {
      path: candidate.path,
      filename: candidate.filename || basename(candidate.path),
      extension,
      mime: candidate.mime,
      size: Number(info.size),
      mtimeMs: Number(info.mtimeMs),
      atime: info.atime,
      mtime: info.mtime,
      protected: candidate.protected === true
    }
  };
  sessions.set(session.id, session);
  setImmediate(() => encodeSession(session));
  return session;
}

function sessionFor(id) {
  const session = sessions.get(String(id || ''));
  if (!session) throw Object.assign(new Error('Optimization preview expired'), { status: 404 });
  session.updatedAt = Date.now();
  return session;
}

async function serveFile(req, res, url) {
  const session = sessionFor(url.searchParams.get('id'));
  const kind = String(url.searchParams.get('kind') || '');
  let path;
  let mime;
  if (kind === 'original') {
    path = session.originalPreviewPath || session.source.path;
    mime = session.originalPreviewPath ? 'image/webp' : session.source.mime;
  } else if (kind === 'optimized') {
    const candidateId = String(url.searchParams.get('candidate') || session.selectedId || '');
    const candidate = session.candidates.find(item => item.id === candidateId);
    if (!candidate) throw Object.assign(new Error('Optimized preview is not ready'), { status: 404 });
    path = candidate.path;
    mime = candidate.mime;
  } else throw Object.assign(new Error('Invalid preview'), { status: 400 });
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw Object.assign(new Error('Preview is unavailable'), { status: 404 });
  res.writeHead(200, {
    'content-type': mime || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store'
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
}

async function uniqueKeepPath(sourcePath, format) {
  const oldExt = extname(sourcePath);
  const stem = sourcePath.slice(0, sourcePath.length - oldExt.length);
  const extension = `.${format}`;
  let target = oldExt.toLowerCase() === extension ? `${stem}.optimized${extension}` : `${stem}${extension}`;
  if (!await exists(target)) return target;
  for (let index = 2; index < 1000; index++) {
    target = `${stem}.optimized-${index}${extension}`;
    if (!await exists(target)) return target;
  }
  throw new Error('Could not choose an output filename');
}

async function commitSession(session, candidateId, mode) {
  if (session.status !== 'ready') throw Object.assign(new Error('Optimization preview is not ready'), { status: 409 });
  if (!['keep', 'replace'].includes(mode)) throw Object.assign(new Error('Choose Keep both or Replace original'), { status: 400 });
  const candidate = session.candidates.find(item => item.id === candidateId) || session.candidates.find(item => item.id === session.selectedId);
  if (!candidate) throw Object.assign(new Error('Choose an optimized preview'), { status: 400 });

  const current = await stat(session.source.path).catch(() => null);
  if (!sameStamp(current, session.source)) {
    throw Object.assign(new Error('The original changed while the preview was open. Generate a new preview first.'), { status: 409 });
  }
  const candidateInfo = await stat(candidate.path).catch(() => null);
  if (!candidateInfo?.isFile() || Number(candidateInfo.size) !== Number(candidate.size)) throw new Error('Optimized file failed verification');

  const sourcePath = session.source.path;
  const sourceExt = extname(sourcePath);
  const stem = sourcePath.slice(0, sourcePath.length - sourceExt.length);
  const finalPath = mode === 'keep' ? await uniqueKeepPath(sourcePath, candidate.format) : `${stem}.${candidate.format}`;
  if (mode === 'replace' && finalPath !== sourcePath && await exists(finalPath)) {
    throw Object.assign(new Error(`${basename(finalPath)} already exists`), { status: 409 });
  }

  const directory = dirname(sourcePath);
  const stage = join(directory, `.${basename(finalPath)}.mochimono-${session.id}.tmp`);
  const backup = join(directory, `.${basename(sourcePath)}.mochimono-original-${session.id}.tmp`);
  await unlink(stage).catch(() => {});
  await unlink(backup).catch(() => {});
  await copyFile(candidate.path, stage);
  await syncFile(stage);
  if (await sha256(stage) !== candidate.hash) {
    await unlink(stage).catch(() => {});
    throw new Error('Optimized copy failed verification');
  }
  await utimes(stage, session.source.atime, session.source.mtime).catch(() => {});

  if (mode === 'keep') {
    await rename(stage, finalPath);
  } else {
    let placed = false;
    await rename(sourcePath, backup);
    try {
      await rename(stage, finalPath);
      placed = true;
      const finalInfo = await stat(finalPath);
      if (!finalInfo.isFile() || Number(finalInfo.size) !== Number(candidate.size)) throw new Error('Replacement failed verification');
      await utimes(finalPath, session.source.atime, session.source.mtime).catch(() => {});
      await unlink(backup);
    } catch (error) {
      if (placed) await unlink(finalPath).catch(() => {});
      await rename(backup, sourcePath).catch(() => {});
      await unlink(stage).catch(() => {});
      throw error;
    }
  }

  session.status = 'committed';
  session.result = {
    mode,
    path: finalPath,
    filename: basename(finalPath),
    size: candidate.size,
    hash: candidate.hash,
    saved: Math.max(0, session.source.size - candidate.size),
    format: candidate.format
  };
  session.updatedAt = Date.now();
  invalidateClientProviders();
  await cleanupSession(session);
  return session.result;
}

export async function handleImageOptimizeApi(req, res, url) {
  if (!url.pathname.startsWith('/api/image-optimize/')) return false;

  if (req.method === 'POST' && url.pathname === '/api/image-optimize/start') {
    const body = await readJson(req, 32 * 1024);
    const session = await startSession(String(body.hash || ''), body.options || {});
    json(res, 202, publicSession(session));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/image-optimize/status') {
    json(res, 200, publicSession(sessionFor(url.searchParams.get('id'))));
    return true;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/image-optimize/file') {
    await serveFile(req, res, url);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/image-optimize/commit') {
    const body = await readJson(req, 32 * 1024);
    const session = sessionFor(body.id);
    const result = await commitSession(session, String(body.candidate || ''), String(body.mode || ''));
    json(res, 200, { ok: true, result });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
