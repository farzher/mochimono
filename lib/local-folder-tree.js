import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathKey, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { mimeFor } from './mime.js';

const cleanParts = value => String(value || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.' && part !== '..');
const keyFor = parts => parts.join('/');

function rootParts(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(normalized)) {
    const parts = cleanParts(normalized);
    if (parts.length) parts[0] = parts[0].toUpperCase();
    return parts;
  }
  if (normalized.startsWith('/')) return ['Root', ...cleanParts(normalized)];
  return cleanParts(normalized);
}

function configuredFolders() {
  const rows = [];
  for (const item of settings.folders || []) {
    const path = typeof item === 'string' ? item : item?.path;
    if (path) rows.push({ path:String(path), root:pathKey(path), protected:true });
  }
  for (const path of settings.browseFolders || []) {
    if (path) rows.push({ path:String(path), root:`browse:${pathKey(path)}`, protected:false });
  }
  return rows;
}

function startsWithParts(value, prefix) {
  if (prefix.length > value.length) return false;
  for (let index = 0; index < prefix.length; index++) if (value[index] !== prefix[index]) return false;
  return true;
}

function addFolder(folders, name, path, references) {
  if (!name || !references) return;
  const existing = folders.get(path);
  if (existing) existing.references += references;
  else folders.set(path, { name, path, references });
}

function subtreeRows(db, root, prefix) {
  const start = prefix.length + 1;
  const range = prefix ? 'AND path >= ? AND path < ?' : '';
  const rangeArgs = prefix ? [prefix, `${prefix}\uffff`] : [];

  const folderRows = db.prepare(`
    SELECT substr(path, ?, instr(substr(path, ?), '/') - 1) AS name,
           COUNT(*) AS references
    FROM file_hashes
    WHERE root = ? ${range}
      AND instr(substr(path, ?), '/') > 0
    GROUP BY name
  `).all(start, start, root, ...rangeArgs, start);

  const fileRows = db.prepare(`
    SELECT path,size,mtime_ms AS mtimeMs,hash
    FROM file_hashes
    WHERE root = ? ${range}
      AND instr(substr(path, ?), '/') = 0
    ORDER BY path
  `).all(root, ...rangeArgs, start);

  return { folderRows, fileRows };
}

function addIndexedNode(db, configured, wantedParts, folders, files) {
  const root = rootParts(configured.path);

  // The requested virtual folder is above this configured root. Only its next
  // path component and total indexed-file count are needed; no file rows need to
  // cross the JS boundary.
  if (wantedParts.length < root.length && startsWithParts(root, wantedParts)) {
    const references = Number(db.prepare('SELECT COUNT(*) AS count FROM file_hashes WHERE root = ?').get(configured.root)?.count) || 0;
    const child = root[wantedParts.length];
    addFolder(folders, child, keyFor(root.slice(0, wantedParts.length + 1)), references);
    return;
  }

  if (!startsWithParts(wantedParts, root)) return;

  // At or below a configured root, SQLite uses the (root,path) primary key to
  // restrict work to this subtree. It groups descendant folders itself and only
  // returns files that are directly inside the requested folder.
  const relative = keyFor(wantedParts.slice(root.length));
  const prefix = relative ? `${relative}/` : '';
  const { folderRows, fileRows } = subtreeRows(db, configured.root, prefix);

  for (const row of folderRows) {
    const name = String(row.name || '');
    addFolder(folders, name, keyFor([...wantedParts, name]), Number(row.references) || 0);
  }

  for (const row of fileRows) {
    if (!row.hash) continue;
    const virtualPath = keyFor([...wantedParts, basename(row.path)]);
    const exactKey = `${row.hash}\u0000${virtualPath}`;
    if (files.has(exactKey)) continue;
    const time = Number(row.mtimeMs) || Date.now();
    const date = new Date(time).toISOString();
    files.set(exactKey, {
      hash:String(row.hash),
      size:Number(row.size) || 0,
      mime:mimeFor(row.path),
      filename:basename(row.path),
      originalPath:String(row.path),
      virtualPath,
      rootPath:configured.path,
      sourceName:settings.device,
      deviceName:settings.device,
      local:true,
      protected:configured.protected,
      createdAt:date,
      fileDate:date,
      width:0,
      height:0
    });
  }
}

export function localFolderTree(path = '') {
  const wantedParts = cleanParts(path);
  const wanted = keyFor(wantedParts);
  const configured = configuredFolders();
  if (!configured.length || !existsSync(SYNC_INDEX_PATH)) return { path:wanted, folders:[], files:[] };

  const folders = new Map();
  const files = new Map();
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1500 });
  try {
    for (const folder of configured) addIndexedNode(db, folder, wantedParts, folders, files);
  } finally {
    db.close();
  }

  return {
    path:wanted,
    folders:[...folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' })),
    files:[...files.values()].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric:true, sensitivity:'base' }))
  };
}
