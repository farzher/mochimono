import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { api, cancelJob, currentJob, DEVICE, json, persistSettings, readJson, serverState, settings, startJob } from './lib/agent-context.js';
import { addFolder, folderFor, folderStats, queueFolderSync, removeFolder, startSyncService } from './lib/agent-sync.js';
import { backupCollections, backupContents, backupInit, backupLocations, backupRestore, backupStatus, backupUpdate, backupVerify, setBackupPolicy } from './lib/agent-backups.js';
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

async function handleLocalApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    json(res, 200, {
      settings: { server: settings.server, hasToken: Boolean(settings.token), device: settings.device, folders: settings.folders },
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
    await persistSettings();

    if (settings.token && settings.device !== previousDevice) {
      const ids = [...new Set(settings.folders.map(folder => folder.importId).filter(Boolean))];
      await Promise.allSettled(ids.map(id => api(`/api/imports/${id}`, { method: 'POST', body: { sourceName: settings.device } })));
    }
    if (settings.token) settings.folders.forEach(folder => queueFolderSync(folder.path, undefined, 0));
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/revoke-self') {
    if (settings.token) await api('/api/auth/revoke-self', { method: 'POST' }).catch(() => {});
    settings.token = '';
    await persistSettings();
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/job/cancel') {
    if (!cancelJob()) json(res, 409, { error: 'No operation is running' });
    else json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/pick-folder') {
    json(res, 200, { path: await pickFolder() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/folder-stats') {
    json(res, 200, { folders: await folderStats() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a folder' });
    else json(res, 200, { folder: await addFolder(body.path) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders/sync') {
    const body = await readJson(req);
    const folder = body.path ? folderFor(body.path) : null;
    if (!folder) json(res, 404, { error: 'Folder not found' });
    else {
      queueFolderSync(folder.path, undefined, 0);
      json(res, 200, { ok: true });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders/remove') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Folder required' });
    else {
      await removeFolder(body.path);
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
    else json(res, 200, await backupInit(body.path, body.name, body.configure === true));
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
    else startJob(res, 'backup', `Update ${body.path}`, update => backupUpdate(body.path, update));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/verify') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a backup location' });
    else startJob(res, 'verify', `Verify ${body.path}`, update => backupVerify(body.path, update));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error: 'Choose a backup location' });
    else startJob(res, 'restore', `Restore ${body.path}`, update => backupRestore(body.path, update));
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
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Mochimono Agent: ${url}`);
  console.log(`Server: ${settings.server}`);
  openBrowser(url);
});
