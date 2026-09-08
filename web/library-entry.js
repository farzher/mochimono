const CLIENT = document.documentElement.classList.contains('client-library');
const PAGE = 5000;
const POLL_MS = 5000;

const runtime = {
  localHashes:new Set(),
  localOnlyHashes:new Set(),
  fingerprint:'',
  hydrating:null
};

async function fetchJson(path) {
  const response = await fetch(path, { cache:'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function localFiles() {
  const files = [];
  let offset = 0;
  while (offset != null) {
    const data = await fetchJson(`/api/client/local-catalog?limit=${PAGE}&offset=${offset}`);
    files.push(...(data.files || []).map(file => ({ ...file, localManaged:true })));
    offset = data.nextOffset == null ? null : Number(data.nextOffset);
  }
  return files;
}

function isCloudRecord(file) {
  if (file?.cloudBacked === true) return true;
  if (file?.localManaged !== true) return true;
  if (Array.isArray(file?.importIds) && file.importIds.length) return true;
  if (Array.isArray(file?.exactImportIds) && file.exactImportIds.length) return true;
  return Number(file?.backupCount) > 0;
}

function sameLocalShape(a, b) {
  return Number(a?.size) === Number(b?.size) &&
    String(a?.filename || '') === String(b?.filename || '') &&
    String(a?.rootPath || '') === String(b?.rootPath || '') &&
    String(a?.originalPath || '') === String(b?.originalPath || '') &&
    String(a?.fileDate || '') === String(b?.fileDate || '') &&
    Boolean(a?.localAvailable) === Boolean(b?.localAvailable);
}

function mergeSnapshot(cached, locals) {
  const previous = new Map((cached?.files || []).map(file => [String(file.hash || ''), file]).filter(([hash]) => hash));
  const next = new Map(previous);
  const localHashes = new Set();
  const localOnlyHashes = new Set();
  let changed = !cached?.files?.length && locals.length > 0;

  for (const local of locals) {
    const hash = String(local.hash || '');
    if (!hash) continue;
    localHashes.add(hash);
    const old = previous.get(hash);
    const cloudBacked = old ? isCloudRecord(old) : false;
    if (!cloudBacked) localOnlyHashes.add(hash);
    const searchText = [old?.searchText, local.searchText].filter(Boolean).join(' ').trim();
    const merged = old
      ? {
          ...local,
          ...old,
          rootPath:local.rootPath || old.rootPath,
          localAvailable:local.localAvailable,
          localManaged:true,
          cloudBacked,
          searchText
        }
      : { ...local, localManaged:true, cloudBacked:false };
    if (!old || !sameLocalShape(old, merged) || old.localManaged !== true || Boolean(old.cloudBacked) !== cloudBacked) changed = true;
    next.set(hash, merged);
  }

  // Remove only records we know came solely from the Agent index. Cloud-backed
  // metadata remains visible even if its local source is later disconnected.
  for (const [hash, file] of previous) {
    if (file?.localManaged === true && !isCloudRecord(file) && !localHashes.has(hash)) {
      next.delete(hash);
      changed = true;
    }
  }

  runtime.localHashes = localHashes;
  runtime.localOnlyHashes = localOnlyHashes;
  return {
    changed,
    snapshot:{
      version:String(cached?.version || 'agent-local-v1'),
      imports:Array.isArray(cached?.imports) ? cached.imports : [],
      files:[...next.values()]
    }
  };
}

async function prepareOfflineCatalog() {
  if (!CLIENT) return;
  const cache = window.mochimonoCatalogCache;
  if (!cache?.load || !cache?.save) return;
  const [cached, locals] = await Promise.all([
    cache.load().catch(() => null),
    localFiles().catch(() => [])
  ]);
  if (!locals.length && !cached?.files?.length) return;
  const merged = mergeSnapshot(cached, locals);
  if (merged.changed) {
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
    const locals = await localFiles();
    const nextHashes = new Set(locals.map(file => String(file.hash || '')).filter(Boolean));
    const library = window.mochimonoLibrary;
    if (locals.length) library?.upsertMany?.(locals);

    const removed = [...runtime.localOnlyHashes].filter(hash => !nextHashes.has(hash));
    if (removed.length) library?.remove?.(removed);
    runtime.localHashes = nextHashes;
    runtime.localOnlyHashes = new Set([...runtime.localOnlyHashes].filter(hash => nextHashes.has(hash)));
  })().catch(() => {}).finally(() => { runtime.hydrating = null; });
  return runtime.hydrating;
}

if (CLIENT) {
  await prepareOfflineCatalog().catch(error => console.warn('Local catalog bootstrap failed.', error));

  window.addEventListener('mochimono:catalog-updated', () => {
    // A Cloud refresh replaces the in-memory catalog. Re-merge any local-only
    // files so local browsing remains first-class while uploads are pending.
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
