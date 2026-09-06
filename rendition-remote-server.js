import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, db, json } from './lib/server-context.js';
import { objectPath, readObject } from './lib/store.js';

const RENDITION_ROOT = join(DATA_DIR, 'renditions');
const parse = value => {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
};

function publicRendition(row) {
  if (!row) return null;
  return {
    originalHash:row.original_hash,
    hash:row.rendition_hash,
    mediaType:row.media_type,
    presetId:row.preset_id || '',
    presetName:row.preset_name,
    options:parse(row.options_json),
    mime:row.mime,
    size:Number(row.size) || 0,
    sourceSize:Number(row.source_size) || 0,
    width:Number(row.width) || 0,
    height:Number(row.height) || 0,
    duration:row.duration == null ? null : Number(row.duration),
    createdAt:row.created_at,
    updatedAt:row.updated_at,
    remote:true
  };
}

async function serve(req, res, row) {
  const path = objectPath(RENDITION_ROOT, row.rendition_hash);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || Number(info.size) !== Number(row.size)) return json(res, 404, { error:'Compact rendition is unavailable' });
  const headers = { 'content-type':row.mime, 'accept-ranges':'bytes', 'cache-control':'private, max-age=3600' };
  const range = String(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { ...headers, 'content-length':info.size });
    if (req.method === 'HEAD') return res.end();
    return readObject(RENDITION_ROOT, row.rendition_hash).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'content-range':`bytes */${info.size}` }); return res.end(); }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : info.size - 1;
  if (!match[1] && match[2]) { start = Math.max(0, info.size - Number(match[2])); end = info.size - 1; }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= info.size) { res.writeHead(416, { 'content-range':`bytes */${info.size}` }); return res.end(); }
  end = Math.min(end, info.size - 1);
  res.writeHead(206, { ...headers, 'content-range':`bytes ${start}-${end}/${info.size}`, 'content-length':end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  return readObject(RENDITION_ROOT, row.rendition_hash, { start, end }).pipe(res);
}

export async function handleRemoteRenditionServer(req, res, url) {
  const metadata = /^\/api\/representations\/([a-f0-9]{64})\/rendition$/.exec(url.pathname);
  if (metadata && req.method === 'GET') {
    const row = db.prepare('SELECT * FROM renditions WHERE original_hash=?').get(metadata[1]);
    return json(res, 200, { rendition:publicRendition(row) });
  }

  const compact = /^\/api\/representations\/([a-f0-9]{64})\/compact$/.exec(url.pathname);
  if (compact && (req.method === 'GET' || req.method === 'HEAD')) {
    const row = db.prepare('SELECT * FROM renditions WHERE original_hash=?').get(compact[1]);
    if (!row) return json(res, 404, { error:'Compact rendition not found' });
    return serve(req, res, row);
  }

  return false;
}
