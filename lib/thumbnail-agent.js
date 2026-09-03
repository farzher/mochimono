import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { availableParallelism, homedir, platform, setPriority } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const TMP_DIR = join(homedir(), '.mochimono', 'tmp');
const THUMB_VERSION = 3;
const THUMB_EDGE = 768;
const MAX_OUTPUT = 5 * 1024 * 1024;
const CPU_COUNT = Math.max(1, availableParallelism());
const DEFAULT_WORKERS = Math.max(1, Math.min(8, Math.ceil(CPU_COUNT / 2)));
const WORKERS = Math.max(1, Math.min(16, Number(process.env.MOCHIMONO_THUMBNAIL_WORKERS) || DEFAULT_WORKERS));
const DEFAULT_VIDEO_WORKERS = Math.max(1, Math.min(4, Math.ceil(WORKERS / 2)));
const VIDEO_WORKERS = Math.max(1, Math.min(WORKERS, Number(process.env.MOCHIMONO_THUMBNAIL_VIDEO_WORKERS) || DEFAULT_VIDEO_WORKERS));
const BACKGROUND_WORKERS = Math.max(1, Math.floor(WORKERS / 2));
const BACKGROUND_VIDEO_WORKERS = Math.max(1, Math.min(VIDEO_WORKERS, BACKGROUND_WORKERS));
const MAX_URGENT_QUEUE = 320;
const urgentQueue = new Map();
const priorityQueue = new Map();
const backgroundQueue = new Map();
const running = new Set();
const failedUntil = new Map();
const warnedFailures = new Map();
let active = 0;
let activeVideo = 0;
let ingestBusy = false;
let stopped = false;
let loopTimer = null;
let ffmpegPromise = null;
let sharpPromise = null;
let lastDependencyError = '';
let lastBackgroundDiscovery = 0;

const IMAGE_EXTENSIONS = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.avif','.bmp','.tif','.tiff']);
const VIDEO_EXTENSIONS = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);
const MIME = new Map([
  ['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.png','image/png'],['.gif','image/gif'],['.webp','image/webp'],
  ['.heic','image/heic'],['.heif','image/heif'],['.avif','image/avif'],['.bmp','image/bmp'],['.tif','image/tiff'],['.tiff','image/tiff'],
  ['.mp4','video/mp4'],['.m4v','video/mp4'],['.mov','video/quicktime'],['.mkv','video/x-matroska'],['.webm','video/webm'],
  ['.avi','video/x-msvideo'],['.mpg','video/mpeg'],['.mpeg','video/mpeg'],['.m2v','video/mpeg'],['.mts','video/mp2t'],['.m2ts','video/mp2t'],['.3gp','video/3gpp']
]);

function kindFor(file) {
  const base = String(file?.mime || '').split('/')[0];
  if (base === 'image' || base === 'video') return base;
  const extension = extname(file?.filename || '').toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return '';
}

function mimeFor(file) {
  if (file.mime && file.mime !== 'application/octet-stream') return file.mime;
  return MIME.get(extname(file.filename || '').toLowerCase()) || 'application/octet-stream';
}

async function readSettings() {
  let saved = {};
  try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
  const folders = Array.isArray(saved.folders) ? saved.folders.map(item => ({
    path: resolve(String(item.path || item)),
    importId: Number(item.importId) || null
  })).filter(item => item.importId) : [];
  return {
    server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
    token: String(process.env.MOCHIMONO_TOKEN || saved.token || ''),
    folders
  };
}

const auth = settings => ({ authorization: `Bearer ${settings.token}` });

async function api(settings, path, options = {}) {
  const response = await fetch(`${settings.server}${path}`, {
    ...options,
    headers: { ...auth(settings), ...(options.headers || {}) }
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return (response.headers.get('content-type') || '').includes('application/json') ? response.json() : response;
}

function sameMtime(actual, expected) {
  const time = Date.parse(expected || '');
  return !Number.isFinite(time) || Math.abs(actual - time) <= 5000;
}

async function validDirectCandidate(file) {
  if (!file.localPath) return null;
  const path = resolve(String(file.localPath));
  let info;
  try { info = await stat(path); } catch { return null; }
  return info.isFile() && Number(info.size) === Number(file.size) && sameMtime(info.mtimeMs, file.mtime) ? path : null;
}

function safeLocalPath(root, relativePath) {
  const base = resolve(root);
  const target = resolve(base, ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  return targetKey === baseKey || targetKey.startsWith(`${baseKey}${sep}`) ? target : null;
}

async function validLocalCandidate(settings, file, source) {
  const folder = settings.folders.find(item => item.importId === Number(source.importId));
  if (!folder) return null;
  const path = safeLocalPath(folder.path, source.originalPath);
  if (!path) return null;
  let info;
  try { info = await stat(path); } catch { return null; }
  return info.isFile() && Number(info.size) === Number(file.size) && sameMtime(info.mtimeMs, source.mtime) ? path : null;
}

async function localSource(settings, file) {
  const direct = await validDirectCandidate(file);
  if (direct) return { path: direct, direct: true };
  const candidates = file.sources?.length ? file.sources : [file];
  for (const source of candidates) {
    const path = await validLocalCandidate(settings, file, source);
    if (path) return { path, source };
  }
  return null;
}

async function sharpLibrary() {
  if (!sharpPromise) sharpPromise = import('sharp').then(module => {
    const sharp = module.default || module;
    sharp.concurrency(1);
    sharp.cache({ memory: 32, files: 0, items: 32 });
    return sharp;
  });
  return sharpPromise;
}

async function sharpPreview(path) {
  const sharp = await sharpLibrary();
  const { data, info } = await sharp(path)
    .rotate()
    .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 2, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  if (!data.length) throw new Error('Preview is empty');
  if (data.length > MAX_OUTPUT) throw new Error('Preview is too large');
  return { blob: data, width: info.width || 0, height: info.height || 0, duration: null };
}

async function encodeFrame(frame) {
  const sharp = await sharpLibrary();
  const { data, info } = await sharp(frame.blob)
    .webp({ quality: 78, effort: 2, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  if (!data.length) throw new Error('Preview is empty');
  if (data.length > MAX_OUTPUT) throw new Error('Preview is too large');
  return { blob: data, width: info.width || 0, height: info.height || 0, duration: frame.duration ?? null };
}

async function previewIsBlank(blob) {
  try {
    const stats = await (await sharpLibrary())(blob).stats();
    return stats.channels.slice(0, 3).every(channel => channel.mean < 6);
  } catch { return false; }
}

async function ffmpegBinary() {
  if (!ffmpegPromise) ffmpegPromise = (async () => {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    try { return (await import('ffmpeg-static')).default || 'ffmpeg'; }
    catch { return 'ffmpeg'; }
  })();
  return ffmpegPromise;
}

function parseDuration(stderr) {
  const match = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function ffmpegError(stderr, code) {
  const lines = String(stderr || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const useful = [...lines].reverse().find(line => /invalid|error|failed|unsupported|could not|not found|no such file|moov|decoder|corrupt|damaged/i.test(line));
  return new Error(useful || lines.at(-1) || `FFmpeg exited with ${code}`);
}

async function ffmpegFrame(input, kind, seekSeconds = 0, token = '') {
  const binary = await ffmpegBinary();
  return new Promise((resolvePromise, reject) => {
    const args = [
      '-nostdin','-hide_banner','-loglevel','info','-threads','1','-filter_threads','1',
      ...(token ? ['-headers', `Authorization: Bearer ${token}\r\n`] : []),
      ...(kind === 'video' && seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
      '-i', input,
      '-an','-sn','-dn',
      '-vf', `scale=w='min(${THUMB_EDGE},iw)':h='min(${THUMB_EDGE},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v','1','-c:v','mjpeg','-q:v','3','-f','image2pipe','pipe:1'
    ];
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    try { setPriority(child.pid, 10); } catch {}
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolvePromise(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Preview generation timed out')); }, kind === 'video' ? 20_000 : 15_000);
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { child.kill(); finish(new Error('Generated preview frame is too large')); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (stderr.length < 128 * 1024) stderr += chunk.toString(); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(code !== 0 || !bytes ? ffmpegError(stderr, code) : null, { blob: Buffer.concat(chunks), duration: parseDuration(stderr) }));
  });
}

async function videoPreview(input, token = '') {
  let first;
  try { first = await encodeFrame(await ffmpegFrame(input, 'video', .5, token)); }
  catch { first = await encodeFrame(await ffmpegFrame(input, 'video', 0, token)); }
  if (!await previewIsBlank(first.blob)) return first;
  for (const seek of [2, 8]) {
    try {
      const later = await encodeFrame(await ffmpegFrame(input, 'video', seek, token));
      if (!await previewIsBlank(later.blob)) return { ...later, duration: first.duration ?? later.duration };
    } catch {}
  }
  return first;
}

async function imagePreview(path) {
  try { return await sharpPreview(path); }
  catch (error) {
    if (/cannot find package|module not found|ERR_MODULE_NOT_FOUND/i.test(`${error.code || ''} ${error.message}`)) throw error;
    return encodeFrame(await ffmpegFrame(path, 'image'));
  }
}

async function remoteImage(settings, file) {
  await mkdir(TMP_DIR, { recursive: true });
  const path = join(TMP_DIR, `preview-${process.pid}-${file.hash}`);
  try {
    const response = await fetch(`${settings.server}/api/objects/${file.hash}`, { headers: auth(settings) });
    if (!response.ok || !response.body) throw new Error(`Object unavailable (${response.status})`);
    const source = Readable.fromWeb(response.body);
    source.on('error', () => {});
    await pipeline(source, createWriteStream(path));
    return await imagePreview(path);
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

async function generatePreview(settings, file, local) {
  const kind = kindFor(file);
  if (local) return kind === 'video' ? videoPreview(local.path) : imagePreview(local.path);
  if (!file.requestedAt) throw new Error('Local source unavailable');
  if (kind === 'video') return videoPreview(`${settings.server}/api/objects/${file.hash}`, settings.token);
  return remoteImage(settings, file);
}

async function uploadThumbnail(settings, file, result) {
  const response = await fetch(`${settings.server}/api/thumbs/${file.hash}`, {
    method: 'PUT',
    headers: {
      ...auth(settings),
      'content-type': 'image/webp',
      'content-length': String(result.blob.length),
      'x-mochimono-thumb-version': String(THUMB_VERSION),
      'x-mochimono-width': String(result.width || 0),
      'x-mochimono-height': String(result.height || 0),
      ...(result.duration == null ? {} : { 'x-mochimono-duration': String(result.duration) }),
      'x-mochimono-source-mime': mimeFor(file)
    },
    body: result.blob
  });
  if (!response.ok) throw new Error(`Could not save preview (${response.status})`);
}

function queueFile(file) {
  if (!file?.hash || running.has(file.hash) || (!file.requestedAt && Number(file.size) <= 0) || !kindFor(file)) return false;
  if ((failedUntil.get(file.hash) || 0) > Date.now()) return false;
  if (file.requestedAt) {
    priorityQueue.delete(file.hash);
    backgroundQueue.delete(file.hash);
    if (!urgentQueue.has(file.hash) && urgentQueue.size >= MAX_URGENT_QUEUE) {
      const stale = urgentQueue.keys().next().value;
      if (stale) urgentQueue.delete(stale);
    }
    urgentQueue.set(file.hash, file);
  } else if (file.priority) {
    backgroundQueue.delete(file.hash);
    if (!urgentQueue.has(file.hash)) priorityQueue.set(file.hash, file);
  } else if (!urgentQueue.has(file.hash) && !priorityQueue.has(file.hash) && !backgroundQueue.has(file.hash)) {
    backgroundQueue.set(file.hash, file);
  }
  pump();
  return true;
}

function nextFrom(queue, videoLimit = VIDEO_WORKERS) {
  for (const [hash, file] of queue) {
    if (kindFor(file) === 'video' && activeVideo >= videoLimit) continue;
    queue.delete(hash);
    return file;
  }
  return null;
}

function nextFile() {
  const urgent = nextFrom(urgentQueue) || nextFrom(priorityQueue);
  if (urgent) return urgent;
  const backgroundWorkers = ingestBusy ? 1 : BACKGROUND_WORKERS;
  if (active >= backgroundWorkers) return null;
  return nextFrom(backgroundQueue, ingestBusy ? 1 : BACKGROUND_VIDEO_WORKERS);
}

async function processFile(file) {
  const settings = await readSettings();
  if (!settings.token) return;
  const local = await localSource(settings, file);
  const kind = kindFor(file);
  try {
    const result = await generatePreview(settings, file, local);
    if (local) {
      const valid = local.direct ? await validDirectCandidate(file) : await validLocalCandidate(settings, file, local.source);
      if (valid !== local.path) return;
    }
    await uploadThumbnail(settings, file, result);
    failedUntil.delete(file.hash);
    warnedFailures.delete(file.hash);
    lastDependencyError = '';
  } catch (error) {
    const message = String(error?.message || error);
    const dependency = error?.code === 'ENOENT' || /(?:ffmpeg|sharp).*(?:not found|enoent|cannot find package)/i.test(message);
    if (dependency) {
      if (lastDependencyError !== message) {
        lastDependencyError = message;
        console.warn('Mochimono previews: Sharp/FFmpeg is unavailable. Run npm install or set FFMPEG_PATH.');
      }
      failedUntil.set(file.hash, Date.now() + 60_000);
      return;
    }
    if (local) {
      const valid = local.direct ? await validDirectCandidate(file) : await validLocalCandidate(settings, file, local.source);
      if (valid !== local.path) return;
    }
    const terminal = /object unavailable \(404\)|invalid data found|moov atom not found|could not find codec parameters|unsupported codec|invalid nal|corrupt|damaged/i.test(message);
    const warning = `${terminal}:${message}`;
    if (warnedFailures.get(file.hash) !== warning) {
      warnedFailures.set(file.hash, warning);
      console.warn(`Mochimono preview ${terminal ? 'unavailable' : 'failed'} for ${file.filename || file.hash.slice(0, 12)} [${file.hash.slice(0, 12)}]: ${message}`);
    }
    failedUntil.set(file.hash, terminal ? Infinity : Date.now() + 5 * 60_000);
  }
}

function pump() {
  while (!stopped && active < WORKERS) {
    const file = nextFile();
    if (!file) return;
    const video = kindFor(file) === 'video';
    running.add(file.hash);
    active++;
    if (video) activeVideo++;
    processFile(file).finally(() => {
      running.delete(file.hash);
      active--;
      if (video) activeVideo--;
      pump();
    });
  }
}

async function discover() {
  const settings = await readSettings();
  if (!settings.token || !settings.folders.length) return;
  const imports = settings.folders.map(item => item.importId).join(',');

  const urgent = await api(settings, `/api/thumbs/missing?priority=1&imports=${encodeURIComponent(imports)}&limit=100`);
  for (const file of urgent.files || []) queueFile(file);

  const queued = urgentQueue.size + priorityQueue.size + backgroundQueue.size;
  if (queued >= Math.max(8, WORKERS * 6) || Date.now() - lastBackgroundDiscovery < 5000) return;
  lastBackgroundDiscovery = Date.now();
  const background = await api(settings, `/api/thumbs/missing?imports=${encodeURIComponent(imports)}&limit=250`);
  for (const file of background.files || []) queueFile(file);
}

async function loop() {
  if (stopped) return;
  try { await discover(); }
  catch (error) {
    if (!/ECONNREFUSED|fetch failed/i.test(error.message)) console.warn(`Mochimono previews: ${error.message}`);
  }
  if (!stopped) loopTimer = setTimeout(loop, urgentQueue.size || priorityQueue.size || backgroundQueue.size || active ? 700 : 1500);
}

export function queueLocalThumbnail(record) {
  if (!record?.hash || !record?.path) return false;
  return queueFile({
    hash: String(record.hash),
    size: Number(record.size) || 0,
    mime: String(record.mime || ''),
    filename: String(record.filename || record.path),
    mtime: record.mtime ? String(record.mtime) : null,
    localPath: resolve(String(record.path)),
    priority: record.priority !== false
  });
}

export function queueRemoteThumbnail(record) {
  if (!record?.hash) return false;
  return queueFile({
    hash: String(record.hash),
    size: Number(record.size) || 0,
    mime: String(record.mime || ''),
    filename: String(record.filename || record.hash),
    requestedAt: new Date().toISOString()
  });
}

export function thumbnailFailure(hash) {
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

export function setThumbnailIngestBusy(value) {
  ingestBusy = Boolean(value);
  pump();
}

export function startThumbnailAgent() {
  if (loopTimer || stopped) return;
  loop();
}

export function stopThumbnailAgent() {
  stopped = true;
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
}

export function thumbnailAgentStatus() {
  return {
    workers: WORKERS,
    videoWorkers: VIDEO_WORKERS,
    ingestBusy,
    urgent: urgentQueue.size,
    priority: priorityQueue.size,
    queued: backgroundQueue.size,
    active,
    activeVideo,
    failed: [...failedUntil.values()].filter(time => time > Date.now()).length
  };
}
