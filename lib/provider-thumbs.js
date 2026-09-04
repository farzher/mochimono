import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, setPriority } from 'node:os';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { currentJob, settings } from './agent-context.js';
import { backgroundWorkAllowed, backgroundWorkStatus, noteBackgroundActivity } from './background-work.js';

const DIR = join(homedir(), '.mochimono', 'provider-thumbs');
const THUMB_VERSION = 3;
const EDGE = 768;
const CPU_COUNT = Math.max(1, availableParallelism());
const CONFIGURED_WORKERS = Number(process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS) || 0;
const MAX_WORKERS = Math.max(1, Math.min(64, CONFIGURED_WORKERS || CPU_COUNT));
const INTERACTIVE_WORKERS = CONFIGURED_WORKERS
  ? MAX_WORKERS
  : Math.max(1, Math.min(MAX_WORKERS, 8, Math.ceil(CPU_COUNT / 2)));
const CONFIGURED_VIDEO_WORKERS = Number(process.env.MOCHIMONO_PROVIDER_THUMBNAIL_VIDEO_WORKERS) || 0;
const MAX_VIDEO_WORKERS = Math.max(1, Math.min(MAX_WORKERS, CONFIGURED_VIDEO_WORKERS || MAX_WORKERS));
const INTERACTIVE_VIDEO_WORKERS = 1;
const READY_CACHE_MAX = 200_000;
const MISSING_CACHE_MAX = 32_768;
const MAX_QUEUE = 320;
const MAX_BACKGROUND_QUEUE = Math.max(512, MAX_WORKERS * 16);
const queue = new Map();
const backgroundQueue = new Map();
const running = new Set();
const failedUntil = new Map();
const warnedFailures = new Map();
const readyCache = new Map();
const missingCache = new Set();
const ownerQueued = new Map();
const ownerActive = new Map();
const ownerCompleted = new Map();
const ownerLastCompletedAt = new Map();
let active = 0;
let activeVideo = 0;
let activeInteractive = 0;
let activeInteractiveVideo = 0;
let activeBackground = 0;
let activeBackgroundVideo = 0;
let sharpPromise = null;
let ffmpegPromise = null;

const IMAGE = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.avif','.bmp','.tif','.tiff']);
const VIDEO = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);
const HEIF = new Set(['.heic','.heif']);
const bucketFor = hash => join(DIR, String(hash).slice(0, 2));
const pathFor = hash => join(bucketFor(hash), `${hash}.webp`);
const infoPath = hash => join(bucketFor(hash), `${hash}.json`);
const ownerFor = file => String(file?.owner || '');

function bumpOwner(map, owner, amount) {
  owner = String(owner || '');
  if (!owner) return;
  const next = (Number(map.get(owner)) || 0) + amount;
  if (next > 0) map.set(owner, next);
  else map.delete(owner);
}

function completeOwner(file) {
  const owner = ownerFor(file);
  if (!owner) return;
  ownerCompleted.set(owner, (Number(ownerCompleted.get(owner)) || 0) + 1);
  ownerLastCompletedAt.set(owner, Date.now());
}

const policyTimer = setInterval(() => {
  if (settings.thumbnailMode === 'idle') pump();
}, 1000);
policyTimer.unref?.();

function kind(file) {
  const base = String(file?.mime || '').split('/')[0];
  if (base === 'image' || base === 'video') return base;
  const extension = extname(file?.filename || '').toLowerCase();
  if (IMAGE.has(extension)) return 'image';
  if (VIDEO.has(extension)) return 'video';
  return '';
}

function rememberReady(hash, thumb) {
  missingCache.delete(hash);
  readyCache.delete(hash);
  readyCache.set(hash, thumb);
  while (readyCache.size > READY_CACHE_MAX) readyCache.delete(readyCache.keys().next().value);
  return thumb;
}

function rememberMissing(hash) {
  missingCache.delete(hash);
  missingCache.add(hash);
  while (missingCache.size > MISSING_CACHE_MAX) missingCache.delete(missingCache.values().next().value);
}

async function validCandidate(candidate) {
  if (!candidate?.path) return null;
  try {
    const info = await stat(candidate.path);
    if (!info.isFile()) return null;
    if (Number(candidate.size) > 0 && Number(info.size) !== Number(candidate.size)) return null;
    return candidate;
  } catch { return null; }
}

async function sharp() {
  if (!sharpPromise) sharpPromise = import('sharp').then(module => {
    const library = module.default || module;
    library.concurrency(1);
    library.cache({ memory: 32, files: 0, items: 24 });
    return library;
  });
  return sharpPromise;
}

async function ffmpeg() {
  if (!ffmpegPromise) ffmpegPromise = (async () => {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try { return (await import('ffmpeg-static')).default || 'ffmpeg'; }
    catch { return 'ffmpeg'; }
  })();
  return ffmpegPromise;
}

async function imageThumb(input) {
  const library = await sharp();
  return library(input).rotate().resize({ width: EDGE, height: EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 2, smartSubsample: true }).toBuffer({ resolveWithObject: true });
}

async function videoFrame(input, output, seek = .5) {
  const binary = await ffmpeg();
  await new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [
      '-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1',
      ...(seek > 0 ? ['-ss', String(seek)] : []),
      '-i',input,'-an','-sn','-dn',
      '-vf',`scale=w='min(${EDGE},iw)':h='min(${EDGE},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v','1','-q:v','3','-y',output
    ], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    try { setPriority(child.pid, settings.thumbnailMode === 'max' ? 0 : 10); } catch {}
    let stderr = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolvePromise();
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Preview generation timed out')); }, 20_000);
    child.stderr.on('data', chunk => { if (stderr.length < 32 * 1024) stderr += chunk.toString(); });
    child.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error(stderr.trim() || `FFmpeg exited with ${code}`)));
  });
}

function shortError(error) {
  return String(error?.message || error).split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ');
}

async function imageFileThumb(file, candidate, frame) {
  try {
    return await imageThumb(candidate.path);
  } catch (primaryError) {
    const extension = extname(file?.filename || candidate.path || '').toLowerCase();
    if (!HEIF.has(extension)) throw primaryError;
    try {
      await videoFrame(candidate.path, frame, 0);
      return await imageThumb(frame);
    } catch (fallbackError) {
      const error = new Error(`HEIF decode failed (sharp: ${shortError(primaryError)}; ffmpeg: ${shortError(fallbackError)})`);
      error.code = 'HEIF_DECODE_FAILED';
      throw error;
    }
  }
}

async function generate(file, candidate) {
  const directory = bucketFor(file.hash);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `${file.hash}.${process.pid}.${Date.now()}.tmp.webp`);
  const frame = join(directory, `${file.hash}.${process.pid}.${Date.now()}.jpg`);
  try {
    let result;
    if (kind(file) === 'video') {
      try { await videoFrame(candidate.path, frame, .5); }
      catch { await videoFrame(candidate.path, frame, 0); }
      result = await imageThumb(frame);
    } else result = await imageFileThumb(file, candidate, frame);

    const width = result.info.width || 0;
    const height = result.info.height || 0;
    await writeFile(temp, result.data);
    readyCache.delete(file.hash);
    await rm(pathFor(file.hash), { force: true });
    await rename(temp, pathFor(file.hash));
    await writeFile(infoPath(file.hash), `${JSON.stringify({ version: THUMB_VERSION, width, height })}\n`);
    rememberReady(file.hash, { hash: file.hash, path: pathFor(file.hash), size: result.data.length, width, height });
  } finally {
    await rm(temp, { force: true }).catch(() => {});
    await rm(frame, { force: true }).catch(() => {});
  }
}

function failureDelay(error) {
  const message = String(error?.message || error);
  if (error?.code === 'ENOENT' || /(?:ffmpeg|sharp).*(?:not found|enoent|cannot find package)/i.test(message)) return 60_000;
  if (error?.code === 'HEIF_DECODE_FAILED') return Infinity;
  if (/invalid data found|moov atom not found|could not find codec parameters|unsupported codec|invalid nal|corrupt|damaged|bad seek|heif: decoder plugin generated an error/i.test(message)) return Infinity;
  return 5 * 60_000;
}

async function processThumbnail(file) {
  try {
    if (await providerThumbnail(file.hash)) return;
    const candidate = await validCandidate(file.candidate);
    if (!candidate) {
      failedUntil.set(file.hash, Date.now() + 5000);
      return;
    }
    await generate(file, candidate);
    failedUntil.delete(file.hash);
    warnedFailures.delete(file.hash);
  } catch (error) {
    const message = String(error?.message || error);
    const previous = warnedFailures.get(file.hash);
    if (previous !== message) {
      warnedFailures.set(file.hash, message);
      console.warn(`Mochimono provider preview failed for ${file.filename || file.hash.slice(0, 12)}: ${message}`);
    }
    const delay = failureDelay(error);
    failedUntil.set(file.hash, delay === Infinity ? Infinity : Date.now() + delay);
  }
}

function nextUrgent() {
  if (activeInteractive >= INTERACTIVE_WORKERS) return null;
  let selected = null;
  for (const [hash, file] of queue) {
    if (kind(file) === 'video' && activeInteractiveVideo >= INTERACTIVE_VIDEO_WORKERS) continue;
    selected = [hash, file];
  }
  if (!selected) return null;
  queue.delete(selected[0]);
  bumpOwner(ownerQueued, ownerFor(selected[1]), -1);
  return { file: selected[1], background: false };
}

function backgroundLimits() {
  if (settings.thumbnailMode === 'off') return { workers: 0, videos: 0 };
  if (settings.thumbnailMode === 'idle') {
    if (currentJob()?.status === 'running' || !backgroundWorkAllowed()) return { workers: 0, videos: 0 };
    return { workers: 1, videos: 1 };
  }
  return { workers: MAX_WORKERS, videos: MAX_VIDEO_WORKERS };
}

function nextBackground() {
  const limits = backgroundLimits();
  if (!limits.workers || activeBackground >= limits.workers) return null;
  for (const [hash, file] of backgroundQueue) {
    if (kind(file) === 'video' && activeBackgroundVideo >= limits.videos) continue;
    backgroundQueue.delete(hash);
    bumpOwner(ownerQueued, ownerFor(file), -1);
    return { file, background: true };
  }
  return null;
}

function nextFile() {
  return nextUrgent() || nextBackground();
}

function pump() {
  while (active < MAX_WORKERS) {
    const picked = nextFile();
    if (!picked) return;
    const { file, background } = picked;
    const video = kind(file) === 'video';
    const owner = ownerFor(file);
    running.add(file.hash);
    active++;
    bumpOwner(ownerActive, owner, 1);
    if (video) activeVideo++;
    if (background) {
      activeBackground++;
      if (video) activeBackgroundVideo++;
    } else {
      activeInteractive++;
      if (video) activeInteractiveVideo++;
    }
    processThumbnail(file).finally(() => {
      running.delete(file.hash);
      active--;
      bumpOwner(ownerActive, owner, -1);
      completeOwner(file);
      if (video) activeVideo--;
      if (background) {
        activeBackground--;
        if (video) activeBackgroundVideo--;
      } else {
        activeInteractive--;
        if (video) activeInteractiveVideo--;
      }
      pump();
    });
  }
}

function makeUrgentRoom() {
  if (queue.size < MAX_QUEUE) return;
  const stale = queue.keys().next().value;
  if (!stale) return;
  const file = queue.get(stale);
  queue.delete(stale);
  bumpOwner(ownerQueued, ownerFor(file), -1);
}

export function noteProviderThumbnailActivity() {
  noteBackgroundActivity();
}

export function refreshProviderThumbnailPolicy() {
  pump();
}

export function queueProviderThumbnail(file, options = {}) {
  const hash = String(file?.hash || '');
  const background = options === true || options?.background === true;
  const owner = String(options?.owner || file?.owner || '');
  const item = { ...file, hash, ...(owner ? { owner } : {}) };
  if (!hash || !kind(file) || running.has(hash) || (failedUntil.get(hash) || 0) > Date.now()) return false;
  if (background && settings.thumbnailMode === 'off') return false;

  if (!background && queue.has(hash)) {
    const queued = queue.get(hash);
    queue.delete(hash);
    queue.set(hash, { ...queued, ...item });
    pump();
    return true;
  }
  if (background && queue.has(hash)) return false;

  if (!background && backgroundQueue.has(hash)) {
    makeUrgentRoom();
    const queued = backgroundQueue.get(hash);
    backgroundQueue.delete(hash);
    queue.set(hash, { ...queued, ...item });
    pump();
    return true;
  }
  if (backgroundQueue.has(hash)) return false;

  if (!background) {
    makeUrgentRoom();
    queue.set(hash, item);
    pump();
    return true;
  }

  if (backgroundQueue.size >= MAX_BACKGROUND_QUEUE) return false;
  backgroundQueue.set(hash, item);
  bumpOwner(ownerQueued, owner, 1);
  pump();
  return true;
}

export function providerThumbnailQueueStatus(owner = '') {
  const limits = backgroundLimits();
  const policy = backgroundWorkStatus();
  owner = String(owner || '');
  return {
    mode: settings.thumbnailMode,
    workers: MAX_WORKERS,
    videoWorkers: MAX_VIDEO_WORKERS,
    backgroundLimit: limits.workers,
    backgroundVideoLimit: limits.videos,
    active,
    activeVideo,
    urgent: queue.size,
    background: backgroundQueue.size,
    backgroundActive: activeBackground,
    backgroundWaiting: Boolean(backgroundQueue.size && settings.thumbnailMode === 'idle' && !policy.allowed),
    ownerQueued: owner ? Number(ownerQueued.get(owner)) || 0 : 0,
    ownerActive: owner ? Number(ownerActive.get(owner)) || 0 : 0,
    ownerCompleted: owner ? Number(ownerCompleted.get(owner)) || 0 : 0,
    ownerLastCompletedAt: owner ? Number(ownerLastCompletedAt.get(owner)) || 0 : 0,
    cpuLoad: policy.cpuLoad,
    idleMs: policy.idleMs,
    inputSource: policy.inputSource
  };
}

export function providerThumbnailFailure(hash) {
  hash = String(hash || '');
  const until = failedUntil.get(hash) || 0;
  const now = Date.now();
  if (!until || until <= now) {
    if (until && until !== Infinity) failedUntil.delete(hash);
    return null;
  }
  return {
    hash,
    terminal: until === Infinity,
    retryAfterMs: until === Infinity ? null : Math.max(1, until - now)
  };
}

export async function providerThumbnail(hash) {
  hash = String(hash);
  const cached = readyCache.get(hash);
  if (cached) return rememberReady(hash, cached);
  if (missingCache.has(hash)) return null;
  const path = pathFor(hash);
  if (!existsSync(path)) {
    rememberMissing(hash);
    return null;
  }
  try {
    const [file, raw] = await Promise.all([stat(path), readFile(infoPath(hash), 'utf8').catch(() => '{}')]);
    if (!file.isFile() || !file.size) {
      rememberMissing(hash);
      return null;
    }
    const info = JSON.parse(raw || '{}');
    if (Number(info.version) !== THUMB_VERSION) {
      readyCache.delete(hash);
      await Promise.all([rm(path, { force: true }), rm(infoPath(hash), { force: true })]);
      rememberMissing(hash);
      return null;
    }
    return rememberReady(hash, { hash, path, size: file.size, width: Number(info.width) || 0, height: Number(info.height) || 0 });
  } catch {
    readyCache.delete(hash);
    rememberMissing(hash);
    return null;
  }
}

export async function serveProviderThumbnail(req, res, hash) {
  const thumb = await providerThumbnail(hash);
  if (!thumb) return false;

  const etag = `\"${hash}-provider-thumb-${THUMB_VERSION}\"`;
  const cacheControl = 'private, max-age=31536000, immutable';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cacheControl });
    res.end();
    return true;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'content-type': 'image/webp', 'content-length': thumb.size,
      'cache-control': cacheControl, etag
    });
    res.end();
    return true;
  }

  const source = createReadStream(thumb.path);
  let opened = false;
  source.once('open', () => {
    opened = true;
    if (res.destroyed) return source.destroy();
    res.writeHead(200, {
      'content-type': 'image/webp', 'content-length': thumb.size,
      'cache-control': cacheControl, etag
    });
    source.pipe(res);
  });
  source.once('error', error => {
    readyCache.delete(hash);
    if (!opened && !res.headersSent && !res.destroyed) {
      res.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'cache-control': 'no-store' });
      res.end();
    } else if (!res.destroyed) res.destroy(error);
  });
  res.once('close', () => {
    if (!source.destroyed) source.destroy();
  });
  return true;
}
