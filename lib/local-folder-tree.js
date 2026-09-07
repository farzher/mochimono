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

function addIndexedNode(db, configured, wantedParts, folders, files) {
  const root = rootParts(configured.path);

  // The requested virtual folder is above this configured root. Its next child
  // comes entirely from the configured root, so only COUNT the index; there is
  // no reason to read any individual file rows yet.
  if (wantedParts.length < root.length && startsWithParts(root, wantedParts)) {
    const references = Number(db.prepare('SELECT COUNT(*) AS count FROM file_hashes WHERE root = ?').get(configured.root)?.count) || 0;
    const child = root[wantedParts.length];
    addFolder(folders, child, keyFor(root.slice(0, wantedParts.length + 1)), references);
    return;
  }

  // This configured root is unrelated to the requested virtual folder.
  if (!startsWithParts(wantedParts, root)) return;

  // We are at or below the configured root. Restrict SQLite to only this
  // subtree using the (root,path) primary-key ordering instead of rebuilding the
  // complete local folder tree for every click.
  const relativeParts = wantedParts.slice(root.length);
  const relative = keyFor(relativeParts);
  const prefix = relative ? `${relative}/` : '';
  const lower = prefix;
  const upper = `${prefix}\uffff`;
  const prefixLength = prefix.length;

  const rows = prefix
    ? db.prepare(`
        SELECT path,size,mtime_ms AS mtimeMs,hash
        FROM file_hashes
        WHERE root = ? AND path >= ? AND path < ?
        ORDER BY path
      `).iterate(configured.root, lower, upper)
    : db.prepare(`
        SELECT path,size,mtime_ms AS mtimeMs,hash
        FROM file_hashes
        WHERE root = ?
        ORDER BY path
      `).iterate(configured.root);

  for (const row of rows) {
    if (!row.hash) continue;
    const indexedPath = String(row.path || '').replaceAll('\\', '/').replace(/^\/+/, '');
    if (prefix && !indexedPath.startsWith(prefix)) continue;
    const rest = indexedPath.slice(prefixLength);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const child = rest.slice(0, slash);
      addFolder(folders, child, keyFor([...wantedParts, child]), 1);
      continue;
    }

    const virtualPath = keyFor([...wantedParts, rest]);
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
