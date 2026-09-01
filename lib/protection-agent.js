import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { getPriority, hostname, networkInterfaces, platform, setPriority } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { api, beginJob, CONFIG_DIR, currentJob, json, now, readJson, settings } from './agent-context.js';
import { backupLocations, backupUpdate } from './agent-backups.js';
import { localCandidate, localLocations } from './local-locations.js';

const CONFIG_PATH = join(CONFIG_DIR, 'protection.json');
const PEER_PORT = Number(process.env.MOCHIMONO_PEER_PORT || 8644);
const CONTROL_PORT = Number(process.env.MOCHIMONO_PROTECTION_PORT || 8645);
const HEADER = Buffer.from('MOMO1');
const HEADER_BYTES = HEADER.length + 12;
const TAG_BYTES = 16;
const LEVELS = new Set(['disposable','normal','important','critical']);
let config = null;
let savePromise = Promise.resolve();
let peerServer = null;
let controlServer = null;
let tickTimer = null;
let lastAutoAt = 0;

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function defaults() {
  return {
    background: 'low',
    site: settings.device || hostname(),
    backupKey: randomBytes(32).toString('base64url'),
    peers: [],
    share: {
      enabled: false,
      path: '',
      name: `${settings.device || hostname()} storage`,
      token: randomBytes(32).toString('base64url'),
      maxBytes: 0
    }
  };
}

async function loadConfig() {
  if (config) return config;
  let saved = {};
  try { saved = JSON.parse(await readFile(CONFIG_PATH, 'utf8')); } catch {}
  const base = defaults();
  config = {
    ...base,
    ...saved,
    background: ['paused','low','normal'].includes(saved.background) ? saved.background : base.background,
    site: String(saved.site || base.site),
    backupKey: /^[A-Za-z0-9_-]{40,}$/.test(String(saved.backupKey || '')) ? String(saved.backupKey) : base.backupKey,
    peers: Array.isArray(saved.peers) ? saved.peers.filter(peer => peer && peer.id && peer.url && peer.token).map(peer => ({
      id: String(peer.id),
      name: String(peer.name || 'Remote PC'),
      url: String(peer.url).replace(/\/$/, ''),
      token: String(peer.token),
      site: String(peer.site || peer.name || 'Remote'),
      reliability: ['low','normal','high'].includes(peer.reliability) ? peer.reliability : 'normal',
      enabled: peer.enabled !== false,
      lastBackupAt: peer.lastBackupAt || null
    })) : [],
    share: {
      ...base.share,
      ...(saved.share || {}),
      enabled: Boolean(saved.share?.enabled),
      path: saved.share?.path ? resolve(String(saved.share.path)) : '',
      token: /^[A-Za-z0-9_-]{20,}$/.test(String(saved.share?.token || '')) ? String(saved.share.token) : base.share.token,
      maxBytes: Math.max(0, Number(saved.share?.maxBytes) || 0)
    }
  };
  await persist();
  return config;
}

async function persist() {
  if (!config) return;
  const snapshot = JSON.stringify(config, null, 2) + '\n';
  savePromise = savePromise.then(async () => {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_PATH, snapshot);
  });
  await savePromise;
}

function publicConfig(value) {
  return {
    background: value.background,
    site: value.site,
    keyFingerprint: createHash('sha256').update(Buffer.from(value.backupKey, 'base64url')).digest('hex').slice(0, 12),
    peers: value.peers.map(({ token, ...peer }) => ({ ...peer, hasToken: Boolean(token) })),
    share: {
      enabled: value.share.enabled,
      path: value.share.path,
      name: value.share.name,
      maxBytes: value.share.maxBytes,
      tokenHint: value.share.token ? `${value.share.token.slice(0, 6)}…` : ''
    }
  };
}

function masterKey(value = config) {
  return Buffer.from(value.backupKey, 'base64url');
}

function opaqueId(hash, value = config) {
  return createHmac('sha256', masterKey(value)).update(`object:${hash}`).digest('hex');
}

function objectKey(hash, value = config) {
  return Buffer.from(hkdfSync('sha256', masterKey(value), Buffer.from(hash, 'hex'), Buffer.from('mochimono-peer-object-v1'), 32));
}

function peerHeaders(peer) {
  return { authorization: `Bearer ${peer.token}` };
}

async function peerRequest(peer, path, options = {}) {
  const response = await fetch(`${peer.url}${path}`, {
    ...options,
    headers: { ...peerHeaders(peer), ...(options.headers || {}) },
    duplex: options.body ? 'half' : undefined
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response;
}

async function registerPeer(peer) {
  await api('/api/drives/register', {
    method: 'POST',
    body: {
      id: peer.id,
      name: peer.name,
      policy: { all: true, collectionId: null },
      storage: {
        name: peer.name,
        kind: 'peer',
        deviceName: peer.name,
        site: peer.site,
        reliability: peer.reliability,
        remote: true,
        encrypted: true
      }
    }
  });
  await api(`/api/protection/locations/${encodeURIComponent(peer.id)}`, {
    method: 'POST',
    body: {
      name: peer.name,
      kind: 'peer',
      deviceName: peer.name,
      site: peer.site,
      reliability: peer.reliability,
      remote: true,
      encrypted: true
    }
  });
}

async function syncLocalBackupLocations(value) {
  await api(`/api/protection/locations/${encodeURIComponent(`source:${settings.device}`)}`, {
    method: 'POST',
    body: {
      name: settings.device,
      kind: 'source',
      deviceName: settings.device,
      site: value.site || settings.device,
      reliability: 'normal',
      remote: false,
      encrypted: false
    }
  }).catch(() => {});
  let backups = [];
  try { backups = await backupLocations(); } catch {}
  for (const backup of backups) {
    const id = backup.meta?.id;
    if (!id) continue;
    await api(`/api/protection/locations/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: {
        name: backup.meta?.name || basename(backup.path),
        kind: 'backup',
        deviceName: settings.device,
        site: value.site || settings.device,
        reliability: backup.meta?.reliability || 'normal',
        remote: false,
        encrypted: false
      }
    }).catch(() => {});
  }
  return backups;
}

async function encryptedBody(hash, source, expectedSize, nonce) {
  const digest = createHash('sha256');
  let size = 0;
  const cipher = createCipheriv('aes-256-gcm', objectKey(hash), nonce);
  async function* chunks() {
    yield HEADER;
    yield nonce;
    for await (const chunk of source) {
      digest.update(chunk);
      size += chunk.length;
      const out = cipher.update(chunk);
      if (out.length) yield out;
    }
    const final = cipher.final();
    if (final.length) yield final;
    yield cipher.getAuthTag();
    if (digest.digest('hex') !== hash || size !== Number(expectedSize)) throw new Error(`Source verification failed for ${hash}`);
  }
  return Readable.from(chunks());
}

async function uploadPeerObject(peer, object, update) {
  const opaque = opaqueId(object.hash);
  const head = await fetch(`${peer.url}/v1/objects/${opaque}`, { method: 'HEAD', headers: peerHeaders(peer) }).catch(() => null);
  if (head?.ok && Number(head.headers.get('content-length')) === Number(object.size) + HEADER_BYTES + TAG_BYTES) return false;

  const response = await api(`/api/objects/${object.hash}`);
  if (!response.body) throw new Error(`Object unavailable: ${object.hash}`);
  const nonce = randomBytes(12);
  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  const body = await encryptedBody(object.hash, source, Number(object.size), nonce);
  update({ phase: `Encrypting to ${peer.name}`, current: object.hash.slice(0, 12) });
  const result = await fetch(`${peer.url}/v1/objects/${opaque}`, {
    method: 'PUT',
    headers: {
      ...peerHeaders(peer),
      'content-type': 'application/octet-stream',
      'content-length': String(Number(object.size) + HEADER_BYTES + TAG_BYTES)
    },
    body,
    duplex: 'half'
  });
  if (!result.ok) {
    let message = `${result.status} ${result.statusText}`;
    try { message = (await result.json()).error || message; } catch {}
    throw new Error(message);
  }
  return true;
}

async function downloadEncryptedPeerObject(peer, hash, expectedSize) {
  const opaque = opaqueId(hash);
  const response = await peerRequest(peer, `/v1/objects/${opaque}`);
  if (!response.body) throw new Error(`Encrypted backup unavailable: ${hash}`);
  const tmpDir = join(CONFIG_DIR, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const path = join(tmpDir, `peer-${process.pid}-${Date.now()}-${opaque}`);
  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  await pipeline(source, createWriteStream(path, { flags: 'wx' }));
  const info = await stat(path);
  const wanted = Number(expectedSize) + HEADER_BYTES + TAG_BYTES;
  if (Number(info.size) !== wanted) {
    await rm(path, { force: true }).catch(() => {});
    throw new Error(`Encrypted backup size mismatch for ${hash}`);
  }
  return path;
}

async function repairFromPeer(peer, object, update) {
  const encrypted = await downloadEncryptedPeerObject(peer, object.hash, object.size);
  let handle;
  try {
    handle = await open(encrypted, 'r');
    const prefix = Buffer.alloc(HEADER_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(prefix, 0, prefix.length, 0);
    await handle.read(tag, 0, tag.length, HEADER_BYTES + Number(object.size));
    if (!prefix.subarray(0, HEADER.length).equals(HEADER)) throw new Error('Unknown encrypted backup format');
    const nonce = prefix.subarray(HEADER.length);
    const decipher = createDecipheriv('aes-256-gcm', objectKey(object.hash), nonce);
    decipher.setAuthTag(tag);
    const digest = createHash('sha256');
    let bytes = 0;
    const verify = new Transform({
      transform(chunk, encoding, callback) {
        digest.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
      flush(callback) {
        if (bytes !== Number(object.size) || digest.digest('hex') !== object.hash) callback(new Error(`Decrypted backup verification failed for ${object.hash}`));
        else callback();
      }
    });
    update({ phase: `Restoring from ${peer.name}`, current: object.hash.slice(0, 12) });
    const body = createReadStream(encrypted, { start: HEADER_BYTES, end: HEADER_BYTES + Number(object.size) - 1 }).pipe(decipher).pipe(verify);
    await api(`/api/integrity/repair/${object.hash}`, {
      method: 'PUT',
      headers: { 'content-length': String(object.size) },
      body
    });
    return true;
  } finally {
    try { await handle?.close(); } catch {}
    await rm(encrypted, { force: true }).catch(() => {});
  }
}

async function repairPrimaryFromPeers(peers, update) {
  if (!peers.length) return 0;
  let after = '';
  let repaired = 0;
  do {
    const page = await api(`/api/integrity/bad?limit=500&after=${encodeURIComponent(after)}`).catch(() => ({ objects: [] }));
    for (const object of page.objects || []) {
      const state = await api(`/api/protection/objects/${object.hash}`).catch(() => null);
      const candidateIds = new Set((state?.copies || []).filter(copy => copy.kind === 'peer').map(copy => copy.id));
      const candidates = peers.filter(peer => candidateIds.has(peer.id));
      for (const peer of candidates) {
        try {
          if (await repairFromPeer(peer, object, update)) { repaired++; break; }
        } catch {}
      }
    }
    after = page.nextAfter || '';
  } while (after);
  return repaired;
}

async function consumePeerDeletions(peer) {
  const page = await api(`/api/protection/deletions/${encodeURIComponent(peer.id)}`);
  const done = [];
  for (const item of page.deletions || []) {
    const opaque = opaqueId(item.hash);
    const response = await fetch(`${peer.url}/v1/objects/${opaque}`, { method: 'DELETE', headers: peerHeaders(peer) }).catch(() => null);
    if (response?.ok || response?.status === 404) done.push(item.hash);
  }
  if (done.length) await api(`/api/protection/deletions/${encodeURIComponent(peer.id)}/ack`, { method: 'POST', body: { hashes: done } });
}

async function consumeLocalBackupDeletions(backup) {
  const id = backup.meta?.id;
  if (!id) return;
  const page = await api(`/api/protection/deletions/${encodeURIComponent(id)}`).catch(() => ({ deletions: [] }));
  const done = [];
  for (const item of page.deletions || []) {
    const path = join(resolve(backup.path), '.mochimono', 'objects', item.hash.slice(0, 2), item.hash);
    try {
      await rm(path, { force: true });
      done.push(item.hash);
    } catch {}
  }
  if (done.length) await api(`/api/protection/deletions/${encodeURIComponent(id)}/ack`, { method: 'POST', body: { hashes: done } }).catch(() => {});
}

async function updatePeer(peer, update, mode) {
  await registerPeer(peer);
  await consumePeerDeletions(peer);
  let after = '';
  let copied = 0;
  let already = 0;
  let copiedBytes = 0;
  do {
    const page = await api(`/api/protection/plan/${encodeURIComponent(peer.id)}?after=${encodeURIComponent(after)}&limit=100`);
    for (const object of page.objects || []) {
      const written = await uploadPeerObject(peer, object, update);
      if (written) {
        copied++;
        copiedBytes += Number(object.size) || 0;
      } else already++;
      await api(`/api/drives/${encodeURIComponent(peer.id)}/replicas`, {
        method: 'POST',
        body: { replicas: [{ hash: object.hash, verifiedAt: written ? now() : null }] }
      });
      update({ phase: `Backing up to ${peer.name}`, copied, already, copiedBytes, current: object.hash.slice(0, 12) });
      if (mode === 'low') await sleep(80);
    }
    after = page.nextAfter || '';
  } while (after);
  peer.lastBackupAt = now();
  await persist();
  return { copied, already, copiedBytes };
}

async function runProtection(update, automatic = false) {
  const value = await loadConfig();
  const mode = value.background === 'paused' && automatic ? 'paused' : value.background;
  if (mode === 'paused' && automatic) return { skipped: true };
  let previousPriority = null;
  if (mode === 'low') {
    try { previousPriority = getPriority(process.pid); setPriority(process.pid, Math.max(10, previousPriority)); } catch {}
  }
  try {
    update({ phase: 'Checking pending changes', current: '' });
    const deletedSources = await consumeSourceDeletions();
    const primaryRepaired = await repairPrimaryFromPeers(value.peers, update);
    const backups = await syncLocalBackupLocations(value);
    let copied = 0;
    let copiedBytes = 0;

    for (const backup of backups) {
      await consumeLocalBackupDeletions(backup);
      const missing = Math.max(0, Number(backup.remote?.desiredBytes) - Number(backup.remote?.protectedBytes));
      if (!missing) continue;
      update({ phase: `Backing up to ${backup.meta?.name || basename(backup.path)}`, current: '' });
      const result = await backupUpdate(backup.path, patch => update({ ...patch, phase: patch.phase === 'Backing up' ? `Backing up to ${backup.meta?.name || basename(backup.path)}` : patch.phase }));
      copied += Number(result.copied) || 0;
      copiedBytes += Number(result.copiedBytes) || 0;
      if (mode === 'low') await sleep(300);
    }

    const enabledPeers = value.peers.filter(peer => peer.enabled !== false);
    for (const peer of enabledPeers) {
      try {
        const result = await updatePeer(peer, update, mode);
        copied += result.copied;
        copiedBytes += result.copiedBytes;
      } catch (error) {
        update({ phase: `${peer.name} unavailable`, current: error.message });
        if (!automatic) throw error;
      }
    }

    return { copied, copiedBytes, deletedSources, primaryRepaired, targets: backups.length + enabledPeers.length };
  } finally {
    if (previousPriority !== null) try { setPriority(process.pid, previousPriority); } catch {}
  }
}

function runCommand(command, args, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${code})`)));
  });
}

async function sendToTrash(path) {
  path = resolve(path);
  if (platform() === 'win32') {
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:MOCHI_PATH,'OnlyErrorDialogs','SendToRecycleBin')";
    await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { MOCHI_PATH: path });
  } else if (platform() === 'darwin') {
    await runCommand('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete POSIX file (item 1 of argv)', '-e', 'end run', path]);
  } else {
    await runCommand('gio', ['trash', path]);
  }
  if (existsSync(path)) throw new Error('The file could not be moved to Trash');
}

function safeIndexedPath(root, relativePath) {
  const base = resolve(String(root || ''));
  const target = resolve(base, ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));
  const key = value => platform() === 'win32' ? value.toLowerCase() : value;
  return key(target) === key(base) || key(target).startsWith(`${key(base)}${platform() === 'win32' ? '\\' : '/'}`) ? target : null;
}

async function consumeSourceDeletions() {
  const page = await api(`/api/protection/source-deletions/${encodeURIComponent(settings.device)}`).catch(() => ({ deletions: [] }));
  const done = [];
  for (const item of page.deletions || []) {
    const local = localLocations(item.hash);
    const definitions = new Map((local.locations || []).map(location => [location.id, location]));
    let failed = false;
    for (const [, locationId, relativePath] of local.files || []) {
      const location = definitions.get(locationId);
      const path = location && safeIndexedPath(location.rootPath, relativePath);
      if (!path || !existsSync(path)) continue;
      try { await rm(path, { force: true }); }
      catch { failed = true; }
    }
    if (!failed) done.push(item.hash);
  }
  if (done.length) await api(`/api/protection/source-deletions/${encodeURIComponent(settings.device)}/ack`, { method: 'POST', body: { hashes: done } }).catch(() => {});
  return done.length;
}

async function freeLocal(hash) {
  const candidate = localCandidate(hash);
  if (!candidate?.path || !existsSync(candidate.path)) throw Object.assign(new Error('No local copy is available on this PC'), { status: 404 });
  const local = localLocations(hash);
  const localCount = (local.files || []).length;
  const exclude = localCount <= 1 ? settings.device : '';
  const state = await api(`/api/protection/objects/${hash}${exclude ? `?excludeSourceDevice=${encodeURIComponent(exclude)}` : ''}`);
  const managedElsewhere = state.copies.some(copy => copy.kind === 'primary' || copy.kind === 'backup' || copy.kind === 'peer');
  if (!managedElsewhere || !state.meets) {
    const error = new Error('Another independent copy is required before freeing this local file');
    error.status = 409;
    error.protection = state;
    throw error;
  }
  const info = await stat(candidate.path);
  await sendToTrash(candidate.path);
  return { ok: true, path: candidate.path, bytes: Number(info.size) || 0, protection: state };
}

async function estimateFolder(path, update = () => {}) {
  const root = resolve(String(path || ''));
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw Object.assign(new Error('Choose a folder'), { status: 400 });
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    let entries;
    try { entries = await import('node:fs/promises').then(fs => fs.readdir(current, { withFileTypes: true })); }
    catch { continue; }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile()) {
        files++;
        try { bytes += Number((await stat(child)).size) || 0; } catch {}
        if (!(files % 500)) update({ phase: 'Measuring folder', scanned: files, doneBytes: bytes });
        if (files >= 250_000) { truncated = true; queue.length = 0; break; }
      }
    }
  }
  return { path: root, files, bytes, truncated };
}

function shareRoot(value) {
  return value.share.path ? resolve(value.share.path) : '';
}

function peerDataRoot(value) {
  return join(shareRoot(value), '.mochimono-peer');
}

function peerObjectPath(value, id) {
  return join(peerDataRoot(value), 'objects', id.slice(0, 2), id);
}

function peerDb(value) {
  const path = join(peerDataRoot(value), 'inventory.sqlite');
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_at TEXT NOT NULL) STRICT;
  `);
  return db;
}

async function shareStatus(value) {
  if (!value.share.enabled || !shareRoot(value)) return { enabled: false };
  await mkdir(peerDataRoot(value), { recursive: true });
  const fs = await statfs(shareRoot(value));
  const db = peerDb(value);
  const usage = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM objects').get();
  db.close();
  return {
    enabled: true,
    name: value.share.name,
    count: Number(usage.count) || 0,
    bytes: Number(usage.bytes) || 0,
    freeBytes: Number(fs.bavail) * Number(fs.bsize),
    maxBytes: Number(value.share.maxBytes) || 0
  };
}

function authorized(req, value) {
  return req.headers.authorization === `Bearer ${value.share.token}`;
}

async function handlePeerRequest(req, res) {
  const value = await loadConfig();
  if (!value.share.enabled || !shareRoot(value)) return void json(res, 404, { error: 'Peer storage is disabled' });
  if (!authorized(req, value)) return void json(res, 401, { error: 'Unauthorized' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/v1/status') return void json(res, 200, await shareStatus(value));
  const match = /^\/v1\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match) return void json(res, 404, { error: 'Not found' });
  const id = match[1];
  const target = peerObjectPath(value, id);

  if (req.method === 'HEAD' || req.method === 'GET') {
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) return void json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return void res.end();
    return void createReadStream(target).pipe(res);
  }

  if (req.method === 'PUT') {
    const length = Number(req.headers['content-length'] || 0);
    if (!Number.isFinite(length) || length < HEADER_BYTES + TAG_BYTES) return void json(res, 400, { error: 'Content-Length required' });
    const status = await shareStatus(value);
    const previous = await stat(target).catch(() => null);
    const projected = status.bytes - Number(previous?.size || 0) + length;
    if (status.maxBytes > 0 && projected > status.maxBytes) return void json(res, 507, { error: 'Peer storage limit reached' });
    if (length > status.freeBytes + Number(previous?.size || 0)) return void json(res, 507, { error: 'Not enough free space' });
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await pipeline(req, createWriteStream(temp, { flags: 'wx' }));
      const info = await stat(temp);
      if (info.size !== length) throw new Error('Incomplete upload');
      await rm(target, { force: true });
      await rename(temp, target);
      const db = peerDb(value);
      db.prepare('INSERT INTO objects(id,size,stored_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET size=excluded.size, stored_at=excluded.stored_at').run(id, length, now());
      db.close();
      return void json(res, 201, { ok: true });
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  if (req.method === 'DELETE') {
    await rm(target, { force: true });
    const db = peerDb(value);
    db.prepare('DELETE FROM objects WHERE id=?').run(id);
    db.close();
    return void json(res, 200, { ok: true });
  }

  json(res, 405, { error: 'Method not allowed' });
}

function networkUrls() {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) {
    if (address.family !== 'IPv4' || address.internal) continue;
    urls.push(`http://${address.address}:${PEER_PORT}`);
  }
  urls.unshift(`http://${hostname()}:${PEER_PORT}`);
  return [...new Set(urls)];
}

async function localState() {
  const value = await loadConfig();
  const [summary, rules, locations, backups] = await Promise.all([
    api('/api/protection/summary').catch(() => null),
    api('/api/protection/rules').catch(() => ({ rules: [] })),
    api('/api/protection/locations').catch(() => ({ locations: [] })),
    syncLocalBackupLocations(value)
  ]);
  const peerStates = await Promise.all(value.peers.map(async peer => {
    try {
      const response = await peerRequest(peer, '/v1/status');
      return { id: peer.id, online: true, ...(await response.json()) };
    } catch (error) { return { id: peer.id, online: false, error: error.message }; }
  }));
  return {
    config: publicConfig(value),
    summary,
    rules: rules.rules || [],
    locations: locations.locations || [],
    backups: backups.map(item => ({ id: item.meta?.id, name: item.meta?.name, path: item.path })),
    folders: settings.folders || [],
    peers: peerStates,
    share: { ...(await shareStatus(value)), urls: networkUrls() },
    job: currentJob()
  };
}

export async function handleProtectionAgent(req, res, url) {
  if (!url.pathname.startsWith('/api/client/protection/')) return false;
  const value = await loadConfig();

  if (req.method === 'GET' && url.pathname === '/api/client/protection/state') {
    json(res, 200, await localState());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/settings') {
    const body = await readJson(req);
    if (body.background !== undefined) {
      if (!['paused','low','normal'].includes(body.background)) return void json(res, 400, { error: 'Invalid background mode' });
      value.background = body.background;
    }
    if (body.site !== undefined) value.site = String(body.site || settings.device).trim().slice(0, 120) || settings.device;
    await persist();
    json(res, 200, publicConfig(value));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/run') {
    const job = beginJob('protection', 'Protect library', update => runProtection(update, false));
    if (!job) json(res, 409, { error: 'Another Agent operation is already running' });
    else json(res, 202, { job });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/folder-level') {
    const body = await readJson(req);
    const importId = Number(body.importId);
    const level = String(body.level || 'normal');
    if (!Number.isInteger(importId) || importId < 1 || !LEVELS.has(level)) return void json(res, 400, { error: 'Invalid folder protection setting' });
    const result = await api(`/api/protection/rules/import/${importId}`, { method: 'POST', body: { level } });
    json(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/location') {
    const body = await readJson(req);
    if (!body.id) return void json(res, 400, { error: 'Storage location required' });
    if (body.id === `source:${settings.device}` && body.site !== undefined) {
      value.site = String(body.site || settings.device).trim().slice(0, 120) || settings.device;
      await persist();
    }
    const result = await api(`/api/protection/locations/${encodeURIComponent(body.id)}`, { method: 'POST', body });
    json(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/peers') {
    const body = await readJson(req);
    const urlValue = String(body.url || '').trim().replace(/\/$/, '');
    const token = String(body.token || '').trim();
    if (!/^https?:\/\//i.test(urlValue) || !token) return void json(res, 400, { error: 'Peer URL and token are required' });
    const existing = body.id ? value.peers.find(peer => peer.id === body.id) : null;
    const peer = existing || { id: `peer-${randomUUID()}` };
    Object.assign(peer, {
      name: String(body.name || existing?.name || 'Remote PC').trim().slice(0, 120) || 'Remote PC',
      url: urlValue,
      token,
      site: String(body.site || existing?.site || body.name || 'Remote').trim().slice(0, 120) || 'Remote',
      reliability: ['low','normal','high'].includes(body.reliability) ? body.reliability : existing?.reliability || 'normal',
      enabled: body.enabled === undefined ? existing?.enabled !== false : Boolean(body.enabled)
    });
    if (!existing) value.peers.push(peer);
    await persist();
    try { await registerPeer(peer); } catch {}
    json(res, 200, { ok: true, peer: { ...peer, token: undefined, hasToken: true } });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/peers/toggle') {
    const body = await readJson(req);
    const peer = value.peers.find(item => item.id === String(body.id || ''));
    if (!peer) return void json(res, 404, { error: 'Remote PC not found' });
    peer.enabled = body.enabled !== false;
    await persist();
    json(res, 200, { ok: true, enabled: peer.enabled });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/share') {
    const body = await readJson(req);
    if (body.path !== undefined) value.share.path = body.path ? resolve(String(body.path)) : '';
    if (body.name !== undefined) value.share.name = String(body.name || `${settings.device} storage`).trim().slice(0, 120);
    if (body.maxBytes !== undefined) value.share.maxBytes = Math.max(0, Number(body.maxBytes) || 0);
    if (body.enabled !== undefined) value.share.enabled = Boolean(body.enabled);
    if (value.share.enabled) {
      if (!value.share.path) return void json(res, 400, { error: 'Choose a folder to share' });
      await mkdir(peerDataRoot(value), { recursive: true });
    }
    await persist();
    json(res, 200, { ...(await shareStatus(value)), urls: networkUrls() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/client/protection/share-token') {
    json(res, 200, { token: value.share.token, urls: networkUrls() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/client/protection/key') {
    json(res, 200, { key: value.backupKey, fingerprint: publicConfig(value).keyFingerprint });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/key') {
    const body = await readJson(req);
    const key = String(body.key || '').trim();
    let bytes;
    try { bytes = Buffer.from(key, 'base64url'); } catch {}
    if (!bytes || bytes.length !== 32 || bytes.toString('base64url') !== key) return void json(res, 400, { error: 'Recovery key must be a 32-byte base64url key' });
    if (value.peers.some(peer => peer.lastBackupAt) && body.confirm !== 'REPLACE') return void json(res, 409, { error: 'Replacing this key makes existing remote backups unreadable. Confirm REPLACE only when restoring the original saved key.', requiresConfirmation: true });
    value.backupKey = key;
    await persist();
    json(res, 200, { ok: true, fingerprint: publicConfig(value).keyFingerprint });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/free-local') {
    const body = await readJson(req);
    const hash = String(body.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return void json(res, 400, { error: 'Valid file hash required' });
    try { json(res, 200, await freeLocal(hash)); }
    catch (error) {
      if (error.protection) json(res, error.status || 409, { error: error.message, protection: error.protection });
      else throw error;
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/estimate-folder') {
    const body = await readJson(req);
    json(res, 200, await estimateFolder(body.path));
    return true;
  }

  return false;
}

async function backgroundTick() {
  const value = await loadConfig();
  if (value.background === 'paused' || currentJob()?.status === 'running') return;
  const interval = value.background === 'low' ? 30 * 60_000 : 10 * 60_000;
  if (Date.now() - lastAutoAt < interval) return;
  lastAutoAt = Date.now();
  beginJob('protection', 'Automatic protection', update => runProtection(update, true));
}

export async function startProtectionAgent() {
  await loadConfig();
  if (!controlServer) {
    controlServer = http.createServer(async (req, res) => {
      const origin = String(req.headers.origin || '');
      const localOrigin = !origin || /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(origin);
      if (!localOrigin) return json(res, 403, { error: 'Local Mochimono UI only' });
      if (origin) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
      }
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (await handleProtectionAgent(req, res, url)) return;
        json(res, 404, { error: 'Not found' });
      } catch (error) {
        console.error(error);
        if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Protection error' });
        else res.destroy();
      }
    });
    controlServer.listen(CONTROL_PORT, '127.0.0.1', () => console.log(`Mochimono protection control: http://127.0.0.1:${CONTROL_PORT}`));
  }
  if (!peerServer) {
    peerServer = http.createServer((req, res) => handlePeerRequest(req, res).catch(error => {
      console.error(error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Peer storage error' });
      else res.destroy();
    }));
    peerServer.listen(PEER_PORT, '0.0.0.0', () => console.log(`Mochimono peer storage: port ${PEER_PORT}`));
  }
  clearInterval(tickTimer);
  tickTimer = setInterval(() => backgroundTick().catch(console.error), 60_000);
  setTimeout(() => backgroundTick().catch(console.error), 15_000);
}
