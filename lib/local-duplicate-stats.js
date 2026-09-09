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
  const empty = { sourceBytes:0, sourceFiles:0, duplicateBytes:0, duplicateFiles:0, groups:0, hashes:[] };
  const roots = sourceRoots();
  if (!roots.length || !existsSync(SYNC_INDEX_PATH)) return empty;

  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1500 });
  try {
    const placeholders = roots.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT hash, MAX(size) AS size, COUNT(*) AS copies
      FROM file_hashes
      WHERE root IN (${placeholders})
      GROUP BY hash
    `).iterate(...roots);

    let sourceBytes = 0;
    let sourceFiles = 0;
    let duplicateBytes = 0;
    let duplicateFiles = 0;
    const hashes = [];

    for (const row of rows) {
      const size = Math.max(0, Number(row.size) || 0);
      const copies = Math.max(0, Number(row.copies) || 0);
      sourceFiles += copies;
      sourceBytes += copies * size;
      if (copies <= 1) continue;
      hashes.push(String(row.hash));
      duplicateFiles += copies - 1;
      duplicateBytes += (copies - 1) * size;
    }

    return {
      sourceBytes,
      sourceFiles,
      duplicateBytes,
      duplicateFiles,
      groups:hashes.length,
      hashes
    };
  } finally {
    db.close();
  }
}
