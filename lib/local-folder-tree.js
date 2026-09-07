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

export function localFolderTree(path = '') {
  const wanted = keyFor(cleanParts(path));
  const nodes = new Map();
  const node = parts => {
    const key = keyFor(parts);
    let value = nodes.get(key);
    if (!value) nodes.set(key, value = { path:key, folders:new Map(), files:[], fileKeys:new Set() });
    return value;
  };
  node([]);

  const folders = configuredFolders();
  if (!folders.length || !existsSync(SYNC_INDEX_PATH)) return { path:wanted, folders:[], files:[] };
  const byRoot = new Map(folders.map(folder => [folder.root, folder]));
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:1500 });
  try {
    const roots = [...byRoot.keys()];
    const marks = roots.map(() => '?').join(',');
    if (!marks) return { path:wanted, folders:[], files:[] };
    for (const row of db.prepare(`
      SELECT root,path,size,mtime_ms AS mtimeMs,hash
      FROM file_hashes WHERE root IN (${marks}) ORDER BY root,path
    `).iterate(...roots)) {
      const configured = byRoot.get(row.root);
      if (!configured || !row.hash) continue;
      const root = rootParts(configured.path);
      const relative = cleanParts(row.path);
      if (!relative.length) continue;
      const full = [...root, ...relative];
      const parent = full.slice(0, -1);

      for (let depth = 0; depth < parent.length; depth++) {
        const parentParts = parent.slice(0, depth);
        const childName = parent[depth];
        const parentNode = node(parentParts);
        const childPath = keyFor(parent.slice(0, depth + 1));
        const existing = parentNode.folders.get(childName) || { name:childName, path:childPath, references:0 };
        existing.references++;
        parentNode.folders.set(childName, existing);
        node(parent.slice(0, depth + 1));
      }

      const parentNode = node(parent);
      const virtualPath = keyFor(full);
      const exactKey = `${row.hash}\u0000${virtualPath}`;
      if (parentNode.fileKeys.has(exactKey)) continue;
      parentNode.fileKeys.add(exactKey);
      const time = Number(row.mtimeMs) || Date.now();
      const date = new Date(time).toISOString();
      parentNode.files.push({
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
  } finally { db.close(); }

  const current = nodes.get(wanted);
  if (!current) return { path:wanted, folders:[], files:[] };
  return {
    path:wanted,
    folders:[...current.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' })),
    files:current.files.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric:true, sensitivity:'base' }))
  };
}
