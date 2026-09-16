import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces, platform } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { api, cancelJob, currentJob, DEVICE, json, pathKey, persistSettings, preemptBackgroundJob, readJson, serverState, settings, startJob } from './lib/agent-context.js';
import { backgroundWorkStatus } from './lib/background-work.js';
import { addFolder, folderFor, folderStats, queueFolderSync, removeFolder, startSyncService } from './lib/agent-sync.js';
import { backupContents, backupInit, backupLocations, backupRestore, backupStatus, backupVerify } from './lib/agent-backups.js';
import { invalidateClientProviders } from './lib/client-provider-cache.js';
import { pickFolder } from './lib/folder-picker.js';
import { handleSourceExclusions } from './lib/source-exclusion-routes.js';
import { thumbnailAgentStatus } from './lib/thumbnail-agent.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WEB_DIR = join(ROOT, 'agent-web');
const HOST_OVERRIDE = String(process.env.MOCHIMONO_AGENT_HOST || '').trim();
const PORT = Number(process.env.MOCHIMONO_AGENT_PORT || 8643);
const desiredHost = () => HOST_OVERRIDE || (settings.lanAccess ? '0.0.0.0' : '127.0.0.1');
let activeHost = desiredHost();
let deviceIdentityReconciled = false;
let providerThumbsPromise = null;
let browseFoldersPromise = null;
let clientImportPromise = null;
let clientGatewayPromise = null;
let libraryBackgroundPromise = null;
let compressionDefaultsPromise = null;
let browseServiceStarted = false;
let syncServiceStarted = false;

const providerThumbs = () => providerThumbsPromise ||= import('./lib/provider-thumbs.js');
const clientImport = () => clientImportPromise ||= import('./client-import.js');
const clientGateway = () => clientGatewayPromise ||= import('./client-gateway.js');
const libraryBackground = () => libraryBackgroundPromise ||= import('./lib/library-background.js');
const compressionDefaults = () => compressionDefaultsPromise ||= import('./lib/compression-defaults.js');

function ensureSyncService() {
  if (syncServiceStarted) return;
  syncServiceStarted = true;
  startSyncService();
}

async function browseFolders(startService = false) {
  const module = await (browseFoldersPromise ||= import('./lib/browse-folders.js'));
  if (startService && !browseServiceStarted) {
    browseServiceStarted = true;
    module.startBrowseService(invalidateClientProviders);
  }
  return module;
}

const browseScope = path => String(settings.browseFolderScopes?.[pathKey(path)] || '').toLowerCase() === 'all' ? 'all' : 'media';
const configuredBrowsePath = path => settings.browseFolders.find(item => pathKey(item) === pathKey(path));

function clientImportRoute(pathname) {
  return pathname === '/api/client/folder-browser' ||
    pathname === '/api/client/folder-tree' ||
    pathname.startsWith('/api/client/import/') ||
    pathname.startsWith('/api/client/browser-') ||
    pathname.startsWith('/api/video-optimize/cloud-') ||
    /^\/api\/thumbs\/[a-f0-9]{64}$/.test(pathname);
}

async function handleLazyClientImport(req, res, url) {
  if (!clientImportRoute(url.pathname)) return false;
  return (await clientImport()).handleClientImport(req, res, url);
}

async function handleLazyClientGateway(req, res, url) {
  await compressionDefaults();
  const [gateway, background] = await Promise.all([clientGateway(), libraryBackground()]);
  background.startLibraryBackground().catch(error => console.error('Library background failed', error));
  return gateway.handleClientGateway(req, res, url);
}

function lanUrls() {
  if (activeHost === '127.0.0.1' || activeHost === 'localhost') return [];
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      urls.push(`http://${entry.address}:${PORT}`);
    }
  }
  return [...new Set(urls)];
}

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
    res.writeHead(200, { 'content-type':staticType(file), 'content-length':info.size, 'cache-control':'no-cache' });
    createReadStream(file).pipe(res);
    return true;
  } catch { return false; }
}

function visibleFolders() {
  return [
    ...settings.folders.map(folder => ({ ...folder, protected:true })),
    ...settings.browseFolders.map(path => ({ path, importId:null, lastSynced:null, protected:false, scope:browseScope(path) }))
  ];
}

function sameLocalPath(a, b) {
  if (!a || !b) return false;
  const clean = value => {
    const path = resolve(String(value));
    return platform() === 'win32' ? path.toLowerCase() : path;
  };
  return clean(a) === clean(b);
}

async function takeOverBackgroundJob(path) {
  const job = currentJob();
  if (!job || job.status !== 'running' || !job.background) return false;
  if (job.progress?.path && sameLocalPath(job.progress.path, path)) {
    job.background = false;
    return true;
  }
  if (!preemptBackgroundJob()) return false;
  for (let attempt = 0; attempt < 20 && currentJob()?.status === 'running'; attempt++) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  return false;
}

async function reconcileDeviceIdentity() {
  if (deviceIdentityReconciled || !settings.token) return;
  const aliases = new Set((settings.deviceAliases || []).map(String).filter(Boolean));
  if (DEVICE && DEVICE.toLowerCase() !== settings.device.toLowerCase()) aliases.add(DEVICE);
  let complete = true;
  for (const alias of aliases) {
    if (!alias || alias.toLowerCase() === settings.device.toLowerCase()) continue;
    try {
      await api('/api/device-identity/rename', { method:'POST', body:{ from:alias, to:settings.device } });
      settings.deviceAliases = settings.deviceAliases.filter(item => item.toLowerCase() !== alias.toLowerCase());
    } catch {
      complete = false;
    }
  }
  if (complete) {
    deviceIdentityReconciled = true;
    await persistSettings();
  }
}

async function openNativePath(path, selectFile = false) {
  const target = resolve(String(path || ''));
  const info = await stat(target).catch(() => null);
  if (selectFile ? !info?.isFile() : !info?.isDirectory()) {
    throw Object.assign(new Error(selectFile ? 'File is unavailable' : 'Folder is unavailable'), { status:404 });
  }

  let command;
  let args;
  if (platform() === 'win32') {
    command = 'explorer.exe';
    args = selectFile ? [`/select,${target}`] : [target];
  } else if (platform() === 'darwin') {
    command = 'open';
    args = selectFile ? ['-R', target] : [target];
  } else {
    command = 'xdg-open';
    args = [selectFile ? resolve(target, '..') : target];
  }

  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { detached:true, stdio:'ignore', windowsHide:false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}

async function lightweightDrives() {
  if (settings.token) {
    try { return await api('/api/drives'); }
    catch {}
  }
  const backups = await backupLocations();
  return {
    drives:backups.map(item => item.remote || {
      id:item.meta?.id || item.path,
      name:item.meta?.name || item.path,
      lastSeen:item.meta?.lastBackupAt || null,
      storedCount:Number(item.local?.count) || 0,
      storedBytes:Number(item.local?.bytes) || 0,
      verifiedCount:0,
      oldestVerifiedAt:item.local?.oldestVerification || null,
      lastVerifiedAt:item.meta?.lastVerifiedAt || null
    })
  };
}

async function handleLocalApi(req, res, url) {
  if (await handleSourceExclusions(req, res, url)) return true;

  if (req.method === 'POST' && url.pathname === '/api/thumbnail-activity') {
    (await providerThumbs()).noteProviderThumbnailActivity();
    json(res, 200, { ok:true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    await reconcileDeviceIdentity();
    json(res, 200, {
      settings:{
        server:settings.server, hasToken:Boolean(settings.token), device:settings.device,
        uploadWorkers:settings.uploadWorkers, thumbnailMode:settings.thumbnailMode, folders:visibleFolders(),
        lanAccess:activeHost !== '127.0.0.1' && activeHost !== 'localhost',
        lanAccessLocked:Boolean(HOST_OVERRIDE),
        lanUrls:lanUrls()
      },
      server:await serverState(),
      background:backgroundWorkStatus(),
      previews:thumbnailAgentStatus(),
      job:currentJob()
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/drives') {
    json(res, 200, await lightweightDrives());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readJson(req);
    const previousDevice = settings.device;
    const previousServer = settings.server;
    const previousToken = settings.token;
    const previousThumbnailMode = settings.thumbnailMode;
    const previousLanAccess = settings.lanAccess;
    if (body.server !== undefined) settings.server = String(body.server || 'http://127.0.0.1:8642').trim().replace(/\/$/, '');
    if (body.token !== undefined) settings.token = String(body.token || '');
    if (body.device !== undefined) {
      const nextDevice = String(body.device || DEVICE).trim() || DEVICE;
      if (nextDevice.toLowerCase() !== previousDevice.toLowerCase()) settings.deviceAliases = [...new Set([...(settings.deviceAliases || []), previousDevice])];
      settings.device = nextDevice;
    }
    if (body.uploadWorkers !== undefined) {
      const workers = Number(body.uploadWorkers);
      if (![1, 2, 4].includes(workers)) return json(res, 400, { error:'Upload concurrency must be 1, 2, or 4' });
      settings.uploadWorkers = workers;
    }
    if (body.thumbnailMode !== undefined) {
      const mode = String(body.thumbnailMode || '');
      if (!['off', 'idle', 'max'].includes(mode)) return json(res, 400, { error:'Background mode must be off, idle, or max' });
      settings.thumbnailMode = mode;
    }
    if (body.lanAccess !== undefined && !HOST_OVERRIDE) settings.lanAccess = body.lanAccess === true;
    await persistSettings();

    const connectionChanged = settings.server !== previousServer || settings.token !== previousToken;
    const deviceChanged = settings.device !== previousDevice;
    const previewModeChanged = settings.thumbnailMode !== previousThumbnailMode;
    const lanChanged = !HOST_OVERRIDE && settings.lanAccess !== previousLanAccess;
    if (connectionChanged || deviceChanged) deviceIdentityReconciled = false;
    await reconcileDeviceIdentity();

    if (settings.token && deviceChanged) {
      const ids = [...new Set(settings.folders.map(folder => folder.importId).filter(Boolean))];
      await Promise.allSettled(ids.map(id => api(`/api/imports/${id}`, { method:'POST', body:{ sourceName:settings.device } })));
    }
    if (settings.token && (connectionChanged || deviceChanged)) settings.folders.forEach(folder => queueFolderSync(folder.path, undefined, 0));
    if (previewModeChanged) {
      (await providerThumbs()).refreshProviderThumbnailPolicy();
      if (settings.browseFolders.length || browseFoldersPromise) (await browseFolders()).refreshBrowsePreviewPolicy(previousThumbnailMode);
    }
    if (connectionChanged || deviceChanged) invalidateClientProviders();
    json(res, 200, { ok:true, thumbnailMode:settings.thumbnailMode, lanAccess:settings.lanAccess });
    if (lanChanged) setTimeout(() => rebindServer(desiredHost()).catch(error => console.error('Could not change LAN access:', error)), 40);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/revoke-self') {
    if (settings.token) await api('/api/auth/revoke-self', { method:'POST' }).catch(() => {});
    settings.token = '';
    deviceIdentityReconciled = false;
    await persistSettings();
    invalidateClientProviders();
    json(res, 200, { ok:true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/job/cancel') {
    if (!cancelJob()) json(res, 409, { error:'No operation is running' });
    else json(res, 200, { ok:true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/pick-folder') {
    const multiple = url.searchParams.get('multiple') === '1';
    const picked = await pickFolder({ multiple, title:multiple ? 'Choose folders for Mochimono' : 'Choose a folder for Mochimono' });
    const paths = multiple ? picked : picked ? [picked] : [];
    json(res, 200, { path:paths[0] || null, paths });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/open-folder') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:body.select ? 'File required' : 'Folder required' });
    else {
      await openNativePath(body.path, body.select === true);
      json(res, 200, { ok:true });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/folder-stats') {
    const browseStats = settings.browseFolders.length ? await (await browseFolders()).browseFolderStats() : [];
    const protectedFolders = await folderStats();
    json(res, 200, {
      folders:[...protectedFolders.map(folder => ({ ...folder, protected:true })), ...browseStats]
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:'Choose a folder' });
    else {
      const folder = await addFolder(body.path, body.scope);
      ensureSyncService();
      invalidateClientProviders();
      json(res, 200, { folder });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders/sync') {
    const body = await readJson(req);
    const protectedFolder = body.path ? folderFor(body.path) : null;
    const browseFolder = body.path ? configuredBrowsePath(body.path) : null;
    if (protectedFolder) {
      ensureSyncService();
      const continuing = await takeOverBackgroundJob(protectedFolder.path);
      if (!continuing) queueFolderSync(protectedFolder.path, undefined, 0, true);
      json(res, 200, { ok:true });
    } else if (browseFolder) {
      const browse = await browseFolders(true);
      const continuing = await takeOverBackgroundJob(browseFolder);
      if (!continuing) await browse.addBrowseFolder(browseFolder, browseScope(browseFolder));
      json(res, 200, { ok:true });
    } else json(res, 404, { error:'Folder not found' });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/folders/remove') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:'Folder required' });
    else {
      if (folderFor(body.path)) await removeFolder(body.path);
      else if (configuredBrowsePath(body.path)) await (await browseFolders(true)).removeBrowseFolder(body.path);
      else return json(res, 404, { error:'Folder not found' });
      invalidateClientProviders();
      json(res, 200, { ok:true });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/browse-folders') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:'Choose a folder' });
    else {
      const path = await (await browseFolders(true)).addBrowseFolder(body.path, body.scope);
      invalidateClientProviders();
      json(res, 200, { path });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/browse-folders/index') {
    const body = await readJson(req);
    const path = body.path ? configuredBrowsePath(body.path) : null;
    if (!path) json(res, 404, { error:'Folder not found' });
    else {
      const continuing = await takeOverBackgroundJob(path);
      if (!continuing) await (await browseFolders(true)).addBrowseFolder(path, browseScope(path));
      json(res, 200, { ok:true });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/browse-folders/protect') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:'Folder required' });
    else {
      const folder = await (await browseFolders(true)).protectBrowseFolder(body.path, addFolder);
      ensureSyncService();
      invalidateClientProviders();
      json(res, 200, { folder });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/browse-folders/remove') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:'Folder required' });
    else {
      await (await browseFolders(true)).removeBrowseFolder(body.path);
      invalidateClientProviders();
      json(res, 200, { ok:true });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/backups') {
    json(res, 200, { backups:await backupLocations() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/backup/status') {
    const path = url.searchParams.get('path');
    if (!path) json(res, 400, { error:'Backup folder required' });
    else json(res, 200, await backupStatus(path));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/backup/contents') {
    const path = url.searchParams.get('path');
    if (!path) json(res, 400, { error:'Backup folder required' });
    else json(res, 200, await backupContents(path));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/init') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:'Choose a backup folder' });
    else {
      const result = await backupInit(body.path, body.name, body.configure === true);
      invalidateClientProviders();
      json(res, 200, result);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/verify') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:'Choose a backup location' });
    else startJob(res, 'verify', `Verify ${body.path}`, async update => {
      const result = await backupVerify(body.path, update);
      invalidateClientProviders();
      return result;
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    const body = await readJson(req);
    if (!body.path) json(res, 400, { error:'Choose a backup location' });
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
      if (await handleLazyClientImport(req, res, url)) return;
      if (await handleLazyClientGateway(req, res, url)) return;
    } else {
      if (await serveStatic(res, decodeURIComponent(url.pathname))) return;
      if ((url.pathname === '/files' || url.pathname.startsWith('/files/')) && await handleLazyClientGateway(req, res, url)) return;
    }
    json(res, 404, { error:'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error:error.message || 'Internal error' });
    else if (!res.destroyed) res.destroy();
  }
});

function listenServer(host) {
  return new Promise((resolvePromise, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, host);
  });
}

async function rebindServer(host) {
  if (host === activeHost) return;
  const previousHost = activeHost;
  await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  try {
    await listenServer(host);
    activeHost = host;
  } catch (error) {
    try {
      await listenServer(previousHost);
      activeHost = previousHost;
    } catch {}
    throw error;
  }
  console.log(`Mochimono Agent listening on ${activeHost}:${PORT}`);
  for (const url of lanUrls()) console.log(`LAN: ${url}`);
}

function openBrowser(url) {
  if (process.env.MOCHIMONO_NO_OPEN === '1') return;
  try {
    const child = platform() === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached:true, stdio:'ignore' })
      : platform() === 'darwin'
        ? spawn('open', [url], { detached:true, stdio:'ignore' })
        : spawn('xdg-open', [url], { detached:true, stdio:'ignore' });
    child.unref();
  } catch {}
}

if (settings.folders.length) ensureSyncService();
if (settings.browseFolders.length) browseFolders(true).catch(error => console.error('Browse service failed', error));
listenServer(activeHost).then(() => {
  const browserHost = activeHost === '0.0.0.0' ? '127.0.0.1' : activeHost;
  const url = `http://${browserHost}:${PORT}`;
  console.log(`Mochimono Agent: ${url}`);
  for (const lanUrl of lanUrls()) console.log(`LAN: ${lanUrl}`);
  console.log(`Server: ${settings.server}`);
  openBrowser(url);
}).catch(error => {
  console.error(`Could not start Mochimono Agent on ${activeHost}:${PORT}:`, error);
  process.exitCode = 1;
});
