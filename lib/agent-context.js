import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { join, resolve } from 'node:path';

export const CONFIG_DIR = resolve(process.env.MOCHIMONO_CONFIG_DIR || join(homedir(), '.mochimono'));
export const CONFIG_PATH = join(CONFIG_DIR, 'agent.json');
export const SYNC_INDEX_PATH = join(CONFIG_DIR, 'index.sqlite');
export const DEVICE = hostname();
export const now = () => new Date().toISOString();
export const pathKey = path => platform() === 'win32' ? resolve(path).toLowerCase() : resolve(path);

let saved = {};
try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
const savedUploadWorkers = [1, 2, 4].includes(Number(saved.uploadWorkers)) ? Number(saved.uploadWorkers) : 2;
const savedThumbnailMode = ['off', 'idle', 'max'].includes(String(saved.thumbnailMode)) ? String(saved.thumbnailMode) : 'idle';

export const settings = {
  server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
  token: String(process.env.MOCHIMONO_TOKEN || saved.token || ''),
  device: String(saved.device || DEVICE),
  deviceAliases: Array.isArray(saved.deviceAliases) ? [...new Set(saved.deviceAliases.map(String).filter(Boolean))] : [],
  uploadWorkers: savedUploadWorkers,
  thumbnailMode: savedThumbnailMode,
  folders: Array.isArray(saved.folders) ? saved.folders.map(item => ({
    path: resolve(String(item.path || item)),
    importId: Number(item.importId) || null,
    lastSynced: item.lastSynced ? String(item.lastSynced) : null
  })) : [],
  browseFolders: Array.isArray(saved.browseFolders) ? [...new Set(saved.browseFolders.map(path => resolve(String(path))))] : [],
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
let backgroundJobGate = () => true;
const suspendedBackgroundJobs = [];
let suspendedTimer = null;
let suspendedNotBefore = 0;

export const currentJob = () => job;

function configuredPath(path) {
  if (!path) return true;
  const key = pathKey(path);
  return settings.folders.some(folder => pathKey(folder.path) === key) || settings.browseFolders.some(folder => pathKey(folder) === key);
}

function scheduleSuspended(delay = 0) {
  if (!suspendedBackgroundJobs.length) return;
  if (suspendedTimer) clearTimeout(suspendedTimer);
  suspendedTimer = setTimeout(pumpSuspended, Math.max(0, delay));
  suspendedTimer.unref?.();
}

function pumpSuspended() {
  suspendedTimer = null;
  if (!suspendedBackgroundJobs.length) return;
  const wait = suspendedNotBefore - Date.now();
  if (wait > 0) return scheduleSuspended(wait);
  if (job?.status === 'running' || !backgroundJobGate()) return scheduleSuspended(1000);

  while (suspendedBackgroundJobs.length) {
    const next = suspendedBackgroundJobs.shift();
    if (next.path && !configuredPath(next.path)) continue;
    if (beginJob(next.type, next.label, next.work, next.options)) return;
    suspendedBackgroundJobs.unshift(next);
    return scheduleSuspended(500);
  }
}

export function setBackgroundJobGate(gate) {
  backgroundJobGate = typeof gate === 'function' ? gate : () => true;
  scheduleSuspended(0);
}

export function canceled() {
  if (job?.cancelRequested) throw Object.assign(new Error('Canceled'), { canceled: true });
}

export function cancelJob() {
  if (job?.status !== 'running') return false;
  job.cancelRequested = true;
  return true;
}

export function preemptBackgroundJob() {
  if (job?.status !== 'running' || !job.background || job.cancelRequested) return false;
  const descriptor = job.backgroundDescriptor;
  if (descriptor) {
    suspendedBackgroundJobs.push({
      ...descriptor,
      path: descriptor.path || String(job.progress?.path || '')
    });
    suspendedNotBefore = Math.max(suspendedNotBefore, Date.now() + 2000);
  }
  job.cancelRequested = true;
  scheduleSuspended(2000);
  return true;
}

export function beginJob(type, label, work, options = {}) {
  if (job?.status === 'running') return null;
  const descriptor = options.background === true ? {
    type,
    label,
    work,
    options: { ...options, background: true },
    path: String(options.path || '')
  } : null;
  job = {
    id: randomUUID(), type, label, status: 'running', cancelRequested: false,
    background: options.background === true, startedAt: now(), progress: {}
  };
  if (descriptor) Object.defineProperty(job, 'backgroundDescriptor', { value: descriptor, enumerable: false });
  const id = job.id;
  setImmediate(async () => {
    try {
      const update = patch => {
        canceled();
        if (job?.id === id && job.status === 'running') {
          job.progress = { ...job.progress, ...patch };
          if (descriptor && patch?.path) descriptor.path = String(patch.path);
        }
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
    } finally {
      scheduleSuspended(0);
    }
  });
  return job;
}

export function startJob(res, type, label, work) {
  const started = beginJob(type, label, work);
  if (!started) return json(res, 409, { error: 'Another Agent operation is already running' });
  return json(res, 202, { job: started });
}
