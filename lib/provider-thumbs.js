import { createReadStream, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, setPriority } from 'node:os';
import { basename, extname, join } from 'node:path';
import { withDriveRead } from './drive-read.js';
import isolatedSharp from './sharp-provider-proxy.js';
import { previewState } from './preview-state.js';
import { commitReadHash, contentForPath, previewAliases } from './local-content.js';
import { spawn } from 'node:child_process';
import { CONFIG_DIR, currentJob, settings } from './agent-context.js';
import { backgroundWorkAllowed, backgroundWorkStatus, noteBackgroundActivity } from './background-work.js';
import { decodeHeic } from './heic.js';

const DIR = join(CONFIG_DIR, 'provider-thumbs');
const THUMB_VERSION = 1;
const EDGE = 1080;
const QUALITY = 83;
const EFFORT = 4;
const CPU_COUNT = Math.max(1, availableParallelism());
const CONFIGURED_WORKERS = Number(process.env.MOCHIMONO_PROVIDER_THUMBNAIL_WORKERS) || 0;
const MAX_WORKERS = Math.max(1, Math.min(16, CONFIGURED_WORKERS || Math.min(8, Math.ceil(CPU_COUNT / 2))));
const INTERACTIVE_WORKERS = CONFIGURED_WORKERS ? MAX_WORKERS : Math.max(1, Math.min(MAX_WORKERS, 8, Math.ceil(CPU_COUNT / 2)));
const BACKGROUND_WORKERS = MAX_WORKERS > 1 ? MAX_WORKERS - 1 : 1;
const CONFIGURED_VIDEO_WORKERS = Number(process.env.MOCHIMONO_PROVIDER_THUMBNAIL_VIDEO_WORKERS) || 0;
const MAX_VIDEO_WORKERS = Math.max(1, Math.min(MAX_WORKERS, CONFIGURED_VIDEO_WORKERS || 2));
const INTERACTIVE_VIDEO_WORKERS = 1;
const READY_CACHE_MAX = 200_000;
const MISSING_CACHE_MAX = 32_768;
const MISSING_TTL_MS = 30_000;
const MAX_THUMBNAIL_ATTEMPTS = 3;
const MAX_QUEUE = 320;
const MAX_BACKGROUND_QUEUE = Math.max(512, MAX_WORKERS * 16);
const queue = new Map();
const backgroundQueue = new Map();
const running = new Set();
const waiters = new Map();
const failedUntil = new Map();
const warnedFailures = new Map();
const readyCache = new Map();
const missingCache = new Map();
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
let ffmpegPromise = null;

const IMAGE = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.avif','.bmp','.tif','.tiff']);
const VIDEO = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);
const HEIF = new Set(['.heic','.heif']);
const bucketFor = hash => join(DIR, String(hash).slice(0, 2));
const pathFor = hash => join(bucketFor(hash), `${hash}.webp`);
const ownerFor = file => String(file?.owner || '');


function webpDimensions(buffer) {
  if (buffer.length < 25 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return { width:0, height:0 };
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return { width:buffer.readUIntLE(24, 3) + 1, height:buffer.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    return {
      width:1 + buffer[21] + ((buffer[22] & 0x3f) << 8),
      height:1 + ((buffer[22] & 0xc0) >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10)
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width:buffer.readUInt16LE(26) & 0x3fff, height:buffer.readUInt16LE(28) & 0x3fff };
  }
  return { width:0, height:0 };
}

async function inspectThumbnail(path) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size) return null;
    const header = Buffer.allocUnsafe(Math.min(30, info.size));
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (bytes.length < 12 || bytes.readUInt32LE(4) + 8 !== info.size) return null;
    return { size:info.size, ...webpDimensions(bytes) };
  } finally {
    await file.close();
  }
}

// A local index is not a complete list of Cloud/browser previews. Never infer
// cache deletion from absence there; previews remain useful when sources leave.
const cacheReady = mkdir(DIR, { recursive:true });
process.on('mochimono:browser-preview-saved', hash => {
  readyCache.delete(String(hash));
  missingCache.delete(String(hash));
  process.emit('mochimono:preview-cache-changed');
});

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
  pump();
}, 1000);
policyTimer.unref?.();

function kind(file) {
  const filename = String(file?.filename || '');
  if (/\.d\.(?:mts|cts|ts)$/i.test(filename)) return '';
  const mime = String(file?.mime || '').trim().toLowerCase();
  const base = mime.split('/')[0];
  if (base === 'image' || base === 'video') return base;
  if (mime && mime !== 'application/octet-stream') return '';
  const extension = extname(filename).toLowerCase();
  if (IMAGE.has(extension)) return 'image';
  if (VIDEO.has(extension)) return 'video';
  return '';
}

function rememberReady(hash, thumb) {
  missingCache.delete(hash);
  readyCache.delete(hash);
  if (!thumb.checkedAt) thumb.checkedAt = Date.now();
  thumb.storageHash = basename(thumb.path, '.webp');
  readyCache.set(hash, thumb);
  while (readyCache.size > READY_CACHE_MAX) readyCache.delete(readyCache.keys().next().value);
  return thumb;
}

function rememberMissing(hash) {
  missingCache.delete(hash);
  missingCache.set(hash, Date.now());
  while (missingCache.size > MISSING_CACHE_MAX) missingCache.delete(missingCache.keys().next().value);
}

async function validCandidate(candidate) {
  if (!candidate?.path) return null;
  try {
    const info = await stat(candidate.path);
    if (!info.isFile()) return null;
    if (Number(info.size) !== Number(candidate.size)) return null;
    if (Number.isFinite(candidate.mtimeMs) && Math.trunc(info.mtimeMs) !== candidate.mtimeMs) return null;
    return candidate;
  } catch { return null; }
}

const sharp = async () => isolatedSharp;

async function ffmpeg() {
  if (!ffmpegPromise) ffmpegPromise = (async () => {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try { return (await import('ffmpeg-static')).default || 'ffmpeg'; }
    catch { return 'ffmpeg'; }
  })();
  return ffmpegPromise;
}

async function imageThumb(input, checkBlank = false, hashSource = false, options = {}) {
  const library = await sharp();
  return library(input)
    .rotate()
    .resize({ width:EDGE, height:EDGE, fit:'inside', withoutEnlargement:true })
    .webp({ quality:QUALITY, effort:EFFORT, smartSubsample:true })
    .toBuffer({ resolveWithObject:true, checkBlank, hashSource, ...options });
}

async function videoFrame(input, output, seek = .5, priority = false) {
  const binary = await ffmpeg();
  return withDriveRead(input, () => new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [
      '-nostdin','-hide_banner','-loglevel','info','-threads','1','-filter_threads','1',
      ...(seek > 0 ? ['-ss', String(seek)] : []),
      '-i',input,'-an','-sn','-dn',
      '-vf',`scale=w='min(${EDGE},iw)':h='min(${EDGE},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v','1','-q:v','3','-y',output
    ], { windowsHide:true, stdio:['ignore','ignore','pipe'] });
    try { setPriority(child.pid, 10); } catch {}
    let stderr = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
      error ? reject(error) : resolvePromise(duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Preview generation timed out')); }, 20_000);
    child.stderr.on('data', chunk => { if (stderr.length < 32 * 1024) stderr += chunk.toString(); });
    child.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error(stderr.trim() || `FFmpeg exited with ${code}`)));
  }), { priority }).then(async duration => {
    const frame = await stat(output).catch(() => null);
    if (!frame?.size) throw Object.assign(new Error('Video contains no decodable frame'), { code:'NO_VIDEO_FRAME' });
    return duration;
  });
}

function shortError(error) {
  return String(error?.message || error).split(/\r?\n/).filter(Boolean).slice(0, 2).join(' | ');
}

async function imageFileThumb(file, candidate, frame, hashSource) {
  try {
    return await imageThumb(candidate.path, false, hashSource, {
      driveRead:{ priority:!file.background },
      lowPriority:file.background
    });
  } catch (primaryError) {
    const extension = extname(file?.filename || candidate.path || '').toLowerCase();
    if (!HEIF.has(extension) && !/^image\/hei[cf]$/i.test(String(file?.mime || ''))) throw primaryError;
    try {
      const result = await withDriveRead(candidate.path,
        () => decodeHeic(candidate.path, { edge:EDGE, quality:QUALITY, effort:EFFORT }), { priority:!file.background });
      result.info.contentHash = primaryError.contentHash || '';
      return result;
    } catch (portableError) {
      try {
        await videoFrame(candidate.path, frame, 0, !file.background);
        const result = await imageThumb(frame, false, false, { lowPriority:file.background });
        result.info.contentHash = primaryError.contentHash || '';
        return result;
      } catch (fallbackError) {
        const error = new Error(`HEIF decode failed (sharp: ${shortError(primaryError)}; portable: ${shortError(portableError)}; ffmpeg: ${shortError(fallbackError)})`);
        error.code = 'HEIF_DECODE_FAILED';
        error.contentHash = primaryError.contentHash || '';
        throw error;
      }
    }
  }
}

async function generate(file, candidate) {
  await cacheReady;
  const directory = bucketFor(file.hash);
  await mkdir(directory, { recursive:true });
  const frame = join(directory, `${file.hash}.${process.pid}.${Date.now()}.jpg`);
  try {
    let result;
    const knownHash = contentForPath(candidate.path, candidate.size, candidate.mtimeMs);
    if (kind(file) === 'video') {
      const options = { lowPriority:file.background };
      let duration;
      try { duration = await videoFrame(candidate.path, frame, .5, !file.background); }
      catch { duration = await videoFrame(candidate.path, frame, 0, !file.background); }
      result = await imageThumb(frame, true, false, options);
      if (result.info.blank) for (const seek of [2, 8]) {
        try {
          await videoFrame(candidate.path, frame, seek, !file.background);
          const later = await imageThumb(frame, true, false, options);
          if (!later.info.blank) { result = later; break; }
        } catch {}
      }
      result.duration = duration;
    } else result = await imageFileThumb(file, candidate, frame, !knownHash);
    if (!await validCandidate(candidate)) throw new Error('Source changed during preview generation');
    if (file.candidate?.kind === 'backup' && result.info.contentHash && result.info.contentHash !== file.hash) {
      throw new Error('Backup content hash verification failed');
    }
    const contentHash = knownHash || result.info.contentHash || '';
    const thumb = await saveProviderThumbnail(contentHash || file.hash, result);
    if (thumb.hash !== file.hash) {
      const alias = rememberReady(file.hash, { ...thumb, hash:file.hash });
      previewState.ready(alias);
    }
    if (contentHash) commitReadHash(candidate.path, candidate.size, candidate.mtimeMs, contentHash);
  } finally {
    await rm(frame, { force:true }).catch(() => {});
  }
}

export async function saveProviderThumbnail(hash, result) {
  await cacheReady;
  const width = Number(result.info.width) || 0;
  const height = Number(result.info.height) || 0;
  if (!width || !height || !result.data?.length) throw new Error('Preview is empty');
  await mkdir(bucketFor(hash), { recursive:true });
  const temp = join(bucketFor(hash), `${hash}.${process.pid}.${randomUUID()}.tmp.webp`);
  try {
    await writeFile(temp, result.data, { flag:'wx' });
    // Rename installs the complete output before any durable ready state.
    await rename(temp, pathFor(hash));
    const thumb = rememberReady(hash, { hash, path:pathFor(hash), size:result.data.length, width, height, duration:result.duration ?? null });
    previewState.ready(thumb);
    process.emit('mochimono:preview-cache-changed');
    return thumb;
  } finally { await rm(temp, { force:true }).catch(() => {}); }
}

function failureDelay(error) {
  const message = String(error?.message || error);
  if (['ENOENT','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(error?.code) || /(?:ffmpeg|sharp).*(?:not found|enoent|cannot find package)/i.test(message)) return 60_000;
  if (['HEIF_DECODE_FAILED','NO_VIDEO_FRAME','INVALID_MEDIA'].includes(error?.code)) return Infinity;
  if (/invalid data found|moov atom not found|could not find codec parameters|unsupported codec|unsupported image format|input buffer is empty|output file does not contain any stream|invalid nal|corrupt|damaged|bad seek|heif: decoder plugin generated an error/i.test(message)) return Infinity;
  return 5 * 60_000;
}

async function processThumbnail(file) {
  try {
    if (await providerThumbnail(file.hash)) return true;
    if (!file.candidate?.path) return false;
    const candidate = await validCandidate(file.candidate);
    if (!candidate) throw Object.assign(new Error('Source unavailable or changed'), { code:'ENOENT' });
    if (!candidate.size) throw Object.assign(new Error('Source file is empty'), { code:'INVALID_MEDIA' });
    await generate(file, candidate);
    failedUntil.delete(file.hash);
    warnedFailures.delete(file.hash);
    return true;
  } catch (error) {
    if (error.contentHash && await validCandidate(file.candidate)) {
      commitReadHash(file.candidate.path, file.candidate.size, file.candidate.mtimeMs, error.contentHash);
    }
    const message = String(error?.message || error);
    if (warnedFailures.get(file.hash) !== message) {
      warnedFailures.set(file.hash, message);
      console.warn(`Mochimono provider preview failed for ${file.filename || file.hash.slice(0, 12)}: ${message}`);
    }
    // A local id and its content hash represent the same attempt, not two
    // independent retry budgets. Persist the budget so restarts cannot reset it.
    const contentHash = error.contentHash || (file.candidate?.path
      ? contentForPath(file.candidate.path, file.candidate.size, file.candidate.mtimeMs) : '');
    const aliases = [...new Set([file.hash, contentHash].filter(Boolean))];
    const attempts = Math.max(...aliases.map(hash => previewState.attempts(hash))) + 1;
    const delay = failureDelay(error);
    const until = delay === Infinity || attempts >= MAX_THUMBNAIL_ATTEMPTS ? Infinity : Date.now() + delay;
    for (const hash of aliases) {
      failedUntil.set(hash, until);
      previewState.failed(hash, until, message, attempts);
    }
    return false;
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
  return { file:selected[1], background:false };
}

function backgroundLimits() {
  if (settings.workMode === 'idle') {
    if (currentJob()?.status === 'running' || !backgroundWorkAllowed()) return { workers:0, videos:0 };
    return { workers:1, videos:1 };
  }
  return { workers:BACKGROUND_WORKERS, videos:Math.min(MAX_VIDEO_WORKERS, BACKGROUND_WORKERS) };
}

function nextBackground() {
  const limits = backgroundLimits();
  if (!limits.workers || activeBackground >= limits.workers) return null;
  let selected = null;
  let selectedLoad = Infinity;
  for (const [hash, file] of backgroundQueue) {
    if (kind(file) === 'video' && activeBackgroundVideo >= limits.videos) continue;
    const owner = ownerFor(file);
    const load = owner ? Number(ownerActive.get(owner)) || 0 : activeBackground;
    if (!selected || load < selectedLoad) {
      selected = [hash, file];
      selectedLoad = load;
      if (load === 0) break;
    }
  }
  if (!selected) return null;
  const owner = ownerFor(selected[1]);
  backgroundQueue.delete(selected[0]);
  bumpOwner(ownerQueued, owner, -1);
  return { file:selected[1], background:true };
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
    processThumbnail({ ...file, background }).then(success => {
      if (success) completeOwner(file);
      const callbacks = waiters.get(file.hash);
      waiters.delete(file.hash);
      for (const resolve of callbacks || []) resolve(success ? readyCache.get(file.hash) : null);
    }).finally(() => {
      running.delete(file.hash);
      active--;
      bumpOwner(ownerActive, owner, -1);
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
  const owner = ownerFor(file);
  if (owner && backgroundQueue.size < MAX_BACKGROUND_QUEUE) {
    backgroundQueue.set(stale, file);
    return;
  }
  bumpOwner(ownerQueued, owner, -1);
  for (const resolve of waiters.get(stale) || []) resolve(null);
  waiters.delete(stale);
}

export async function ensureProviderThumbnail(file) {
  const cached = await providerThumbnail(file.hash);
  if (cached) return cached;
  if (providerThumbnailFailure(file.hash)) return null;
  return new Promise(resolve => {
    let group = waiters.get(file.hash);
    if (!group) waiters.set(file.hash, group = new Set());
    group.add(resolve);
    const queued = queueProviderThumbnail(file);
    if (!queued && !running.has(file.hash) && !queue.has(file.hash) && !backgroundQueue.has(file.hash)) {
      group.delete(resolve);
      if (!group.size) waiters.delete(file.hash);
      resolve(null);
    }
  });
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
  if (!hash || !kind(file) || readyCache.has(hash) || running.has(hash) || providerThumbnailFailure(hash)) return false;
  if (!background && queue.has(hash)) {
    const queued = queue.get(hash);
    const merged = { ...queued, ...item };
    if (ownerFor(queued) !== ownerFor(merged)) {
      bumpOwner(ownerQueued, ownerFor(queued), -1);
      bumpOwner(ownerQueued, ownerFor(merged), 1);
    }
    queue.delete(hash);
    queue.set(hash, merged);
    pump();
    return true;
  }
  if (background && queue.has(hash)) return false;
  if (!background && backgroundQueue.has(hash)) {
    makeUrgentRoom();
    const queued = backgroundQueue.get(hash);
    const merged = { ...queued, ...item };
    if (ownerFor(queued) !== ownerFor(merged)) {
      bumpOwner(ownerQueued, ownerFor(queued), -1);
      bumpOwner(ownerQueued, ownerFor(merged), 1);
    }
    backgroundQueue.delete(hash);
    queue.set(hash, merged);
    pump();
    return true;
  }
  if (backgroundQueue.has(hash)) return false;
  if (!background) {
    makeUrgentRoom();
    queue.set(hash, item);
    bumpOwner(ownerQueued, owner, 1);
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
    mode:settings.workMode,
    workers:MAX_WORKERS,
    videoWorkers:MAX_VIDEO_WORKERS,
    backgroundLimit:limits.workers,
    backgroundVideoLimit:limits.videos,
    active,
    activeVideo,
    urgent:queue.size,
    background:backgroundQueue.size,
    backgroundActive:activeBackground,
    backgroundWaiting:Boolean(backgroundQueue.size && settings.workMode === 'idle' && !policy.allowed),
    ownerQueued:owner ? Number(ownerQueued.get(owner)) || 0 : 0,
    ownerActive:owner ? Number(ownerActive.get(owner)) || 0 : 0,
    ownerCompleted:owner ? Number(ownerCompleted.get(owner)) || 0 : 0,
    ownerLastCompletedAt:owner ? Number(ownerLastCompletedAt.get(owner)) || 0 : 0,
    ownerDriveBlocked:false,
    cpuLoad:policy.cpuLoad,
    idleMs:policy.idleMs,
    inputSource:policy.inputSource
  };
}

export function providerThumbnailFailure(hash) {
  hash = String(hash || '');
  const persisted = previewState.get(hash)?.retry_at || 0;
  const until = failedUntil.get(hash) || (persisted === -1 ? Infinity : persisted);
  const now = Date.now();
  if (!until || until <= now) {
    if (until && until !== Infinity) failedUntil.delete(hash);
    return null;
  }
  return { hash, terminal:until === Infinity, retryAfterMs:until === Infinity ? null : Math.max(1, until - now) };
}

export function resetProviderThumbnailFailure(hash) {
  const stored = previewState.get(hash);
  if (!stored?.error || stored.size) return;
  previewState.forget(hash);
  failedUntil.delete(hash);
  warnedFailures.delete(hash);
  missingCache.delete(hash);
}

export async function reuseProviderThumbnail(fromHash, hash) {
  if (!fromHash || fromHash === hash || await providerThumbnail(hash)) return;
  const source = await providerThumbnail(fromHash);
  if (!source) {
    // Hash promotion must preserve failures and their retry budget too.
    const failure = previewState.get(fromHash);
    if (failure?.error && !failure.size) {
      const attempts = Math.max(previewState.attempts(fromHash), previewState.attempts(hash));
      const until = failure.retry_at === -1 ? Infinity : failure.retry_at;
      previewState.failed(hash, until, failure.error, attempts);
      failedUntil.set(hash, until);
    }
    return;
  }
  // Hash promotion aliases one stored output; it does not copy or regenerate it.
  const thumb = rememberReady(hash, { ...source, hash });
  previewState.ready(thumb);
}

export async function providerThumbnail(hash, findAliases = true) {
  await cacheReady;
  hash = String(hash);
  const cached = readyCache.get(hash);
  if (cached && Date.now() - cached.checkedAt < 30_000) return rememberReady(hash, cached);
  if (Date.now() - (missingCache.get(hash) || 0) < MISSING_TTL_MS) return null;
  const stored = previewState.get(hash);
  const storageHash = stored?.size ? stored.storage_hash : hash;
  const path = pathFor(storageHash);
  if (!existsSync(path)) {
    if (findAliases) {
      for (const alias of previewAliases(hash)) {
        const source = await providerThumbnail(alias, false);
        if (source) {
          const thumb = rememberReady(hash, { ...source, hash, checkedAt:Date.now() });
          previewState.ready(thumb);
          return thumb;
        }
      }
    }
    readyCache.delete(hash);
    if (previewState.get(hash)?.size) {
      previewState.forget(hash);
      process.emit('mochimono:preview-cache-missing', hash);
    }
    rememberMissing(hash);
    return null;
  }
  try {
    const file = await inspectThumbnail(path);
    if (!file?.size || !file.width || !file.height) {
      readyCache.delete(hash);
      process.emit('mochimono:preview-cache-changed');
      previewState.forget(hash);
      process.emit('mochimono:preview-cache-missing', hash);
      rememberMissing(hash);
      return null;
    }
    const thumb = rememberReady(hash, { hash, storageHash, path, size:file.size, width:file.width, height:file.height, duration:stored?.duration ?? null, checkedAt:Date.now() });
    previewState.ready(thumb);
    return thumb;
  } catch {
    readyCache.delete(hash);
    if (previewState.get(hash)?.size) {
      previewState.forget(hash);
      process.emit('mochimono:preview-cache-missing', hash);
    }
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
    res.writeHead(304, { etag, 'cache-control':cacheControl });
    res.end();
    return true;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-type':'image/webp', 'content-length':thumb.size, 'cache-control':cacheControl, etag });
    res.end();
    return true;
  }
  const source = createReadStream(thumb.path);
  let opened = false;
  source.once('open', () => {
    opened = true;
    if (res.destroyed) return source.destroy();
    res.writeHead(200, { 'content-type':'image/webp', 'content-length':thumb.size, 'cache-control':cacheControl, etag });
    source.pipe(res);
  });
  source.once('error', error => {
    readyCache.delete(hash);
    previewState.forget(hash);
    process.emit('mochimono:preview-cache-missing', hash);
    if (!opened && !res.headersSent && !res.destroyed) {
      res.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'cache-control':'no-store' });
      res.end();
    } else if (!res.destroyed) res.destroy(error);
  });
  res.once('close', () => {
    if (!source.destroyed) source.destroy();
  });
  return true;
}
