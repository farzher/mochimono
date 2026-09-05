import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCatalog } from './db.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = resolve(process.env.MOCHIMONO_DATA || join(ROOT, 'data'));
export const TOKEN = String(process.env.MOCHIMONO_TOKEN || '');

await mkdir(DATA_DIR, { recursive: true });
export const db = openCatalog(join(DATA_DIR, 'catalog.sqlite'));
export const now = () => new Date().toISOString();
const catalogRevision = db.prepare('SELECT revision FROM catalog_revision WHERE singleton = 1');
export const catalogVersion = () => `r${Number(catalogRevision.get()?.revision) || 1}`;

export function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

export async function readJson(req, max = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

export function sameToken(value) {
  if (!TOKEN || typeof value !== 'string') return false;
  const left = Buffer.from(value);
  const right = Buffer.from(TOKEN);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorized(req) {
  const auth = String(req.headers.authorization || '');
  return (auth.startsWith('Bearer ') && sameToken(auth.slice(7))) || sameToken(cookie(req, 'mochimono_session'));
}

export function requireAuth(req, res) {
  if (authorized(req)) return true;
  json(res, 401, { error: 'Unauthorized' });
  return false;
}
