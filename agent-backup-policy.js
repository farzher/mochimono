import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { inspectBackup } from './lib/restore.js';

const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');
const AGENT_PORT = Number(process.env.MOCHIMONO_AGENT_PORT || 8643);
const driveMetaPath = root => join(root, '.mochimono', 'drive.json');
const now = () => new Date().toISOString();
const trackedJobs = new Set();

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

async function stamp(path, action) {
  const fields = { update: 'lastBackupAt', verify: 'lastVerifiedAt', restore: 'lastRestoreAt' };
  const field = fields[action];
  if (!field) return null;
  const meta = await readMeta(path);
  meta[field] = now();
  await writeMeta(path, meta);
  return meta[field];
}

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

async function watchJob(job, action, path) {
  if (!job?.id || trackedJobs.has(job.id)) return;
  trackedJobs.add(job.id);
  try {
    while (true) {
      await sleep(250);
      let state;
      try {
        const response = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/state`, { cache: 'no-store' });
        if (!response.ok) continue;
        state = await response.json();
      } catch {
        continue;
      }
      if (state.job?.id !== job.id) return;
      if (state.job.status === 'running') continue;
      if (state.job.status === 'done') await stamp(path, action);
      return;
    }
  } catch {}
  finally {
    trackedJobs.delete(job.id);
  }
}

function captureBackupJob(req, res, url, listener) {
  if (req.method !== 'POST') return false;
  const actions = new Map([
    ['/api/backup/update', ['update', 'Update ']],
    ['/api/backup/verify', ['verify', 'Verify ']],
    ['/api/backup/restore', ['restore', 'Restore ']]
  ]);
  const match = actions.get(url.pathname);
  if (!match) return false;
  const [action, prefix] = match;
  const originalEnd = res.end;
  res.end = function (chunk, encoding, callback) {
    res.end = originalEnd;
    try {
      if (res.statusCode === 202 && chunk) {
        const data = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        const job = data?.job;
        const label = String(job?.label || '');
        const path = label.startsWith(prefix) ? label.slice(prefix.length) : '';
        if (path) watchJob(job, action, path);
      }
    } catch {}
    return originalEnd.call(this, chunk, encoding, callback);
  };
  listener(req, res);
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
      if (req.method === 'GET' && url.pathname === '/api/backup-collections') {
        const data = await remote('/api/smart-collections');
        return json(res, 200, { collections: data.collections || [] });
      }

      if (req.method === 'GET' && url.pathname === '/api/backup/contents') {
        const path = url.searchParams.get('path');
        if (!path) return json(res, 400, { error: 'Backup folder required' });
        return json(res, 200, await inspectBackup(path));
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
        const at = await stamp(body.path, String(body.action || ''));
        if (!at) return json(res, 400, { error: 'Invalid backup action' });
        return json(res, 200, { ok: true, at });
      }

      if (captureBackupJob(req, res, url, listener)) return;
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || 'Backup policy error' });
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};
