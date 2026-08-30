import { stat, readFile } from 'node:fs/promises';
import { homedir, availableParallelism, platform, setPriority } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const THUMB_VERSION = 1;
const THUMB_EDGE = 768;
const MAX_OUTPUT = 5 * 1024 * 1024;
const WORKERS = Math.max(1, Math.min(3, Number(process.env.MOCHIMONO_THUMBNAIL_WORKERS) || Math.ceil(availableParallelism() / 4)));
const priorityQueue = new Map();
const backgroundQueue = new Map();
const running = new Set();
const failedUntil = new Map();
let active = 0;
let stopped = false;
let loopTimer = null;
let ffmpegPromise = null;
let sharpPromise = null;
let lastDependencyError = '';
let lastBackgroundDiscovery = 0;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.m2v', '.mts', '.m2ts', '.3gp']);
const MIME = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
  ['.heic', 'image/heic'], ['.heif', 'image/heif'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime'], ['.mkv', 'video/x-matroska'], ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'], ['.mpg', 'video/mpeg'], ['.mpeg', 'video/mpeg'], ['.m2v', 'video/mpeg'], ['.mts', 'video/mp2t'], ['.m2ts', 'video/mp2t'], ['.3gp', 'video/3gpp']
]);

function kindFor(file) {
  const base = String(file.mime || '').split('/')[0];
  if (base === 'image' || base === 'video') return base;
  const extension = extname(file.filename || '').toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return '';
}

function mimeFor(file) {
  if (file.mime && file.mime !== 'application/octet-stream') return file.mime;
  return MIME.get(extname(file.filename || '').toLowerCase()) || file.mime || 'application/octet-stream';
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

function auth(settings) {
  return { authorization: `Bearer ${settings.token}` };
}

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

function safeLocalPath(root, relativePath) {
  const base = resolve(root);
  const target = resolve(base, ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));
  const normalize = value => platform() === 'win32' ? value.toLowerCase() : value;
  const baseKey = normalize(base);
  const targetKey = normalize(target);
  if (targetKey !== baseKey && !targetKey.startsWith(`${baseKey}${sep}`)) return null;
  return target;
}

async function validLocalCandidate(settings, file, source) {
  const folder = settings.folders.find(item => item.importId === Number(source.importId));
  if (!folder) return null;
  const path = safeLocalPath(folder.path, source.originalPath);
  if (!path) return null;
  let info;
  try { info = await stat(path); } catch { return null; }
  if (!info.isFile() || Number(info.size) !== Number(file.size)) return null;
  if (source.mtime) {
    const expected = Date.parse(source.mtime);
    if (Number.isFinite(expected) && Math.abs(info.mtimeMs - expected) > 5000) return null;
  }
  return path;
}

async function localSource(settings, file) {
  const candidates = Array.isArray(file.sources) && file.sources.length
    ? file.sources
    : [{ importId: file.importId, originalPath: file.originalPath, filename: file.filename, mtime: file.mtime }];
  for (const candidate of candidates) {
    const path = await validLocalCandidate(settings, file, candidate);
    if (path) return path;
  }
  return null;
}

async function sharpLibrary() {
  if (!sharpPromise) {
    sharpPromise = import('sharp').then(module => {
      const sharp = module.default || module;
      sharp.concurrency(1);
      sharp.cache({ memory: 32, files: 0, items: 32 });
      return sharp;
    });
  }
  return sharpPromise;
}

async function runSharp(path) {
  const sharp = await sharpLibrary();
  const { data, info } = await sharp(path)
    .rotate()
    .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 2, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  if (!data.length) throw new Error('Image preview is empty');
  if (data.length > MAX_OUTPUT) throw new Error('Generated preview is too large');
  return { blob: data, width: info.width || 0, height: info.height || 0, duration: null };
}

async function previewIsBlank(blob) {
  try {
    const sharp = await sharpLibrary();
    const stats = await sharp(blob).resize({ width: 40, height: 40, fit: 'inside' }).stats();
    const channels = stats.channels.slice(0, 3);
    return channels.length > 0 && channels.every(channel => channel.mean < 6);
  } catch {
    return false;
  }
}

async function ffmpegBinary() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
      try {
        const module = await import('ffmpeg-static');
        if (module.default) return module.default;
      } catch {}
      return 'ffmpeg';
    })();
  }
  return ffmpegPromise;
}

function parseMetadata(stderr) {
  const dimensions = [...stderr.matchAll(/Video:.*?(\d{2,5})x(\d{2,5})/g)].at(-1);
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  return {
    width: dimensions ? Number(dimensions[1]) : 0,
    height: dimensions ? Number(dimensions[2]) : 0,
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null
  };
}

async function runFfmpeg(path, kind, seekSeconds = 0) {
  const binary = await ffmpegBinary();
  return new Promise((resolvePromise, reject) => {
    const scale = `scale=w='min(${THUMB_EDGE},iw)':h='min(${THUMB_EDGE},ih)':force_original_aspect_ratio=decrease`;
    const filter = kind === 'video' ? `thumbnail=30,${scale}` : scale;
    const seek = kind === 'video' && seekSeconds > 0 ? ['-ss', String(seekSeconds)] : [];
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'info', '-threads', '1', '-filter_threads', '1',
      ...seek,
      '-i', path,
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', filter,
      '-frames:v', '1',
      '-c:v', 'libwebp', '-lossless', '0', '-quality', '78', '-compression_level', '3',
      '-f', 'image2pipe', 'pipe:1'
    ];
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { setPriority(child.pid, 10); } catch {}
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error('Preview generation timed out'));
    }, kind === 'video' ? 30_000 : 20_000);

    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        child.kill();
        settled = true;
        clearTimeout(timer);
        reject(new Error('Generated preview is too large'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 128 * 1024) stderr += chunk.toString();
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || !bytes) return reject(new Error(stderr.trim().split('\n').at(-1) || `FFmpeg exited with ${code}`));
      resolvePromise({ blob: Buffer.concat(chunks), ...parseMetadata(stderr) });
    });
  });
}

async function runVideoPreview(path) {
  const first = await runFfmpeg(path, 'video');
  if (!await previewIsBlank(first.blob)) return first;
  for (const seek of [2, 8]) {
    try {
      const later = await runFfmpeg(path, 'video', seek);
      if (!await previewIsBlank(later.blob)) return { ...later, duration: first.duration ?? later.duration };
    } catch {}
  }
  return first;
}

async function generatePreview(path, kind) {
  if (kind === 'video') return runVideoPreview(path);
  try { return await runSharp(path); }
  catch { return runFfmpeg(path, kind); }
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
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
}

function queueFile(file) {
  if (!file?.hash || running.has(file.hash)) return;
  if ((failedUntil.get(file.hash) || 0) > Date.now()) return;
  if (!kindFor(file)) return;

  if (file.requestedAt) {
    backgroundQueue.delete(file.hash);
    priorityQueue.set(file.hash, file);
  } else if (!priorityQueue.has(file.hash) && !backgroundQueue.has(file.hash)) {
    backgroundQueue.set(file.hash, file);
  }
}

function nextFile() {
  const queue = priorityQueue.size ? priorityQueue : backgroundQueue;
  const entry = queue.entries().next().value;
  if (!entry) return null;
  queue.delete(entry[0]);
  return entry[1];
}

async function processFile(file) {
  const settings = await readSettings();
  if (!settings.token) return;
  const path = await localSource(settings, file);
  if (!path) {
    failedUntil.set(file.hash, Date.now() + 60_000);
    return;
  }
  const kind = kindFor(file);
  try {
    const result = await generatePreview(path, kind);
    await uploadThumbnail(settings, file, result);
    failedUntil.delete(file.hash);
    lastDependencyError = '';
  } catch (error) {
    const dependencyError = error.code === 'ENOENT' || /ffmpeg|sharp/i.test(error.message) && /not found|enoent|cannot find package/i.test(error.message);
    if (dependencyError) {
      if (lastDependencyError !== error.message) {
        lastDependencyError = error.message;
        console.warn('Mochimono previews: local preview dependencies are unavailable. Run npm install or set FFMPEG_PATH.');
      }
      failedUntil.set(file.hash, Date.now() + 60_000);
    } else {
      console.warn(`Mochimono preview failed for ${file.filename || file.hash.slice(0, 12)}: ${error.message}`);
      failedUntil.set(file.hash, Date.now() + 5 * 60_000);
    }
  }
}

function pump() {
  while (!stopped && active < WORKERS && (priorityQueue.size || backgroundQueue.size)) {
    const file = nextFile();
    if (!file) break;
    running.add(file.hash);
    active++;
    processFile(file).finally(() => {
      running.delete(file.hash);
      active--;
      pump();
    });
  }
}

async function discover() {
  const settings = await readSettings();
  if (!settings.token || !settings.folders.length) return;
  const imports = settings.folders.map(item => item.importId).join(',');

  const priority = await api(settings, `/api/thumbs/missing?priority=1&imports=${encodeURIComponent(imports)}&limit=100`);
  for (const file of priority.files || []) queueFile(file);

  const queued = priorityQueue.size + backgroundQueue.size;
  const refillAt = Math.max(8, WORKERS * 6);
  if (queued < refillAt && Date.now() - lastBackgroundDiscovery >= 5000) {
    lastBackgroundDiscovery = Date.now();
    const background = await api(settings, `/api/thumbs/missing?imports=${encodeURIComponent(imports)}&limit=250`);
    for (const file of background.files || []) queueFile(file);
  }
  pump();
}

async function loop() {
  if (stopped) return;
  try { await discover(); }
  catch (error) {
    if (!/ECONNREFUSED|fetch failed/i.test(error.message)) console.warn(`Mochimono previews: ${error.message}`);
  }
  if (!stopped) loopTimer = setTimeout(loop, priorityQueue.size || backgroundQueue.size || active ? 700 : 1500);
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
    priority: priorityQueue.size,
    queued: backgroundQueue.size,
    active,
    failed: [...failedUntil.values()].filter(time => time > Date.now()).length
  };
}
