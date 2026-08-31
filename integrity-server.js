import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { DATA_DIR, db, json, now } from './lib/server-context.js';
import { objectPath, validHash, writeVerifiedObject } from './lib/store.js';

const AUTO_SCRUB_DAYS = Math.max(0, Number(process.env.MOCHIMONO_SCRUB_DAYS ?? 30) || 0);
const AUTO_SCRUB_MS = AUTO_SCRUB_DAYS * 24 * 60 * 60 * 1000;
const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;
let run = null;

function meta(key, fallback = '') {
  return db.prepare('SELECT value FROM integrity_meta WHERE key = ?').get(key)?.value ?? fallback;
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO integrity_meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ''));
}

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function mark(hash, status, error = '') {
  const timestamp = now();
  db.prepare(`
    INSERT INTO object_integrity(hash, status, checked_at, verified_at, error)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      status = excluded.status,
      checked_at = excluded.checked_at,
      verified_at = excluded.verified_at,
      error = excluded.error
  `).run(hash, status, timestamp, status === 'healthy' ? timestamp : null, error || null);
}

async function checkObject(row) {
  const path = objectPath(DATA_DIR, row.hash);
  let info;
  try { info = await stat(path); }
  catch { return { status: 'missing', error: 'Object file is missing' }; }
  if (!info.isFile()) return { status: 'missing', error: 'Object path is not a file' };
  if (Number(info.size) !== Number(row.size)) return { status: 'corrupt', error: `Size mismatch: expected ${row.size}, got ${info.size}` };
  const actual = await hashFile(path);
  if (actual !== row.hash) return { status: 'corrupt', error: `SHA-256 mismatch: got ${actual}` };
  return { status: 'healthy', error: '' };
}

function catalogCheck() {
  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    const messages = rows.map(row => String(Object.values(row)[0] ?? '')).filter(Boolean);
    return { healthy: messages.length === 1 && messages[0] === 'ok', messages };
  } catch (error) {
    return { healthy: false, messages: [error.message] };
  }
}

async function scrub() {
  if (run?.running) return;
  const rows = db.prepare("SELECT hash, size FROM objects WHERE state = 'active' ORDER BY hash").all();
  const startedAt = now();
  run = { running: true, startedAt, checked: 0, total: rows.length, healthy: 0, bad: 0, current: '', error: '' };
  setMeta('last_scrub_started_at', startedAt);
  db.prepare("DELETE FROM object_integrity WHERE hash NOT IN (SELECT hash FROM objects WHERE state = 'active')").run();

  try {
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      run.current = row.hash;
      const result = await checkObject(row);
      mark(row.hash, result.status, result.error);
      run.checked = index + 1;
      if (result.status === 'healthy') run.healthy++;
      else run.bad++;
      await new Promise(resolve => setImmediate(resolve));
    }

    const catalog = catalogCheck();
    const finishedAt = now();
    setMeta('last_scrub_at', finishedAt);
    setMeta('last_scrub_error', '');
    setMeta('catalog_integrity', catalog.healthy ? 'healthy' : 'corrupt');
    setMeta('catalog_checked_at', finishedAt);
    setMeta('catalog_error', catalog.healthy ? '' : catalog.messages.join('\n').slice(0, 4000));
    run = { ...run, running: false, finishedAt, current: '', catalog };
  } catch (error) {
    const finishedAt = now();
    run = { ...run, running: false, finishedAt, current: '', error: error.message || String(error) };
    setMeta('last_scrub_error', run.error);
  }
}

function counts() {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM object_integrity oi
    JOIN objects o ON o.hash = oi.hash
    WHERE o.state = 'active'
    GROUP BY status
  `).all();
  const result = { healthy: 0, corrupt: 0, missing: 0 };
  for (const row of rows) result[row.status] = Number(row.count) || 0;
  return result;
}

function status() {
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM objects WHERE state = 'active'").get().count) || 0;
  const checked = counts();
  const bad = checked.corrupt + checked.missing;
  return {
    running: Boolean(run?.running),
    progress: run?.running ? run : null,
    lastRun: run && !run.running ? run : null,
    lastScrubAt: meta('last_scrub_at') || null,
    lastScrubStartedAt: meta('last_scrub_started_at') || null,
    lastScrubError: meta('last_scrub_error') || null,
    automaticEveryDays: AUTO_SCRUB_DAYS || null,
    catalog: {
      status: meta('catalog_integrity', 'unknown'),
      checkedAt: meta('catalog_checked_at') || null,
      error: meta('catalog_error') || null
    },
    total,
    checked: checked.healthy + bad,
    healthy: checked.healthy,
    corrupt: checked.corrupt,
    missing: checked.missing,
    bad
  };
}

function maybeAutoScrub() {
  if (!AUTO_SCRUB_MS || run?.running) return;
  const previous = meta('last_scrub_at');
  const time = previous ? new Date(previous).getTime() : 0;
  if (!time || Date.now() - time >= AUTO_SCRUB_MS) scrub().catch(error => console.error('Automatic integrity scrub failed', error));
}

if (AUTO_SCRUB_MS) {
  const timer = setTimeout(() => {
    maybeAutoScrub();
    setInterval(maybeAutoScrub, AUTO_CHECK_MS).unref?.();
  }, AUTO_CHECK_MS);
  timer.unref?.();
}

export function integrityStatus() {
  return status();
}

export async function handleIntegrity(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/integrity') {
    json(res, 200, status());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/integrity/scrub') {
    if (run?.running) json(res, 409, { error: 'Integrity scrub is already running' });
    else {
      setImmediate(() => scrub().catch(error => console.error('Integrity scrub failed', error)));
      json(res, 202, { ok: true });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/integrity/bad') {
    const after = String(url.searchParams.get('after') || '');
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || 1000)));
    const rows = db.prepare(`
      SELECT oi.hash, oi.status, oi.checked_at AS checkedAt, oi.error, o.size
      FROM object_integrity oi JOIN objects o ON o.hash = oi.hash
      WHERE o.state = 'active' AND oi.status != 'healthy' AND oi.hash > ?
      ORDER BY oi.hash LIMIT ?
    `).all(after, limit);
    json(res, 200, { objects: rows, nextAfter: rows.length === limit ? rows.at(-1).hash : null });
    return true;
  }

  const repair = /^\/api\/integrity\/repair\/([a-f0-9]{64})$/.exec(url.pathname);
  if (repair && req.method === 'PUT') {
    const hash = repair[1];
    if (!validHash(hash)) return true;
    const row = db.prepare("SELECT size FROM objects WHERE hash = ? AND state = 'active'").get(hash);
    if (!row) { json(res, 404, { error: 'Object not found' }); return true; }
    const integrity = db.prepare('SELECT status FROM object_integrity WHERE hash = ?').get(hash);
    if (!integrity || integrity.status === 'healthy') {
      json(res, 409, { error: 'Object is not marked damaged' });
      return true;
    }
    try {
      const stored = await writeVerifiedObject({ root: DATA_DIR, hash, input: req, replace: true });
      if (Number(stored.size) !== Number(row.size)) throw new Error(`Size mismatch: expected ${row.size}, got ${stored.size}`);
      mark(hash, 'healthy');
      json(res, 200, { ok: true, hash, size: stored.size, repairedAt: now() });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return true;
  }

  return false;
}
