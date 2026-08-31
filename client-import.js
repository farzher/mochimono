import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import http from 'node:http';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const TMP_DIR = join(homedir(), '.mochimono', 'tmp');
const sessions = new Map();

const MIME = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
  ['.heic', 'image/heic'], ['.heif', 'image/heif'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime'], ['.mkv', 'video/x-matroska'], ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'], ['.mpg', 'video/mpeg'], ['.mpeg', 'video/mpeg'], ['.m2v', 'video/mpeg'], ['.mts', 'video/mp2t'], ['.m2ts', 'video/mp2t'], ['.3gp', 'video/3gpp'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.flac', 'audio/flac'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.csv', 'text/csv'], ['.html', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'],
  ['.json', 'application/json'], ['.pdf', 'application/pdf'], ['.zip', 'application/zip'], ['.7z', 'application/x-7z-compressed'], ['.rar', 'application/vnd.rar']
]);

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

async function config() {
  let saved = {};
  try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
  return {
    server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
    token: String(process.env.MOCHIMONO_TOKEN || saved.token || ''),
    device: String(saved.device || 'Mochimono Client')
  };
}

async function remote(path, options = {}) {
  const current = await config();
  if (!current.token) throw Object.assign(new Error('Connect the Client first'), { status: 401 });
  const headers = { authorization: `Bearer ${current.token}`, ...(options.headers || {}) };
  if (options.body && typeof options.body === 'object' && !options.body.pipe && !options.body[Symbol.asyncIterator] && !Buffer.isBuffer(options.body)) {
    headers['content-type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const body = options.body;
  const response = await fetch(`${current.server}${path}`, {
    ...options,
    headers,
    duplex: body?.pipe || body?.[Symbol.asyncIterator] ? 'half' : undefined
  });
  const data = (response.headers.get('content-type') || '').includes('application/json')
    ? await response.json().catch(() => ({}))
    : response;
  if (!response.ok) throw Object.assign(new Error(data.error || `${response.status} ${response.statusText}`), { status: response.status });
  return data;
}

function cleanRelative(value) {
  const parts = String(value || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) throw Object.assign(new Error('Invalid file path'), { status: 400 });
  return parts.join('/');
}

function mimeFor(path, supplied) {
  const value = String(supplied || '').trim();
  return value || MIME.get(extname(path).toLowerCase()) || 'application/octet-stream';
}

async function startImport(req, res) {
  const body = await readJson(req);
  const current = await config();
  const created = await remote('/api/imports', { method: 'POST', body: { sourceName: current.device } });
  const id = randomUUID();
  sessions.set(id, { importId: Number(created.id), createdAt: Date.now(), label: String(body.label || 'Drop').slice(0, 200) });
  return json(res, 200, { session: id, importId: Number(created.id) });
}

async function importFile(req, res, url) {
  const session = sessions.get(String(url.searchParams.get('session') || ''));
  if (!session) return json(res, 410, { error: 'Import session expired' });
  const relative = cleanRelative(url.searchParams.get('path'));
  const name = basename(relative);
  const mtime = String(url.searchParams.get('mtime') || '') || new Date().toISOString();
  const mime = mimeFor(relative, req.headers['x-mochimono-file-mime']);

  await mkdir(TMP_DIR, { recursive: true });
  const temp = join(TMP_DIR, `drop-${process.pid}-${Date.now()}-${randomUUID()}`);
  const digest = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    }
  });

  try {
    await pipeline(req, meter, createWriteStream(temp, { flags: 'wx' }));
    const hash = digest.digest('hex');
    const checked = await remote('/api/objects/check', { method: 'POST', body: { hashes: [hash] } });
    const missing = Array.isArray(checked.missing) && checked.missing.includes(hash);
    const ignored = Array.isArray(checked.ignored) && checked.ignored.includes(hash);
    let previous = [];

    if (!missing) {
      try { previous = (await remote(`/api/files/${hash}/details`)).sources || []; } catch {}
    }

    if (missing && !ignored) {
      await remote(`/api/objects/${hash}`, {
        method: 'PUT',
        headers: {
          'content-length': String(size),
          'x-mochimono-mime': mime
        },
        body: createReadStream(temp)
      });
    }

    if (!ignored) {
      await remote('/api/sources', {
        method: 'POST',
        body: {
          importId: session.importId,
          sources: [{ hash, path: relative, filename: name, mtime }]
        }
      });
    }

    return json(res, 200, {
      hash,
      name,
      path: relative,
      size,
      existing: !missing,
      ignored,
      previous: previous.slice(0, 8)
    });
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function cleanupSessions() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, value] of sessions) if (value.createdAt < cutoff) sessions.delete(id);
}
setInterval(cleanupSessions, 10 * 60 * 1000).unref();

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
      if (req.method === 'POST' && url.pathname === '/api/client/import/start') return await startImport(req, res);
      if (req.method === 'PUT' && url.pathname === '/api/client/import/file') return await importFile(req, res, url);
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || 'Import failed' });
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};