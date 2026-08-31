import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(ROOT, 'web');
const CONFIG_PATH = join(homedir(), '.mochimono', 'agent.json');

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
    device: String(saved.device || '')
  };
}

function staticType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

// The Client reuses the normal library. These optional replacements only expose
// Client-only live import behavior and added-date state. A library change must
// never make the Client fail to serve app.js, so unmatched replacements are
// simply skipped.
function patchClientApp(source) {
  const replacements = [
    [
      "    backupCount: Number(file.backupCount) || 0,\n    dateMs: Number.isNaN(date.getTime()) ? 0 : date.getTime()",
      "    backupCount: Number(file.backupCount) || 0,\n    addedMs: Number.isNaN(new Date(file.addedAt || file.createdAt || 0).getTime()) ? 0 : new Date(file.addedAt || file.createdAt || 0).getTime(),\n    dateMs: Number.isNaN(date.getTime()) ? 0 : date.getTime()"
    ],
    [
      "function dateValue(file) {\n  return new Date(file.dateMs || 0);\n}",
      "function dateValue(file) {\n  return new Date(sort === 'date-added' ? (file.addedMs || file.dateMs || 0) : (file.dateMs || 0));\n}"
    ],
    [
      "function sortFiles(files) {\n  if (sort === 'date-asc')",
      "function sortFiles(files) {\n  if (sort === 'date-added') return files.sort((a, b) => (b.addedMs || 0) - (a.addedMs || 0) || a.hash.localeCompare(b.hash));\n  if (sort === 'date-asc')"
    ]
  ];
  for (const [from, to] of replacements) if (source.includes(from)) source = source.replace(from, to);

  const marker = 'boot().catch(error => {';
  if (!source.includes(marker)) return source;
  const hook = `window.mochimonoLibrary = {\n  setSort(value) {\n    sort = String(value || 'date-desc');\n    $('#sort').value = sort;\n    applyFilters(true);\n  },\n  setBatch(hashes) {\n    setCollectionHashes(hashes instanceof Set ? hashes : null);\n  },\n  upsert(file) {\n    this.upsertMany(file ? [file] : []);\n  },\n  upsertMany(files) {\n    let changed = false;\n    for (const file of files || []) {\n      if (!file?.hash) continue;\n      const index = catalog.findIndex(item => item.hash === file.hash);\n      if (index >= 0) {\n        const current = catalog[index];\n        catalog[index] = normalizeFile({\n          ...current,\n          ...file,\n          searchText: [current.searchText, file.searchText].filter(Boolean).join(' ')\n        });\n      } else {\n        catalog.push(normalizeFile(file));\n      }\n      changed = true;\n    }\n    if (!changed) return;\n    rebuildIndexes();\n    applyFilters(false);\n  },\n  refresh() { return syncCatalog(true); }\n};\n\n`;
  return source.replace(marker, `${hook}${marker}`);
}

async function serveLibrary(res, pathname) {
  let relative = pathname.slice('/files'.length);
  if (!relative || relative === '/') {
    let html = await readFile(join(WEB_DIR, 'index.html'), 'utf8');
    html = html
      .replace(/(href|src)="\/(?!api\/)/g, '$1="/files/')
      .replace('<script type="module" src="/files/thumbs.js"></script>', '<script type="module" src="/files/client-thumbs.js"></script>')
      .replace('</head>', `<script>document.documentElement.classList.add('client-library')</script><style>
        html.client-library .topbar,html.client-library .protection,html.client-library #login{display:none!important}
        html.client-library .shell{padding-top:0!important;max-width:none!important}
        html.client-library body{min-height:100vh}
      </style></head>`)
      .replace('</body>', '<script type="module" src="/files/client-drop.js"></script></body>');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-cache'
    });
    res.end(html);
    return true;
  }

  relative = decodeURIComponent(relative).replace(/^\/+/, '');
  const path = resolve(WEB_DIR, relative);
  if (path !== WEB_DIR && !path.startsWith(`${WEB_DIR}${sep}`)) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (relative === 'app.js') {
      const source = patchClientApp(await readFile(path, 'utf8'));
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(source),
        'cache-control': 'no-cache'
      });
      res.end(source);
      return true;
    }
    res.writeHead(200, {
      'content-type': staticType(path),
      'content-length': info.size,
      'cache-control': 'no-cache'
    });
    createReadStream(path).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const LOCAL_API = [
  /^\/api\/state$/,
  /^\/api\/settings$/,
  /^\/api\/job\/cancel$/,
  /^\/api\/pick-folder$/,
  /^\/api\/folders(?:\/.*)?$/,
  /^\/api\/backups$/,
  /^\/api\/backup(?:\/.*)?$/,
  /^\/api\/folder-stats$/,
  /^\/api\/backup-collections$/,
  /^\/api\/client(?:\/.*)?$/
];

function isLocalApi(pathname) {
  return LOCAL_API.some(pattern => pattern.test(pathname));
}

async function login(req, res) {
  const body = await readJson(req);
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
  if (!response.ok) return json(res, response.status, { error: data.error || 'Login failed' });
  return json(res, 200, { token: data.token, username: data.username });
}

async function proxyApi(req, res, url) {
  const current = await config();
  if (!current.token) return json(res, 401, { error: 'Connect the Client first' });

  const headers = {};
  for (const name of ['content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since', 'x-mochimono-mime', 'x-mochimono-thumb-version', 'x-mochimono-width', 'x-mochimono-height', 'x-mochimono-duration', 'x-mochimono-source-mime']) {
    if (req.headers[name] != null) headers[name] = req.headers[name];
  }
  headers.authorization = `Bearer ${current.token}`;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : req;
  const controller = new AbortController();
  const response = await fetch(`${current.server}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body,
    duplex: body ? 'half' : undefined,
    redirect: 'manual',
    signal: controller.signal
  });

  const out = {};
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'content-disposition', 'etag', 'last-modified']) {
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
  const onClose = () => {
    if (!res.writableFinished) abort();
  };
  req.once('aborted', abort);
  res.once('close', onClose);
  try {
    await pipeline(source, res);
  } catch (error) {
    const expectedAbort = controller.signal.aborted || res.destroyed || req.destroyed || error?.code === 'ERR_STREAM_PREMATURE_CLOSE' || /terminated|aborted|premature close/i.test(String(error?.message || ''));
    if (!expectedAbort) throw error;
  } finally {
    req.off('aborted', abort);
    res.off('close', onClose);
  }
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
      if (url.pathname === '/api/client/login' && req.method === 'POST') return await login(req, res);
      if (url.pathname === '/files' || url.pathname.startsWith('/files/')) {
        if (await serveLibrary(res, url.pathname)) return;
        return json(res, 404, { error: 'Not found' });
      }
      if (url.pathname.startsWith('/api/') && !isLocalApi(url.pathname)) return await proxyApi(req, res, url);
    } catch (error) {
      if (!res.headersSent) return json(res, error.status || 502, { error: error.message || 'Client gateway error' });
      if (!res.destroyed) res.destroy();
    }
    return listener(req, res);
  };
  return originalCreateServer.apply(context, args);
};
