import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { providerCandidate } from './client-providers.js';

const DIR = join(homedir(), '.mochimono', 'provider-thumbs');
const EDGE = 768;
const queue = new Map();
const running = new Set();
let active = 0;
const WORKERS = 2;
let sharpPromise = null;
let ffmpegPromise = null;

const IMAGE = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.avif','.bmp','.tif','.tiff']);
const VIDEO = new Set(['.mp4','.m4v','.mov','.mkv','.webm','.avi','.mpg','.mpeg','.m2v','.mts','.m2ts','.3gp']);
const pathFor = hash => join(DIR, `${hash}.webp`);
const infoPath = hash => join(DIR, `${hash}.json`);

function kind(file) {
  const base = String(file?.mime || '').split('/')[0];
  if (base === 'image' || base === 'video') return base;
  const extension = extname(file?.filename || '').toLowerCase();
  if (IMAGE.has(extension)) return 'image';
  if (VIDEO.has(extension)) return 'video';
  return '';
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

async function videoFrame(input, output) {
  const binary = await ffmpeg();
  await new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [
      '-nostdin','-hide_banner','-loglevel','error','-threads','1','-ss','0.5','-i',input,
      '-an','-sn','-dn','-vf',`scale=w='min(${EDGE},iw)':h='min(${EDGE},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v','1','-q:v','3','-y',output
    ], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Preview generation timed out')); }, 20_000);
    child.stderr.on('data', chunk => { if (stderr.length < 32 * 1024) stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolvePromise() : reject(new Error(stderr.trim() || `FFmpeg exited with ${code}`));
    });
  });
}

async function generate(file, candidate) {
  await mkdir(DIR, { recursive: true });
  const temp = join(DIR, `${file.hash}.${process.pid}.${Date.now()}.tmp.webp`);
  const frame = join(DIR, `${file.hash}.${process.pid}.${Date.now()}.jpg`);
  try {
    let result;
    if (kind(file) === 'video') {
      try { await videoFrame(candidate.path, frame); }
      catch {
        const binary = await ffmpeg();
        await new Promise((resolvePromise, reject) => {
          const child = spawn(binary, ['-nostdin','-hide_banner','-loglevel','error','-threads','1','-i',candidate.path,'-an','-sn','-dn','-frames:v','1','-q:v','3','-y',frame], { windowsHide: true });
          child.on('error', reject);
          child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`FFmpeg exited with ${code}`)));
        });
      }
      result = await imageThumb(frame);
    } else result = await imageThumb(candidate.path);

    await writeFile(temp, result.data);
    await rm(pathFor(file.hash), { force: true });
    await rename(temp, pathFor(file.hash));
    await writeFile(infoPath(file.hash), `${JSON.stringify({ width: result.info.width || 0, height: result.info.height || 0 })}\n`);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
    await rm(frame, { force: true }).catch(() => {});
  }
}

async function process(file) {
  try {
    if (await providerThumbnail(file.hash)) return;
    const candidate = await providerCandidate(file.hash);
    if (!candidate) return;
    await generate(file, candidate);
  } catch (error) {
    console.warn(`Mochimono provider preview failed for ${file.filename || file.hash.slice(0, 12)}: ${error.message}`);
  }
}

function pump() {
  while (active < WORKERS && queue.size) {
    const [hash, file] = queue.entries().next().value;
    queue.delete(hash);
    running.add(hash);
    active++;
    process(file).finally(() => {
      running.delete(hash);
      active--;
      pump();
    });
  }
}

export function queueProviderThumbnail(file) {
  if (!file?.hash || !kind(file) || running.has(file.hash) || queue.has(file.hash)) return false;
  queue.set(String(file.hash), { ...file, hash: String(file.hash) });
  pump();
  return true;
}

export async function providerThumbnail(hash) {
  const path = pathFor(String(hash));
  if (!existsSync(path)) return null;
  try {
    const [file, raw] = await Promise.all([stat(path), readFile(infoPath(String(hash)), 'utf8').catch(() => '{}')]);
    if (!file.isFile() || !file.size) return null;
    const info = JSON.parse(raw || '{}');
    return { hash: String(hash), path, size: file.size, width: Number(info.width) || 0, height: Number(info.height) || 0 };
  } catch { return null; }
}

export async function serveProviderThumbnail(req, res, hash) {
  const thumb = await providerThumbnail(hash);
  if (!thumb) return false;
  res.writeHead(200, {
    'content-type': 'image/webp', 'content-length': thumb.size,
    'cache-control': 'private, max-age=31536000, immutable'
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(thumb.path).pipe(res);
  return true;
}
