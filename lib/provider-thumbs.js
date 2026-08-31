import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, setPriority } from 'node:os';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { providerCandidate } from './client-providers.js';

const DIR = join(homedir(), '.mochimono', 'provider-thumbs');
const THUMB_VERSION = 3;
const EDGE = 768;
const CPU_COUNT = Math.max(1, availableParallelism());
const DEFAULT_WORKERS = Math.max(1, Math.min(8, Math.ceil(CPU_COUNT / 2)));
const WORKERS = Math.max(1, Math.min(16, Number(process.env.MOCHIMONO_THUMBNAIL_WORKERS) || DEFAULT_WORKERS));
const DEFAULT_VIDEO_WORKERS = Math.max(1, Math.min(4, Math.ceil(WORKERS / 2)));
const VIDEO_WORKERS = Math.max(1, Math.min(WORKERS, Number(process.env.MOCHIMONO_THUMBNAIL_VIDEO_WORKERS) || DEFAULT_VIDEO_WORKERS));
const READY_CACHE_MAX = 4096;
const queue = new Map();
const running = new Set();
const failedUntil = new Map();
const warnedFailures = new Map();
const readyCache = new Map();
let active = 0;
let activeVideo = 0;
let sharpPromise = null;
let ffmpegPromise = null;

const IMAGE = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.avif','.bmp','.tif','.tiff']);
const VIDEO = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);
const bucketFor = hash => join(DIR, String(hash).slice(0, 2));
const pathFor = hash => join(bucketFor(hash), `${hash}.webp`);
const infoPath = hash => join(bucketFor(hash), `${hash}.json`);

function kind(file) {
  const base = String(file?.mime || '').split('/')[0];
  if (base === 'image' || base === 'video') return base;
  const extension = extname(file?.filename || '').toLowerCase();
  if (IMAGE.has(extension)) return 'image';
  if (VIDEO.has(extension)) return 'video';
  return '';
}

function rememberReady(hash, thumb) {
  readyCache.delete(hash);
  readyCache.set(hash, thumb);
  while (readyCache.size > READY_CACHE_MAX) readyCache.delete(readyCache.keys().next().value);
  return thumb;
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
    try { setPriority(child.pid, 10); } catch {}
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
    } else result = await imageThumb(candidate.path);

    const width = result.info.width || 0;
    const height = result.info.height || 0;
    await writeFile(temp, result.data);
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
  if (/invalid data found|moov atom not found|could not find codec parameters|unsupported codec|invalid nal|corrupt|damaged/i.test(message)) return Infinity;
  return 5 * 60_000;
}

async function processThumbnail(file) {
  try {
    if (await providerThumbnail(file.hash)) return;
    const candidate = await validCandidate(file.candidate) || await providerCandidate(file.hash);
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

function nextFile() {
  for (const [hash, file] of queue) {
    if (kind(file) === 'video' && activeVideo >= VIDEO_WORKERS) continue;
    queue.delete(hash);
    return file;
  }
  return null;
}

function pump() {
  while (active < WORKERS) {
    const file = nextFile();
    if (!file) return;
    const video = kind(file) === 'video';
    running.add(file.hash);
    active++;
    if (video) activeVideo++;
    processThumbnail(file).finally(() => {
      running.delete(file.hash);
      active--;
      if (video) activeVideo--;
      pump();
    });
  }
}

export function queueProviderThumbnail(file) {
  const hash = String(file?.hash || '');
  if (!hash || !kind(file) || running.has(hash) || queue.has(hash) || (failedUntil.get(hash) || 0) > Date.now()) return false;
  queue.set(hash, { ...file, hash });
  pump();
  return true;
}

export async function providerThumbnail(hash) {
  hash = String(hash);
  const cached = readyCache.get(hash);
  if (cached) return rememberReady(hash, cached);
  const path = pathFor(hash);
  if (!existsSync(path)) return null;
  try {
    const [file, raw] = await Promise.all([stat(path), readFile(infoPath(hash), 'utf8').catch(() => '{}')]);
    if (!file.isFile() || !file.size) return null;
    const info = JSON.parse(raw || '{}');
    if (Number(info.version) !== THUMB_VERSION) {
      await Promise.all([rm(path, { force: true }), rm(infoPath(hash), { force: true })]);
      return null;
    }
    return rememberReady(hash, { hash, path, size: file.size, width: Number(info.width) || 0, height: Number(info.height) || 0 });
  } catch { return null; }
}

export async function serveProviderThumbnail(req, res, hash) {
  const thumb = await providerThumbnail(hash);
  if (!thumb) return false;
  const etag = `\"${hash}-provider-thumb-${THUMB_VERSION}\"`;
  const cacheControl = 'private, max-age=31536000, immutable';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cacheControl });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': 'image/webp', 'content-length': thumb.size,
    'cache-control': cacheControl, etag
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(thumb.path).pipe(res);
  return true;
}
