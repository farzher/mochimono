import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { api, CONFIG_DIR, settings } from './agent-context.js';
import { localLocations } from './local-locations.js';

const DB_PATH = join(CONFIG_DIR, 'work.sqlite');
const db = new DatabaseSync(DB_PATH, { timeout:5000 });
const RENDITION_RETRY_MS = 60_000;
const deferredRenditions = new Map();
let running = false;
let timer = null;
let presenceAt = 0;

db.exec(`
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS compression_server_sync (
    original_hash TEXT PRIMARY KEY,
    rendition_hash TEXT NOT NULL,
    synced_at TEXT NOT NULL
  ) STRICT;
`);

const parse = value => {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
};
const stamp = value => {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};
const originalMissing = error => /Original object not found/i.test(String(error?.message || error || ''));

async function serverSnapshot() {
  return api('/api/compression/snapshot');
}

async function syncPresets(remote = []) {
  const locals = db.prepare('SELECT * FROM compression_presets').all();
  const localByName = new Map(locals.map(row => [`${row.media_type}\0${String(row.name).toLowerCase()}`, row]));
  const remoteByName = new Map(remote.map(item => [`${item.mediaType}\0${String(item.name).toLowerCase()}`, item]));

  for (const row of locals) {
    const key = `${row.media_type}\0${String(row.name).toLowerCase()}`;
    const other = remoteByName.get(key);
    if (other && stamp(other.updatedAt) >= stamp(row.updated_at)) continue;
    await api('/api/compression/presets', {
      method:'POST',
      body:{
        id:row.id,
        name:row.name,
        mediaType:row.media_type,
        options:parse(row.options_json),
        isDefault:Boolean(row.is_default),
        createdAt:row.created_at,
        updatedAt:row.updated_at
      }
    });
  }

  const upsert = db.prepare(`INSERT INTO compression_presets(id,name,media_type,options_json,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(media_type,name) DO UPDATE SET options_json=excluded.options_json,is_default=excluded.is_default,updated_at=excluded.updated_at`);
  for (const item of remote) {
    const key = `${item.mediaType}\0${String(item.name).toLowerCase()}`;
    const local = localByName.get(key);
    if (local && stamp(local.updated_at) > stamp(item.updatedAt)) continue;
    if (item.isDefault) db.prepare('UPDATE compression_presets SET is_default=0 WHERE media_type=?').run(item.mediaType);
    upsert.run(item.id, item.name, item.mediaType, JSON.stringify(item.options || {}), item.isDefault ? 1 : 0, item.createdAt || item.updatedAt || new Date().toISOString(), item.updatedAt || new Date().toISOString());
  }
}

async function syncPolicies(remote = []) {
  const locals = db.prepare('SELECT * FROM representation_policies').all();
  const localByKey = new Map(locals.map(row => [`${row.location_id}\0${row.media_type}`, row]));
  const remoteByKey = new Map(remote.map(item => [`${item.locationId}\0${item.mediaType}`, item]));

  for (const row of locals) {
    const other = remoteByKey.get(`${row.location_id}\0${row.media_type}`);
    if (other && stamp(other.updatedAt) >= stamp(row.updated_at)) continue;
    await api('/api/compression/policies', {
      method:'POST',
      body:{ locationId:row.location_id, mediaType:row.media_type, representation:row.representation }
    });
  }

  const upsert = db.prepare(`INSERT INTO representation_policies(location_id,media_type,representation,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(location_id,media_type) DO UPDATE SET representation=excluded.representation,updated_at=excluded.updated_at`);
  for (const item of remote) {
    const local = localByKey.get(`${item.locationId}\0${item.mediaType}`);
    if (local && stamp(local.updated_at) > stamp(item.updatedAt)) continue;
    upsert.run(item.locationId, item.mediaType, item.representation, item.updatedAt || new Date().toISOString());
  }
}

async function syncRenditions() {
  const rows = db.prepare('SELECT * FROM renditions ORDER BY created_at').all();
  const synced = db.prepare('SELECT rendition_hash FROM compression_server_sync WHERE original_hash=?');
  const mark = db.prepare(`INSERT INTO compression_server_sync(original_hash,rendition_hash,synced_at) VALUES(?,?,?)
    ON CONFLICT(original_hash) DO UPDATE SET rendition_hash=excluded.rendition_hash,synced_at=excluded.synced_at`);

  for (const row of rows) {
    if (synced.get(row.original_hash)?.rendition_hash === row.rendition_hash) {
      deferredRenditions.delete(row.original_hash);
      continue;
    }
    const deferred = deferredRenditions.get(row.original_hash);
    if (deferred?.renditionHash === row.rendition_hash && deferred.retryAt > Date.now()) continue;

    const info = await stat(row.path).catch(() => null);
    if (!info?.isFile() || Number(info.size) !== Number(row.size)) continue;

    try {
      await api(`/api/renditions/${row.original_hash}/upload/${row.rendition_hash}`, {
        method:'PUT',
        headers:{ 'content-length':String(info.size), 'content-type':'application/octet-stream' },
        body:createReadStream(row.path)
      });
      await api(`/api/renditions/${row.original_hash}`, {
        method:'POST',
        body:{
          hash:row.rendition_hash,
          mediaType:row.media_type,
          presetId:row.preset_id || '',
          presetName:row.preset_name || '',
          options:parse(row.options_json),
          mime:row.mime,
          size:Number(row.size),
          sourceSize:Number(row.source_size),
          width:Number(row.width) || 0,
          height:Number(row.height) || 0,
          duration:row.duration == null ? null : Number(row.duration)
        }
      });
      mark.run(row.original_hash, row.rendition_hash, new Date().toISOString());
      deferredRenditions.delete(row.original_hash);
    } catch (error) {
      // Local-only files can have a valid Squished rendition even when their
      // Original is not stored in the server catalog. That is an expected
      // state, not a sync failure. Retry occasionally in case the Original is
      // later uploaded, while allowing every other rendition to keep syncing.
      if (originalMissing(error)) {
        deferredRenditions.set(row.original_hash, {
          renditionHash:row.rendition_hash,
          retryAt:Date.now() + RENDITION_RETRY_MS
        });
        continue;
      }
      throw error;
    }
  }
}

async function reportPresence() {
  const data = localLocations();
  const byLocation = new Map((data.locations || []).map(location => [location.id, []]));
  for (const [hash, locationId] of data.files || []) {
    if (!byLocation.has(locationId)) byLocation.set(locationId, []);
    byLocation.get(locationId).push(hash);
  }
  for (const [locationId, values] of byLocation) {
    const hashes = [...new Set(values)];
    for (let offset = 0; offset < Math.max(1, hashes.length); offset += 10000) {
      const chunk = hashes.slice(offset, offset + 10000);
      await api('/api/representations/report', {
        method:'POST',
        body:{ locationId, representation:'original', hashes:chunk, complete:offset === 0 }
      });
      if (!hashes.length) break;
    }
  }
}

async function syncOnce(forcePresence = false) {
  if (running || !settings.token) return;
  running = true;
  try {
    const snapshot = await serverSnapshot();
    await syncPresets(snapshot.presets || []);
    await syncPolicies(snapshot.policies || []);
    await syncRenditions();
    if (forcePresence || Date.now() - presenceAt > 60_000) {
      await reportPresence();
      presenceAt = Date.now();
    }
  } catch (error) {
    if (!/not connected|offline|fetch failed|ECONNREFUSED/i.test(String(error?.message || ''))) console.warn('Squish metadata sync failed', error.message || error);
  } finally {
    running = false;
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await syncOnce();
    schedule();
  }, 3000);
  timer.unref?.();
}

export function startCompressionServerSync() {
  syncOnce(true).finally(schedule);
}

export function syncCompressionServerNow() {
  return syncOnce(true);
}
