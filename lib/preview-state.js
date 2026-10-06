import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './agent-context.js';

mkdirSync(CONFIG_DIR, { recursive:true });
const db = new DatabaseSync(join(CONFIG_DIR, 'previews.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  CREATE TABLE IF NOT EXISTS previews (
    hash TEXT PRIMARY KEY, storage_hash TEXT NOT NULL DEFAULT '', width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, duration REAL,
    retry_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE TABLE IF NOT EXISTS thumbnail_attempts (
    hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS scans (
    root TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, after_path TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS uploads (
    hash TEXT PRIMARY KEY, mime TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
  INSERT OR IGNORE INTO meta VALUES(1,1);
  CREATE TRIGGER IF NOT EXISTS preview_insert AFTER INSERT ON previews WHEN NEW.size>0 BEGIN
    UPDATE meta SET revision=revision+1;
  END;
  CREATE TRIGGER IF NOT EXISTS preview_delete AFTER DELETE ON previews WHEN OLD.size>0 BEGIN
    UPDATE meta SET revision=revision+1;
  END;
  CREATE TRIGGER IF NOT EXISTS preview_update AFTER UPDATE ON previews
    WHEN OLD.width IS NOT NEW.width OR OLD.height IS NOT NEW.height OR OLD.size IS NOT NEW.size BEGIN
    UPDATE meta SET revision=revision+1;
  END;
`);
const get = db.prepare('SELECT * FROM previews WHERE hash=?');
const revision = db.prepare('SELECT revision FROM meta WHERE id=1');
const ready = db.prepare(`INSERT INTO previews(hash,storage_hash,width,height,size,duration) VALUES(?,?,?,?,?,?)
  ON CONFLICT(hash) DO UPDATE SET storage_hash=excluded.storage_hash,width=excluded.width,height=excluded.height,size=excluded.size,duration=excluded.duration,retry_at=0,error=''
  WHERE previews.storage_hash<>excluded.storage_hash OR previews.width<>excluded.width OR previews.height<>excluded.height OR previews.size<>excluded.size OR previews.duration IS NOT excluded.duration OR previews.retry_at<>0`);
const failed = db.prepare(`INSERT INTO previews(hash,retry_at,error) VALUES(?,?,?)
  ON CONFLICT(hash) DO UPDATE SET width=0,height=0,size=0,retry_at=excluded.retry_at,error=excluded.error`);
const forget = db.prepare('DELETE FROM previews WHERE hash=?');
const attempts = db.prepare('SELECT attempts FROM thumbnail_attempts WHERE hash=?');
const saveAttempts = db.prepare('INSERT INTO thumbnail_attempts VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET attempts=excluded.attempts');
const clearAttempts = db.prepare('DELETE FROM thumbnail_attempts WHERE hash=?');
const queueUpload = db.prepare('INSERT INTO uploads(hash,mime) VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET mime=excluded.mime');
const finishUpload = db.prepare('DELETE FROM uploads WHERE hash=?');
const deferUpload = db.prepare('UPDATE uploads SET retry_at=?,error=? WHERE hash=?');
const uploadRows = db.prepare('SELECT hash,mime FROM uploads WHERE retry_at<=? ORDER BY hash LIMIT ?');
const uploadStats = db.prepare("SELECT COUNT(*) AS pending,COALESCE(MAX(error),'') AS error FROM uploads");
const scan = db.prepare('SELECT indexed_at AS indexedAt,after_path AS afterPath FROM scans WHERE root=?');
const saveScan = db.prepare(`INSERT INTO scans VALUES(?,?,?) ON CONFLICT(root) DO UPDATE SET indexed_at=excluded.indexed_at,after_path=excluded.after_path`);

export const previewState = {
  get:hash => get.get(hash),
  queueUpload:(hash,mime) => queueUpload.run(hash,mime),
  finishUpload:hash => finishUpload.run(hash),
  deferUpload:(hash,until,error) => deferUpload.run(until,String(error || ''),hash),
  uploads:limit => uploadRows.all(Date.now(),limit),
  uploadStats:() => uploadStats.get(),
  revision:() => revision.get().revision,
  attempts:hash => Number(attempts.get(hash)?.attempts) || 0,
  ready(thumb) {
    ready.run(thumb.hash, thumb.storageHash || thumb.hash, thumb.width, thumb.height, thumb.size, thumb.duration ?? null);
    clearAttempts.run(thumb.hash);
  },
  failed(hash, retryAt, error, count) {
    saveAttempts.run(hash, count);
    failed.run(hash, Number.isFinite(retryAt) ? retryAt : -1, String(error || ''));
  },
  forget(hash) {
    forget.run(hash);
    clearAttempts.run(hash);
  },
  scan:root => scan.get(root),
  saveScan:(root,indexedAt,afterPath) => saveScan.run(root,indexedAt,afterPath)
};
