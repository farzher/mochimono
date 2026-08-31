import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import http from 'node:http';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const TMP_DIR = join(homedir(), '.mochimono', 'tmp');
const THUMB_VERSION = 3;
const THUMB_EDGE = 768;
const MAX_OUTPUT = 5 * 1024 * 1024;
const queue = new Map();
let active = false;
let sharpPromise = null;
let ffmpegPromise = null;

const IMAGE_EXTENSIONS = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.avif','.bmp','.tif','.tiff']);
const VIDEO_EXTENSIONS = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);

async function config() {
  let saved = {};
  try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
  return {
    server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
    token: String(process.env.MOCHIMONO_TOKEN || saved.token || '')
  };
}

function auth(settings) {
  return { authorization: `Bearer ${settings.token}` };
}

async function sharpLibrary() {
  if (!sharpPromise) sharpPromise = import('sharp').then(module => module.default || module);
  return sharpPromise;
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

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req, max = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function kindFor(item) {
  if (item.kind === 'image' || item.kind === 'video') return item.kind;
  const extension = extname(item.filename || '').toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return '';
}

function sourceMime(item) {
  const value = String(item.mime || '');
  return value && !value.endsWith('/unknown') ? value : 'application/octet-stream';
}

async function canonicalExists(settings, hash) {
  try {
    const response = await fetch(`${settings.server}/api/thumbs/${hash}`, { method: 'HEAD', headers: auth(settings) });
    return response.ok;
  } catch {
    return false;
  }
}

async function imagePreview(settings, item) {
  await mkdir(TMP_DIR, { recursive: true });
  const temp = join(TMP_DIR, `preview-${process.pid}-${item.hash}`);
  try {
    const response = await fetch(`${settings.server}/api/objects/${item.hash}`, { headers: auth(settings) });
    if (!response.ok || !response.body) throw new Error(`Object unavailable (${response.status})`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
    const sharp = await sharpLibrary();
    sharp.concurrency(1);
    const { data, info } = await sharp(temp)
      .rotate()
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 2, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    return { blob: data, width: info.width || 0, height: info.height || 0, duration: null };
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function ffmpegFrame(settings, item, seek = .5) {
  const binary = await ffmpegBinary();
  return new Promise((resolvePromise, reject) => {
    const args = [
      '-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1',
      '-headers', `Authorization: Bearer ${settings.token}\r\n`,
      ...(seek > 0 ? ['-ss', String(seek)] : []),
      '-i', `${settings.server}/api/objects/${item.hash}`,
      '-map','0:v:0','-an','-sn','-dn',
      '-vf', `scale=w='min(${THUMB_EDGE},iw)':h='min(${THUMB_EDGE},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v','1','-c:v','mjpeg','-q:v','3','-f','image2pipe','pipe:1'
    ];
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Preview timed out'));
    }, 20_000);
    child.stdout.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new Error('Preview too large'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += chunk.toString(); });
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
      if (code !== 0 || !bytes) return reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || `FFmpeg exited with ${code}`));
      resolvePromise(Buffer.concat(chunks));
    });
  });
}

async function videoPreview(settings, item) {
  let frame;
  try { frame = await ffmpegFrame(settings, item, .5); }
  catch { frame = await ffmpegFrame(settings, item, 0); }
  const sharp = await sharpLibrary();
  sharp.concurrency(1);
  const { data, info } = await sharp(frame).webp({ quality: 78, effort: 2, smartSubsample: true }).toBuffer({ resolveWithObject: true });
  return { blob: data, width: info.width || 0, height: info.height || 0, duration: null };
}

async function upload(settings, item, result) {
  if (!result.blob?.length) throw new Error('Empty preview');
  const response = await fetch(`${settings.server}/api/thumbs/${item.hash}`, {
    method: 'PUT',
    headers: {
      ...auth(settings),
      'content-type': 'image/webp',
      'content-length': String(result.blob.length),
      'x-mochimono-thumb-version': String(THUMB_VERSION),
      'x-mochimono-width': String(result.width || 0),
      'x-mochimono-height': String(result.height || 0),
      'x-mochimono-source-mime': sourceMime(item)
    },
    body: result.blob
  });
  if (!response.ok) throw new Error(`Could not save preview (${response.status})`);
}

async function repair(item) {
  const settings = await config();
  if (!settings.token || !item.hash) return;
  if (await canonicalExists(settings, item.hash)) return;
  const kind = kindFor(item);
  if (!kind) return;
  const result = kind === 'video' ? await videoPreview(settings, item) : await imagePreview(settings, item);
  if (await canonicalExists(settings, item.hash)) return;
  await upload(settings, { ...item, kind }, result);
}

function pump() {
  if (active || !queue.size) return;
  const [hash, item] = queue.entries().next().value;
  queue.delete(hash);
  active = true;
  repair(item).catch(error => {
    if (!/Object unavailable \(404\)|Could not save preview \(404\)/.test(error.message)) {
      console.warn(`Mochimono preview repair failed for ${item.filename || hash.slice(0, 12)}: ${error.message}`);
    }
  }).finally(() => {
    active = false;
    pump();
  });
}

function enqueue(items) {
  let added = 0;
  for (const raw of items || []) {
    const hash = String(raw.hash || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash) || queue.has(hash)) continue;
    const item = {
      hash,
      filename: String(raw.filename || '').slice(0, 1000),
      mime: String(raw.mime || '').slice(0, 200),
      kind: String(raw.kind || '')
    };
    if (!kindFor(item)) continue;
    queue.set(hash, item);
    added++;
  }
  pump();
  return added;
}

const originalCreateServer = http.createServer;
http.createServer = function (...args) {
  const context = this;
  http.createServer = originalCreateServer;
  const index = args.findIndex(value => typeof value === 'function');
  if (index < 0) return originalCreateServer.apply(context, args);
  const listener = args[index];
  args[index] = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'POST' && url.pathname === '/api/client/previews/request') {
        const body = await readJson(req);
        if (!Array.isArray(body.files) || body.files.length > 200) return json(res, 400, { error: 'files must be an array of at most 200 items' });
        return json(res, 202, { queued: enqueue(body.files), pending: queue.size, active });
      }
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || 'Preview repair failed' });
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};
