import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CONFIG_DIR, json, readJson } from './agent-context.js';
import { invalidateClientProviders } from './client-providers.js';
import { localCandidate } from './local-locations.js';

const TEMP_DIR = join(CONFIG_DIR, 'optimize');
const WORKER_FILE = fileURLToPath(new URL('./image-optimize-worker.js', import.meta.url));
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE = 1;
const AUTO_MAX_EDGE = 2560;
const WEBP_DEFAULT_QUALITY = 90;
const AVIF_DEFAULT_QUALITY = 69;
const AUTO_AVIF_QUALITY_OFFSET = WEBP_DEFAULT_QUALITY - AVIF_DEFAULT_QUALITY;
const MAX_QUALITY_MASK_BYTES = 128 * 1024;
const RASTER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.gif', '.tif', '.tiff']);
const BROWSER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.gif']);
const LOSSLESS_FRIENDLY = new Set(['.png', '.bmp', '.tif', '.tiff', '.gif']);
const PHOTO_FORMATS = new Set(['jpeg', 'webp', 'avif', 'tiff']);
const sessions = new Map();
const recentSessions = new Map();
let activeEncodes = 0;
let pendingSession = null;

await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
await mkdir(TEMP_DIR, { recursive: true });

const number = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value) || fallback));
const sameStamp = (info, source) => info?.isFile() && Number(info.size) === Number(source.size) && Math.trunc(info.mtimeMs) === Math.trunc(source.mtimeMs);
const exists = async path => Boolean(await stat(path).catch(() => null));

function normalizeQualityPaint(raw, format) {
  if (format !== 'avif' || raw?.enabled !== true) return null;
  if (raw.mode && raw.mode !== 'avif-base-v1') throw Object.assign(new Error('Unsupported quality paint mode'), { status: 400 });
  const match = String(raw.mask || '').match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw Object.assign(new Error('Invalid quality paint mask'), { status: 400 });
  const mask = Buffer.from(match[1], 'base64');
  if (!mask.length || mask.length > MAX_QUALITY_MASK_BYTES) {
    throw Object.assign(new Error('Quality paint mask is too large'), { status: 413 });
  }
  return {
    enabled: true,
    mode: 'avif-base-v1',
    lowQuality: Math.round(number(raw.lowQuality, 12, 1, 50)),
    mask: match[1],
    maskHash: createHash('sha256').update(mask).digest('hex')
  };
}

function normalizeOptions(raw = {}) {
  const format = ['auto', 'webp', 'avif'].includes(String(raw.format || '')) ? String(raw.format) : 'auto';
  const defaultQuality = format === 'avif' ? AVIF_DEFAULT_QUALITY : WEBP_DEFAULT_QUALITY;
  const content = ['auto', 'photo', 'graphics'].includes(String(raw.content || '')) ? String(raw.content) : 'auto';
  const requestedPercent = Math.round(Number(raw.resizePercent) || 0);
  const resizePercent = [25, 33, 50, 75, 100].includes(requestedPercent) ? requestedPercent : 0;
  const rawResize = raw.resizeMax;
  const resizeMax = resizePercent
    ? 0
    : rawResize === 0 || rawResize === '0'
      ? 0
      : Math.round(number(rawResize, AUTO_MAX_EDGE, 512, 8192));
  return {
    format,
    quality: Math.round(number(raw.quality, defaultQuality, 1, 100)),
    content,
    // The saved file is the exact candidate the user previewed. Max effort is opt-in.
    effort: raw.effort === 'max' ? 'max' : 'normal',
    lossless: raw.lossless === true && format === 'webp',
    resizeMax,
    resizePercent,
    qualityPaint: normalizeQualityPaint(raw.qualityPaint, format)
  };
}

function previewKey(hash, options) {
  return [
    hash,
    options.format,
    options.quality,
    options.content,
    options.effort,
    options.lossless ? 1 : 0,
    options.resizeMax,
    options.resizePercent,
    options.qualityPaint?.mode || '',
    options.qualityPaint?.lowQuality || 0,
    options.qualityPaint?.maskHash || ''
  ].join(':');
}

function encodeLabel(spec) {
  if (spec.lossless) return 'Lossless WebP';
  return `${spec.format === 'avif' ? 'AVIF' : 'WebP'} ${spec.quality}`;
}

function outputMime(format) {
  return format === 'avif' ? 'image/avif' : 'image/webp';
}

function targetDimensions(width, height, options) {
  width = Math.max(1, Number(width) || 1);
  height = Math.max(1, Number(height) || 1);
  if (options.resizePercent) {
    const scale = Math.min(1, options.resizePercent / 100);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }
  const longest = Math.max(width, height);
  if (!options.resizeMax || longest <= options.resizeMax) return { width, height };
  const scale = options.resizeMax / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function syncFile(path) {
  // Windows requires a handle with write access for fsync/FlushFileBuffers.
  // Opening the freshly staged copy read-only can fail with EPERM even though
  // the file itself is writable.
  const file = await open(path, 'r+');
  try { await file.sync(); }
  finally { await file.close(); }
}

function runEncodeWorker(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_FILE], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Best effort only. The worker itself also constrains Sharp to one codec
    // thread, so encoding never owns the Agent event loop or every CPU core.
    try { if (child.pid) setPriority(child.pid, 10); } catch {}

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `Image encoder exited with code ${code}`));
      try { resolve(JSON.parse(stdout || '{}')); }
      catch { reject(new Error('Image encoder returned an invalid result')); }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

async function encodeCandidate(session, spec, { effort = session.options.effort, id = '', record = true } = {}) {
  const candidateId = id || `c${session.candidates.length + 1}`;
  const suffix = spec.format === 'avif' ? 'avif' : 'webp';
  const path = join(TEMP_DIR, `${session.id}-${candidateId}.${suffix}`);
  const qualityPaint = spec.format === 'avif' ? session.options.qualityPaint : null;
  const encoded = await runEncodeWorker({
    sourcePath: session.source.path,
    outputPath: path,
    targetWidth: session.target.width,
    targetHeight: session.target.height,
    format: spec.format,
    quality: spec.quality,
    lossless: Boolean(spec.lossless),
    effort,
    photo: session.photo,
    qualityMaskBase64: qualityPaint?.mask || '',
    qualityLow: qualityPaint?.lowQuality || 0
  });
  if (Number(encoded.width) !== Number(session.target.width) || Number(encoded.height) !== Number(session.target.height)) {
    throw new Error('Compressed image dimensions changed unexpectedly');
  }
  const item = {
    id: candidateId,
    path,
    hash: String(encoded.hash || ''),
    format: spec.format,
    mime: outputMime(spec.format),
    quality: spec.lossless ? null : spec.quality,
    lossless: Boolean(spec.lossless),
    label: encodeLabel(spec),
    effort,
    width: Number(encoded.width),
    height: Number(encoded.height),
    size: Number(encoded.size)
  };
  if (!item.hash || !item.size) throw new Error('Encoder produced an invalid result');
  if (record) session.candidates.push(item);
  return item;
}

function selectSmallest(items) {
  return [...items].sort((a, b) => a.size - b.size)[0] || null;
}

function selectCurrent(session) {
  const lossless = session.candidates.find(item => item.lossless && item.size <= session.source.size * 0.90);
  return lossless || selectSmallest(session.candidates);
}

async function makeOriginalPreview(session) {
  if (BROWSER_EXTENSIONS.has(session.source.extension)) return;
  const path = join(TEMP_DIR, `${session.id}-original.webp`);
  await runEncodeWorker({
    sourcePath: session.source.path,
    outputPath: path,
    targetWidth: session.metadata.width,
    targetHeight: session.metadata.height,
    format: 'webp',
    quality: 100,
    lossless: true,
    effort: 'normal'
  });
  session.originalPreviewPath = path;
}

function startEncoding(session) {
  if (!session || session.status === 'encoding') return;
  activeEncodes++;
  session.status = 'encoding';
  session.updatedAt = Date.now();
  setImmediate(() => encodeSession(session));
}

function runPending() {
  if (activeEncodes >= MAX_ACTIVE || !pendingSession) return;
  const session = pendingSession;
  pendingSession = null;
  if (session.status === 'queued' && sessions.has(session.id)) startEncoding(session);
}

function queueLatest(session) {
  const previous = pendingSession;
  if (previous && previous.id !== session.id && previous.status === 'queued') {
    previous.status = 'superseded';
    previous.error = 'Replaced by newer preview settings';
    if (recentSessions.get(previous.cacheKey) === previous.id) recentSessions.delete(previous.cacheKey);
    sessions.delete(previous.id);
  }
  pendingSession = session;
}

async function encodeSession(session) {
  try {
    session.progress = { label: 'Reading image', done: 0, total: 1 };
    const metadata = await sharp(session.source.path, { failOn: 'warning', limitInputPixels: false, animated: false }).metadata();
    if (!metadata.width || !metadata.height) throw new Error('Could not read image dimensions');
    if (Number(metadata.pages || 1) > 1) throw Object.assign(new Error('Animated or multi-page images are not supported yet'), { status: 415 });
    if (metadata.depth && metadata.depth !== 'uchar') throw Object.assign(new Error('16-bit/HDR image replacement is not supported safely yet'), { status: 415 });
    if (String(metadata.space || '').toLowerCase() === 'cmyk') throw Object.assign(new Error('CMYK image replacement is not supported safely yet'), { status: 415 });
    session.metadata = { width: Number(metadata.width), height: Number(metadata.height) };
    const detectedPhoto = !metadata.hasAlpha && PHOTO_FORMATS.has(String(metadata.format || '').toLowerCase());
    session.photo = session.options.content === 'photo' || (session.options.content === 'auto' && detectedPhoto);
    session.target = targetDimensions(session.metadata.width, session.metadata.height, session.options);
    await makeOriginalPreview(session);

    const requested = session.options;
    const specs = [];
    if (requested.format === 'webp') {
      specs.push({ format: 'webp', quality: requested.quality, lossless: requested.lossless });
    } else if (requested.format === 'avif') {
      specs.push({ format: 'avif', quality: requested.quality, lossless: false });
    } else {
      if (LOSSLESS_FRIENDLY.has(session.source.extension)) specs.push({ format: 'webp', quality: 100, lossless: true });
      specs.push({ format: 'webp', quality: requested.quality, lossless: false });
      specs.push({ format: 'avif', quality: Math.max(1, requested.quality - AUTO_AVIF_QUALITY_OFFSET), lossless: false });
    }

    session.progress.total = specs.length;
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      session.progress = { label: `Encoding ${encodeLabel(spec)}`, done: index, total: specs.length };
      const item = await encodeCandidate(session, spec);
      session.progress.done = index + 1;
      // Publish the best result so far immediately. The browser can show WebP
      // while AVIF continues in the background without resetting the viewport.
      session.selectedId = selectCurrent(session)?.id || '';
      session.updatedAt = Date.now();

      if (requested.format === 'auto' && spec.lossless && item.size <= session.source.size * 0.75) break;
    }

    session.selectedId = selectCurrent(session)?.id || '';
    if (!session.selectedId) throw new Error('No compressed image was produced');
    session.status = 'ready';
    session.progress = null;
  } catch (error) {
    session.status = 'error';
    session.error = error?.message || String(error);
    if (recentSessions.get(session.cacheKey) === session.id) recentSessions.delete(session.cacheKey);
  } finally {
    session.updatedAt = Date.now();
    activeEncodes--;
    runPending();
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
    effort: item.effort,
    width: item.width,
    height: item.height,
    size: item.size,
    saved,
    percent: session.source.size ? saved / session.source.size * 100 : 0,
    url: `/api/image-optimize/file?id=${encodeURIComponent(session.id)}&kind=optimized&candidate=${encodeURIComponent(item.id)}`
  };
}

function publicOptions(options) {
  return {
    ...options,
    qualityPaint: options.qualityPaint ? {
      enabled: true,
      mode: options.qualityPaint.mode,
      lowQuality: options.qualityPaint.lowQuality,
      maskHash: options.qualityPaint.maskHash
    } : null
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
    targetWidth: session.target?.width || 0,
    targetHeight: session.target?.height || 0,
    options: publicOptions(session.options),
    progress: session.progress,
    originalUrl: `/api/image-optimize/file?id=${encodeURIComponent(session.id)}&kind=original`,
    selected: publicCandidate(session, selected),
    candidates: session.candidates.map(item => publicCandidate(session, item)),
    worthwhile: selected ? selected.size <= session.source.size * 0.95 && session.source.size - selected.size >= 256 * 1024 : false,
    result: session.result || null
  };
}

async function cleanupSession(session) {
  const paths = [
    session.originalPreviewPath,
    ...session.candidates.map(item => item.path),
    ...(session.finalPaths || [])
  ].filter(Boolean);
  await Promise.all(paths.map(path => unlink(path).catch(() => {})));
}

function cleanupExpired() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.updatedAt > cutoff || session.status === 'encoding' || session.status === 'queued') continue;
    sessions.delete(id);
    if (recentSessions.get(session.cacheKey) === id) recentSessions.delete(session.cacheKey);
    cleanupSession(session).catch(() => {});
  }
}
setInterval(cleanupExpired, 60_000).unref?.();

async function recentSession(key) {
  const id = recentSessions.get(key);
  const session = id ? sessions.get(id) : null;
  if (!session) {
    recentSessions.delete(key);
    return null;
  }
  if (session.status === 'encoding' || session.status === 'queued') {
    session.updatedAt = Date.now();
    return session;
  }
  if (session.status !== 'ready') {
    recentSessions.delete(key);
    return null;
  }
  const sourceInfo = await stat(session.source.path).catch(() => null);
  if (!sameStamp(sourceInfo, session.source)) {
    recentSessions.delete(key);
    return null;
  }
  const paths = [session.originalPreviewPath, ...session.candidates.map(item => item.path)].filter(Boolean);
  const available = await Promise.all(paths.map(path => stat(path).then(info => info.isFile()).catch(() => false)));
  if (available.some(value => !value)) {
    recentSessions.delete(key);
    return null;
  }
  session.updatedAt = Date.now();
  return session;
}

async function startSession(hash, rawOptions) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Object.assign(new Error('Invalid file'), { status: 400 });
  const normalized = normalizeOptions(rawOptions);
  const cacheKey = previewKey(hash, normalized);
  const cached = await recentSession(cacheKey);
  if (cached) return cached;

  const candidate = localCandidate(hash);
  if (!candidate) throw Object.assign(new Error('Image compression currently requires a local copy'), { status: 404 });
  const extension = extname(candidate.path).toLowerCase();
  if (!RASTER_EXTENSIONS.has(extension) || !String(candidate.mime || '').startsWith('image/')) {
    throw Object.assign(new Error('This image format is not supported for safe replacement yet'), { status: 415 });
  }
  const info = await stat(candidate.path).catch(() => null);
  if (!info?.isFile()) throw Object.assign(new Error('Local image is unavailable'), { status: 404 });

  const session = {
    id: randomUUID(),
    hash,
    cacheKey,
    status: activeEncodes < MAX_ACTIVE ? 'starting' : 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    options: normalized,
    metadata: null,
    photo: false,
    target: null,
    candidates: [],
    finalPaths: [],
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
  recentSessions.set(cacheKey, session.id);
  if (activeEncodes < MAX_ACTIVE) startEncoding(session);
  else queueLatest(session);
  return session;
}

function sessionFor(id) {
  const session = sessions.get(String(id || ''));
  if (!session) throw Object.assign(new Error('Compression preview expired'), { status: 404 });
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
    if (!candidate) throw Object.assign(new Error('Compressed preview is not ready'), { status: 404 });
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
  let target = oldExt.toLowerCase() === extension ? `${stem}.compressed${extension}` : `${stem}${extension}`;
  if (!await exists(target)) return target;
  for (let index = 2; index < 1000; index++) {
    target = `${stem}.compressed-${index}${extension}`;
    if (!await exists(target)) return target;
  }
  throw new Error('Could not choose an output filename');
}

async function commitSession(session, candidateId, mode) {
  if (session.status !== 'ready') throw Object.assign(new Error('Compression preview is not ready'), { status: 409 });
  if (!['keep', 'replace'].includes(mode)) throw Object.assign(new Error('Choose Keep both or Replace original'), { status: 400 });
  const candidate = session.candidates.find(item => item.id === candidateId) || session.candidates.find(item => item.id === session.selectedId);
  if (!candidate) throw Object.assign(new Error('Choose a compressed preview'), { status: 400 });

  const current = await stat(session.source.path).catch(() => null);
  if (!sameStamp(current, session.source)) {
    throw Object.assign(new Error('The original changed while the preview was open. Generate a new preview first.'), { status: 409 });
  }

  const candidateInfo = await stat(candidate.path).catch(() => null);
  if (!candidateInfo?.isFile() || Number(candidateInfo.size) !== Number(candidate.size)) throw new Error('Compressed file failed verification');

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
    throw new Error('Compressed copy failed verification');
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
  if (recentSessions.get(session.cacheKey) === session.id) recentSessions.delete(session.cacheKey);
  session.result = {
    mode,
    path: finalPath,
    filename: basename(finalPath),
    size: candidate.size,
    previewSize: candidate.size,
    hash: candidate.hash,
    saved: Math.max(0, session.source.size - candidate.size),
    format: candidate.format,
    width: candidate.width,
    height: candidate.height,
    effort: candidate.effort
  };
  session.updatedAt = Date.now();
  invalidateClientProviders();
  await cleanupSession(session);
  return session.result;
}

export async function handleImageOptimizeApi(req, res, url) {
  if (!url.pathname.startsWith('/api/image-optimize/')) return false;

  if (req.method === 'POST' && url.pathname === '/api/image-optimize/start') {
    const body = await readJson(req, 256 * 1024);
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