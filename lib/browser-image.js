import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { decodeHeic } from './heic.js';

const inflight = new Map();
const HEIF = new Set(['.heic', '.heif']);

export function isHeicFile(file, path = '') {
  const name = String(file?.filename || path || '');
  const mime = String(file?.mime || '').toLowerCase();
  return mime === 'image/heic' || mime === 'image/heif' || HEIF.has(extname(name).toLowerCase());
}

export async function browserImage(hash, sourcePath, cacheDir) {
  hash = String(hash || '');
  const output = join(cacheDir, `${hash}.webp`);
  const existing = await stat(output).catch(() => null);
  if (existing?.isFile() && existing.size) return { path: output, size: existing.size };

  const key = `${cacheDir}\0${hash}`;
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    await mkdir(cacheDir, { recursive: true });
    const result = await decodeHeic(sourcePath, { edge: 4096, quality: 90, effort: 3 });
    const temp = `${output}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, result.data);
      await rename(temp, output);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    return { path: output, size: result.data.length, width: result.info.width || 0, height: result.info.height || 0 };
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function serveBrowserImage(req, res, image, immutable = true) {
  const headers = {
    'content-type': 'image/webp',
    'content-length': image.size,
    'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=3600'
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(image.path).pipe(res);
}
