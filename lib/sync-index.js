import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

export function openSyncIndex(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    -- The client historically used this database and its -wal file timestamps as
    -- the local catalog revision. DELETE journaling keeps that signal stable
    -- across process restarts when file_hashes itself did not change.
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS file_hashes (
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY(root, path)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS file_hashes_hash ON file_hashes(hash);
    CREATE INDEX IF NOT EXISTS file_hashes_mtime ON file_hashes(mtime_ms DESC, root);
    CREATE INDEX IF NOT EXISTS file_hashes_size ON file_hashes(size);
    -- Retain the old tables only as a one-time migration source. New scan and
    -- thumbnail bookkeeping lives in the metadata database below so changing it
    -- cannot invalidate the file-catalog version.
    CREATE TABLE IF NOT EXISTS root_meta (
      root TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS preview_meta (
      root TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL
    ) STRICT;
  `);

  const meta = new DatabaseSync(`${path}.meta.sqlite`, { timeout: 5000 });
  meta.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS root_meta (
      root TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS preview_meta (
      root TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL
    ) STRICT;
    -- Browse folders are visible before their contents are SHA-256 hashed. A row
    -- here means file_hashes.hash is a stable local identity rather than a
    -- confirmed content hash. Background hashing updates only this metadata DB,
    -- so the visible catalog does not churn while hashes are being learned.
    CREATE TABLE IF NOT EXISTS browse_hash_state (
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(root, path)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS browse_hash_state_content ON browse_hash_state(content_hash);
  `);

  const metaRows = Number(meta.prepare('SELECT COUNT(*) AS count FROM root_meta').get()?.count) || 0;
  const metaPreviews = Number(meta.prepare('SELECT COUNT(*) AS count FROM preview_meta').get()?.count) || 0;
  if (!metaRows && !metaPreviews) {
    // Preserve existing installations once, then stop touching the legacy
    // metadata tables in the catalog database.
    const saveRootMigration = meta.prepare('INSERT OR REPLACE INTO root_meta(root,indexed_at) VALUES(?,?)');
    const savePreviewMigration = meta.prepare('INSERT OR REPLACE INTO preview_meta(root,indexed_at) VALUES(?,?)');
    try {
      meta.exec('BEGIN IMMEDIATE');
      for (const row of db.prepare('SELECT root, indexed_at AS indexedAt FROM root_meta').all()) saveRootMigration.run(row.root,row.indexedAt);
      for (const row of db.prepare('SELECT root, indexed_at AS indexedAt FROM preview_meta').all()) savePreviewMigration.run(row.root,row.indexedAt);
      meta.exec('COMMIT');
    } catch (error) {
      try { meta.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  const load = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE root = ?');
  const get = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE root = ? AND path = ?');
  const pageAfter = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE root = ? AND path > ? ORDER BY path LIMIT ?');
  const prefixRows = db.prepare('SELECT path, size, mtime_ms AS mtimeMs, hash FROM file_hashes WHERE root = ? AND path >= ? AND path < ? ORDER BY path');
  const prefixEntry = db.prepare('SELECT 1 AS found FROM file_hashes WHERE root = ? AND path >= ? AND path < ? LIMIT 1');
  const save = db.prepare(`
    INSERT INTO file_hashes(root, path, size, mtime_ms, hash)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(root,path) DO UPDATE SET
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      hash = excluded.hash
  `);
  const promote = db.prepare(`
    UPDATE file_hashes SET hash = ?
    WHERE root = ? AND path = ? AND size = ? AND mtime_ms = ?
  `);
  const removeEntry = db.prepare('DELETE FROM file_hashes WHERE root = ? AND path = ?');
  const removePrefix = db.prepare('DELETE FROM file_hashes WHERE root = ? AND path >= ? AND path < ?');
  const removeRoot = db.prepare('DELETE FROM file_hashes WHERE root = ?');
  const stats = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM file_hashes WHERE root = ?');

  const loadMeta = meta.prepare('SELECT indexed_at AS indexedAt FROM root_meta WHERE root = ?');
  const saveMeta = meta.prepare(`
    INSERT INTO root_meta(root,indexed_at)
    VALUES(?,?)
    ON CONFLICT(root) DO UPDATE SET indexed_at = excluded.indexed_at
  `);
  const removeMeta = meta.prepare('DELETE FROM root_meta WHERE root = ?');
  const loadPreviewMeta = meta.prepare('SELECT indexed_at AS indexedAt FROM preview_meta WHERE root = ?');
  const savePreviewMeta = meta.prepare(`
    INSERT INTO preview_meta(root,indexed_at)
    VALUES(?,?)
    ON CONFLICT(root) DO UPDATE SET indexed_at = excluded.indexed_at
  `);
  const removePreviewMeta = meta.prepare('DELETE FROM preview_meta WHERE root = ?');

  const loadBrowseState = meta.prepare('SELECT path, size, mtime_ms AS mtimeMs, content_hash AS contentHash FROM browse_hash_state WHERE root = ?');
  const getBrowseState = meta.prepare('SELECT path, size, mtime_ms AS mtimeMs, content_hash AS contentHash FROM browse_hash_state WHERE root = ? AND path = ?');
  const saveBrowseState = meta.prepare(`
    INSERT INTO browse_hash_state(root,path,size,mtime_ms,content_hash)
    VALUES(?,?,?,?,?)
    ON CONFLICT(root,path) DO UPDATE SET
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      content_hash = excluded.content_hash
  `);
  const setBrowseContentHash = meta.prepare(`
    UPDATE browse_hash_state SET content_hash = ?
    WHERE root = ? AND path = ? AND size = ? AND mtime_ms = ?
  `);
  const removeBrowseState = meta.prepare('DELETE FROM browse_hash_state WHERE root = ? AND path = ?');
  const removeBrowseStatePrefix = meta.prepare('DELETE FROM browse_hash_state WHERE root = ? AND path >= ? AND path < ?');
  const removeBrowseStateRoot = meta.prepare('DELETE FROM browse_hash_state WHERE root = ?');
  const browseStateStats = meta.prepare(`
    SELECT COUNT(*) AS tracked,
           COALESCE(SUM(CASE WHEN content_hash = '' THEN 1 ELSE 0 END),0) AS pending,
           COALESCE(SUM(CASE WHEN content_hash <> '' THEN 1 ELSE 0 END),0) AS ready
    FROM browse_hash_state WHERE root = ?
  `);
  const allReadyBrowseStates = meta.prepare(`
    SELECT root,path,size,mtime_ms AS mtimeMs,content_hash AS contentHash
    FROM browse_hash_state WHERE content_hash <> ''
  `);

  function deleteBrowseRows(root, rows) {
    if (!rows?.length) return;
    try {
      meta.exec('BEGIN IMMEDIATE');
      for (const row of rows) removeBrowseState.run(root,row.path);
      meta.exec('COMMIT');
    } catch (error) {
      try { meta.exec('ROLLBACK'); } catch {}
      throw error;
    }
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
      save.run(root,path,Number(size),Math.trunc(Number(mtimeMs)),hash);
    },
    saveMany(root,rows) {
      if (!rows?.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) save.run(root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs)),row.hash);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    // State is committed before the visible row. A crash can therefore leave a
    // harmless orphan state row, but never a provisional local identity that is
    // accidentally mistaken for a confirmed SHA-256 hash.
    saveBrowse(root,path,size,mtimeMs,hash,contentHash = '') {
      saveBrowseState.run(root,path,Number(size),Math.trunc(Number(mtimeMs)),String(contentHash || ''));
      save.run(root,path,Number(size),Math.trunc(Number(mtimeMs)),hash);
    },
    saveBrowseMany(root,rows) {
      if (!rows?.length) return 0;
      try {
        meta.exec('BEGIN IMMEDIATE');
        for (const row of rows) saveBrowseState.run(root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs)),String(row.contentHash || ''));
        meta.exec('COMMIT');
      } catch (error) {
        try { meta.exec('ROLLBACK'); } catch {}
        throw error;
      }
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) save.run(root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs)),row.hash);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    browseHashState(root) {
      return new Map(loadBrowseState.all(root).map(row => [row.path,row]));
    },
    browseHashEntry(root,path) {
      return getBrowseState.get(root,String(path || '')) || null;
    },
    saveBrowseContentHashes(root,rows) {
      if (!rows?.length) return 0;
      let changed = 0;
      try {
        meta.exec('BEGIN IMMEDIATE');
        for (const row of rows) changed += Number(setBrowseContentHash.run(String(row.contentHash || ''),root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs))).changes) || 0;
        meta.exec('COMMIT');
      } catch (error) {
        try { meta.exec('ROLLBACK'); } catch {}
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
      const wanted = [...new Set((hashes || []).map(String).filter(Boolean))];
      const found = new Set();
      for (let offset = 0; offset < wanted.length; offset += 400) {
        const chunk = wanted.slice(offset,offset + 400);
        const placeholders = chunk.map(() => '?').join(',');
        if (!placeholders) continue;
        for (const row of db.prepare(`SELECT DISTINCT hash FROM file_hashes WHERE hash IN (${placeholders})`).all(...chunk)) found.add(String(row.hash));
      }
      return found;
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
      for (const hash of this.confirmedHashes(candidates)) duplicates.add(hash);
      return duplicates;
    },
    promoteBrowseContentHashes(hashes) {
      const wanted = new Set((hashes || []).map(String).filter(Boolean));
      if (!wanted.size) return 0;
      const rows = allReadyBrowseStates.all().filter(row => wanted.has(String(row.contentHash || '')));
      if (!rows.length) return 0;
      let changed = 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) changed += Number(promote.run(row.contentHash,row.root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs))).changes) || 0;
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      try {
        meta.exec('BEGIN IMMEDIATE');
        for (const row of rows) removeBrowseState.run(row.root,row.path);
        meta.exec('COMMIT');
      } catch (error) {
        try { meta.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return changed;
    },
    promoteAllBrowseHashes(root) {
      const rows = loadBrowseState.all(root);
      const pending = rows.filter(row => !row.contentHash);
      if (pending.length) throw new Error(`${pending.length} files still need content hashes`);
      if (!rows.length) return 0;
      let changed = 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) changed += Number(promote.run(row.contentHash,root,row.path,Number(row.size),Math.trunc(Number(row.mtimeMs))).changes) || 0;
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      removeBrowseStateRoot.run(root);
      return changed;
    },
    markIndexed(root,value = new Date().toISOString()) {
      saveMeta.run(root,String(value));
    },
    lastIndexed(root) {
      return loadMeta.get(root)?.indexedAt || null;
    },
    markPreviewed(root,value) {
      const indexedAt = String(value || loadMeta.get(root)?.indexedAt || '');
      if (!indexedAt) return false;
      savePreviewMeta.run(root,indexedAt);
      return true;
    },
    lastPreviewed(root) {
      return loadPreviewMeta.get(root)?.indexedAt || null;
    },
    clearPreviewed(root) {
      removePreviewMeta.run(root);
    },
    forget(root,path) {
      if (!confirmedAbsent(root,path)) return 0;
      const changes = Number(removeEntry.run(root,path).changes) || 0;
      if (changes) removeBrowseState.run(root,path);
      return changes;
    },
    forgetPrefix(root,prefix) {
      const start = String(prefix || '');
      if (!start) return 0;
      const directory = start.replace(/[\\/]+$/, '');
      if (!directory || !confirmedAbsent(root,directory)) return 0;
      const changes = Number(removePrefix.run(root,start,`${start}\uffff`).changes) || 0;
      if (changes) removeBrowseStatePrefix.run(root,start,`${start}\uffff`);
      return changes;
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
      deleteBrowseRows(root,stale);
      return stale.length;
    },
    moveRoot(from,to) {
      if (from === to) return 0;
      const rows = load.all(from);
      const rootMeta = loadMeta.get(from);
      const previewMeta = loadPreviewMeta.get(from);
      const hashState = loadBrowseState.all(from);
      if (!rows.length && !rootMeta && !previewMeta && !hashState.length) return 0;
      try {
        db.exec('BEGIN IMMEDIATE');
        for (const row of rows) save.run(to,row.path,row.size,row.mtimeMs,row.hash);
        removeRoot.run(from);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      try {
        meta.exec('BEGIN IMMEDIATE');
        if (rootMeta?.indexedAt) saveMeta.run(to,rootMeta.indexedAt);
        if (previewMeta?.indexedAt) savePreviewMeta.run(to,previewMeta.indexedAt);
        for (const row of hashState) saveBrowseState.run(to,row.path,row.size,row.mtimeMs,row.contentHash);
        removeBrowseStateRoot.run(from);
        removeMeta.run(from);
        removePreviewMeta.run(from);
        meta.exec('COMMIT');
      } catch (error) {
        try { meta.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return rows.length;
    },
    forgetRoot(root) {
      removeRoot.run(root);
      removeMeta.run(root);
      removePreviewMeta.run(root);
      removeBrowseStateRoot.run(root);
    },
    stats(root) {
      const row = stats.get(root);
      return { files:Number(row?.files) || 0,bytes:Number(row?.bytes) || 0 };
    },
    close() {
      db.close();
      meta.close();
    }
  };
}
