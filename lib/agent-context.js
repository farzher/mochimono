import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { join, resolve } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.mochimono');
export const CONFIG_PATH = join(CONFIG_DIR, 'agent.json');
export const SYNC_INDEX_PATH = join(CONFIG_DIR, 'index.sqlite');
export const DEVICE = hostname();
export const now = () => new Date().toISOString();
export const pathKey = path => platform() === 'win32' ? resolve(path).toLowerCase() : resolve(path);

let saved = {};
try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}

export const settings = {
  server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
  token: String(process.env.MOCHIMONO_TOKEN || saved.token || ''),
  device: String(saved.device || DEVICE),
  folders: Array.isArray(saved.folders) ? saved.folders.map(item => ({
    path: resolve(String(item.path || item)),
    importId: Number(item.importId) || null,
    lastSynced: item.lastSynced ? String(item.lastSynced) : null
  })) : [],
  backups: Array.isArray(saved.backups) ? [...new Set(saved.backups.map(path => resolve(String(path))))] : []
};

export async function persistSettings() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

export async function rememberBackup(path) {
  const root = resolve(path);
  if (settings.backups.includes(root)) return;
  settings.backups.push(root);
  await persistSettings();
}

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

export async function readJson(req, max = 1024 * 1024) {
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

export async function api(path, options = {}) {
  if (!settings.token) throw Object.assign(new Error('Connect to the Mochimono server first'), { status: 401 });
  const headers = { authorization: `Bearer ${settings.token}`, ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== 'string' && !Buffer.isBuffer(body) && !body.pipe && !body[Symbol.asyncIterator]) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const streaming = body?.pipe || body?.[Symbol.asyncIterator];
  const response = await fetch(`${settings.server}${path}`, { ...options, headers, body, duplex: streaming ? 'half' : undefined });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw Object.assign(new Error(message), { status: response.status });
  }
  return (response.headers.get('content-type') || '').includes('application/json') ? response.json() : response;
}

export async function serverState() {
  if (!settings.token) return { online: false, error: 'Not connected' };
  try { return { online: true, stats: await api('/api/stats') }; }
  catch (error) { return { online: false, error: error.message }; }
}

let job = null;
export const currentJob = () => job;

export function canceled() {
  if (job?.cancelRequested) throw Object.assign(new Error('Canceled'), { canceled: true });
}

export function cancelJob() {
  if (job?.status !== 'running') return false;
  job.cancelRequested = true;
  return true;
}

export function beginJob(type, label, work) {
  if (job?.status === 'running') return null;
  job = { id: randomUUID(), type, label, status: 'running', cancelRequested: false, startedAt: now(), progress: {} };
  const id = job.id;
  setImmediate(async () => {
    try {
      const update = patch => {
        canceled();
        if (job?.id === id && job.status === 'running') job.progress = { ...job.progress, ...patch };
      };
      const result = await work(update);
      canceled();
      if (job?.id === id) job = { ...job, status: 'done', cancelRequested: false, finishedAt: now(), result };
    } catch (error) {
      if (!error.canceled) console.error(error);
      if (job?.id === id) job = {
        ...job,
        status: error.canceled ? 'canceled' : 'error',
        cancelRequested: false,
        finishedAt: now(),
        error: error.message
      };
    }
  });
  return job;
}

export function startJob(res, type, label, work) {
  const started = beginJob(type, label, work);
  if (!started) return json(res, 409, { error: 'Another Agent operation is already running' });
  return json(res, 202, { job: started });
}
