import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR, api, canceled, json, now, readJson, serverState, settings, startJob } from './agent-context.js';
import { readBackup } from './agent-backups.js';
import { FriendPeerNetwork } from './friend-p2p.js';

const PORT = Number(process.env.MOCHIMONO_FRIEND_PORT || 8644);
const AGENT_PORT = Number(process.env.MOCHIMONO_AGENT_PORT || 8643);
const CONFIG_PATH = join(CONFIG_DIR, 'friend-storage.json');
const TMP_DIR = join(CONFIG_DIR, 'friend-tmp');
const MAGIC = Buffer.from('MFR1');
const HEADER_SIZE = MAGIC.length + 12;
const TAG_SIZE = 16;
const OVERHEAD = HEADER_SIZE + TAG_SIZE;
const MAX_MANIFEST = 96 * 1024 * 1024;

let config = { shares: [], backups: [] };
try {
  const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  config.shares = Array.isArray(parsed.shares) ? parsed.shares : [];
  config.backups = Array.isArray(parsed.backups) ? parsed.backups : [];
} catch {}

const safeName = value => String(value || '').trim().slice(0, 120);
const shareDir = share => join(resolve(share.path), '.mochimono-friend', share.id);
const objectPath = (share, id) => join(shareDir(share), 'objects', id.slice(0, 2), id);
const objectMetaPath = (share, id) => `${objectPath(share, id)}.json`;
const keyBytes = target => Buffer.from(String(target.key || ''), 'base64url');
const opaqueId = (key, label) => createHmac('sha256', key).update(`mochimono-friend-v1:${label}`).digest('hex');
const manifestId = key => opaqueId(key, 'manifest');
const catalogId = key => opaqueId(key, 'catalog');
const objectId = (key, hash) => opaqueId(key, `object:${hash}`);

async function persist() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function sameUiOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return ['127.0.0.1', '::1'].includes(String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
  try {
    const source = new URL(origin);
    return ['127.0.0.1', 'localhost', '::1'].includes(source.hostname) && Number(source.port) === AGENT_PORT;
  } catch { return false; }
}

function cors(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin) return;
  try {
    const source = new URL(origin);
    if (!['127.0.0.1', 'localhost', '::1'].includes(source.hostname) || Number(source.port) !== AGENT_PORT) return;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  } catch {}
}

function sendJson(req, res, status, data) { cors(req, res); json(res, status, data); return true; }

async function hostedInfo(share) {
  const fs = await statfs(resolve(share.path));
  const physicalFree = Number(fs.bavail) * Number(fs.bsize);
  const physicalTotal = Number(fs.blocks) * Number(fs.bsize);
  const used = Math.max(0, Number(share.usedBytes) || 0);
  const quota = Math.max(0, Number(share.quotaBytes) || 0);
  const free = quota ? Math.max(0, Math.min(physicalFree, quota - used)) : physicalFree;
  return { id: share.id, name: share.name, usedBytes: used, quotaBytes: quota, capacityBytes: quota || Math.min(physicalTotal, used + physicalFree), freeBytes: free, encryptedOnly: true };
}

function shareForPeer(peerId, shareId) {
  const share = config.shares.find(item => item.id === shareId && item.peerId === peerId);
  if (!share) throw new Error('Friend storage share is not authorized for this peer');
  return share;
}

async function beginHostedPut(share, id) {
  const destination = objectPath(share, id);
  const previous = await stat(destination).catch(() => null);
  const oldSize = previous?.isFile() ? Number(previous.size) || 0 : 0;
  const quota = Math.max(0, Number(share.quotaBytes) || 0);
  const baseUsed = Math.max(0, Number(share.usedBytes) || 0) - oldSize;
  const allowed = quota ? Math.max(0, quota - baseUsed) : Infinity;
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive: true });
  let size = 0;
  const digest = createHash('sha256');
  const input = new PassThrough({ highWaterMark: 2 * 1024 * 1024 });
  const meter = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > allowed) return callback(new Error('Friend storage quota exceeded'));
    digest.update(chunk); callback(null, chunk);
  }});
  const done = (async () => {
    try {
      await pipeline(input, meter, createWriteStream(temp, { flags: 'wx' }));
      if (size < OVERHEAD) throw new Error('Encrypted object is incomplete');
      await rm(destination, { force: true });
      await rename(temp, destination);
      const sha256 = digest.digest('hex');
      await writeFile(objectMetaPath(share, id), `${JSON.stringify({ size, sha256, storedAt: now() })}\n`);
      share.usedBytes = baseUsed + size;
      await persist();
      return { id, size, sha256 };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  })();
  return { sink: input, done };
}

async function openHostedGet(share, id) {
  const path = objectPath(share, id);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error('Encrypted object not found');
  let meta = {};
  try { meta = JSON.parse(await readFile(objectMetaPath(share, id), 'utf8')); } catch {}
  return { size: Number(info.size), sha256: meta.sha256 || '', stream: createReadStream(path) };
}

async function removeHostedObject(share, id) {
  const path = objectPath(share, id);
  const info = await stat(path).catch(() => null);
  await Promise.all([rm(path, { force: true }), rm(objectMetaPath(share, id), { force: true })]);
  if (info?.isFile()) { share.usedBytes = Math.max(0, (Number(share.usedBytes) || 0) - Number(info.size || 0)); await persist(); }
  return { ok: true };
}

function peerPublicKey(peerId) {
  return config.shares.find(s => s.peerId === peerId)?.peerPublicKey || config.backups.find(b => b.peerId === peerId)?.peerPublicKey || '';
}

const network = await new FriendPeerNetwork({
  peerPublicKey,
  onPairJoined: async ({ shareId, peer }) => {
    const share = config.shares.find(item => item.id === shareId);
    if (!share) return;
    share.peerId = peer.deviceId;
    share.peerPublicKey = peer.publicKey;
    share.peerName = safeName(peer.deviceName) || 'Friend';
    share.pairedAt = now();
    await persist();
  },
  backend: {
    info: async (peerId, shareId) => hostedInfo(shareForPeer(peerId, shareId)),
    head: async (peerId, shareId, id) => {
      const share = shareForPeer(peerId, shareId);
      const info = await stat(objectPath(share, id)).catch(() => null);
      return info?.isFile() ? { size: Number(info.size) } : null;
    },
    beginPut: async (peerId, shareId, id) => beginHostedPut(shareForPeer(peerId, shareId), id),
    openGet: async (peerId, shareId, id) => openHostedGet(shareForPeer(peerId, shareId), id),
    remove: async (peerId, shareId, id) => removeHostedObject(shareForPeer(peerId, shareId), id)
  }
}).start();

function encryptedReadable(source, key, state = {}) {
  return Readable.from((async function* () {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const digest = createHash('sha256');
    state.size = 0;
    const emit = chunk => { if (!chunk?.length) return null; digest.update(chunk); state.size += chunk.length; return chunk; };
    let chunk = emit(Buffer.concat([MAGIC, nonce])); if (chunk) yield chunk;
    for await (const input of source) { chunk = emit(cipher.update(input)); if (chunk) yield chunk; }
    chunk = emit(cipher.final()); if (chunk) yield chunk;
    chunk = emit(cipher.getAuthTag()); if (chunk) yield chunk;
    state.sha256 = digest.digest('hex');
  })());
}

async function* decryptedIterable(source, key) {
  let pending = Buffer.alloc(0), decipher = null;
  for await (const input of source) {
    pending = Buffer.concat([pending, Buffer.from(input)]);
    if (!decipher && pending.length >= HEADER_SIZE) {
      if (!pending.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Friend backup encryption header is invalid');
      decipher = createDecipheriv('aes-256-gcm', key, pending.subarray(MAGIC.length, HEADER_SIZE));
      pending = pending.subarray(HEADER_SIZE);
    }
    if (decipher && pending.length > TAG_SIZE) {
      const length = pending.length - TAG_SIZE;
      const plain = decipher.update(pending.subarray(0, length));
      pending = pending.subarray(length);
      if (plain.length) yield plain;
    }
  }
  if (!decipher || pending.length !== TAG_SIZE) throw new Error('Friend backup encrypted object is truncated');
  decipher.setAuthTag(pending);
  const final = decipher.final(); if (final.length) yield final;
}

const request = (target, op, objectIdValue) => network.call(target.peerId, { op, shareId: target.shareId, ...(objectIdValue ? { objectId: objectIdValue } : {}) });
async function uploadEncrypted(target, id, source, key) {
  const state = {};
  const result = await network.put(target.peerId, { op: 'put', shareId: target.shareId, objectId: id }, encryptedReadable(source, key, state));
  if (!state.sha256 || result.sha256 !== state.sha256 || Number(result.size) !== Number(state.size)) throw new Error('Friend storage ciphertext verification failed');
  return { ...result, cipherSize: state.size };
}
async function encryptedObjectHead(target, id) { return request(target, 'head', id).catch(() => null); }
async function encryptedObjectStream(target, id) { return network.get(target.peerId, { op: 'get', shareId: target.shareId, objectId: id }); }
async function decryptBuffer(target, id, key, max = MAX_MANIFEST) {
  const { stream } = await encryptedObjectStream(target, id); const chunks = []; let size = 0;
  for await (const chunk of decryptedIterable(stream, key)) { size += chunk.length; if (size > max) throw new Error('Friend backup metadata is too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function decryptToFile(target, id, key, path) { const { stream } = await encryptedObjectStream(target, id); await mkdir(dirname(path), { recursive: true }); await pipeline(Readable.from(decryptedIterable(stream, key)), createWriteStream(path)); return path; }
async function loadManifest(target) { const key = keyBytes(target); try { const value = JSON.parse((await decryptBuffer(target, manifestId(key), key)).toString('utf8')); return value && Array.isArray(value.objects) ? value : { version: 1, objects: [] }; } catch (error) { if (/not found|unavailable/i.test(error.message)) return { version: 1, objects: [] }; throw error; } }
async function saveManifest(target, manifest) { const key = keyBytes(target); await uploadEncrypted(target, manifestId(key), Readable.from([Buffer.from(JSON.stringify(manifest))]), key); }
async function registerFriendBackup(target) { try { return await api('/api/drives/register', { method: 'POST', body: { id: target.id, name: target.name, policy: target.policy || { all: true, collectionId: null } } }); } catch { return null; } }
async function reportReplicas(target, replicas) { for (let offset = 0; offset < replicas.length; offset += 1000) await api(`/api/drives/${encodeURIComponent(target.id)}/replicas`, { method: 'POST', body: { replicas: replicas.slice(offset, offset + 1000) } }); }
async function removeReplicas(target, hashes) { for (let offset = 0; offset < hashes.length; offset += 1000) await api(`/api/drives/${encodeURIComponent(target.id)}/replicas/remove`, { method: 'POST', body: { hashes: hashes.slice(offset, offset + 1000) } }); }
async function uploadFriendObject(target, object, key) { const response = await api(`/api/objects/${object.hash}`); const result = await uploadEncrypted(target, objectId(key, object.hash), Readable.fromWeb(response.body), key); if (Number(result.cipherSize) !== Number(object.size) + OVERHEAD) throw new Error(`Encrypted size mismatch for ${object.hash}`); }
async function saveEncryptedCatalog(target, key) { const response = await api('/api/catalog/export'); await uploadEncrypted(target, catalogId(key), Readable.fromWeb(response.body), key); }

async function friendBackupUpdate(target, update = () => {}) {
  const key = keyBytes(target); if (key.length !== 32) throw new Error('Friend backup recovery key is invalid');
  await request(target, 'info');
  const coverage = await registerFriendBackup(target); if (coverage?.policy?.missing) throw new Error('Choose a current backup scope before updating');
  const previous = await loadManifest(target); const prior = new Map(previous.objects.map(item => [item.hash, item])); const objects = [], replicas = [];
  let after = '', copied = 0, copiedBytes = 0, already = 0;
  do {
    canceled(); const page = await api(`/api/drives/${encodeURIComponent(target.id)}/desired?after=${encodeURIComponent(after)}&limit=1000`);
    for (const object of page.objects || []) {
      canceled(); const id = objectId(key, object.hash); const old = prior.get(object.hash); const head = old && Number(old.size) === Number(object.size) ? await encryptedObjectHead(target, id) : null;
      if (head && Number(head.size) === Number(object.size) + OVERHEAD && old.verifiedAt) { already++; objects.push({ ...old, hash: object.hash, size: Number(object.size), mime: object.mime, id }); replicas.push({ hash: object.hash, verifiedAt: old.verifiedAt }); }
      else { update({ phase: 'Encrypting to friend', current: object.hash.slice(0, 12), copied, already, copiedBytes }); await uploadFriendObject(target, object, key); const verifiedAt = now(); objects.push({ hash: object.hash, size: Number(object.size), mime: object.mime, id, verifiedAt }); replicas.push({ hash: object.hash, verifiedAt }); copied++; copiedBytes += Number(object.size); }
      if (replicas.length >= 1000) await reportReplicas(target, replicas.splice(0));
    }
    after = page.nextAfter || '';
  } while (after);
  await reportReplicas(target, replicas); update({ phase: 'Encrypting backup catalog', copied, already, copiedBytes }); await saveEncryptedCatalog(target, key);
  const manifest = { version: 1, driveId: target.id, updatedAt: now(), catalogId: catalogId(key), objects }; await saveManifest(target, manifest); target.lastBackupAt = manifest.updatedAt; await persist();
  return { drive: target.name, copied, already, copiedBytes, encrypted: true };
}

async function verifyPlainObject(target, item, key) { const { stream } = await encryptedObjectStream(target, item.id || objectId(key, item.hash)); const digest = createHash('sha256'); let size = 0; for await (const chunk of decryptedIterable(stream, key)) { digest.update(chunk); size += chunk.length; } return size === Number(item.size) && digest.digest('hex') === item.hash; }
async function friendBackupVerify(target, update = () => {}) {
  const key = keyBytes(target), manifest = await loadManifest(target), good = [], bad = []; let repaired = 0;
  for (let index = 0; index < manifest.objects.length; index++) { canceled(); const item = manifest.objects[index]; update({ phase: 'Verifying encrypted friend backup', current: item.hash.slice(0, 12), checked: index, total: manifest.objects.length, bad: bad.length, repaired }); let ok = false; try { ok = await verifyPlainObject(target, item, key); } catch {} if (!ok) { try { await uploadFriendObject(target, item, key); ok = true; repaired++; } catch {} } if (ok) { item.verifiedAt = now(); good.push({ hash: item.hash, verifiedAt: item.verifiedAt }); } else bad.push(item.hash); }
  await reportReplicas(target, good).catch(() => {}); await removeReplicas(target, bad).catch(() => {}); await saveManifest(target, manifest);
  let catalogHealthy = false; const catalogPath = join(TMP_DIR, `${target.id}-verify-catalog.sqlite`);
  try { await decryptToFile(target, manifest.catalogId || catalogId(key), key, catalogPath); const db = new DatabaseSync(catalogPath, { readOnly: true, timeout: 5000 }); try { const rows = db.prepare('PRAGMA quick_check').all().map(row => String(Object.values(row)[0] || '')); catalogHealthy = rows.length === 1 && rows[0] === 'ok'; } finally { db.close(); } } catch {} finally { await rm(catalogPath, { force: true }).catch(() => {}); }
  target.lastVerifiedAt = now(); target.lastVerifyBad = bad.length; target.lastVerifyRepaired = repaired; target.lastVerifyCatalogHealthy = catalogHealthy; await persist(); update({ phase: 'Done', checked: manifest.objects.length, total: manifest.objects.length, bad: bad.length, repaired, catalogHealthy });
  return { drive: target.name, checked: manifest.objects.length, healthy: manifest.objects.length - bad.length, bad: bad.length, repaired, catalogHealthy };
}

function createInventory(path, objects) { const db = new DatabaseSync(path); try { db.exec('CREATE TABLE objects(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,stored_at TEXT,verified_at TEXT) STRICT;'); const insert = db.prepare('INSERT INTO objects(hash,size,stored_at,verified_at) VALUES(?,?,?,?)'); for (const item of objects) insert.run(item.hash, Number(item.size) || 0, now(), item.verifiedAt || null); } finally { db.close(); } }
async function restoreSources(db, ignored) { const currentImports = (await api('/api/imports')).imports || []; const importIds = new Map(currentImports.map(item => [String(item.sourceName), Number(item.id)])); const sourceNames = db.prepare(`SELECT DISTINCT i.source_name AS sourceName FROM sources s JOIN imports i ON i.id=s.import_id JOIN friend_inventory.objects b ON b.hash=s.object_hash ORDER BY lower(i.source_name)`).all().map(item => String(item.sourceName)); for (const sourceName of sourceNames) { if (!importIds.has(sourceName)) { const imported = await api('/api/imports', { method: 'POST', body: { sourceName } }); importIds.set(sourceName, Number(imported.id)); } const rows = db.prepare(`SELECT s.object_hash AS hash,s.original_path AS path,s.filename,s.mtime FROM sources s JOIN imports i ON i.id=s.import_id JOIN friend_inventory.objects b ON b.hash=s.object_hash WHERE i.source_name=? ORDER BY s.original_path`).all(sourceName).filter(row => !ignored.has(row.hash)); for (let offset = 0; offset < rows.length; offset += 1000) await api('/api/sources', { method: 'POST', body: { importId: importIds.get(sourceName), sources: rows.slice(offset, offset + 1000) } }); } const roots = db.prepare(`SELECT i.source_name AS sourceName,COALESCE(MAX(ir.device_name),'') AS deviceName,COALESCE(MAX(ir.root_path),'') AS rootPath FROM imports i JOIN sources s ON s.import_id=i.id JOIN friend_inventory.objects b ON b.hash=s.object_hash LEFT JOIN import_roots ir ON ir.import_id=i.id GROUP BY i.source_name`).all().filter(item => item.deviceName || item.rootPath); if (roots.length) await api('/api/import-roots', { method: 'POST', body: { roots: roots.map(item => ({ importId: importIds.get(String(item.sourceName)), deviceName: item.deviceName, rootPath: item.rootPath })) } }); }
async function restoreMetadata(db) { const rows = db.prepare(`SELECT mm.object_hash AS hash,mm.captured_at AS capturedAt,mm.source FROM media_metadata mm JOIN friend_inventory.objects b ON b.hash=mm.object_hash`).all(); for (let offset = 0; offset < rows.length; offset += 20) await Promise.all(rows.slice(offset, offset + 20).map(row => api(`/api/media-metadata/${row.hash}`, { method: 'POST', body: { capturedAt: row.capturedAt, source: row.source } }))); }
async function friendBackupRestore(target, update = () => {}) {
  const key = keyBytes(target), manifest = await loadManifest(target); if (!manifest.objects.length) throw new Error('Friend backup is empty'); const catalogPath = join(TMP_DIR, `${target.id}-restore-catalog.sqlite`), inventoryPath = join(TMP_DIR, `${target.id}-restore-inventory.sqlite`); await mkdir(TMP_DIR, { recursive: true });
  try { await decryptToFile(target, manifest.catalogId || catalogId(key), key, catalogPath); await rm(inventoryPath, { force: true }); createInventory(inventoryPath, manifest.objects); const missing = new Set(), ignored = new Set(); for (let offset = 0; offset < manifest.objects.length; offset += 1000) { const batch = manifest.objects.slice(offset, offset + 1000); const result = await api('/api/objects/check', { method: 'POST', body: { hashes: batch.map(item => item.hash) } }); for (const hash of result.missing || []) missing.add(hash); for (const hash of result.ignored || []) ignored.add(hash); } let restored = 0, restoredBytes = 0; const totalBytes = manifest.objects.filter(item => missing.has(item.hash)).reduce((sum, item) => sum + Number(item.size), 0), already = Math.max(0, manifest.objects.length - missing.size - ignored.size); for (let index = 0; index < manifest.objects.length; index++) { canceled(); const item = manifest.objects[index]; if (missing.has(item.hash)) { const { stream } = await encryptedObjectStream(target, item.id || objectId(key, item.hash)); await api(`/api/objects/${item.hash}`, { method: 'PUT', headers: { 'content-length': String(item.size), 'x-mochimono-mime': String(item.mime || 'application/octet-stream') }, body: Readable.from(decryptedIterable(stream, key)) }); restored++; restoredBytes += Number(item.size); } update({ phase: 'Restoring encrypted friend backup', checked: index + 1, total: manifest.objects.length, restored, already, ignored: ignored.size, doneBytes: restoredBytes, totalBytes, current: item.hash.slice(0, 12) }); } const db = new DatabaseSync(catalogPath, { readOnly: true, timeout: 5000 }); try { db.exec(`ATTACH DATABASE '${inventoryPath.replaceAll("'", "''")}' AS friend_inventory`); update({ phase: 'Restoring file information', checked: 0, total: manifest.objects.length, restored, already, ignored: ignored.size }); await restoreSources(db, ignored); await restoreMetadata(db); } finally { db.close(); } target.lastRestoreAt = now(); await persist(); return { destination: 'Mochimono', total: manifest.objects.length, restored, already, ignored: ignored.size, restoredBytes }; } finally { await Promise.all([rm(catalogPath, { force: true }), rm(inventoryPath, { force: true })]); }
}

async function friendBackupContents(target) { const manifest = await loadManifest(target); return { name: target.name, count: manifest.objects.length, bytes: manifest.objects.reduce((sum, item) => sum + Number(item.size || 0), 0), updatedAt: manifest.updatedAt || target.lastBackupAt || null, encrypted: true }; }
async function remoteInfo(target) { try { return { online: true, connection: network.connectionInfo(target.peerId), ...(await request(target, 'info')) }; } catch (error) { return { online: false, connection: 'offline', error: error.message }; } }
function publicTarget(target) { return { id: target.id, name: target.name, peerName: target.peerName || 'Friend', policy: target.policy || { all: true, collectionId: null }, recoveryKey: target.key, lastBackupAt: target.lastBackupAt || null, lastVerifiedAt: target.lastVerifiedAt || null, lastVerifyBad: Number(target.lastVerifyBad) || 0, lastVerifyRepaired: Number(target.lastVerifyRepaired) || 0, lastVerifyCatalogHealthy: target.lastVerifyCatalogHealthy !== false, lastRestoreAt: target.lastRestoreAt || null }; }
async function friendBackups() { const result = []; for (const target of config.backups) { const [storage, coverage] = await Promise.all([remoteInfo(target), registerFriendBackup(target)]); result.push({ ...publicTarget(target), storage, coverage }); } return result; }
function normalizedRecoveryKey(value) { const text = String(value || '').trim(); if (!text) return ''; try { const key = Buffer.from(text, 'base64url'); return key.length === 32 ? key.toString('base64url') : ''; } catch { return ''; } }

async function createTarget(body) {
  const suppliedKey = normalizedRecoveryKey(body.recoveryKey); if (body.recoveryKey && !suppliedKey) throw Object.assign(new Error('Recovery key is invalid'), { status: 400 });
  const host = await network.joinInvite(body.inviteCode); if (!host.shareId) throw new Error('Friend invite does not contain a storage share');
  const target = { id: randomUUID(), name: safeName(body.name) || safeName(host.name) || 'Friend backup', peerId: host.deviceId, peerPublicKey: host.publicKey, peerName: safeName(host.deviceName) || 'Friend', shareId: host.shareId, key: suppliedKey || randomBytes(32).toString('base64url'), policy: { all: true, collectionId: null }, createdAt: now() };
  if (suppliedKey) { const manifest = await loadManifest(target); if (!manifest.driveId) throw Object.assign(new Error('Recovery key does not match an existing friend backup at this location'), { status: 400 }); target.id = String(manifest.driveId); target.lastBackupAt = manifest.updatedAt || null; if (config.backups.some(item => item.id === target.id)) throw Object.assign(new Error('This friend backup is already connected'), { status: 409 }); }
  config.backups.push(target); await persist(); await registerFriendBackup(target); return { ...publicTarget(target), storage: await remoteInfo(target) };
}
async function createShare(body) { const path = resolve(String(body.path || '')); const info = await stat(path).catch(() => null); if (!info?.isDirectory()) throw Object.assign(new Error('Choose an available folder or drive'), { status: 400 }); const share = { id: randomUUID(), name: safeName(body.name) || basename(path) || 'Friend storage', path, quotaBytes: Math.max(0, Number(body.quotaBytes) || 0), usedBytes: 0, createdAt: now() }; config.shares.push(share); await persist(); return { id: share.id, name: share.name, path: share.path, quotaBytes: share.quotaBytes }; }
async function localShares() { const result = []; for (const share of config.shares) { let storage = { online: false }; try { storage = { online: true, ...(await hostedInfo(share)) }; } catch {} result.push({ id: share.id, name: share.name, path: share.path, quotaBytes: share.quotaBytes, peerName: share.peerName || '', paired: Boolean(share.peerId), storage }); } return result; }

async function storageLocations() {
  const locations = [];
  const state = await serverState();
  if (state.online && state.stats) {
    const stats = state.stats;
    locations.push({ id: 'cloud', type: 'cloud', name: 'Cloud', online: true, capacityBytes: Number(stats.capacityBytes) || 0, freeBytes: Number(stats.freeBytes) || 0, mochimonoBytes: Number(stats.bytes) || 0 });
  } else locations.push({ id: 'cloud', type: 'cloud', name: 'Cloud', online: false });

  // Sources are inputs, not managed storage. The only local managed location is
  // Mochimono's own persistent Agent directory (index, thumbnails, settings,
  // and temporary working data). A Source on D: must never make D: appear as a
  // storage location unless D: is separately configured as a real backup.
  await mkdir(CONFIG_DIR, { recursive: true }).catch(() => {});
  const cacheRoot = parse(CONFIG_DIR).root || CONFIG_DIR;
  try {
    const fs = await statfs(CONFIG_DIR);
    locations.push({
      id: 'local-cache', type: 'local', name: 'Local cache', path: CONFIG_DIR,
      root: cacheRoot, online: true,
      capacityBytes: Number(fs.blocks) * Number(fs.bsize),
      freeBytes: Number(fs.bavail) * Number(fs.bsize),
      contents: 'Index · thumbnails · local metadata'
    });
  } catch {
    locations.push({ id: 'local-cache', type: 'local', name: 'Local cache', path: CONFIG_DIR, root: cacheRoot, online: false, contents: 'Index · thumbnails · local metadata' });
  }

  for (const path of settings.backups || []) {
    const root = parse(resolve(path)).root || resolve(path), key = root.toLowerCase();
    let name = basename(path) || root;
    try { name = (await readBackup(path)).name || name; } catch {}
    try {
      const fs = await statfs(path);
      locations.push({ id: `backup:${key}`, type: 'backup', name, path, online: true, capacityBytes: Number(fs.blocks) * Number(fs.bsize), freeBytes: Number(fs.bavail) * Number(fs.bsize) });
    } catch {
      locations.push({ id: `backup:${key}`, type: 'backup', name, path, online: false });
    }
  }
  for (const target of config.backups) {
    const storage = await remoteInfo(target);
    locations.push({ id: `friend:${target.id}`, type: 'friend', name: target.name, online: storage.online, capacityBytes: Number(storage.capacityBytes) || 0, freeBytes: Number(storage.freeBytes) || 0, mochimonoBytes: Number(storage.usedBytes) || 0, encrypted: true, connection: storage.connection, error: storage.error || '' });
  }
  return locations;
}

async function handleManagement(req, res, url) {
  cors(req, res); if (!sameUiOrigin(req)) return sendJson(req, res, 403, { error: 'Friend storage management is local to this Mochimono Agent' });
  if (req.method === 'GET' && url.pathname === '/local/storage-locations') return sendJson(req, res, 200, { locations: await storageLocations() });
  if (req.method === 'GET' && url.pathname === '/local/friend-shares') return sendJson(req, res, 200, { shares: await localShares() });
  if (req.method === 'POST' && url.pathname === '/local/friend-shares') return sendJson(req, res, 201, await createShare(await readJson(req)));
  const invite = /^\/local\/friend-shares\/([^/]+)\/invite$/.exec(url.pathname); if (invite && req.method === 'POST') { const share = config.shares.find(item => item.id === invite[1]); if (!share) return sendJson(req, res, 404, { error: 'Friend share not found' }); return sendJson(req, res, 200, await network.createInvite(share)); }
  const shareDelete = /^\/local\/friend-shares\/([^/]+)$/.exec(url.pathname); if (shareDelete && req.method === 'DELETE') { config.shares = config.shares.filter(item => item.id !== shareDelete[1]); await persist(); return sendJson(req, res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/local/friend-backups') return sendJson(req, res, 200, { backups: await friendBackups() });
  if (req.method === 'POST' && url.pathname === '/local/friend-backups') return sendJson(req, res, 201, await createTarget(await readJson(req)));
  const targetDelete = /^\/local\/friend-backups\/([^/]+)$/.exec(url.pathname); if (targetDelete && req.method === 'DELETE') { const target = config.backups.find(item => item.id === targetDelete[1]); if (target) { try { const manifest = await loadManifest(target); await removeReplicas(target, manifest.objects.map(item => item.hash)); } catch {} } config.backups = config.backups.filter(item => item.id !== targetDelete[1]); await persist(); return sendJson(req, res, 200, { ok: true }); }
  const contents = /^\/local\/friend-backups\/([^/]+)\/contents$/.exec(url.pathname); if (contents && req.method === 'GET') { const target = config.backups.find(item => item.id === contents[1]); if (!target) return sendJson(req, res, 404, { error: 'Friend backup not found' }); return sendJson(req, res, 200, await friendBackupContents(target)); }
  const action = /^\/local\/friend-backups\/([^/]+)\/(update|verify|restore)$/.exec(url.pathname); if (action && req.method === 'POST') { const target = config.backups.find(item => item.id === action[1]); if (!target) return sendJson(req, res, 404, { error: 'Friend backup not found' }); const verb = action[2], work = verb === 'update' ? friendBackupUpdate : verb === 'verify' ? friendBackupVerify : friendBackupRestore; return startJob(res, verb === 'update' ? 'backup' : verb, `Friend ${verb} ${target.id}`, update => work(target, update)); }
  return false;
}

const server = http.createServer(async (req, res) => { try { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (req.method === 'OPTIONS') { cors(req, res); res.writeHead(204); return res.end(); } if (url.pathname.startsWith('/local/')) { const handled = await handleManagement(req, res, url); if (handled !== false) return; } sendJson(req, res, 404, { error: 'Not found' }); } catch (error) { if (!res.headersSent) sendJson(req, res, error.status || 500, { error: error.message || 'Friend storage error' }); else if (!res.destroyed) res.destroy(); } });
server.listen(PORT, '127.0.0.1', () => console.log(`Mochimono friend storage management: 127.0.0.1:${PORT}`));
