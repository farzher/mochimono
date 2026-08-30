import { readFile, stat } from 'node:fs/promises';
import { homedir, platform, setPriority } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.bmp', '.tif', '.tiff']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.m2v', '.mts', '.m2ts', '.3gp']);
let sharpPromise;
let ffmpegPromise;
let timer;
let running = false;
let publishedRoots = '';

async function settings() {
  let saved = {};
  try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
  return {
    server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
    token: String(process.env.MOCHIMONO_TOKEN || saved.token || ''),
    device: String(saved.device || ''),
    folders: Array.isArray(saved.folders) ? saved.folders.map(item => ({
      path: resolve(String(item.path || item)),
      importId: Number(item.importId) || null
    })).filter(item => item.importId) : []
  };
}

async function api(config, path, options = {}) {
  const response = await fetch(`${config.server}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
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

async function localPath(config, file) {
  for (const source of file.sources || []) {
    const folder = config.folders.find(item => item.importId === Number(source.importId));
    if (!folder) continue;
    const path = safeLocalPath(folder.path, source.originalPath);
    if (!path) continue;
    try {
      const info = await stat(path);
      if (info.isFile() && Number(info.size) === Number(file.size)) return path;
    } catch {}
  }
  return null;
}

function dateParts(value, offset = '') {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1980 || year > new Date().getFullYear() + 1) return null;
  const suffix = /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '';
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${suffix}`;
}

function exifFields(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return new Map();
  let start = buffer.subarray(0, 6).toString('ascii') === 'Exif\0\0' ? 6 : -1;
  if (start < 0) {
    for (let i = 0; i <= Math.min(buffer.length - 4, 64); i++) {
      const mark = buffer.subarray(i, i + 4);
      if (mark.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || mark.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) {
        start = i;
        break;
      }
    }
  }
  if (start < 0 || start + 8 > buffer.length) return new Map();
  const little = buffer.toString('ascii', start, start + 2) === 'II';
  const u16 = offset => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const u32 = offset => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const within = (offset, bytes = 1) => offset >= 0 && offset + bytes <= buffer.length;
  const ascii = (entry, type, count) => {
    if (type !== 2 || count < 1 || count > 256) return '';
    const dataOffset = count <= 4 ? entry + 8 : start + u32(entry + 8);
    if (!within(dataOffset, count)) return '';
    return buffer.toString('ascii', dataOffset, dataOffset + count).replace(/\0.*$/, '').trim();
  };
  const result = new Map();
  const readIfd = offset => {
    const location = start + offset;
    if (!within(location, 2)) return;
    const count = Math.min(u16(location), 256);
    for (let i = 0; i < count; i++) {
      const entry = location + 2 + i * 12;
      if (!within(entry, 12)) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const values = u32(entry + 4);
      if ([0x0132, 0x9003, 0x9004, 0x9010, 0x9011, 0x9012].includes(tag)) result.set(tag, ascii(entry, type, values));
      if (tag === 0x8769 && type === 4 && values === 1) readIfd(u32(entry + 8));
    }
  };
  if (u16(start + 2) !== 42) return result;
  readIfd(u32(start + 4));
  return result;
}

async function sharpLibrary() {
  if (!sharpPromise) sharpPromise = import('sharp').then(module => module.default || module);
  return sharpPromise;
}

async function imageDate(path) {
  try {
    const sharp = await sharpLibrary();
    const metadata = await sharp(path).metadata();
    const fields = exifFields(metadata.exif);
    const candidates = [
      [0x9003, 0x9011, 'exif.DateTimeOriginal'],
      [0x9004, 0x9012, 'exif.DateTimeDigitized'],
      [0x0132, 0x9010, 'exif.DateTime']
    ];
    for (const [dateTag, offsetTag, source] of candidates) {
      const capturedAt = dateParts(fields.get(dateTag), fields.get(offsetTag));
      if (capturedAt) return { capturedAt, source };
    }
  } catch {}
  return { capturedAt: null, source: 'none' };
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

function videoDateFromText(text) {
  const patterns = [
    /(?:creation_time|com\.apple\.quicktime\.creationdate)\s*:\s*([^\r\n]+)/ig,
    /\bdate\s*:\s*([^\r\n]+)/ig
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(text || '')))) {
      const date = new Date(match[1].trim());
      const year = date.getFullYear();
      if (!Number.isNaN(date.getTime()) && year >= 1980 && year <= new Date().getFullYear() + 1) {
        return { capturedAt: date.toISOString(), source: 'video.creation_time' };
      }
    }
  }
  return { capturedAt: null, source: 'none' };
}

async function videoDate(path) {
  const binary = await ffmpegBinary();
  return new Promise(resolvePromise => {
    const child = spawn(binary, ['-nostdin', '-hide_banner', '-i', path], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    try { setPriority(child.pid, 10); } catch {}
    let stderr = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(videoDateFromText(stderr));
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish();
    }, 8000);
    child.stderr.on('data', chunk => { if (stderr.length < 256 * 1024) stderr += chunk.toString(); });
    child.on('error', finish);
    child.on('close', finish);
  });
}

async function extractDate(path, file) {
  const extension = extname((file.sources || [])[0]?.filename || path).toLowerCase();
  const kind = String(file.mime || '').split('/')[0];
  if (kind === 'image' || IMAGE_EXTENSIONS.has(extension)) return imageDate(path);
  if (kind === 'video' || VIDEO_EXTENSIONS.has(extension)) return videoDate(path);
  return { capturedAt: null, source: 'none' };
}

async function publishRoots(config) {
  if (!config.token || !config.folders.length) return;
  const roots = config.folders.map(folder => ({ importId: folder.importId, deviceName: config.device, rootPath: folder.path }));
  const signature = JSON.stringify([config.server, config.device, roots]);
  if (signature === publishedRoots) return;
  await api(config, '/api/import-roots', { method: 'POST', body: { roots } });
  publishedRoots = signature;
}

async function cycle() {
  if (running) return;
  running = true;
  let delay = 60_000;
  try {
    const config = await settings();
    if (!config.token || !config.folders.length) return;
    await publishRoots(config).catch(() => {});
    const imports = config.folders.map(folder => folder.importId).join(',');
    const data = await api(config, `/api/media-metadata/missing?imports=${encodeURIComponent(imports)}&limit=80`);
    const files = data.files || [];
    if (files.length) delay = 1000;
    for (const file of files) {
      const path = await localPath(config, file);
      if (!path) continue;
      const metadata = await extractDate(path, file);
      await api(config, `/api/media-metadata/${file.hash}`, { method: 'POST', body: metadata });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } catch (error) {
    if (!/fetch failed|ECONNREFUSED|not connected/i.test(error.message)) console.warn(`Mochimono metadata: ${error.message}`);
  } finally {
    running = false;
    clearTimeout(timer);
    timer = setTimeout(cycle, delay);
    timer.unref?.();
  }
}

export function startMediaMetadataAgent() {
  clearTimeout(timer);
  timer = setTimeout(cycle, 1500);
  timer.unref?.();
}
