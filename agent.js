import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, watch } from 'node:fs';
import { mkdir, opendir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { restoreBackup } from './lib/restore.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(ROOT, 'agent-web');
const CONFIG_DIR = join(homedir(), '.mochimono');
const CONFIG_PATH = join(CONFIG_DIR, 'agent.json');
const HOST = '127.0.0.1';
const PORT = Number(process.env.MOCHIMONO_AGENT_PORT || 8643);
const DEVICE = hostname();

let saved = {};
try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}

const settings = {
  server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
  token: String(process.env.MOCHIMONO_TOKEN || saved.token || ''),
  device: String(saved.device || DEVICE),
  folders: Array.isArray(saved.folders) ? saved.folders.map(item => ({
    path: resolve(String(item.path || item)),
    importId: Number(item.importId) || null,
    lastSynced: item.lastSynced ? String(item.lastSynced) : null
  })) : [],
  backups: Array.isArray(saved.backups) ? saved.backups.map(String) : []
};

let job = null;
const folderWatchers = new Map();
const pendingSyncs = new Set();
const pathKey = path => platform() === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const folderFor = path => settings.folders.find(folder => pathKey(folder.path) === pathKey(path));
const now = () => new Date().toISOString();

async function persistSettings() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

async function rememberBackup(path) {
  const root = resolve(path);
  if (!settings.backups.includes(root)) {
    settings.backups.push(root);
    await persistSettings();
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readJson(req, max = 1024 * 1024) {
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

async function api(path, options = {}) {
  if (!settings.token) throw new Error('Connect to the Mochimono server first');
  const headers = { authorization: `Bearer ${settings.token}`, ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== 'string' && !body.pipe && !body[Symbol.asyncIterator]) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const streaming = body?.pipe || body?.[Symbol.asyncIterator];
  const response = await fetch(`${settings.server}${path}`, { ...options, headers, body, duplex: streaming ? 'half' : undefined });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return (response.headers.get('content-type') || '').includes('application/json') ? response.json() : response;
}

async function serverState() {
  if (!settings.token) return { online: false, error: 'Not connected' };
  try { return { online: true, stats: await api('/api/stats') }; }
  catch (error) { return { online: false, error: error.message }; }
}

function canceled() {
  if (job?.cancelRequested) throw Object.assign(new Error('Canceled'), { canceled: true });
}

function beginJob(type, label, work) {
  if (job?.status === 'running') return null;
  job = { id: randomUUID(), type, label, status: 'running', cancelRequested: false, startedAt: now(), progress: {} };
  setImmediate(async () => {
    try {
      const update = patch => {
        canceled();
        if (job?.status === 'running') job.progress = { ...job.progress, ...patch };
      };
      const result = await work(update);
      canceled();
      job = { ...job, status: 'done', cancelRequested: false, finishedAt: now(), result };
    } catch (error) {
      if (!error.canceled) console.error(error);
      job = {
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

function startJob(res, type, label, work) {
  const started = beginJob(type, label, work);
  if (!started) return json(res, 409, { error: 'Another Agent operation is already running' });
  return json(res, 202, { job: started });
}

async function* filesUnder(directory) {
  canceled();
  let dir;
  try { dir = await opendir(directory); }
  catch { return; }
  for await (const entry of dir) {
    canceled();
    if (entry.name === '.mochimono') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

async function hashFile(path, onProgress) {
  const hash = createHash('sha256');
  let read = 0;
  for await (const chunk of createReadStream(path)) {
    canceled();
    hash.update(chunk);
    read += chunk.length;
    onProgress?.(read);
  }
  return hash.digest('hex');
}

const MIME = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.heic', 'image/heic'], ['.avif', 'image/avif'],
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.mkv', 'video/x-matroska'], ['.webm', 'video/webm'], ['.avi', 'video/x-msvideo'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.flac', 'audio/flac'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.csv', 'text/csv'], ['.html', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'],
  ['.json', 'application/json'], ['.pdf', 'application/pdf'], ['.zip', 'application/zip'], ['.7z', 'application/x-7z-compressed'], ['.rar', 'application/vnd.rar']
]);
const mimeFor = path => MIME.get(extname(path).toLowerCase()) || 'application/octet-stream';

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function transferProgress(doneBytes, totalBytes, startedAt) {
  const elapsed = Math.max(0.1, (Date.now() - startedAt) / 1000);
  const speedBps = doneBytes / elapsed;
  return {
    doneBytes,
    totalBytes,
    speedBps: Math.round(speedBps),
    etaSeconds: speedBps > 0 && doneBytes < totalBytes ? Math.ceil((totalBytes - doneBytes) / speedBps) : 0,
    indeterminate: false
  };
}

function progressReporter(update, base) {
  let last = 0;
  return (patch, force = false) => {
    const time = Date.now();
    if (!force && time - last < 180) return;
    last = time;
    update({ ...base, ...patch });
  };
}

async function uploadFile(record, onProgress) {
  let sent = 0;
  let last = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      sent += chunk.length;
      const time = Date.now();
      if (time - last >= 180 || sent === record.size) {
        last = time;
        onProgress?.(sent);
      }
      callback(null, chunk);
    }
  });
  await api(`/api/objects/${record.hash}`, {
    method: 'PUT',
    headers: { 'content-length': String(record.size), 'x-mochimono-mime': record.mime },
    body: createReadStream(record.path).pipe(meter)
  });
  canceled();
}

async function syncFiles(folder, update, importId = null) {
  const root = resolve(folder);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`${root} is not a directory`);

  const records = [];
  let errors = 0;
  const scanReport = progressReporter(update, { phase: 'Scanning', path: root, indeterminate: true });
  scanReport({ scanned: 0, current: '' }, true);

  for await (const path of filesUnder(root)) {
    try {
      const file = await stat(path);
      records.push({
        path,
        relative: relative(root, path).replaceAll('\\', '/'),
        size: file.size,
        mtime: file.mtime.toISOString(),
        mime: mimeFor(path)
      });
      scanReport({ scanned: records.length, current: relative(root, path) });
    } catch (error) {
      if (error.canceled) throw error;
      errors++;
    }
  }
  scanReport({ scanned: records.length, current: '' }, true);

  const totalBytes = records.reduce((sum, record) => sum + record.size, 0);
  const hashed = [];
  let hashedBytes = 0;
  const hashStarted = Date.now();
  const hashReport = progressReporter(update, { phase: 'Hashing', path: root });

  for (const record of records) {
    const base = hashedBytes;
    try {
      record.hash = await hashFile(record.path, read => {
        hashReport({ current: record.relative, ...transferProgress(base + read, totalBytes, hashStarted) });
      });
      hashed.push(record);
    } catch (error) {
      if (error.canceled) throw error;
      errors++;
    }
    hashedBytes += record.size;
    hashReport({ current: record.relative, ...transferProgress(hashedBytes, totalBytes, hashStarted) }, true);
  }

  const unique = new Map();
  for (const record of hashed) if (!unique.has(record.hash)) unique.set(record.hash, record);
  const hashes = [...unique.keys()];
  const missing = new Set();
  const ignored = new Set();

  update({ phase: 'Checking', path: root, indeterminate: true, current: '' });
  for (let index = 0; index < hashes.length; index += 1000) {
    const result = await api('/api/objects/check', { method: 'POST', body: { hashes: hashes.slice(index, index + 1000) } });
    result.missing.forEach(hash => missing.add(hash));
    result.ignored.forEach(hash => ignored.add(hash));
  }

  const missingRecords = [...missing].map(hash => unique.get(hash));
  const uploadBytes = missingRecords.reduce((sum, record) => sum + record.size, 0);
  let uploadedBytes = 0;

  if (uploadBytes) {
    const uploadStarted = Date.now();
    const uploadReport = progressReporter(update, { phase: 'Uploading', path: root });
    for (const record of missingRecords) {
      const base = uploadedBytes;
      await uploadFile(record, sent => {
        uploadReport({ current: record.relative, ...transferProgress(base + sent, uploadBytes, uploadStarted) });
      });
      uploadedBytes += record.size;
      uploadReport({ current: record.relative, ...transferProgress(uploadedBytes, uploadBytes, uploadStarted) }, true);
    }
  }

  update({ phase: 'Saving', path: root, indeterminate: true, current: '' });
  const source = settings.device;
  const created = importId ? { id: importId } : await api('/api/imports', { method: 'POST', body: { sourceName: source } });
  const accepted = hashed.filter(record => !ignored.has(record.hash));

  if (importId) {
    await api(`/api/imports/${importId}`, { method: 'POST', body: { sourceName: source } });
  }

  for (let index = 0; index < accepted.length; index += 1000) {
    await api('/api/sources', {
      method: 'POST',
      body: {
        importId: created.id,
        sources: accepted.slice(index, index + 1000).map(record => ({
          hash: record.hash,
          path: record.relative,
          filename: basename(record.path),
          mtime: record.mtime
        }))
      }
    });
  }

  return {
    importId: created.id,
    source,
    scanned: records.length,
    new: missingRecords.length,
    duplicates: Math.max(0, accepted.length - missingRecords.length),
    ignored: hashed.length - accepted.length,
    errors,
    uploadedBytes
  };
}

async function syncFolder(folder, update) {
  const result = await syncFiles(folder.path, update, folder.importId);
  folder.importId = result.importId;
  folder.lastSynced = now();
  await persistSettings();
  return result;
}

function queueFolderSync(path) {
  const folder = folderFor(path);
  if (folder) pendingSyncs.add(pathKey(folder.path));
}

function watchFolder(folder) {
  const key = pathKey(folder.path);
  if (folderWatchers.has(key) || !existsSync(folder.path)) return;
  try {
    const watcher = watch(folder.path, { recursive: true }, () => queueFolderSync(folder.path));
    watcher.on('error', () => {
      watcher.close();
      folderWatchers.delete(key);
    });
    folderWatchers.set(key, watcher);
  } catch {}
}

function unwatchFolder(path) {
  const key = pathKey(path);
  folderWatchers.get(key)?.close();
  folderWatchers.delete(key);
  pendingSyncs.delete(key);
}

function pumpSyncs() {
  if (!settings.token || job?.status === 'running' || !pendingSyncs.size) return;
  const key = pendingSyncs.values().next().value;
  const folder = settings.folders.find(item => pathKey(item.path) === key);
  pendingSyncs.delete(key);
  if (!folder || !existsSync(folder.path)) return;
  beginJob('sync', `Sync ${basename(folder.path) || folder.path}`, update => syncFolder(folder, update));
}

const controlPath = root => join(root, '.mochimono');
const driveMetaPath = root => join(controlPath(root), 'drive.json');
const driveDbPath = root => join(controlPath(root), 'inventory.sqlite');
const backupObjectPath = (root, hash) => join(controlPath(root), 'objects', hash.slice(0, 2), hash);

function openInventory(root) {
  const db = new DatabaseSync(driveDbPath(root), { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS objects (
      hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      stored_at TEXT NOT NULL,
      verified_at TEXT
    ) STRICT;
  `);
  return db;
}

async function readBackup(root) {
  return JSON.parse(await readFile(driveMetaPath(root), 'utf8'));
}

function policy(types) {
  const clean = Array.isArray(types) ? types.map(String).map(value => value.trim()).filter(Boolean) : [];
  return clean.length ? { all: false, types: clean } : { all: true, types: [] };
}

async function registerBackup(meta) {
  return api('/api/drives/register', { method: 'POST', body: meta });
}

async function backupInit(path, name, types, configure = false) {
  const root = resolve(path);
  if (!(await stat(root)).isDirectory()) throw new Error(`${root} is not a directory`);

  if (existsSync(driveMetaPath(root))) {
    const meta = await readBackup(root);
    if (configure) {
      if (String(name || '').trim()) meta.name = String(name).trim();
      meta.policy = policy(types);
      await writeFile(driveMetaPath(root), `${JSON.stringify(meta, null, 2)}\n`);
    }
    await rememberBackup(root);
    let remote = null;
    try { remote = await registerBackup(meta); } catch {}
    return { path: root, meta, remote, existing: true, configured: configure };
  }

  await mkdir(controlPath(root), { recursive: true });
  const meta = { format: 1, id: randomUUID(), name: String(name || basename(root) || root), policy: policy(types), createdAt: now() };
  await writeFile(driveMetaPath(root), `${JSON.stringify(meta, null, 2)}\n`);
  openInventory(root).close();
  await rememberBackup(root);
  let remote = null;
  try { remote = await registerBackup(meta); } catch {}
  return { path: root, meta, remote, existing: false };
}

async function downloadVerified(hash, expectedSize, destination) {
  canceled();
  const response = await api(`/api/objects/${hash}`);
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive: true });
  const digest = createHash('sha256');
  let size = 0;
  const verifier = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temp, { flags: 'wx' }));
    canceled();
    if (digest.digest('hex') !== hash || size !== expectedSize) throw new Error(`Verification failed for ${hash}`);
    await rm(destination, { force: true });
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function reportReplicas(id, replicas) {
  if (replicas.length) await api(`/api/drives/${encodeURIComponent(id)}/replicas`, { method: 'POST', body: { replicas } });
}

async function saveCatalogSnapshot(root) {
  canceled();
  const response = await api('/api/catalog/export');
  const target = join(controlPath(root), 'catalog.sqlite');
  const temp = `${target}.tmp`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  canceled();
  await rm(target, { force: true });
  await rename(temp, target);
}

async function backupUpdate(path, update) {
  const root = resolve(path);
  const meta = await readBackup(root);
  await rememberBackup(root);
  await registerBackup(meta);
  const db = openInventory(root);
  const find = db.prepare('SELECT hash, size, verified_at FROM objects WHERE hash = ?');
  const save = db.prepare('INSERT INTO objects(hash, size, stored_at, verified_at) VALUES(?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET size=excluded.size, stored_at=excluded.stored_at, verified_at=excluded.verified_at');
  let after = '';
  let copied = 0;
  let copiedBytes = 0;
  let already = 0;
  let reports = [];

  try {
    do {
      canceled();
      const page = await api(`/api/drives/${encodeURIComponent(meta.id)}/desired?after=${encodeURIComponent(after)}&limit=1000`);
      for (const object of page.objects) {
        canceled();
        const destination = backupObjectPath(root, object.hash);
        const local = find.get(object.hash);
        let present = false;
        if (local && existsSync(destination)) {
          try { present = (await stat(destination)).size === object.size; } catch {}
        }
        if (present) {
          already++;
          reports.push({ hash: object.hash, verifiedAt: local.verified_at });
        } else {
          update({ phase: 'Backing up', current: object.hash.slice(0, 12), copied, already, copiedSize: formatBytes(copiedBytes) });
          await downloadVerified(object.hash, object.size, destination);
          const timestamp = now();
          save.run(object.hash, object.size, timestamp, timestamp);
          reports.push({ hash: object.hash, verifiedAt: timestamp });
          copied++;
          copiedBytes += object.size;
        }
        if (reports.length >= 1000) {
          await reportReplicas(meta.id, reports);
          reports = [];
        }
      }
      after = page.nextAfter || '';
    } while (after);

    await reportReplicas(meta.id, reports);
    update({ phase: 'Saving', copied, already, copiedSize: formatBytes(copiedBytes) });
    await saveCatalogSnapshot(root);
    return { drive: meta.name, copied, already, copiedBytes };
  } finally {
    db.close();
  }
}

async function backupVerify(path, update) {
  const root = resolve(path);
  const meta = await readBackup(root);
  await rememberBackup(root);
  const db = openInventory(root);
  const rows = db.prepare('SELECT hash, size FROM objects ORDER BY hash').all();
  const mark = db.prepare('UPDATE objects SET verified_at = ? WHERE hash = ?');
  const forget = db.prepare('DELETE FROM objects WHERE hash = ?');
  const good = [];
  const bad = [];
  let badCount = 0;

  try {
    for (let index = 0; index < rows.length; index++) {
      canceled();
      const row = rows[index];
      update({ phase: 'Verifying', current: row.hash.slice(0, 12), checked: index, total: rows.length, bad: badCount });
      let ok = false;
      try {
        const path = backupObjectPath(root, row.hash);
        ok = (await stat(path)).size === row.size && await hashFile(path) === row.hash;
      } catch (error) {
        if (error.canceled) throw error;
      }
      if (ok) {
        const timestamp = now();
        mark.run(timestamp, row.hash);
        good.push({ hash: row.hash, verifiedAt: timestamp });
      } else {
        forget.run(row.hash);
        bad.push(row.hash);
        badCount++;
      }
    }
  } finally {
    db.close();
  }

  try {
    await registerBackup(meta);
    for (let i = 0; i < good.length; i += 1000) await reportReplicas(meta.id, good.slice(i, i + 1000));
    for (let i = 0; i < bad.length; i += 1000) await api(`/api/drives/${encodeURIComponent(meta.id)}/replicas/remove`, { method: 'POST', body: { hashes: bad.slice(i, i + 1000) } });
  } catch {}

  update({ phase: 'Done', checked: rows.length, total: rows.length, bad: badCount });
  return { drive: meta.name, checked: rows.length, healthy: rows.length - badCount, bad: badCount };
}

async function backupStatus(path) {
  const root = resolve(path);
  const meta = await readBackup(root);
  await rememberBackup(root);
  const db = openInventory(root);
  const local = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes, MIN(verified_at) AS oldestVerification FROM objects').get();
  db.close();
  let remote = null;
  try { remote = await registerBackup(meta); } catch {}
  return { path: root, meta, local, remote };
}

async function pathInfo(path) {
  const root = resolve(path);
  const fs = await statfs(root);
  let meta = null;
  try { meta = await readBackup(root); } catch {}
  return {
    path: root,
    totalBytes: Number(fs.blocks) * Number(fs.bsize),
    freeBytes: Number(fs.bavail) * Number(fs.bsize),
    managed: Boolean(meta),
    meta
  };
}

async function roots() {
  const candidates = [];
  if (platform() === 'win32') {
    for (let code = 67; code <= 90; code++) candidates.push(`${String.fromCharCode(code)}:\\`);
  } else if (platform() === 'darwin') {
    candidates.push('/');
    try {
      for (const entry of await readdir('/Volumes', { withFileTypes: true })) if (entry.isDirectory()) candidates.push(join('/Volumes', entry.name));
    } catch {}
  } else {
    candidates.push('/');
    for (const base of ['/mnt', join('/media', userInfo().username), join('/run/media', userInfo().username)]) {
      try {
        for (const entry of await readdir(base, { withFileTypes: true })) if (entry.isDirectory()) candidates.push(join(base, entry.name));
      } catch {}
    }
  }

  const result = [];
  for (const path of [...new Set(candidates)]) {
    try { result.push(await pathInfo(path)); } catch {}
  }
  return result;
}

async function backupLocations() {
  const discovered = (await roots()).filter(item => item.managed).map(item => item.path);
  const result = [];
  for (const path of [...new Set([...settings.backups, ...discovered])]) {
    try {
      const info = await pathInfo(path);
      if (!info.managed) continue;
      const status = await backupStatus(path);
      result.push({ ...info, local: status.local, remote: status.remote });
    } catch {}
  }
  return result;
}

function commandOutput(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(stderr.trim() || `Folder picker exited with code ${code}`)));
  });
}

const WINDOWS_FOLDER_PICKER = String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;

namespace Mochimono {
  public static class FolderPicker {
    private static readonly Guid FileOpenDialogClsid = new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
    private const uint PickFolders = 0x00000020;
    private const uint ForceFileSystem = 0x00000040;
    private const uint PathMustExist = 0x00000800;
    private const uint FileSystemPath = 0x80058000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FilterSpec {
      [MarshalAs(UnmanagedType.LPWStr)] public string Name;
      [MarshalAs(UnmanagedType.LPWStr)] public string Spec;
    }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog {
      [PreserveSig] int Show(IntPtr owner);
      void SetFileTypes(uint count, [MarshalAs(UnmanagedType.LPArray)] FilterSpec[] filters);
      void SetFileTypeIndex(uint index);
      void GetFileTypeIndex(out uint index);
      void Advise(IntPtr events, out uint cookie);
      void Unadvise(uint cookie);
      void SetOptions(uint options);
      void GetOptions(out uint options);
      void SetDefaultFolder(IShellItem folder);
      void SetFolder(IShellItem folder);
      void GetFolder(out IShellItem folder);
      void GetCurrentSelection(out IShellItem item);
      void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
      void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
      void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
      void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
      void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
      void GetResult(out IShellItem item);
      void AddPlace(IShellItem item, uint alignment);
      void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
      void Close(int result);
      void SetClientGuid(ref Guid guid);
      void ClearClientData();
      void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
      void BindToHandler(IntPtr bindContext, ref Guid bhid, ref Guid riid, out IntPtr result);
      void GetParent(out IShellItem parent);
      void GetDisplayName(uint format, out IntPtr name);
      void GetAttributes(uint mask, out uint attributes);
      void Compare(IShellItem item, uint hint, out int order);
    }

    public static string Pick() {
      IFileDialog dialog = null;
      IShellItem item = null;
      IntPtr pathPointer = IntPtr.Zero;
      try {
        dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(FileOpenDialogClsid));
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | PickFolders | ForceFileSystem | PathMustExist);
        dialog.SetTitle("Choose a folder for Mochimono");
        dialog.SetOkButtonLabel("Select Folder");
        if (dialog.Show(IntPtr.Zero) != 0) return null;
        dialog.GetResult(out item);
        item.GetDisplayName(FileSystemPath, out pathPointer);
        return Marshal.PtrToStringUni(pathPointer);
      } finally {
        if (pathPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pathPointer);
        if (item != null) Marshal.FinalReleaseComObject(item);
        if (dialog != null) Marshal.FinalReleaseComObject(dialog);
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source
$path = [Mochimono.FolderPicker]::Pick()
if ($path) { [Console]::Out.Write($path) }
`;

async function pickFolder() {
  if (platform() === 'win32') return await commandOutput('powershell.exe', ['-NoProfile', '-STA', '-Command', WINDOWS_FOLDER_PICKER]) || null;
  if (platform() === 'darwin') {
    try { return await commandOutput('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for Mochimono")']) || null; }
    catch { return null; }
  }
  try { return await commandOutput('zenity', ['--file-selection', '--directory', '--title=Choose a folder for Mochimono']) || null; }
  catch { throw new Error('Native folder picker is unavailable. Paste the folder path instead.'); }
}

function staticType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function serveStatic(res, pathname) {
  const relativePath = pathname === '/' ? '/index.html' : pathname;
  const file = resolve(WEB_DIR, `.${relativePath}`);
  if (file !== WEB_DIR && !file.startsWith(`${WEB_DIR}${sep}`)) return false;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(200, { 'content-type': staticType(file), 'content-length': info.size, 'cache-control': 'no-cache' });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, {
      settings: { server: settings.server, hasToken: Boolean(settings.token), device: settings.device, folders: settings.folders },
      server: await serverState(),
      job
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readJson(req);
    settings.server = String(body.server || settings.server).trim().replace(/\/$/, '');
    if (body.token !== undefined && body.token !== '') settings.token = String(body.token);
    if (body.device !== undefined) {
      const device = String(body.device || DEVICE).trim() || DEVICE;
      const changed = device !== settings.device;
      settings.device = device;
      await persistSettings();
      if (changed && settings.token) {
        const ids = [...new Set(settings.folders.map(folder => folder.importId).filter(Boolean))];
        await Promise.allSettled(ids.map(id => api(`/api/imports/${id}`, { method: 'POST', body: { sourceName: device } })));
      }
    } else {
      await persistSettings();
    }
    if (settings.token) settings.folders.forEach(folder => queueFolderSync(folder.path));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/job/cancel') {
    if (job?.status !== 'running') return json(res, 409, { error: 'No operation is running' });
    job.cancelRequested = true;
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/pick-folder') return json(res, 200, { path: await pickFolder() });

  if (req.method === 'POST' && url.pathname === '/api/folders') {
    const body = await readJson(req);
    if (!body.path) return json(res, 400, { error: 'Choose a folder' });
    const root = resolve(String(body.path));
    let info;
    try { info = await stat(root); } catch { return json(res, 400, { error: 'Folder not found' }); }
    if (!info.isDirectory()) return json(res, 400, { error: 'Choose a folder' });

    let folder = folderFor(root);
    if (!folder) {
      folder = { path: root, importId: null, lastSynced: null };
      settings.folders.push(folder);
    }
    await persistSettings();
    watchFolder(folder);
    queueFolderSync(root);
    pumpSyncs();
    return json(res, 200, { folder });
  }

  if (req.method === 'POST' && url.pathname === '/api/folders/sync') {
    const body = await readJson(req);
    if (!body.path) return json(res, 400, { error: 'Folder required' });
    const folder = folderFor(body.path);
    if (!folder) return json(res, 404, { error: 'Folder not found' });
    queueFolderSync(folder.path);
    pumpSyncs();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/folders/remove') {
    const body = await readJson(req);
    if (!body.path) return json(res, 400, { error: 'Folder required' });
    const key = pathKey(body.path);
    const index = settings.folders.findIndex(folder => pathKey(folder.path) === key);
    if (index < 0) return json(res, 404, { error: 'Folder not found' });
    const [folder] = settings.folders.splice(index, 1);
    unwatchFolder(folder.path);
    await persistSettings();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/backups') return json(res, 200, { backups: await backupLocations() });
  if (req.method === 'GET' && url.pathname === '/api/backup/status') return json(res, 200, await backupStatus(url.searchParams.get('path')));

  if (req.method === 'POST' && url.pathname === '/api/backup/init') {
    const body = await readJson(req);
    if (!body.path) return json(res, 400, { error: 'Choose a backup folder' });
    return json(res, 200, await backupInit(body.path, body.name, body.types, body.configure === true));
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/update') {
    const body = await readJson(req);
    if (!body.path) return json(res, 400, { error: 'Choose a backup location' });
    return startJob(res, 'backup', `Update ${body.path}`, update => backupUpdate(body.path, update));
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/verify') {
    const body = await readJson(req);
    if (!body.path) return json(res, 400, { error: 'Choose a backup location' });
    return startJob(res, 'verify', `Verify ${body.path}`, update => backupVerify(body.path, update));
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    const body = await readJson(req);
    if (!body.path || !body.destination) return json(res, 400, { error: 'Backup and destination required' });
    return startJob(res, 'restore', `Restore ${body.path}`, update => restoreBackup(body.path, body.destination, update));
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (await serveStatic(res, decodeURIComponent(url.pathname))) return;
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Internal error' });
    else res.destroy();
  }
});

function openBrowser(url) {
  if (process.env.MOCHIMONO_NO_OPEN === '1') return;
  try {
    const child = platform() === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      : platform() === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

for (const folder of settings.folders) {
  watchFolder(folder);
  queueFolderSync(folder.path);
}
setInterval(pumpSyncs, 1000);
setInterval(() => settings.folders.forEach(folder => queueFolderSync(folder.path)), 15 * 60 * 1000);

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Mochimono Agent: ${url}`);
  console.log(`Server: ${settings.server}`);
  openBrowser(url);
});
