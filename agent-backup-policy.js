import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const driveMetaPath = root => join(resolve(root), '.mochimono', 'drive.json');
const now = () => new Date().toISOString();

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req, max = 256 * 1024) {
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

async function settings() {
  let saved = {};
  try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
  return {
    server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
    token: String(process.env.MOCHIMONO_TOKEN || saved.token || '')
  };
}

async function remote(path, options = {}) {
  const config = await settings();
  if (!config.token) throw Object.assign(new Error('Connect to the server first'), { status: 409 });
  const response = await fetch(`${config.server}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `${response.status} ${response.statusText}`), { status: response.status });
  return data;
}

async function readMeta(path) {
  return JSON.parse(await readFile(driveMetaPath(path), 'utf8'));
}

async function writeMeta(path, meta) {
  await writeFile(driveMetaPath(path), `${JSON.stringify(meta, null, 2)}\n`);
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
      if (req.method === 'GET' && url.pathname === '/api/backup-collections') {
        const data = await remote('/api/smart-collections');
        return json(res, 200, { collections: data.collections || [] });
      }

      if (req.method === 'POST' && url.pathname === '/api/backup/policy') {
        const body = await readJson(req);
        if (!body.path) return json(res, 400, { error: 'Choose a backup folder' });
        const meta = await readMeta(body.path);
        const collectionId = Number(body.collectionId) || 0;
        meta.policy = collectionId
          ? { all: false, collectionId, collectionName: String(body.collectionName || '').slice(0, 80) }
          : { all: true, collectionId: null };
        await writeMeta(body.path, meta);
        let registered = null;
        try {
          registered = await remote('/api/drives/register', { method: 'POST', body: JSON.stringify(meta) });
        } catch {}
        return json(res, 200, { meta, remote: registered });
      }

      if (req.method === 'POST' && url.pathname === '/api/backup/history') {
        const body = await readJson(req);
        if (!body.path) return json(res, 400, { error: 'Backup folder required' });
        const fields = {
          update: 'lastBackupAt',
          verify: 'lastVerifiedAt',
          restore: 'lastRestoreAt'
        };
        const field = fields[String(body.action || '')];
        if (!field) return json(res, 400, { error: 'Invalid backup action' });
        const meta = await readMeta(body.path);
        meta[field] = now();
        await writeMeta(body.path, meta);
        return json(res, 200, { ok: true, [field]: meta[field] });
      }
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || 'Backup policy error' });
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};