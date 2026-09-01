import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { api, cancelJob, currentJob, DEVICE, json, persistSettings, readJson, serverState, settings, startJob } from './lib/agent-context.js';
import { addFolder, folderFor, folderStats, queueFolderSync, removeFolder, startSyncService } from './lib/agent-sync.js';
import { addBrowseFolder, browseFolderFor, browseFolderStats, indexBrowseFolder, protectBrowseFolder, removeBrowseFolder, startBrowseService } from './lib/browse-folders.js';
import { backupCollections, backupContents, backupInit, backupLocations, backupRestore, backupStatus, backupUpdate, backupVerify, setBackupPolicy } from './lib/agent-backups.js';
import { invalidateClientProviders } from './lib/client-providers.js';
import { pickFolder } from './lib/folder-picker.js';
import { thumbnailAgentStatus } from './lib/thumbnail-agent.js';
import { handleClientImport } from './client-import.js';
import { handleClientGateway } from './client-gateway.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(ROOT, 'agent-web');
const HOST = '127.0.0.1';
const PORT = Number(process.env.MOCHIMONO_AGENT_PORT || 8643);

function staticType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
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

function visibleFolders() {
  return [
    ...settings.folders.map(folder => ({ ...folder, protected: true })),
    ...settings.browseFolders.map(path => ({ path, importId: null, lastSynced: null, protected: false }))
  ];
}

async function handleLocalApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    json(res, 200, {
      settings: {
        server: settings.server, hasToken: Boolean(settings.token), device: settings.device,
        uploadWorkers: settings.uploadWorkers, folders: visibleFolders()
      },
      server: await serverState(),
      previews: thumbnailAgentStatus(),
      job: currentJob()
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readJson(req);
    const previousDevice = settings.device;
    if (body.server !== undefined) settings.server = String(body.server || 'http://127.0.0.1:8642').trim().replace(/\/$/, '');
    if (body.token !== undefined) settings.token = String(body.token || '');
    if (body.device !== undefined) settings.device = String(body.device || DEVICE).trim() || DEVICE;
    if (body.uploadWorkers !== undefined) {
      const workers = Number(body.uploadWorkers);
      if (![1, 2, 4].includes(workers)) return json(res, 400, { error: 'Upload concurrency must be 1, 2, or 4' });
      settings.uploadWorkers = workers;
    }
    await persistSettings();

    if (settings.token && settings.device !== previousDevice) {
      const ids = [...new Set(settings.folders.map(folder => folder.importId).filter(Boolean))];
      await Promise.allSettled(ids.map(id => api(`/api/imports/${id}`, { method: 'POST', body: { sourceName: settings.device } })));
    }
    if (settings.token) settings.folders.forEach(folder => queueFolderSync(folder.path, undefined, 0));
    invalidateClientProviders();
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/revoke-self') {
    if (settings.token) await api('/api/auth/revoke-self', { method: 'POST' }).catch(() => {});
    settings.token = '';
    await persistSettings();
    invalidateClientProviders();
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/job/cancel') {
    if (!cancelJob()) json(res, 409, { error: 'No operation is running' });
    else json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/pick-folder') {
    const multiple = url.searchParams.get('multiple') === '1';
    const picked = await pickFolder({ multiple, title: multiple ? 'Choose folders for Mochimono' : 'Choose a folder for Mochimono' });
    const paths = multiple ? picked : picked ? [picked] : [];
    json(res, 200, { path: paths[0] || null, paths });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/folder-stats') {
    const [protectedFolders, browseFolders] = await Promise.all([folderStats(), browseFolderStats()]);
    json(res, 200, {
      folders: [
        ...protectedFolders.map(folder => ({ ...folder, protected: true })),
        ...browseFolders
      ]
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a folder' });
    else {
      const folder = await addFolder(body.path);
      invalidateClientProviders();
      json(res, 200, { folder });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders/sync') {
    const body = await readJson(req);
    const protectedFolder = body.path ? folderFor(body.path) : null;
    const browseFolder = body.path ? browseFolderFor(body.path) : null;
    if (protectedFolder) {
      queueFolderSync(protectedFolder.path, undefined, 0);
      json(res, 200, { ok: true });
    } else if (browseFolder) {
      startJob(res, 'sync', `Sync ${browseFolder}`, async update => {
        const result = await indexBrowseFolder(browseFolder, update);
        invalidateClientProviders();
        return result;
      });
    } else json(res, 404, { error: 'Folder not found' });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders/remove') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Folder required' });
    else {
      if (folderFor(body.path)) await removeFolder(body.path);
      else if (browseFolderFor(body.path)) await removeBrowseFolder(body.path);
      else return json(res, 404, { error: 'Folder not found' });
      invalidateClientProviders();
      json(res, 200, { ok: true });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/browse-folders') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a folder' });
    else {
      const path = await addBrowseFolder(body.path);
      invalidateClientProviders();
      json(res, 200, { path });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/browse-folders/index') {
    const body = await readJson(req);
    const path = body.path ? browseFolderFor(body.path) : null;
    if (!path) json(res, 404, { error: 'Folder not found' });
    else startJob(res, 'sync', `Sync ${path}`, async update => {
      const result = await indexBrowseFolder(path, update);
      invalidateClientProviders();
      return result;
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/browse-folders/protect') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Folder required' });
    else {
      const folder = await protectBrowseFolder(body.path, addFolder);
      invalidateClientProviders();
      json(res, 200, { folder });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/browse-folders/remove') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Folder required' });
    else {
      await removeBrowseFolder(body.path);
      invalidateClientProviders();
      json(res, 200, { ok: true });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/backups') {
    json(res, 200, { backups: await backupLocations() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/backup/status') {
    const path = url.searchParams.get('path');
    if (!path) json(res, 400, { error: 'Backup folder required' });
    else json(res, 200, await backupStatus(path));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/backup/contents') {
    const path = url.searchParams.get('path');
    if (!path) json(res, 400, { error: 'Backup folder required' });
    else json(res, 200, await backupContents(path));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/backup-collections') {
    json(res, 200, { collections: await backupCollections() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/init') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a backup folder' });
    else {
      const result = await backupInit(body.path, body.name, body.configure === true);
      invalidateClientProviders();
      json(res, 200, result);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/policy') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a backup folder' });
    else json(res, 200, await setBackupPolicy(body.path, body.collectionId, body.collectionName));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/update') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a backup location' });
    else startJob(res, 'backup', `Update ${body.path}`, async update => {
      const result = await backupUpdate(body.path, update);
      invalidateClientProviders();
      return result;
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/verify') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a backup location' });
    else startJob(res, 'verify', `Verify ${body.path}`, async update => {
      const result = await backupVerify(body.path, update);
      invalidateClientProviders();
      return result;
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a backup location' });
    else startJob(res, 'restore', `Restore ${body.path}`, async update => {
      const result = await backupRestore(body.path, update);
      invalidateClientProviders();
      return result;
    });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (await handleLocalApi(req, res, url)) return;
      if (await handleClientImport(req, res, url)) return;
    }
    if (await handleClientGateway(req, res, url)) return;
    if (await serveStatic(res, decodeURIComponent(url.pathname))) return;
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Internal error' });
    else if (!res.destroyed) res.destroy();
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

startSyncService();
startBrowseService(invalidateClientProviders);
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Mochimono Agent: ${url}`);
  console.log(`Server: ${settings.server}`);
  openBrowser(url);
});
