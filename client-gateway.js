import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { json, pathKey, readJson, settings } from './lib/agent-context.js';
import { backupThumbnailCandidates } from './lib/backup-thumb-candidates.js';
import { handleClientProviderApi } from './lib/client-providers.js';
import { localCandidate, localCandidates, localCatalog, localLocations } from './lib/local-locations.js';
import { providerThumbnail, queueProviderThumbnail, serveProviderThumbnail } from './lib/provider-thumbs.js';
import { queueRemoteThumbnail } from './lib/thumbnail-agent.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(ROOT, 'web');

function staticType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

async function serveLibrary(res, pathname) {
  let relative = pathname.slice('/files'.length);
  if (!relative || relative === '/') {
    let html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
    html = html
      .replace(/(href|src)="\/(?!api\/)/g, '$1="/files/')
      .replace('</head>', `<script>document.documentElement.classList.add('client-library')</script><style>
        html.client-library .topbar,html.client-library .protection,html.client-library #login{display:none!important}
        html.client-library .shell{padding-top:64px!important;max-width:none!important}
        html.client-library body{min-height:100vh}
        @media(max-width:700px){html.client-library .shell{padding-top:58px!important}}
      </style></head>`)
      .replace('</body>', '<script type="module" src="/files/client-drop.js"></script></body>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-cache' });
    res.end(html);
    return true;
  }

  relative = decodeURIComponent(relative).replace(/^\/+/, '');
  const path = resolve(WEB_DIR, relative);
  if (path !== WEB_DIR && !path.startsWith(`${WEB_DIR}${sep}`)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    res.writeHead(200, { 'content-type': staticType(path), 'content-length': info.size, 'cache-control': 'no-cache' });
    createReadStream(path).pipe(res);
    return true;
  } catch { return false; }
}

async function login(req, res) {
  const body = await readJson(req, 128 * 1024);
  const server = String(body.server || '').trim().replace(/\/$/, '');
  const username = String(body.username || '');
  const password = String(body.password || '');
  if (!server || !username || !password) return json(res, 400, { error: 'Server, username, and password are required' });
  const response = await fetch(`${server}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, device: String(body.device || 'Mochimono Client') })
  });
  const data = await response.json().catch(() => ({}));
  return json(res, response.status, response.ok ? { token: data.token, username: data.username } : { error: data.error || 'Login failed' });
}

async function serverThumbnails(hashes) {
  const empty = () => ({ ready: new Map(), missing: new Map() });
  if (!settings.token || !hashes.length) return empty();
  try {
    const response = await fetch(`${settings.server}/api/thumbs/check`, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hashes })
    });
    if (!response.ok) throw new Error(`Thumbnail check failed (${response.status})`);
    const data = await response.json();
    return {
      ready: new Map((data.thumbnails || []).map(item => [String(item.hash), item])),
      missing: new Map((data.missing || []).map(item => [String(item.hash), item]))
    };
  } catch {
    return empty();
  }
}

function queueBackupThumbnails(hashes, background) {
  if (!hashes.length) return;
  setImmediate(() => {
    const candidates = backupThumbnailCandidates(hashes);
    for (const file of candidates.values()) queueProviderThumbnail(file, { background });
  });
}

async function checkThumbnails(req, res) {
  const body = await readJson(req, 256 * 1024);
  if (!Array.isArray(body.hashes) || body.hashes.length > 500) return json(res, 400, { error: 'hashes must be an array of at most 500 items' });
  const background = body.background === true;
  const hashes = [...new Set(body.hashes.map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  const ready = new Map();
  const locals = localCandidates(hashes);

  const [providerEntries, remote] = await Promise.all([
    Promise.all(hashes.map(async hash => [hash, await providerThumbnail(hash)])),
    serverThumbnails(hashes)
  ]);

  for (const [hash, thumb] of providerEntries) if (thumb) ready.set(hash, thumb);
  for (const [hash, thumb] of remote.ready) if (!ready.has(hash)) ready.set(hash, thumb);

  const unresolved = [];
  for (const hash of hashes) {
    if (ready.has(hash)) continue;
    const candidate = locals.get(hash);
    if (candidate) {
      queueProviderThumbnail({ hash, filename: candidate.filename, mime: candidate.mime, candidate }, { background });
      continue;
    }
    const serverFile = remote.missing.get(hash);
    if (serverFile) queueRemoteThumbnail(serverFile);
    else unresolved.push(hash);
  }
  queueBackupThumbnails(unresolved, background);

  json(res, 200, { thumbnails: [...ready.values()].map(item => ({
    hash: item.hash, width: Number(item.width) || 0, height: Number(item.height) || 0,
    duration: item.duration == null ? null : Number(item.duration)
  })) });
}

async function serveLocalObject(req, res, candidate) {
  let info;
  try { info = await stat(candidate.path); }
  catch { return false; }
  if (!info.isFile() || (candidate.size && Number(info.size) !== Number(candidate.size))) return false;

  const headers = {
    'content-type': candidate.mime || 'application/octet-stream',
    'accept-ranges': 'bytes',
    // /api/objects is content-addressed by SHA-256. A successful response for a
    // hash is immutable, so let the browser keep large local originals instead
    // of rereading/redecoding them every time the viewer returns to that file.
    'cache-control': 'private, max-age=31536000, immutable'
  };
  const range = String(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': info.size });
    if (req.method === 'HEAD') return void res.end();
    const source = createReadStream(candidate.path);
    try { await pipeline(source, res); } catch {}
    return true;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` });
    res.end();
    return true;
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : info.size - 1;
  if (!match[1] && match[2]) {
    start = Math.max(0, info.size - Number(match[2]));
    end = info.size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= info.size) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` });
    res.end();
    return true;
  }
  end = Math.min(end, info.size - 1);
  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${info.size}`,
    'content-length': end - start + 1
  });
  if (req.method === 'HEAD') return void res.end();
  const source = createReadStream(candidate.path, { start, end });
  try { await pipeline(source, res); } catch {}
  return true;
}

function configuredFolder(path) {
  const wanted = pathKey(String(path || ''));
  if (!wanted) return '';
  for (const item of settings.folders || []) {
    const value = typeof item === 'string' ? item : item?.path;
    if (value && pathKey(value) === wanted) return String(value);
  }
  for (const value of settings.browseFolders || []) {
    if (value && pathKey(value) === wanted) return String(value);
  }
  return '';
}

function openNativePath(path, selectFile = false) {
  const target = resolve(String(path || ''));
  let child;
  const options = { detached: true, stdio: 'ignore', windowsHide: false };
  if (platform() === 'win32') {
    // Explorer requires /select and the path as one comma-delimited argument.
    // Splitting them into separate argv entries can launch Explorer successfully
    // while silently ignoring the requested file.
    child = spawn('explorer.exe', selectFile ? [`/select,${target}`] : [target], options);
  } else if (platform() === 'darwin') {
    child = spawn('open', selectFile ? ['-R', target] : [target], options);
  } else {
    child = spawn('xdg-open', [selectFile ? dirname(target) : target], options);
  }
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}

async function proxyApi(req, res, url) {
  if (!settings.token) return json(res, 503, { error: 'Mochimono Server is offline or not connected' });
  const headers = { authorization: `Bearer ${settings.token}` };
  for (const name of ['content-type','content-length','range','if-none-match','if-modified-since','x-mochimono-mime','x-mochimono-thumb-version','x-mochimono-width','x-mochimono-height','x-mochimono-duration','x-mochimono-source-mime']) {
    if (req.headers[name] != null) headers[name] = req.headers[name];
  }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : req;
  const controller = new AbortController();
  let response;
  try {
    response = await fetch(`${settings.server}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body,
      duplex: body ? 'half' : undefined,
      redirect: 'manual',
      signal: controller.signal
    });
  } catch {
    if (!res.headersSent) json(res, 503, { error: 'Mochimono Server is offline' });
    return;
  }

  const out = {};
  for (const name of ['content-type','content-length','content-range','accept-ranges','cache-control','content-disposition','etag','last-modified']) {
    const value = response.headers.get(name);
    if (value != null) out[name] = value;
  }
  res.writeHead(response.status, out);
  if (req.method === 'HEAD' || !response.body) return res.end();

  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
    if (!source.destroyed) source.destroy();
  };
  const close = () => { if (!res.writableFinished) abort(); };
  req.once('aborted', abort);
  res.once('close', close);
  try {
    await pipeline(source, res);
  } catch (error) {
    const expected = controller.signal.aborted || res.destroyed || req.destroyed ||
      error?.code === 'ERR_STREAM_PREMATURE_CLOSE' || /terminated|aborted|premature close/i.test(String(error?.message || ''));
    if (!expected) throw error;
  } finally {
    req.off('aborted', abort);
    res.off('close', close);
  }
}

export async function handleClientGateway(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/client/login') {
    await login(req, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/client/locations') {
    const hash = String(url.searchParams.get('hash') || '');
    if (hash && !/^[a-f0-9]{64}$/.test(hash)) json(res, 400, { error: 'Invalid SHA-256 hash' });
    else json(res, 200, localLocations(hash));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/client/local-catalog') {
    const path = String(url.searchParams.get('path') || '');
    const offset = url.searchParams.has('offset') ? url.searchParams.get('offset') : null;
    json(res, 200, localCatalog(url.searchParams.get('limit'), path, offset));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/reveal-file') {
    const body = await readJson(req, 32 * 1024);
    const hash = String(body.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) json(res, 400, { error: 'Invalid file' });
    else {
      const candidate = localCandidate(hash);
      const info = candidate ? await stat(candidate.path).catch(() => null) : null;
      if (!candidate || !info?.isFile()) json(res, 404, { error: 'No local copy is currently available' });
      else {
        try {
          await openNativePath(candidate.path, true);
          json(res, 200, { ok: true, path: candidate.path });
        } catch (error) {
          json(res, 500, { error: `Could not open file browser: ${error?.message || error}` });
        }
      }
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/open-folder') {
    const body = await readJson(req, 32 * 1024);
    const path = configuredFolder(body.path);
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info?.isDirectory()) json(res, 404, { error: 'Folder is not available' });
    else {
      try {
        await openNativePath(path, false);
        json(res, 200, { ok: true, path });
      } catch (error) {
        json(res, 500, { error: `Could not open folder: ${error?.message || error}` });
      }
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/thumbs/check') {
    await checkThumbnails(req, res);
    return true;
  }

  const object = /^\/api\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
  if (object && (req.method === 'GET' || req.method === 'HEAD')) {
    const candidate = localCandidate(object[1]);
    if (candidate && await serveLocalObject(req, res, candidate)) return true;
  }

  const thumb = /^\/api\/thumbs\/([a-f0-9]{64})$/.exec(url.pathname);
  if (thumb && (req.method === 'GET' || req.method === 'HEAD')) {
    // Serve an existing provider preview immediately. Missing provider generation
    // is queued by the batched /api/thumbs/check path; otherwise fall through to
    // the server thumbnail for the same content hash.
    if (await serveProviderThumbnail(req, res, thumb[1])) return true;
  }
  if (url.pathname === '/files' || url.pathname.startsWith('/files/')) {
    if (!await serveLibrary(res, url.pathname)) json(res, 404, { error: 'Not found' });
    return true;
  }
  if (url.pathname.startsWith('/api/')) {
    if (await handleClientProviderApi(req, res, url)) return true;
    await proxyApi(req, res, url);
    return true;
  }
  return false;
}
