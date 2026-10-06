import { execFile } from 'node:child_process';
import { open, opendir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parse, resolve } from 'node:path';
import { promisify } from 'node:util';

// All original readers share this gate, not a folder-specific lease. Windows
// partitions on the same physical disk must share a lane too.
let mappedAt = 0;
let mapping = null;
let disks = new Map();
async function mapDisks() {
  if (process.platform !== 'win32') return;
  if (mapping) return mapping;
  mappedAt = Date.now();
  mapping = promisify(execFile)('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  'Get-Partition | Where-Object DriveLetter | Select-Object DriveLetter,DiskNumber | ConvertTo-Json -Compress'
], { windowsHide:true, timeout:10000 }).then(({ stdout }) => {
  const rows = JSON.parse(stdout || '[]');
  disks = new Map((Array.isArray(rows) ? rows : [rows]).map(row => [`${row.DriveLetter}:\\`.toLowerCase(), `disk:${row.DiskNumber}`]));
}).catch(error => {
  console.warn(`Physical drive discovery failed: ${error.message}`);
}).finally(() => { mapping = null; });
  return mapping;
}
const lanes = new Map();
let active = 0;
let exclusiveActive = false;
const MAX_ACTIVE_DRIVES = 4;

export async function physicalDriveKey(path) {
  const absolute = resolve(String(path));
  if (process.platform === 'win32') {
    const root = parse(absolute).root.toLowerCase();
    if (!mappedAt || Date.now() - mappedAt >= 30_000) await mapDisks();
    // An unidentified local volume cannot safely bypass disk coordination.
    return disks.get(root) || (root.startsWith('\\\\') ? `share:${root}` : 'unidentified-local-disk');
  }
  // Use st_dev, not '/' (which merges every mounted Unix drive).
  let parent = absolute;
  for (;;) {
    const info = await stat(parent).catch(() => null);
    if (info) return `device:${info.dev}`;
    const next = resolve(parent, '..');
    if (next === parent) return `path:${absolute}`;
    parent = next;
  }
}

function pump() {
  while (active < MAX_ACTIVE_DRIVES && !exclusiveActive) {
    let selected;
    for (const lane of lanes.values()) {
      if (lane.busy || !lane.jobs.length || (lane.exclusive && active)) continue;
      if (!selected || lane.jobs[0].priority > selected.jobs[0].priority) selected = lane;
    }
    if (!selected) return;
    const job = selected.jobs.shift();
    selected.busy = true;
    if (selected.exclusive) exclusiveActive = true;
    active++;
    Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
      selected.busy = false;
      if (selected.exclusive) exclusiveActive = false;
      active--;
      pump();
    });
  }
}

// FFmpeg needs seeking, so use the Agent's existing range reader rather than
// an uncoordinated native file input or a non-seekable pipe.
export function driveReadUrl(hash) {
  const host = process.env.MOCHIMONO_AGENT_HOST || '127.0.0.1';
  const address = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${address.includes(':') ? `[${address}]` : address}:${Number(process.env.MOCHIMONO_AGENT_PORT) || 8643}/api/objects/${hash}?background=1`;
}

export async function* directoryEntries(path) {
  const directory = await withDriveRead(path, () => opendir(path));
  try {
    for (;;) {
      const entry = await withDriveRead(path, () => directory.read());
      if (!entry) break;
      yield entry;
    }
  } finally { await directory.close(); }
}

export function driveReadStream(path, { start = 0, end = Infinity, priority = false } = {}) {
  let stream;
  stream = Readable.from((async function* () {
    const file = await withDriveRead(path, () => stream.destroyed ? null : open(path, 'r'), { priority });
    if (!file) return;
    let position = start;
    try {
      while (!stream.destroyed && position <= end) {
        const buffer = Buffer.allocUnsafe(Math.min(8 * 1024 * 1024, end - position + 1));
        const { bytesRead } = await withDriveRead(path,
          () => stream.destroyed ? { bytesRead:0 } : file.read(buffer, 0, buffer.length, position), { priority });
        if (!bytesRead) break;
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    } finally { await file.close(); }
  })(), { highWaterMark:1, objectMode:false });
  return stream;
}

export async function withDriveRead(path, work, { priority = false } = {}) {
  const key = await physicalDriveKey(path);
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, lane = { busy:false, jobs:[], exclusive:key === 'unidentified-local-disk' });
  return new Promise((resolve, reject) => {
    if (lane.jobs.length >= 128) return reject(Object.assign(new Error('Drive reader queue is full'), { code:'EAGAIN', status:503 }));
    const job = { work, resolve, reject, priority:Number(priority) };
    const at = lane.jobs.findIndex(item => item.priority < job.priority);
    if (at < 0) lane.jobs.push(job);
    else lane.jobs.splice(at, 0, job);
    pump();
  });
}
