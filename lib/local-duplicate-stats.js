import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { browseRootKey } from './browse-folders.js';

const configuredPath = value => {
  const raw = typeof value === 'string' ? value : value?.path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
};

function sourceRoots() {
  return [...new Set([
    ...(settings.folders || []).map(folder => configuredPath(folder)).filter(Boolean).map(pathKey),
    ...(settings.browseFolders || []).map(path => configuredPath(path)).filter(Boolean).map(browseRootKey)
  ])];
}

export function localDuplicateStats() {
  const empty = { sourceBytes:0, sourceFiles:0, duplicateBytes:0, duplicateFiles:0, groups:0 };
  const roots = sourceRoots();
  if (!roots.length || !existsSync(SYNC_INDEX_PATH)) return empty;

  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1500 });
  try {
    const placeholders = roots.map(() => '?').join(',');
    const row = db.prepare(`
      WITH source AS (
        SELECT hash, size
        FROM file_hashes
        WHERE root IN (${placeholders})
      ), grouped AS (
        SELECT hash, MAX(size) AS size, COUNT(*) AS copies
        FROM source
        GROUP BY hash
      )
      SELECT
        (SELECT COUNT(*) FROM source) AS sourceFiles,
        (SELECT COALESCE(SUM(size), 0) FROM source) AS sourceBytes,
        COALESCE(SUM(CASE WHEN copies > 1 THEN copies - 1 ELSE 0 END), 0) AS duplicateFiles,
        COALESCE(SUM(CASE WHEN copies > 1 THEN (copies - 1) * size ELSE 0 END), 0) AS duplicateBytes,
        COALESCE(SUM(CASE WHEN copies > 1 THEN 1 ELSE 0 END), 0) AS groups
      FROM grouped
    `).get(...roots) || {};
    return {
      sourceBytes:Number(row.sourceBytes) || 0,
      sourceFiles:Number(row.sourceFiles) || 0,
      duplicateBytes:Number(row.duplicateBytes) || 0,
      duplicateFiles:Number(row.duplicateFiles) || 0,
      groups:Number(row.groups) || 0
    };
  } finally {
    db.close();
  }
}
