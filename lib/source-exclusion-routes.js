import { json, pathKey, readJson } from './agent-context.js';
import { folderFor, queueFolderSync } from './agent-sync.js';
import { addBrowseFolder, browseFolderFor, browseFolderScope, browseRootKey } from './browse-folders.js';
import { invalidateClientProviders } from './client-providers.js';
import { addSourceExclusion, purgeExcludedIndex, removeSourceExclusion, sourceExclusions } from './source-exclusions.js';

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

export async function handleSourceExclusions(req, res, url) {
  if (url.pathname !== '/api/source-exclusions') return false;

  if (req.method === 'GET') {
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
      json(res, 400, { error:'Choose a file or folder to exclude' });
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
