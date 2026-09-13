import { DatabaseSync } from 'node:sqlite';
import { api, json, pathKey, readJson, settings, SYNC_INDEX_PATH } from './agent-context.js';
import { folderFor, queueFolderSync } from './agent-sync.js';
import { addBrowseFolder, browseFolderFor, browseFolderScope, browseRootKey } from './browse-folders.js';
import { invalidateClientProviders } from './client-providers.js';
import { ignoredLeftoverEntries, ignoredLeftoverFile, rememberIgnoredLeftovers } from './ignored-leftovers.js';
import { addSourceExclusion, exclusionMatchesRelative, purgeExcludedIndex, removeSourceExclusion, sourceExclusions } from './source-exclusions.js';

function configuredSource(path) {
  const protectedFolder = path ? folderFor(path) : null;
  if (protectedFolder) return { root:protectedFolder.path, protected:true };
  const browseFolder = path ? browseFolderFor(path) : null;
  if (browseFolder) return { root:browseFolder, protected:false };
  return null;
}

async function refreshSource(source) {
  const indexRoot = source.protected ? pathKey(source.root) : browseRootKey(source.root);
  purgeExcludedIndex(source.root, indexRoot);
  invalidateClientProviders();
  if (source.protected) queueFolderSync(source.root, null, 0, true);
  else await addBrowseFolder(source.root, browseFolderScope(source.root));
}

function currentlyAllowedHashes(candidates) {
  if (!candidates.size) return new Set();
  const allowed = new Set();
  const hashes = [...candidates];
  const db = new DatabaseSync(SYNC_INDEX_PATH, { readOnly:true, timeout:5000 });
  try {
    for (const folder of settings.folders || []) {
      const root = String(folder?.path || '');
      if (!root) continue;
      const indexRoot = pathKey(root);
      for (let offset = 0; offset < hashes.length; offset += 400) {
        const chunk = hashes.slice(offset, offset + 400);
        const marks = chunk.map(() => '?').join(',');
        const rows = db.prepare(`SELECT path, hash FROM file_hashes WHERE root = ? AND hash IN (${marks})`).all(indexRoot, ...chunk);
        for (const row of rows) {
          if (!exclusionMatchesRelative(root, row.path)) allowed.add(String(row.hash));
        }
      }
    }
  } finally {
    db.close();
  }
  return allowed;
}

async function activeCloudHashes(hashes) {
  const active = new Set();
  let checked = false;
  for (let offset = 0; offset < hashes.length; offset += 1000) {
    const chunk = hashes.slice(offset, offset + 1000);
    try {
      const data = await api('/api/objects/check', { method:'POST', body:{ hashes:chunk } });
      checked = true;
      for (const hash of data?.known || []) active.add(String(hash));
    } catch {
      return checked ? active : null;
    }
  }
  return active;
}

async function ignoredLeftovers() {
  const candidates = new Map();
  const seenImports = new Set();

  for (const folder of settings.folders || []) {
    const root = String(folder?.path || '');
    const importId = Number(folder?.importId) || 0;
    if (!root || !sourceExclusions(root).length) continue;

    // The durable ledger is captured before exclusions purge the local index.
    // It is the primary source for newly ignored files and does not depend on
    // server provenance being available at cleanup-view time.
    for (const entry of ignoredLeftoverEntries(root)) {
      try {
        if (!exclusionMatchesRelative(root, entry.path)) continue;
      } catch { continue; }
      if (!candidates.has(entry.hash)) candidates.set(entry.hash, ignoredLeftoverFile(root, entry, importId));
    }

    // Historical server provenance recovers files that were ignored before the
    // local ledger existed. Treat it as best-effort so an old/missing server
    // route cannot turn the entire cleanup view into an empty result.
    if (!importId || seenImports.has(importId)) continue;
    seenImports.add(importId);
    try {
      let after = 0;
      for (;;) {
        const data = await api(`/api/imports/${importId}/sources?limit=5000&after=${after}`);
        const rows = Array.isArray(data?.sources) ? data.sources : [];
        for (const row of rows) {
          const hash = String(row?.hash || '');
          if (!/^[a-f0-9]{64}$/.test(hash) || !exclusionMatchesRelative(root, row?.path || '')) continue;
          candidates.set(hash, {
            hash,
            size:Number(row.size) || 0,
            mime:String(row.mime || 'application/octet-stream'),
            createdAt:row.createdAt || row.fileDate || new Date(0).toISOString(),
            filename:String(row.filename || hash),
            originalPath:String(row.originalPath || row.path || ''),
            fileDate:row.fileDate || row.createdAt || new Date(0).toISOString(),
            addedAt:row.addedAt || row.createdAt || new Date(0).toISOString(),
            reviewed:Boolean(row.reviewed),
            backupCount:Number(row.backupCount) || 0,
            serverStored:row.serverStored !== false,
            integrityStatus:String(row.integrityStatus || 'unknown'),
            width:Number(row.width) || 0,
            height:Number(row.height) || 0,
            importIds:[importId],
            exactImportIds:[importId]
          });
        }
        const next = Number(data?.nextAfter);
        if (!Number.isInteger(next) || next <= after) break;
        after = next;
      }
    } catch {}
  }

  const allowed = currentlyAllowedHashes(new Set(candidates.keys()));
  let files = [...candidates.values()].filter(file => !allowed.has(file.hash));
  const active = await activeCloudHashes(files.map(file => file.hash));
  if (active) files = files.filter(file => active.has(file.hash));
  return { hashes:files.map(file => file.hash), files };
}

export async function handleSourceExclusions(req, res, url) {
  if (url.pathname !== '/api/source-exclusions') return false;

  if (req.method === 'GET') {
    if (url.searchParams.get('leftovers') === '1' && !url.searchParams.get('path')) {
      json(res, 200, await ignoredLeftovers());
      return true;
    }
    const source = configuredSource(url.searchParams.get('path'));
    if (!source) json(res, 404, { error:'Source folder not found' });
    else json(res, 200, { path:source.root, protected:source.protected, exclusions:sourceExclusions(source.root) });
    return true;
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const source = configuredSource(body.path);
    if (!source) {
      json(res, 404, { error:'Source folder not found' });
      return true;
    }

    let result;
    if (body.exclude !== undefined) {
      result = await addSourceExclusion(source.root, body.exclude);
      if (result.changed && source.protected) {
        // Capture hashes/paths while the index still contains the files. The
        // following refresh intentionally purges those rows from normal views.
        await rememberIgnoredLeftovers(source.root, pathKey(source.root));
      }
    } else if (body.include !== undefined) result = await removeSourceExclusion(source.root, body.include);
    else {
      json(res, 400, { error:'Choose a file, folder, or pattern to exclude' });
      return true;
    }

    if (result.changed) await refreshSource(source);
    json(res, 200, {
      ok:true,
      path:source.root,
      protected:source.protected,
      exclusions:sourceExclusions(source.root)
    });
    return true;
  }

  json(res, 405, { error:'Method not allowed' });
  return true;
}
