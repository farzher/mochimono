const CLIENT = document.documentElement.classList.contains('client-library');
const PAGE = 5000;
const POLL_MS = 5000;

const runtime = {
  localHashes:new Set(),
  fingerprint:'',
  hydrating:null
};

async function fetchJson(path) {
  const response = await fetch(path, { cache:'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

const pathName = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');

async function localPage(path, offset) {
  const params = new URLSearchParams({ limit:String(PAGE), offset:String(offset) });
  if (path) params.set('path', path);
  return fetchJson(`/api/client/local-catalog?${params}`);
}

async function localSnapshot() {
  let state = null;
  try { state = await fetchJson('/api/state'); } catch {}
  const configured = Array.isArray(state?.settings?.folders) ? state.settings.folders : [];
  const sources = configured.map(folder => ({
    path:String(folder?.path || ''),
    importId:Number(folder?.importId) || 0,
    protected:folder?.protected !== false
  })).filter(folder => folder.path);

  const files = [];
  const imports = new Map();
  const seenLocations = new Map();

  // A path-specific Agent catalog intentionally reads the persisted index even
  // when that source drive is unplugged. That preserves offline metadata and any
  // already-generated thumbnails instead of making the library appear empty.
  const paths = sources.length ? sources : [{ path:'', importId:0, protected:false }];
  for (const source of paths) {
    let offset = 0;
    do {
      const data = await localPage(source.path, offset);
      for (const raw of data.files || []) {
        const hash = String(raw?.hash || '');
        if (!hash) continue;
        const previous = seenLocations.get(hash);
        const searchText = [previous?.searchText, raw.searchText, source.path].filter(Boolean).join(' ').trim();
        const importIds = source.importId
          ? [...new Set([...(previous?.importIds || []), source.importId])]
          : previous?.importIds || [];
        const next = {
          ...(previous || {}),
          ...raw,
          searchText,
          importIds,
          exactImportIds:importIds,
          localManaged:true,
          localAvailable:Boolean(raw.localAvailable)
        };
        seenLocations.set(hash, next);
      }
      offset = data.nextOffset == null ? null : Number(data.nextOffset);
    } while (offset != null);

    if (source.importId) imports.set(source.importId, {
      id:source.importId,
      sourceName:pathName(source.path) || state?.settings?.device || 'Local',
      files:0,
      referencedBytes:0,
      createdAt:''
    });
  }

  for (const file of seenLocations.values()) {
    files.push(file);
    for (const id of file.importIds || []) {
      const item = imports.get(Number(id));
      if (!item) continue;
      item.files++;
      item.referencedBytes += Number(file.size) || 0;
    }
  }
  return { files, imports:[...imports.values()] };
}

function isCloudRecord(file) {
  // Once a row has been explicitly merged as localManaged, cloudBacked is the
  // durable truth. importIds can also exist on a local-only protected source.
  if (file?.localManaged === true) return file.cloudBacked === true;
  return Boolean(file);
}

function sameLocalShape(a, b) {
  return Number(a?.size) === Number(b?.size) &&
    String(a?.filename || '') === String(b?.filename || '') &&
    String(a?.rootPath || '') === String(b?.rootPath || '') &&
    String(a?.originalPath || '') === String(b?.originalPath || '') &&
    String(a?.fileDate || '') === String(b?.fileDate || '') &&
    Boolean(a?.localAvailable) === Boolean(b?.localAvailable) &&
    String(a?.searchText || '') === String(b?.searchText || '');
}

function mergeImports(cached = [], local = []) {
  const result = new Map();
  for (const item of cached || []) if (Number(item?.id)) result.set(Number(item.id), item);
  for (const item of local || []) {
    const id = Number(item?.id) || 0;
    if (!id || result.has(id)) continue;
    result.set(id, item);
  }
  return [...result.values()];
}

function mergeSnapshot(cached, local) {
  const previous = new Map((cached?.files || []).map(file => [String(file.hash || ''), file]).filter(([hash]) => hash));
  const next = new Map(previous);
  const localHashes = new Set();
  let changed = !cached?.files?.length && local.files.length > 0;

  for (const localFile of local.files) {
    const hash = String(localFile.hash || '');
    if (!hash) continue;
    localHashes.add(hash);
    const old = previous.get(hash);
    const cloudBacked = old ? isCloudRecord(old) : false;
    const searchText = [old?.searchText, localFile.searchText].filter(Boolean).join(' ').trim();
    const merged = old
      ? {
          ...localFile,
          ...old,
          rootPath:localFile.rootPath || old.rootPath,
          originalPath:localFile.originalPath || old.originalPath,
          localAvailable:localFile.localAvailable,
          localManaged:true,
          cloudBacked,
          searchText,
          importIds:[...new Set([...(old.importIds || []), ...(localFile.importIds || [])])],
          exactImportIds:[...new Set([...(old.exactImportIds || []), ...(localFile.exactImportIds || [])])]
        }
      : { ...localFile, localManaged:true, cloudBacked:false };
    if (!old || !sameLocalShape(old, merged) || old.localManaged !== true || Boolean(old.cloudBacked) !== cloudBacked) changed = true;
    next.set(hash, merged);
  }

  // Remove only rows that were previously known to be local-only. Cloud-backed
  // records stay browseable even when their local source disappears.
  for (const [hash, file] of previous) {
    if (file?.localManaged === true && !isCloudRecord(file) && !localHashes.has(hash)) {
      next.delete(hash);
      changed = true;
    }
  }

  runtime.localHashes = localHashes;
  return {
    changed,
    snapshot:{
      version:String(cached?.version || 'agent-local-v1'),
      imports:mergeImports(cached?.imports, local.imports),
      files:[...next.values()]
    }
  };
}

async function prepareOfflineCatalog() {
  if (!CLIENT) return;
  const cache = window.mochimonoCatalogCache;
  if (!cache?.load || !cache?.save) return;
  const [cached, local] = await Promise.all([
    cache.load().catch(() => null),
    localSnapshot().catch(() => ({ files:[], imports:[] }))
  ]);
  if (!local.files.length && !cached?.files?.length) return;
  const merged = mergeSnapshot(cached, local);
  if (merged.changed || merged.snapshot.imports.length !== Number(cached?.imports?.length || 0)) {
    await cache.save(merged.snapshot.files, {
      version:merged.snapshot.version,
      imports:merged.snapshot.imports
    }).catch(() => {});
  }
}

async function localFingerprint() {
  const data = await fetchJson('/api/folder-stats');
  return JSON.stringify((data.folders || []).map(folder => [
    String(folder.path || ''), Number(folder.files) || 0, Number(folder.bytes) || 0,
    String(folder.lastIndexed || ''), Boolean(folder.protected !== false)
  ]));
}

async function hydrateLive() {
  if (!CLIENT || runtime.hydrating) return runtime.hydrating;
  runtime.hydrating = (async () => {
    const local = await localSnapshot();
    const library = window.mochimonoLibrary;
    if (local.files.length) library?.upsertMany?.(local.files);
    runtime.localHashes = new Set(local.files.map(file => String(file.hash || '')).filter(Boolean));
    // Do not delete live rows here. A content hash can simultaneously exist in
    // Cloud and a local source; the cold-start merge can distinguish those safely
    // from persisted metadata, while an in-memory upsert API intentionally cannot.
  })().catch(() => {}).finally(() => { runtime.hydrating = null; });
  return runtime.hydrating;
}

if (CLIENT) {
  await prepareOfflineCatalog().catch(error => console.warn('Local catalog bootstrap failed.', error));

  window.addEventListener('mochimono:catalog-updated', () => {
    // A Cloud refresh replaces the in-memory catalog. Re-merge local-only files
    // so files indexed while disconnected do not disappear before upload.
    setTimeout(() => hydrateLive(), 0);
  });
}

await import('./library-app.js');

if (CLIENT) {
  const poll = async () => {
    if (document.hidden) return;
    try {
      const fingerprint = await localFingerprint();
      if (!runtime.fingerprint) runtime.fingerprint = fingerprint;
      else if (fingerprint !== runtime.fingerprint) {
        runtime.fingerprint = fingerprint;
        await hydrateLive();
      }
    } catch {}
  };
  poll();
  const timer = setInterval(poll, POLL_MS);
  addEventListener('beforeunload', () => clearInterval(timer), { once:true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}
