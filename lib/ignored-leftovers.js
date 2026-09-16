import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR, pathKey, SYNC_INDEX_PATH } from './agent-context.js';
import { exclusionMatchesRelative } from './source-exclusions.js';
import { mimeFor } from './mime.js';

const LEDGER_PATH = join(CONFIG_DIR, 'ignored-leftovers.json');
let ledger = {};
try {
  const parsed = JSON.parse(await readFile(LEDGER_PATH, 'utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ledger = parsed;
} catch {}

function cleanEntry(item) {
  const hash = String(item?.hash || '');
  const path = String(item?.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!/^[a-f0-9]{64}$/.test(hash) || !path) return null;
  return {
    hash,
    path,
    size:Number(item?.size) || 0,
    mtimeMs:Math.max(0, Math.trunc(Number(item?.mtimeMs) || 0))
  };
}

export function ignoredLeftoverEntries(root) {
  const values = ledger[pathKey(root)];
  return Array.isArray(values) ? values.map(cleanEntry).filter(Boolean) : [];
}

export async function rememberIgnoredLeftovers(root, indexRoot = pathKey(root)) {
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:5000 });
  let rows;
  try {
    rows = db.prepare(`
      SELECT path, content_hash AS hash, size, mtime_ms AS mtimeMs
      FROM files
      WHERE root = ? AND content_hash <> ''
    `).all(indexRoot)
      .filter(row => {
        try { return exclusionMatchesRelative(root, row.path); }
        catch { return false; }
      })
      .map(cleanEntry)
      .filter(Boolean);
  } finally {
    db.close();
  }
  if (!rows.length) return 0;

  const key = pathKey(root);
  const byPath = new Map(ignoredLeftoverEntries(root).map(item => [item.path, item]));
  for (const row of rows) byPath.set(row.path, row);
  ledger[key] = [...byPath.values()];
  await mkdir(CONFIG_DIR, { recursive:true });
  await writeFile(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
  return rows.length;
}

export function ignoredLeftoverFile(root, entry, importId = 0) {
  const timestamp = entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : new Date(0).toISOString();
  return {
    hash:entry.hash,
    size:entry.size,
    mime:mimeFor(entry.path),
    createdAt:timestamp,
    filename:basename(entry.path),
    originalPath:entry.path,
    fileDate:timestamp,
    addedAt:timestamp,
    reviewed:false,
    backupCount:0,
    serverStored:true,
    integrityStatus:'unknown',
    width:0,
    height:0,
    importIds:importId ? [importId] : [],
    exactImportIds:importId ? [importId] : []
  };
}
