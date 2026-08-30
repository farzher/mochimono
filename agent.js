import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, opendir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir, platform, userInfo } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(ROOT, 'agent-web');
const CONFIG_DIR = join(homedir(), '.mochimono');
const CONFIG_PATH = join(CONFIG_DIR, 'agent.json');
const HOST = '127.0.0.1';
const PORT = Number(process.env.MOCHIMONO_AGENT_PORT || 8643);
const BATCH = 250;

let saved = {};
try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
let settings = {
  server: String(process.env.MOCHIMONO_URL || saved.server || 'http://127.0.0.1:8642').replace(/\/$/, ''),
  token: String(process.env.MOCHIMONO_TOKEN || saved.token || ''),
  backups: Array.isArray(saved.backups) ? saved.backups.map(String) : []
};
let job = null;

async function persistSettings() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

async function saveSettings(next) {
  settings.server = String(next.server || settings.server || 'http://127.0.0.1:8642').trim().replace(/\/$/, '');
  if (next.token !== undefined) settings.token = String(next.token);
  await persistSettings();
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
  if (!settings.token) throw new Error('Set the Mochimono server token in Agent Settings first');
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
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response;
}

async function* filesUnder(root, directory = root) {
  const dir = await opendir(directory);
  for await (const entry of dir) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(root, path);
    else if (entry.isFile()) yield path;
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const MIME = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.heic', 'image/heic'], ['.avif', 'image/avif'],
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.mkv', 'video/x-matroska'], ['.webm', 'video/webm'], ['.avi', 'video/x-msvideo'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.flac', 'audio/flac'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.json', 'application/json'], ['.csv', 'text/csv'], ['.html', 'text/html'], ['.css', 'text/css'], ['.js', 'text/javascript'],
  ['.pdf', 'application/pdf'], ['.zip', 'application/zip'], ['.7z', 'application/x-7z-compressed'], ['.rar', 'application/vnd.rar']
]);
function mimeFor(path) { return MIME.get(extname(path).toLowerCase()) || 'application/octet-stream'; }

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function progress(patch) {
  if (job?.status === 'running') job.progress = { ...job.progress, ...patch };
}

function startJob(res, type, label, work) {
  if (job?.status === 'running') return json(res, 409, { error: 'Another agent operation is already running' });
  job = { id: randomUUID(), type, label, status: 'running', startedAt: new Date().toISOString(), progress: {} };
  json(res, 202, { job });
  setImmediate(async () => {
    try {
      const result = await work(progress);
      job = { ...job, status: 'done', finishedAt: new Date().toISOString(), result };
    } catch (error) {
      console.error(error);
      job = { ...job, status: 'error', finishedAt: new Date().toISOString(), error: error.message };
    }
  });
}

async function uploadFile(record) {
  await api(`/api/objects/${record.hash}`, {
    method: 'PUT',
    headers: { 'content-length': String(record.size), 'x-mochimono-mime': record.mime },
    body: createReadStream(record.path)
  });
}

async function importBatch(importId, records, totals, update) {
  const firstByHash = new Map();
  for (const record of records) if (!firstByHash.has(record.hash)) firstByHash.set(record.hash, record);
  const check = await api('/api/objects/check', { method: 'POST', body: { hashes: [...firstByHash.keys()] } });
  const missing = new Set(check.missing);
  const ignored = new Set(check.ignored);
  let uploadedObjects = 0;

  for (const hash of missing) {
    const record = firstByHash.get(hash);
    update({ phase: 'Uploading', current: record.relative });
    await uploadFile(record);
    totals.new++;
    totals.uploadedBytes += record.size;
    uploadedObjects++;
  }

  const accepted = records.filter(record => !ignored.has(record.hash));
  totals.ignored += records.length - accepted.length;
  totals.duplicates += accepted.length - uploadedObjects;
  const sources = accepted.map(record => ({ hash: record.hash, path: record.relative, filename: basename(record.path), mtime: record.mtime }));
  if (sources.length) await api('/api/sources', { method: 'POST', body: { importId, sources } });
  update({ ...totals, uploaded: formatBytes(totals.uploadedBytes) });
}

async function importFolder(folder, sourceName, update) {
  const root = resolve(folder);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`${root} is not a directory`);
  const source = String(sourceName || basename(root) || root);
  const created = await api('/api/imports', { method: 'POST', body: { sourceName: source } });
  const totals = { scanned: 0, new: 0, duplicates: 0, ignored: 0, uploadedBytes: 0 };
  let batch = [];
  update({ phase: 'Scanning', source, path: root, ...totals });

  for await (const path of filesUnder(root)) {
    const info = await stat(path);
    const rel = relative(root, path).replaceAll('\\', '/');
    update({ phase: 'Hashing', current: rel, scanned: totals.scanned });
    const hash = await hashFile(path);
    totals.scanned++;
    batch.push({ path, relative: rel, hash, size: info.size, mtime: info.mtime.toISOString(), mime: mimeFor(path) });
    if (batch.length >= BATCH) {
      await importBatch(created.id, batch, totals, update);
      batch = [];
    }
  }
  if (batch.length) await importBatch(created.id, batch, totals, update);
  update({ phase: 'Done', current: '', ...totals, uploaded: formatBytes(totals.uploadedBytes) });
  return { importId: created.id, source, ...totals };
}

function driveMetaPath(root) { return join(root, '.mochimono', 'drive.json'); }
function driveDbPath(root) { return join(root, '.mochimono', 'inventory.sqlite'); }
function backupObjectPath(root, hash) { return join(root, '.mochimono', 'objects', hash.slice(0, 2), hash); }

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

async function readDrive(root) { return JSON.parse(await readFile(driveMetaPath(root), 'utf8')); }
async function registerDrive(meta) { return api('/api/drives/register', { method: 'POST', body: meta }); }
function parseTypes(types) {
  if (!Array.isArray(types) || !types.length) return { all: true, types: [] };
  const clean = types.map(String).map(value => value.trim()).filter(Boolean);
  return clean.length ? { all: false, types: clean } : { all: true, types: [] };
}

async function backupInit(path, name, types) {
  const root = resolve(path);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`${root} is not a directory`);

  // A Mochimono backup is only a folder. Never format, partition, erase, or otherwise modify the filesystem/drive itself.
  if (existsSync(driveMetaPath(root))) {
    const meta = await readDrive(root);
    await rememberBackup(root);
    return { path: root, meta, remote: await registerDrive(meta), existing: true };
  }

  await mkdir(join(root, '.mochimono'), { recursive: true });
  const meta = {
    format: 1,
    id: randomUUID(),
    name: String(name || basename(root) || root),
    policy: parseTypes(types),
    createdAt: new Date().toISOString()
  };
  await writeFile(driveMetaPath(root), `${JSON.stringify(meta, null, 2)}\n`);
  openInventory(root).close();
  await rememberBackup(root);
  const remote = await registerDrive(meta);
  return { path: root, meta, remote, existing: false };
}

async function downloadVerified(hash, expectedSize, destination) {
  const response = await api(`/api/objects/${hash}`);
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive: true });
  const digest = createHash('sha256');
  let size = 0;
  const verifier = new Transform({ transform(chunk, encoding, callback) { digest.update(chunk); size += chunk.length; callback(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temp, { flags: 'wx' }));
    if (digest.digest('hex') !== hash || size !== expectedSize) throw new Error(`Verification failed for ${hash}`);
    await rm(destination, { force: true });
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function saveCatalogSnapshot(root) {
  const response = await api('/api/catalog/export');
  const target = join(root, '.mochimono', 'catalog.sqlite');
  const temp = `${target}.tmp`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  await rm(target, { force: true });
  await rename(temp, target);
}

async function reportReplicas(driveId, replicas) {
  if (replicas.length) await api(`/api/drives/${encodeURIComponent(driveId)}/replicas`, { method: 'POST', body: { replicas } });
}

async function backupUpdate(path, update) {
  const root = resolve(path);
  const meta = await readDrive(root);
  await rememberBackup(root);
  await registerDrive(meta);
  const db = openInventory(root);
  const find = db.prepare('SELECT hash, size, verified_at FROM objects WHERE hash = ?');
  const save = db.prepare(`INSERT INTO objects(hash, size, stored_at, verified_at) VALUES(?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET size=excluded.size, stored_at=excluded.stored_at, verified_at=excluded.verified_at`);
  let after = '';
  let copied = 0;
  let copiedBytes = 0;
  let already = 0;
  let reports = [];
  update({ phase: 'Checking backup', drive: meta.name, copied, already, copiedBytes });

  try {
    do {
      const page = await api(`/api/drives/${encodeURIComponent(meta.id)}/desired?after=${encodeURIComponent(after)}&limit=1000`);
      for (const object of page.objects) {
        const destination = backupObjectPath(root, object.hash);
        const local = find.get(object.hash);
        if (local && existsSync(destination)) {
          already++;
          reports.push({ hash: object.hash, verifiedAt: local.verified_at });
        } else {
          update({ phase: 'Backing up', current: object.hash.slice(0, 12), copied, already, copiedBytes, copiedSize: formatBytes(copiedBytes) });
          await downloadVerified(object.hash, object.size, destination);
          const timestamp = new Date().toISOString();
          save.run(object.hash, object.size, timestamp, timestamp);
          reports.push({ hash: object.hash, verifiedAt: timestamp });
          copied++;
          copiedBytes += object.size;
        }
        if (reports.length >= 1000) { await reportReplicas(meta.id, reports); reports = []; }
      }
      after = page.nextAfter || '';
    } while (after);
    await reportReplicas(meta.id, reports);
    update({ phase: 'Saving catalog snapshot', copied, already, copiedBytes, copiedSize: formatBytes(copiedBytes) });
    await saveCatalogSnapshot(root);
    return { drive: meta.name, copied, already, copiedBytes };
  } finally { db.close(); }
}

async function backupVerify(path, update) {
  const root = resolve(path);
  const meta = await readDrive(root);
  await rememberBackup(root);
  await registerDrive(meta);
  const db = openInventory(root);
  const rows = db.prepare('SELECT hash, size FROM objects ORDER BY hash').all();
  const mark = db.prepare('UPDATE objects SET verified_at = ? WHERE hash = ?');
  const forget = db.prepare('DELETE FROM objects WHERE hash = ?');
  const good = [];
  const bad = [];
  let badCount = 0;
  let checked = 0;
  try {
    for (const row of rows) {
      update({ phase: 'Verifying', drive: meta.name, checked, total: rows.length, bad: badCount, current: row.hash.slice(0, 12) });
      const file = backupObjectPath(root, row.hash);
      let ok = false;
      try { const info = await stat(file); ok = info.size === row.size && await hashFile(file) === row.hash; } catch {}
      checked++;
      if (ok) {
        const timestamp = new Date().toISOString();
        mark.run(timestamp, row.hash);
        good.push({ hash: row.hash, verifiedAt: timestamp });
      } else {
        forget.run(row.hash);
        bad.push(row.hash);
        badCount++;
      }
      if (good.length >= 1000) await reportReplicas(meta.id, good.splice(0));
      if (bad.length >= 1000) await api(`/api/drives/${encodeURIComponent(meta.id)}/replicas/remove`, { method: 'POST', body: { hashes: bad.splice(0) } });
    }
    await reportReplicas(meta.id, good);
    if (bad.length) await api(`/api/drives/${encodeURIComponent(meta.id)}/replicas/remove`, { method: 'POST', body: { hashes: bad } });
    return { drive: meta.name, checked, healthy: checked - badCount, bad: badCount };
  } finally { db.close(); }
}

async function backupStatus(path) {
  const root = resolve(path);
  const meta = await readDrive(root);
  await rememberBackup(root);
  const db = openInventory(root);
  const local = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes, MIN(verified_at) AS oldestVerification FROM objects').get();
  db.close();
  const remote = await registerDrive(meta);
  return { path: root, meta, local, remote };
}

async function managedInfo(path) {
  try {
    const meta = await readDrive(path);
    return { managed: true, meta };
  } catch { return { managed: false }; }
}

async function pathInfo(path) {
  const root = resolve(path);
  const info = await statfs(root);
  const managed = await managedInfo(root);
  return {
    path: root,
    name: root,
    totalBytes: Number(info.blocks) * Number(info.bsize),
    freeBytes: Number(info.bavail) * Number(info.bsize),
    ...managed
  };
}

async function roots() {
  const candidates = [];
  if (platform() === 'win32') {
    for (let code = 67; code <= 90; code++) candidates.push(`${String.fromCharCode(code)}:\\`);
  } else if (platform() === 'darwin') {
    candidates.push('/');
    try { for (const entry of await readdir('/Volumes', { withFileTypes: true })) if (entry.isDirectory()) candidates.push(join('/Volumes', entry.name)); } catch {}
  } else {
    candidates.push('/');
    for (const base of ['/mnt', join('/media', userInfo().username), join('/run/media', userInfo().username)]) {
      try { for (const entry of await readdir(base, { withFileTypes: true })) if (entry.isDirectory()) candidates.push(join(base, entry.name)); } catch {}
    }
  }
  const results = [];
  for (const candidate of [...new Set(candidates)]) {
    try { results.push(await pathInfo(candidate)); } catch {}
  }
  return results;
}

async function backupLocations() {
  const discovered = (await roots()).filter(root => root.managed).map(root => root.path);
  const paths = [...new Set([...settings.backups, ...discovered])];
  const results = [];
  for (const path of paths) {
    try {
      const info = await pathInfo(path);
      if (info.managed) results.push(info);
    } catch {}
  }
  return results;
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

async function pickFolder() {
  if (platform() === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "Choose a folder for Mochimono"',
      '$d.ShowNewFolderButton = $true',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
    ].join('; ');
    return await commandOutput('powershell.exe', ['-NoProfile', '-STA', '-Command', script]) || null;
  }
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
  } catch { return false; }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    let server = { online: false, error: settings.token ? null : 'Token not configured' };
    if (settings.token) {
      try { server = { online: true, stats: await api('/api/stats') }; }
      catch (error) { server = { online: false, error: error.message }; }
    }
    return json(res, 200, { settings: { server: settings.server, hasToken: Boolean(settings.token) }, server, job });
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readJson(req);
    await saveSettings({ server: body.server, token: body.token === '' ? undefined : body.token });
    return json(res, 200, { ok: true, server: settings.server, hasToken: Boolean(settings.token) });
  }
  if (req.method === 'GET' && url.pathname === '/api/pick-folder') return json(res, 200, { path: await pickFolder() });
  if (req.method === 'GET' && url.pathname === '/api/backups') return json(res, 200, { backups: await backupLocations() });
  if (req.method === 'GET' && url.pathname === '/api/backup/status') return json(res, 200, await backupStatus(url.searchParams.get('path')));

  if (req.method === 'POST' && url.pathname === '/api/import') {
    const body = await readJson(req);
    if (!body.path) return json(res, 400, { error: 'Choose or paste a folder to import' });
    return startJob(res, 'import', `Import ${body.source || basename(body.path)}`, update => importFolder(body.path, body.source, update));
  }
  if (req.method === 'POST' && url.pathname === '/api/backup/init') {
    const body = await readJson(req);
    if (!body.path) return json(res, 400, { error: 'Choose or paste a backup folder' });
    const result = await backupInit(body.path, body.name, body.types);
    return json(res, 200, result);
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

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Mochimono Agent: ${url}`);
  console.log(`Server: ${settings.server}`);
  openBrowser(url);
});