import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { settings } from './agent-context.js';

const INDEX_SCHEMA = 2;
const filesystemRoot = root => String(root).startsWith('browse:') ? String(root).slice('browse:'.length) : String(root);
const indexedPath = (root, relativePath) => join(filesystemRoot(root), ...String(relativePath || '').replaceAll('\\', '/').split('/').filter(Boolean));

function confirmedAbsent(root, relativePath) {
  try {
    statSync(indexedPath(root, relativePath));
    return false;
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  }
}

function removeIndexFiles(path) {
  for (const suffix of ['', '-wal', '-shm', '.meta.sqlite', '.meta.sqlite-wal', '.meta.sqlite-shm']) {
    try { rmSync(`${path}${suffix}`, { force:true }); } catch {}
  }
}

function openDatabase(path) {
  mkdirSync(dirname(path), { recursive:true });
  let db = new DatabaseSync(path, { timeout:5000 });
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0;
  if (version && version !== INDEX_SCHEMA) {
    db.close();
    removeIndexFiles(path);
    db = new DatabaseSync(path, { timeout:5000 });
  } else if (!version && existsSync(path)) {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
    if (tables.size && !tables.has('files')) {
      db.close();
      removeIndexFiles(path);
      db = new DatabaseSync(path, { timeout:5000 });
    }
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS files (
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      id TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(root, path)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS files_id ON files(id);
    CREATE INDEX IF NOT EXISTS files_content_hash ON files(content_hash) WHERE content_hash <> '';
    CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime_ms DESC, root);

    -- Read-only catalog-key projection for code that only needs a display/open
    -- key. Content-sensitive decisions use content_hash directly.
    CREATE VIEW IF NOT EXISTS file_hashes AS
      SELECT root, path, size, mtime_ms,
             COALESCE(NULLIF(content_hash, ''), id) AS hash,
             id, content_hash
      FROM files;

    CREATE TABLE IF NOT EXISTS root_meta (
      root TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL DEFAULT '',
      previewed_at TEXT NOT NULL DEFAULT ''
    ) STRICT;

    CREATE TABLE IF NOT EXISTS index_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO index_meta(singleton, revision) VALUES(1, 1);

    CREATE TRIGGER IF NOT EXISTS files_revision_insert AFTER INSERT ON files BEGIN
      UPDATE index_meta SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS files_revision_delete AFTER DELETE ON files BEGIN
      UPDATE index_meta SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS files_revision_update AFTER UPDATE OF size, mtime_ms, id, content_hash ON files
    WHEN OLD.size IS NOT NEW.size OR OLD.mtime_ms IS NOT NEW.mtime_ms OR OLD.id IS NOT NEW.id OR OLD.content_hash IS NOT NEW.content_hash BEGIN
      UPDATE index_meta SET revision = revision + 1 WHERE singleton = 1;
    END;

    PRAGMA user_version = ${INDEX_SCHEMA};
    PRAGMA optimize;
  `);
  for (const suffix of ['.meta.sqlite', '.meta.sqlite-wal', '.meta.sqlite-shm']) {
    try { rmSync(`${path}${suffix}`, { force:true }); } catch {}
  }
  return db;
}

export function syncIndexRevision(path) {
  if (!existsSync(path)) return 0;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly:true, timeout:1000 });
    return Number(db.prepare('SELECT revision FROM index_meta WHERE singleton = 1').get()?.revision) || 0;
  } catch {
    return 0;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function openSyncIndex(path) {
  const db = openDatabase(path);
  const selectColumns = "path, size, mtime_ms AS mtimeMs, id, content_hash AS contentHash, COALESCE(NULLIF(content_hash,''), id) AS hash";
  const load = db.prepare(`SELECT ${selectColumns} FROM files WHERE root = ?`);
  const get = db.prepare(`SELECT ${selectColumns} FROM files WHERE root = ? AND path = ?`);
  const pageAfter = db.prepare(`SELECT ${selectColumns} FROM files WHERE root = ? AND path > ? ORDER BY path LIMIT ?`);
  const prefixRows = db.prepare(`SELECT ${selectColumns} FROM files WHERE root = ? AND path >= ? AND path < ? ORDER BY path`);
  const prefixEntry = db.prepare('SELECT 1 AS found FROM files WHERE root = ? AND path >= ? AND path < ? LIMIT 1');
  const save = db.prepare(`
    INSERT INTO files(root, path, size, mtime_ms, id, content_hash)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(root,path) DO UPDATE SET
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      id = excluded.id,
      content_hash = excluded.content_hash
  `);
  const setContentHash = db.prepare(`
    UPDATE files SET content_hash = ?
    WHERE root = ? AND path = ? AND size = ? AND mtime_ms = ?
  `);
  const removeEntry = db.prepare('DELETE FROM files WHERE root = ? AND path = ?');
  const removePrefix = db.prepare('DELETE FROM files WHERE root = ? AND path >= ? AND path < ?');
  const removeRoot = db.prepare('DELETE FROM files WHERE root = ?');
  const stats = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files WHERE root = ?');
  const loadMeta = db.prepare('SELECT indexed_at AS indexedAt, previewed_at AS previewedAt FROM root_meta WHERE root = ?');
  const saveIndexed = db.prepare(`
    INSERT INTO root_meta(root,indexed_at,previewed_at) VALUES(?,?,'')
    ON CONFLICT(root) DO UPDATE SET indexed_at=excluded.indexed_at
  `);
  const savePreviewed = db.prepare(`
    INSERT INTO root_meta(root,indexed_at,previewed_at) VALUES(?,?,?)
    ON CONFLICT(root) DO UPDATE SET previewed_at=excluded.previewed_at
  `);
  const clearPreviewed = db.prepare("UPDATE root_meta SET previewed_at='' WHERE root = ?");
  const removeMeta = db.prepare('DELETE FROM root_meta WHERE root = ?');
  const browseStates = db.prepare(`
    SELECT path, size, mtime_ms AS mtimeMs, content_hash AS contentHash
    FROM files WHERE root = ?
  `);
  const browseState = db.prepare(`
    SELECT path, size, mtime_ms AS mtimeMs, content_hash AS contentHash
    FROM files WHERE root = ? AND path = ?
  `);
  const browseStateStats = db.prepare(`
    SELECT COUNT(*) AS tracked,
           COALESCE(SUM(CASE WHEN content_hash = '' THEN 1 ELSE 0 END),0) AS pending,
           COALESCE(SUM(CASE WHEN content_hash <> '' THEN 1 ELSE 0 END),0) AS ready
    FROM files WHERE root = ?
  `);
  const allReadyBrowseStates = db.prepare(`
    SELECT root,path,size,mtime_ms AS mtimeMs,content_hash AS contentHash
    FROM files WHERE root LIKE 'browse:%' AND content_hash <> ''
  `);

  function confirmedHashesSet(hashes) {
    const wanted = [...new Set((hashes || []).map(String).filter(Boolean))];
    const found = new Set();
    for (let offset = 0; offset < wanted.length; offset += 400) {
      const chunk = wanted.slice(offset,offset + 400);
      const placeholders = chunk.map(() => '?').join(',');
      if (!placeholders) continue;
      for (const row of db.prepare(`SELECT DISTINCT content_hash AS hash FROM files WHERE content_hash IN (${placeholders})`).all(...chunk)) found.add(String(row.hash));
    }
    return found;
  }

  function backupHashesSet(hashes) {
    const wanted = [...new Set((hashes || []).map(String).filter(Boolean))];
    const found = new Set();
    if (!wanted.length) return found;
    for (const root of settings.backups || []) {
      const inventory = join(root, '.mochimono', 'inventory.sqlite');
      if (!existsSync(inventory)) continue;
      let backup;
      try {
        backup = new DatabaseSync(inventory, { readOnly:true, timeout:1000 });
        for (let offset = 0; offset < wanted.length; offset += 400) {
          const chunk = wanted.slice(offset,offset + 400);
          const placeholders = chunk.map(() => '?').join(',');
          for (const row of backup.prepare(`SELECT hash FROM objects WHERE hash IN (${placeholders})`).all(...chunk)) found.add(String(row.hash));
        }
      } catch {
      } finally {
        try { backup?.close(); } catch {}
      }
    }
    return found;
  }

  return {
    load(root) {
      return new Map(load.all(root).map(row => [row.path,row]));
    },
    get(root,path) {
      return get.get(root,String(path || '')) || null;
    },
    loadPrefix(root,prefix) {
      const start = String(prefix || '');
      if (!start) return new Map();
      return new Map(prefixRows.all(root,start,`${start}\uffff`).map(row => [row.path,row]));
    },
    hasPrefix(root,prefix) {
      const start = String(prefix || '');
      if (!start) return false;
      return Boolean(prefixEntry.get(root,start,`${start}\uffff`)?.found);
    },
    pageAfter(root,afterPath = '',limit = 256) {
      const safeLimit = Math.max(1,Math.min(1000,Number(limit) || 256));
      return pageAfter.all(root,String(afterPath || ''),safeLimit);
    },
    save(root,path,size,mtimeMs,hash) {
      const value = String(hash || '');
      save.run(root,path,Number(size),Math.trunc(Number(mtimeMs)),value,value);
    },
    saveMany(root,rows) {
      if (!rows?.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) {
          const value = String(row.hash || row.contentHash || row.id || '');
          save.run(root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs)),value,value);
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    saveBrowse(root,path,size,mtimeMs,id,contentHash = '') {
      save.run(root,path,Number(size),Math.trunc(Number(mtimeMs)),String(id),String(contentHash || ''));
    },
    saveBrowseMany(root,rows) {
      if (!rows?.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) save.run(root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs)),String(row.id || row.hash),String(row.contentHash || ''));
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    browseHashState(root) {
      return new Map(browseStates.all(root).map(row => [row.path,row]));
    },
    browseHashEntry(root,path) {
      return browseState.get(root,String(path || '')) || null;
    },
    saveBrowseContentHashes(root,rows) {
      if (!rows?.length) return 0;
      let changed = 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) changed += Number(setContentHash.run(String(row.contentHash || ''),root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs))).changes) || 0;
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return changed;
    },
    browseHashStats(root) {
      const row = browseStateStats.get(root);
      return { tracked:Number(row?.tracked) || 0,pending:Number(row?.pending) || 0,ready:Number(row?.ready) || 0 };
    },
    readyBrowseContentHashes() {
      return allReadyBrowseStates.all();
    },
    confirmedHashes(hashes) {
      return confirmedHashesSet(hashes);
    },
    duplicateBrowseContentHashes(hashes = null) {
      const wanted = hashes ? new Set(hashes.map(String)) : null;
      const counts = new Map();
      for (const row of allReadyBrowseStates.all()) {
        const hash = String(row.contentHash || '');
        if (!hash || (wanted && !wanted.has(hash))) continue;
        counts.set(hash,(counts.get(hash) || 0) + 1);
      }
      const duplicates = new Set([...counts].filter(([,count]) => count > 1).map(([hash]) => hash));
      const candidates = wanted ? [...wanted] : [...counts.keys()];
      for (const hash of confirmedHashesSet(candidates)) duplicates.add(hash);
      for (const hash of backupHashesSet(candidates)) duplicates.add(hash);
      return duplicates;
    },
    // Protection promotion now only needs to ensure every browse row has a real
    // content hash. The stable local id remains separate and never changes meaning.
    promoteAllBrowseHashes(root) {
      const row = browseStateStats.get(root);
      const pending = Number(row?.pending) || 0;
      if (pending) throw new Error(`${pending} files still need content hashes`);
      return 0;
    },
    markIndexed(root,value = new Date().toISOString()) {
      saveIndexed.run(root,String(value));
    },
    lastIndexed(root) {
      return loadMeta.get(root)?.indexedAt || null;
    },
    markPreviewed(root,value) {
      const meta = loadMeta.get(root);
      const indexedAt = String(meta?.indexedAt || '');
      const previewedAt = String(value || indexedAt);
      if (!indexedAt || !previewedAt) return false;
      savePreviewed.run(root,indexedAt,previewedAt);
      return true;
    },
    lastPreviewed(root) {
      return loadMeta.get(root)?.previewedAt || null;
    },
    clearPreviewed(root) {
      clearPreviewed.run(root);
    },
    forget(root,path) {
      if (!confirmedAbsent(root,path)) return 0;
      return Number(removeEntry.run(root,path).changes) || 0;
    },
    forgetPrefix(root,prefix) {
      const start = String(prefix || '');
      if (!start) return 0;
      const directory = start.replace(/[\\/]+$/, '');
      if (!directory || !confirmedAbsent(root,directory)) return 0;
      return Number(removePrefix.run(root,start,`${start}\uffff`).changes) || 0;
    },
    prune(root,currentPaths) {
      const keep = currentPaths instanceof Set ? currentPaths : new Set(currentPaths);
      const stale = load.all(root).filter(row => !keep.has(row.path) && confirmedAbsent(root,row.path));
      if (!stale.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of stale) removeEntry.run(root,row.path);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return stale.length;
    },
    moveRoot(from,to) {
      if (from === to) return 0;
      const rows = load.all(from);
      const meta = loadMeta.get(from);
      if (!rows.length && !meta) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) save.run(to,row.path,row.size,row.mtimeMs,row.id,row.contentHash || '');
        removeRoot.run(from);
        if (meta) {
          saveIndexed.run(to,meta.indexedAt || '');
          if (meta.previewedAt) savePreviewed.run(to,meta.indexedAt || '',meta.previewedAt);
          removeMeta.run(from);
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    forgetRoot(root) {
      removeRoot.run(root);
      removeMeta.run(root);
    },
    stats(root) {
      const row = stats.get(root);
      return { files:Number(row?.files) || 0,bytes:Number(row?.bytes) || 0 };
    },
    revision() {
      return Number(db.prepare('SELECT revision FROM index_meta WHERE singleton = 1').get()?.revision) || 0;
    },
    close() {
      db.close();
    }
  };
}
