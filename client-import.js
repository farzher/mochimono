import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CONFIG_DIR, api, json, readJson, settings } from './lib/agent-context.js';
import { mimeFor } from './lib/mime.js';

const TMP_DIR = join(CONFIG_DIR, 'tmp');
const sessions = new Map();

function cleanRelative(value) {
  const parts = String(value || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) throw Object.assign(new Error('Invalid file path'), { status: 400 });
  return parts.join('/');
}

async function browseLocalFolders(res, url) {
  const requested = String(url.searchParams.get('path') || '').trim() || homedir();
  const target = resolve(requested);
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) return json(res, 404, { error: 'Folder is unavailable' });

  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    return json(res, 403, { error: error?.message || 'Folder cannot be opened' });
  }

  const root = parse(target).root;
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return json(res, 200, {
    path: target,
    parent: target === root ? null : dirname(target),
    root,
    directories
  });
}

async function importIdentity(body) {
  const requested = Number(body.importId) || 0;
  if (requested > 0) {
    try {
      await api(`/api/imports/${requested}`, { method: 'POST', body: { sourceName: settings.device } });
      return requested;
    } catch {}
  }
  const created = await api('/api/imports', { method: 'POST', body: { sourceName: settings.device } });
  return Number(created.id);
}

async function startImport(req, res) {
  const body = await readJson(req, 128 * 1024);
  const importId = await importIdentity(body);
  const label = String(body.label || 'Drop').slice(0, 200);
  const rootPath = String(body.rootPath || label).slice(0, 2000);
  const scope = String(body.scope || '').toLowerCase() === 'all' ? 'all' : 'media';
  const id = randomUUID();
  sessions.set(id, { importId, createdAt: Date.now(), label, seen:new Set() });

  await api('/api/import-roots', {
    method: 'POST',
    body: { roots: [{ importId, deviceName: settings.device, rootPath }] }
  }).catch(() => {});
  if (body.browser === true || body.scope !== undefined) {
    await api('/api/import-scope', { method: 'POST', body: { importId, scope } }).catch(() => {});
  }

  return json(res, 200, { session: id, importId, scope });
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
    const checked = await api('/api/objects/check', { method: 'POST', body: { hashes: [hash] } });
    const missing = (checked.missing || []).includes(hash);
    const ignored = (checked.ignored || []).includes(hash);
    let previous = [];

    if (!missing) {
      try { previous = (await api(`/api/files/${hash}/details`)).sources || []; } catch {}
    }

    if (missing && !ignored) {
      await api(`/api/objects/${hash}`, {
        method: 'PUT',
        headers: { 'content-length': String(size), 'x-mochimono-mime': mime },
        body: createReadStream(temp)
      });
    }

    if (!ignored) {
      await api('/api/sources', {
        method: 'POST',
        body: { importId: session.importId, sources: [{ hash, path: relative, filename: name, mtime }] }
      });
    }
    session.seen.add(relative);

    return json(res, 200, { hash, name, path: relative, size, existing: !missing, ignored, previous });
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function markSeen(req, res, url) {
  const session = sessions.get(String(url.searchParams.get('session') || ''));
  if (!session) return json(res, 410, { error: 'Import session expired' });
  const body = await readJson(req, 2 * 1024 * 1024);
  if (!Array.isArray(body.paths) || body.paths.length > 4000) return json(res, 400, { error: 'paths must be an array of at most 4000 entries' });
  for (const path of body.paths) session.seen.add(cleanRelative(path));
  json(res, 200, { ok:true, count:body.paths.length });
}

async function finishImport(req, res, url) {
  const sessionId = String(url.searchParams.get('session') || '');
  const session = sessions.get(sessionId);
  if (!session) return json(res, 410, { error: 'Import session expired' });

  let removed = 0;
  try {
    const current = await api(`/api/imports/${session.importId}/source-paths`);
    const missing = (current.paths || []).filter(path => !session.seen.has(String(path)));
    for (let offset = 0; offset < missing.length; offset += 2000) {
      const batch = missing.slice(offset, offset + 2000);
      const result = await api(`/api/imports/${session.importId}/source-paths/remove`, { method:'POST', body:{ paths:batch } });
      removed += Number(result.count) || 0;
    }
    sessions.delete(sessionId);
    json(res, 200, { ok:true, importId:session.importId, seen:session.seen.size, removed });
  } catch (error) {
    json(res, error.status || 500, { error:error.message || 'Could not finish folder sync' });
  }
}

export async function handleClientImport(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/client/folder-browser') {
    await browseLocalFolders(res, url);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/client/import/start') {
    await startImport(req, res);
    return true;
  }
  if (req.method === 'PUT' && url.pathname === '/api/client/import/file') {
    await importFile(req, res, url);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/client/import/seen') {
    await markSeen(req, res, url);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/client/import/finish') {
    await finishImport(req, res, url);
    return true;
  }
  return false;
}

function cleanupSessions() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, value] of sessions) if (value.createdAt < cutoff) sessions.delete(id);
}
const cleanupTimer = setInterval(cleanupSessions, 10 * 60 * 1000);
cleanupTimer.unref?.();
