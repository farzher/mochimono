import { api, json, pathKey, readJson, settings } from './agent-context.js';
import { folderFor, queueFolderSync } from './agent-sync.js';
import { addBrowseFolder, browseFolderFor, browseFolderScope, browseRootKey } from './browse-folders.js';
import { invalidateClientProviders } from './client-providers.js';
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

async function ignoredLeftoverHashes() {
  const matchedReferences = new Map();
  const totalReferences = new Map();
  const seenImports = new Set();

  for (const folder of settings.folders || []) {
    const root = String(folder?.path || '');
    const importId = Number(folder?.importId) || 0;
    if (!root || !importId || seenImports.has(importId) || !sourceExclusions(root).length) continue;
    seenImports.add(importId);

    let after = 0;
    for (;;) {
      const data = await api(`/api/imports/${importId}/sources?limit=5000&after=${after}`);
      const rows = Array.isArray(data?.sources) ? data.sources : [];
      for (const row of rows) {
        const hash = String(row?.hash || '');
        if (!/^[a-f0-9]{64}$/.test(hash)) continue;
        const total = Math.max(0, Number(row?.referencesCount) || 0);
        if (total) totalReferences.set(hash, Math.max(totalReferences.get(hash) || 0, total));
        if (exclusionMatchesRelative(root, row?.path || '')) {
          matchedReferences.set(hash, (matchedReferences.get(hash) || 0) + 1);
        }
      }
      const next = Number(data?.nextAfter);
      if (!Number.isInteger(next) || next <= after) break;
      after = next;
    }
  }

  const hashes = [];
  for (const [hash, matched] of matchedReferences) {
    const total = totalReferences.get(hash) || 0;
    if (total > 0 && matched >= total) hashes.push(hash);
  }
  return hashes;
}

export async function handleSourceExclusions(req, res, url) {
  if (url.pathname !== '/api/source-exclusions') return false;

  if (req.method === 'GET') {
    if (url.searchParams.get('leftovers') === '1' && !url.searchParams.get('path')) {
      json(res, 200, { hashes:await ignoredLeftoverHashes() });
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
    if (body.exclude !== undefined) result = await addSourceExclusion(source.root, body.exclude);
    else if (body.include !== undefined) result = await removeSourceExclusion(source.root, body.include);
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
