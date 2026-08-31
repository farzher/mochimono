import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { openCatalog } from './lib/db.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = resolve(process.env.MOCHIMONO_DATA || join(ROOT, 'data'));
const TOKEN = process.env.MOCHIMONO_TOKEN || '';
const db = openCatalog(join(DATA_DIR, 'catalog.sqlite'));

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function sameToken(value) {
  if (!TOKEN || typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req) {
  const auth = String(req.headers.authorization || '');
  return (auth.startsWith('Bearer ') && sameToken(auth.slice(7))) || sameToken(cookie(req, 'mochimono_session'));
}

async function handleCollectionDelete(req, res, url) {
  const match = /^\/api\/collections\/(\d+)$/.exec(url.pathname);
  if (!match || req.method !== 'DELETE') return false;
  if (!authorized(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return true;
  }

  const id = Number(match[1]);
  const item = db.prepare('SELECT id, name FROM collections WHERE id = ?').get(id);
  if (!item) {
    json(res, 404, { error: 'Collection not found' });
    return true;
  }

  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  json(res, 200, { ok: true, id, name: item.name });
  return true;
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
      if (await handleCollectionDelete(req, res, url)) return;
    } catch (error) {
      console.error('Collection delete:', error);
      if (!res.headersSent) return json(res, 500, { error: 'Collection delete error' });
      return res.destroy();
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};
