import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { getPriority, hostname, networkInterfaces, platform, setPriority } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { api, beginJob, canceled, CONFIG_DIR, currentJob, json, now, readJson, settings } from './agent-context.js';
import { backupLocations } from './agent-backups.js';
import { localCandidate, localLocations } from './local-locations.js';

const CONFIG_PATH = join(CONFIG_DIR, 'protection.json');
const PEER_PORT = Number(process.env.MOCHIMONO_PEER_PORT || 8644);
const CONTROL_PORT = Number(process.env.MOCHIMONO_PROTECTION_PORT || 8645);
const HEADER = Buffer.from('MOMO1');
const HEADER_BYTES = HEADER.length + 12;
const TAG_BYTES = 16;
const LEVELS = new Set(['disposable','normal','important','critical']);
const SOURCE_SYNC_MS = 5 * 60_000;
let config = null;
let savePromise = Promise.resolve();
let peerServer = null;
let controlServer = null;
let tickTimer = null;
let lastAutoAt = 0;
let lastSourceSyncAt = 0;
let sourceSyncPromise = null;

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const validKey = value => {
  try {
    const bytes = Buffer.from(String(value || ''), 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === String(value || '');
  } catch { return false; }
};

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
    backupKey: validKey(saved.backupKey) ? String(saved.backupKey) : base.backupKey,
    peers: Array.isArray(saved.peers) ? saved.peers.filter(peer => peer?.id && peer?.url && peer?.token).map(peer => ({
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
  const snapshot = `${JSON.stringify(config, null, 2)}\n`;
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

const masterKey = (value = config) => Buffer.from(value.backupKey, 'base64url');
const opaqueId = (hash, value = config) => createHmac('sha256', masterKey(value)).update(`object:${hash}`).digest('hex');
const objectKey = (hash, value = config) => Buffer.from(hkdfSync('sha256', masterKey(value), Buffer.from(hash, 'hex'), Buffer.from('mochimono-peer-object-v1'), 32));
const peerHeaders = peer => ({ authorization: `Bearer ${peer.token}` });

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
        name: peer.name, kind: 'peer', deviceName: peer.name, site: peer.site,
        reliability: peer.reliability, remote: true, encrypted: true
      }
    }
  });
}

async function syncLocalBackupLocations(value) {
  await api(`/api/protection/locations/${encodeURIComponent(`source:${settings.device}`)}`, {
    method: 'POST',
    body: {
      name: settings.device, kind: 'source', deviceName: settings.device,
      site: value.site || settings.device, reliability: 'normal', remote: false, encrypted: false
    }
  }).catch(() => {});

  let backups = [];
  try { backups = await backupLocations(); } catch {}
  const current = await api('/api/protection/locations').catch(() => ({ locations: [] }));
  const known = new Set((current.locations || []).map(item => item.id));
  for (const backup of backups) {
    const id = backup.meta?.id;
    if (!id || known.has(id)) continue;
    await api(`/api/protection/locations/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: {
        name: backup.meta?.name || basename(backup.path), kind: 'backup', deviceName: settings.device,
        site: value.site || settings.device, reliability: 'normal', remote: false, encrypted: false
      }
    }).catch(() => {});
  }
  return backups;
}

async function syncSourceReplicas(value, force = false) {
  if (!force && Date.now() - lastSourceSyncAt < SOURCE_SYNC_MS) return;
  if (sourceSyncPromise) return sourceSyncPromise;
  sourceSyncPromise = (async () => {
    const data = localLocations();
    const hashes = [...new Set((data.files || []).map(row => String(row[0] || '')).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
    const scanId = randomUUID();
    for (let offset = 0; offset < hashes.length; offset += 2000) {
      canceled();
      await api(`/api/protection/source-replicas/${encodeURIComponent(settings.device)}`, {
        method: 'POST',
        body: { scanId, site: value.site || settings.device, reliability: 'normal', hashes: hashes.slice(offset, offset + 2000) }
      });
    }
    await api(`/api/protection/source-replicas/${encodeURIComponent(settings.device)}`, {
      method: 'POST',
      body: { scanId, site: value.site || settings.device, reliability: 'normal', hashes: [], final: true }
    });
    lastSourceSyncAt = Date.now();
  })().finally(() => { sourceSyncPromise = null; });
  return sourceSyncPromise;
}

async function encryptedBody(hash, source, expectedSize, nonce) {
  const digest = createHash('sha256');
  let size = 0;
  const cipher = createCipheriv('aes-256-gcm', objectKey(hash), nonce);
  async function* chunks() {
    yield HEADER;
    yield nonce;
    for await (const chunk of source) {
      canceled();
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
  const response = await api(`/api/objects/${object.hash}`);
  if (!response.body) throw new Error(`Object unavailable: ${object.hash}`);
  const nonce = randomBytes(12);
  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  const body = await encryptedBody(object.hash, source, Number(object.size), nonce);
  const opaque = opaqueId(object.hash);
  update({ phase: `Encrypting to ${peer.name}`, current: object.hash.slice(0, 12) });
  await peerRequest(peer, `/v1/objects/${opaque}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(Number(object.size) + HEADER_BYTES + TAG_BYTES) },
    body
  });
}

async function downloadEncryptedPeerObject(peer, hash, expectedSize) {
  const response = await peerRequest(peer, `/v1/objects/${opaqueId(hash)}`);
  if (!response.body) throw new Error(`Encrypted backup unavailable: ${hash}`);
  const tmpDir = join(CONFIG_DIR, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const path = join(tmpDir, `peer-${process.pid}-${Date.now()}-${opaqueId(hash)}`);
  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  await pipeline(source, createWriteStream(path, { flags: 'wx' }));
  const wanted = Number(expectedSize) + HEADER_BYTES + TAG_BYTES;
  if (Number((await stat(path)).size) !== wanted) {
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
      method: 'PUT', headers: { 'content-length': String(object.size) }, body
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
    canceled();
    const page = await api(`/api/integrity/bad?limit=500&after=${encodeURIComponent(after)}`).catch(() => ({ objects: [] }));
    for (const object of page.objects || []) {
      const state = await api(`/api/protection/objects/${object.hash}`).catch(() => null);
      const ids = new Set((state?.copies || []).filter(copy => copy.kind === 'peer' && copy.verified).map(copy => copy.id));
      for (const peer of peers.filter(item => ids.has(item.id))) {
        try {
          if (await repairFromPeer(peer, object, update)) { repaired++; break; }
        } catch {}
      }
    }
    after = page.nextAfter || '';
  } while (after);
  return repaired;
}

const backupObjectPath = (root, hash) => join(resolve(root), '.mochimono', 'objects', hash.slice(0, 2), hash);
const backupInventoryPath = root => join(resolve(root), '.mochimono', 'inventory.sqlite');
const backupCatalogPath = root => join(resolve(root), '.mochimono', 'catalog.sqlite');

function openBackupInventory(root) {
  const db = new DatabaseSync(backupInventoryPath(root), { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS objects(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,stored_at TEXT NOT NULL,verified_at TEXT) STRICT;
  `);
  return db;
}

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    canceled();
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function downloadPrimary(hash, size, destination) {
  const response = await api(`/api/objects/${hash}`);
  if (!response.body) throw new Error(`Object unavailable: ${hash}`);
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive: true });
  const digest = createHash('sha256');
  let bytes = 0;
  const verify = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    }
  });
  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  try {
    await pipeline(source, verify, createWriteStream(temp, { flags: 'wx' }));
    if (bytes !== Number(size) || digest.digest('hex') !== hash) throw new Error(`Verification failed for ${hash}`);
    await rm(destination, { force: true });
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function saveBackupCatalog(root) {
  const response = await api('/api/catalog/export');
  const target = backupCatalogPath(root);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const source = Readable.fromWeb(response.body);
  source.on('error', () => {});
  try {
    await pipeline(source, createWriteStream(temp, { flags: 'wx' }));
    await rm(target, { force: true });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function consumeLocalBackupDeletions(backup) {
  const id = backup.meta?.id;
  if (!id) return 0;
  const page = await api(`/api/protection/deletions/${encodeURIComponent(id)}`).catch(() => ({ deletions: [] }));
  if (!page.deletions?.length) return 0;
  const db = openBackupInventory(backup.path);
  const done = [];
  try {
    const forget = db.prepare('DELETE FROM objects WHERE hash=?');
    for (const item of page.deletions) {
      try {
        await rm(backupObjectPath(backup.path, item.hash), { force: true });
        forget.run(item.hash);
        done.push(item.hash);
      } catch {}
    }
  } finally { db.close(); }
  if (done.length) await api(`/api/protection/deletions/${encodeURIComponent(id)}/ack`, { method: 'POST', body: { hashes: done } }).catch(() => {});
  return done.length;
}

async function protectLocalBackup(backup, update, mode) {
  const id = backup.meta?.id;
  if (!id) return { copied: 0, copiedBytes: 0, already: 0 };
  const db = openBackupInventory(backup.path);
  const find = db.prepare('SELECT hash,size,verified_at AS verifiedAt FROM objects WHERE hash=?');
  const save = db.prepare(`INSERT INTO objects(hash,size,stored_at,verified_at) VALUES(?,?,?,?)
    ON CONFLICT(hash) DO UPDATE SET size=excluded.size,stored_at=excluded.stored_at,verified_at=excluded.verified_at`);
  let copied = 0;
  let copiedBytes = 0;
  let already = 0;
  let after = '';
  let touched = false;
  try {
    do {
      canceled();
      const page = await api(`/api/protection/plan/${encodeURIComponent(id)}?after=${encodeURIComponent(after)}&limit=100`);
      for (const object of page.objects || []) {
        canceled();
        const destination = backupObjectPath(backup.path, object.hash);
        const local = find.get(object.hash);
        let present = false;
        if (local && existsSync(destination)) {
          try {
            const info = await stat(destination);
            present = info.isFile() && Number(info.size) === Number(object.size) && await hashFile(destination) === object.hash;
          } catch {}
        }
        const timestamp = now();
        if (!present) {
          update({ phase: `Backing up to ${backup.meta?.name || basename(backup.path)}`, current: object.hash.slice(0, 12), copied, copiedBytes });
          await downloadPrimary(object.hash, object.size, destination);
          copied++;
          copiedBytes += Number(object.size) || 0;
        } else already++;
        save.run(object.hash, Number(object.size), timestamp, timestamp);
        await api(`/api/drives/${encodeURIComponent(id)}/replicas`, {
          method: 'POST', body: { replicas: [{ hash: object.hash, verifiedAt: timestamp }] }
        });
        touched = true;
        if (mode === 'low') await sleep(120);
      }
      after = page.nextAfter || '';
    } while (after);
  } finally { db.close(); }
  if (touched) await saveBackupCatalog(backup.path);
  return { copied, copiedBytes, already };
}

async function consumePeerDeletions(peer) {
  const page = await api(`/api/protection/deletions/${encodeURIComponent(peer.id)}`).catch(() => ({ deletions: [] }));
  const done = [];
  for (const item of page.deletions || []) {
    canceled();
    const response = await fetch(`${peer.url}/v1/objects/${opaqueId(item.hash)}`, { method: 'DELETE', headers: peerHeaders(peer) }).catch(() => null);
    if (response?.ok || response?.status === 404) done.push(item.hash);
  }
  if (done.length) await api(`/api/protection/deletions/${encodeURIComponent(peer.id)}/ack`, { method: 'POST', body: { hashes: done } });
}

async function updatePeer(peer, update, mode) {
  await registerPeer(peer);
  await consumePeerDeletions(peer);
  let after = '';
  let copied = 0;
  let copiedBytes = 0;
  do {
    canceled();
    const page = await api(`/api/protection/plan/${encodeURIComponent(peer.id)}?after=${encodeURIComponent(after)}&limit=100`);
    for (const object of page.objects || []) {
      canceled();
      await uploadPeerObject(peer, object, update);
      const verifiedAt = now();
      await api(`/api/drives/${encodeURIComponent(peer.id)}/replicas`, {
        method: 'POST', body: { replicas: [{ hash: object.hash, verifiedAt }] }
      });
      copied++;
      copiedBytes += Number(object.size) || 0;
      update({ phase: `Backing up to ${peer.name}`, copied, copiedBytes, current: object.hash.slice(0, 12) });
      if (mode === 'low') await sleep(120);
    }
    after = page.nextAfter || '';
  } while (after);
  peer.lastBackupAt = now();
  await persist();
  return { copied, copiedBytes };
}

async function consumeSourceDeletions() {
  const page = await api(`/api/protection/source-deletions/${encodeURIComponent(settings.device)}`).catch(() => ({ deletions: [] }));
  const done = [];
  for (const item of page.deletions || []) {
    canceled();
    const local = localLocations(item.hash);
    const definitions = new Map((local.locations || []).map(location => [location.id, location]));
    let failed = false;
    for (const [, locationId, relativePath] of local.files || []) {
      const location = definitions.get(locationId);
      const root = location?.rootPath;
      if (!root) continue;
      const base = resolve(root);
      const target = resolve(base, ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));
      const key = value => platform() === 'win32' ? value.toLowerCase() : value;
      const inside = key(target) === key(base) || key(target).startsWith(`${key(base)}${platform() === 'win32' ? '\\' : '/'}`);
      if (!inside || !existsSync(target)) continue;
      try { await rm(target, { force: true }); }
      catch { failed = true; }
    }
    if (!failed) done.push(item.hash);
  }
  if (done.length) await api(`/api/protection/source-deletions/${encodeURIComponent(settings.device)}/ack`, { method: 'POST', body: { hashes: done } }).catch(() => {});
  return done.length;
}

async function runProtection(update, automatic = false) {
  const value = await loadConfig();
  const mode = value.background;
  if (mode === 'paused' && automatic) return { skipped: true };
  let previousPriority = null;
  if (mode === 'low') {
    try {
      previousPriority = getPriority(process.pid);
      setPriority(process.pid, Math.max(10, previousPriority));
    } catch {}
  }
  try {
    update({ phase: 'Checking local copies', current: '' });
    await syncSourceReplicas(value, true);
    const deletedSources = await consumeSourceDeletions();
    const enabledPeers = value.peers.filter(peer => peer.enabled !== false);
    const primaryRepaired = await repairPrimaryFromPeers(enabledPeers, update);
    const backups = await syncLocalBackupLocations(value);
    let copied = 0;
    let copiedBytes = 0;

    for (const backup of backups) {
      canceled();
      await consumeLocalBackupDeletions(backup);
      const result = await protectLocalBackup(backup, update, mode);
      copied += result.copied;
      copiedBytes += result.copiedBytes;
      if (mode === 'low') await sleep(250);
    }

    for (const peer of enabledPeers) {
      canceled();
      try {
        const result = await updatePeer(peer, update, mode);
        copied += result.copied;
        copiedBytes += result.copiedBytes;
      } catch (error) {
        update({ phase: `${peer.name} unavailable`, current: error.message });
        if (!automatic) throw error;
      }
    }
    update({ phase: 'Done', copied, copiedBytes });
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

async function freeLocal(hash, value) {
  await syncSourceReplicas(value, true);
  const candidate = localCandidate(hash);
  if (!candidate?.path || !existsSync(candidate.path)) throw Object.assign(new Error('No local copy is available on this PC'), { status: 404 });
  const local = localLocations(hash);
  const localCount = (local.files || []).length;
  const exclude = localCount <= 1 ? settings.device : '';
  const state = await api(`/api/protection/objects/${hash}${exclude ? `?excludeSourceDevice=${encodeURIComponent(exclude)}` : ''}`);
  if (!state.meets) {
    const error = new Error('Another independent verified copy is required before freeing this local file');
    error.status = 409;
    error.protection = state;
    throw error;
  }
  const info = await stat(candidate.path);
  await sendToTrash(candidate.path);
  if (localCount <= 1) {
    await api(`/api/protection/source-replicas/${encodeURIComponent(settings.device)}/remove`, {
      method: 'POST', body: { hashes: [hash] }
    }).catch(() => {});
  }
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
    canceled();
    const current = queue.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name === '.mochimono') continue;
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

const shareRoot = value => value.share.path ? resolve(value.share.path) : '';
const peerDataRoot = value => join(shareRoot(value), '.mochimono', 'peer-share');
const peerObjectPath = (value, id) => join(peerDataRoot(value), 'objects', id.slice(0, 2), id);

function peerDb(value) {
  const db = new DatabaseSync(join(peerDataRoot(value), 'inventory.sqlite'), { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,size INTEGER NOT NULL,stored_at TEXT NOT NULL) STRICT;`);
  return db;
}

async function shareStatus(value) {
  if (!value.share.enabled || !shareRoot(value)) return { enabled: false };
  await mkdir(peerDataRoot(value), { recursive: true });
  const fs = await statfs(shareRoot(value));
  const db = peerDb(value);
  const usage = db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM objects').get();
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

const authorized = (req, value) => req.headers.authorization === `Bearer ${value.share.token}`;

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
      if (Number((await stat(temp)).size) !== length) throw new Error('Incomplete upload');
      await rm(target, { force: true });
      await rename(temp, target);
      const db = peerDb(value);
      db.prepare('INSERT INTO objects(id,size,stored_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET size=excluded.size,stored_at=excluded.stored_at').run(id, length, now());
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
  const urls = [`http://${hostname()}:${PEER_PORT}`];
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) {
    if (address.family === 'IPv4' && !address.internal) urls.push(`http://${address.address}:${PEER_PORT}`);
  }
  return [...new Set(urls)];
}

async function updatePeerServer(value) {
  if (!value.share.enabled) {
    if (peerServer) await new Promise(resolvePromise => peerServer.close(resolvePromise));
    peerServer = null;
    return;
  }
  if (peerServer) return;
  peerServer = http.createServer((req, res) => handlePeerRequest(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Peer storage error' });
    else res.destroy();
  }));
  peerServer.listen(PEER_PORT, '0.0.0.0', () => console.log(`Mochimono peer storage: port ${PEER_PORT}`));
}

async function localState() {
  const value = await loadConfig();
  const backups = await syncLocalBackupLocations(value);
  await syncSourceReplicas(value, false).catch(() => {});
  const [summary, rules, locations] = await Promise.all([
    api('/api/protection/summary').catch(() => null),
    api('/api/protection/rules').catch(() => ({ rules: [] })),
    api('/api/protection/locations').catch(() => ({ locations: [] }))
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
    lastSourceSyncAt = 0;
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
    json(res, 200, await api(`/api/protection/rules/import/${importId}`, { method: 'POST', body: { level } }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/location') {
    const body = await readJson(req);
    if (!body.id) return void json(res, 400, { error: 'Storage location required' });
    if (body.id === `source:${settings.device}` && body.site !== undefined) {
      value.site = String(body.site || settings.device).trim().slice(0, 120) || settings.device;
      await persist();
      lastSourceSyncAt = 0;
    }
    json(res, 200, await api(`/api/protection/locations/${encodeURIComponent(body.id)}`, { method: 'POST', body }));
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
    await updatePeerServer(value);
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
    if (!validKey(key)) return void json(res, 400, { error: 'Recovery key must be a 32-byte base64url key' });
    if (key !== value.backupKey && value.peers.some(peer => peer.lastBackupAt) && body.confirm !== 'REPLACE') {
      return void json(res, 409, { error: 'Replacing this key makes existing remote backups unreadable. Confirm REPLACE only when restoring the original saved key.', requiresConfirmation: true });
    }
    value.backupKey = key;
    await persist();
    json(res, 200, { ok: true, fingerprint: publicConfig(value).keyFingerprint });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/free-local') {
    const hash = String((await readJson(req)).hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return void json(res, 400, { error: 'Valid file hash required' });
    try { json(res, 200, await freeLocal(hash, value)); }
    catch (error) {
      if (error.protection) json(res, error.status || 409, { error: error.message, protection: error.protection });
      else throw error;
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/client/protection/estimate-folder') {
    json(res, 200, await estimateFolder((await readJson(req)).path));
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
  const value = await loadConfig();
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
  await updatePeerServer(value);
  clearInterval(tickTimer);
  tickTimer = setInterval(() => backgroundTick().catch(console.error), 60_000);
  tickTimer.unref?.();
  const first = setTimeout(() => backgroundTick().catch(console.error), 15_000);
  first.unref?.();
}
