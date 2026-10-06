import { updateLibraryLoad, updateLibraryWork } from './library-loading.js';

const CLIENT = document.documentElement.classList.contains('client-library');
const nativeFetch = window.fetch.bind(window);
const FIRST_PAGE = 240;
const PAGE = 1000;
let generation = 0;
let loading = null;
let events = null;
let pollTimer = 0;
let sourcePaths = [];
let activeSeen = null;
let reloadRequested = false;

async function json(path) {
  const response = await nativeFetch(path, { cache:'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

if (CLIENT) {
  // Local files are streamed directly from the index. Do not fetch and rebuild
  // that same index again inside the Cloud/backup provider snapshot.
  window.fetch = (input, options) => {
    const value = typeof input === 'string' || input instanceof URL ? input : input.url;
    const url = new URL(value, location.origin);
    if (url.origin === location.origin && ['/api/catalog','/api/catalog/version','/api/imports'].includes(url.pathname)) {
      url.searchParams.set('remote', '1');
      return nativeFetch(input instanceof Request ? new Request(url, input) : url, options);
    }
    return nativeFetch(input, options);
  };
}

await import('./library-app.js');

const turn = delay => new Promise(resolve => setTimeout(resolve, delay));
const pathKey = value => String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

function publish(files, source = {}) {
  if (!files?.length) return;
  for (const file of files) {
    activeSeen?.add(file.hash);
    if (file.localId) activeSeen?.add(file.localId);
  }
  const importIds = source.importId ? [Number(source.importId)] : [];
  window.mochimonoLibrary.upsertMany(files.map(file => ({ ...file, localManaged:true,
    importIds:file.importIds || importIds, exactImportIds:file.exactImportIds || importIds })));
  window.dispatchEvent(new CustomEvent('mochimono:local-catalog-event', { detail:{ files } }));
  updateLibraryLoad({ phase:window.mochimonoLibrary.state().total ? 'Refreshing library' : 'Loading library' });
}

async function page(source, after = '', limit = PAGE) {
  const params = new URLSearchParams({ limit:String(limit), after });
  if (source.path) params.set('path', source.path);
  if (source.media) params.set('media', '1');
  return json(`/api/client/local-catalog?${params}`);
}

async function loadLocalLibrary() {
  const token = ++generation;
  const seen = activeSeen = new Set();
  updateLibraryLoad();
  // This first request does not wait for settings, Cloud, IndexedDB, or a scan.
  const requested = new URL(location.href).searchParams.get('folder') || '';
  const first = page({ media:true, path:requested }, '', FIRST_PAGE);
  const versionRequest = json('/api/client/local-catalog/version').catch(() => ({ version:'', sources:[] }));
  const initial = await first;
  if (token !== generation) return;
  publish(initial.files);
  const restoredCount = await window.mochimonoCatalogRestored;
  const { version, sources:configuredSources } = await versionRequest;
  if (token !== generation) return;
  const sources = configuredSources || [];
  if (!sources.length) sources.push({ path:'', importId:0 });
  sources.sort((a, b) => Number(pathKey(b.path) === pathKey(requested)) - Number(pathKey(a.path) === pathKey(requested)));
  sourcePaths = sources.map(source => source.path);
  if (restoredCount && version && window.mochimonoCatalogCache?.state?.().localVersion === version) {
    window.mochimonoLibrary.finishLoading();
    updateLibraryLoad({ complete:true });
    return;
  }
  const cachedLocalHashes = window.mochimonoLibrary.allHashes().filter(hash => {
    const file = window.mochimonoLibrary.file(hash);
    return file?.localManaged && !file.cloudBacked;
  });
  await turn(0);
  window.mochimonoLibrary.beginUpdates();
  try {
    const remaining = [];
    let paintedAt = performance.now();
    // Give every source a first page before loading the rest of a large drive.
    for (const source of sources) {
      const data = await page(source, '', FIRST_PAGE);
      if (token !== generation) return;
      publish(data.files, source);
      if (data.nextCursor) remaining.push({ source, cursor:data.nextCursor });
      await turn(0);
    }
    while (remaining.length) {
      if (token !== generation) return;
      if (document.hidden || (window.frameElement && !window.frameElement.getClientRects().length)) {
        await turn(500);
        continue;
      }
      const item = remaining.shift();
      const data = await page(item.source, item.cursor);
      if (token !== generation) return;
      publish(data.files, item.source);
      if (data.nextCursor) remaining.push({ ...item, cursor:data.nextCursor });
      if (performance.now() - paintedAt >= 2000) {
        window.mochimonoLibrary.endUpdates();
        await turn(0);
        window.mochimonoLibrary.beginUpdates();
        paintedAt = performance.now();
      }
      await turn(0);
    }
    window.mochimonoLibrary.remove(cachedLocalHashes.filter(hash => !seen.has(hash) && !window.mochimonoLibrary.file(hash)?.cloudBacked));
  } finally { window.mochimonoLibrary.endUpdates(); }
  window.mochimonoLibrary.finishLoading();
  updateLibraryLoad({ complete:true });
  const end = await json('/api/client/local-catalog/version');
  void window.mochimonoLibrary.saveCache({ localVersion:end.version === version ? version : '' });
}

function startLoading() {
  if (loading) return loading;
  window.mochimonoLocalCatalogLoading = true;
  dispatchEvent(new CustomEvent('mochimono:local-catalog-loading'));
  loading = loadLocalLibrary().catch(error => {
    updateLibraryLoad({ error:error.message });
    console.warn('Local library could not load.', error);
  }).finally(() => {
    loading = null;
    activeSeen = null;
    window.mochimonoLocalCatalogLoading = false;
    dispatchEvent(new CustomEvent('mochimono:local-catalog-ready', { detail:{ count:window.mochimonoLibrary.state().total } }));
    if (reloadRequested) { reloadRequested = false; void startLoading(); }
  });
  return loading;
}

function connectEvents() {
  if (events || document.hidden) return;
  events = new EventSource('/api/client/catalog-events');
  events.addEventListener('catalog', event => {
    try {
      const data = JSON.parse(event.data);
      publish(data.files);
      if (data.reset) {
        if (loading) reloadRequested = true;
        else void startLoading();
      }
      else if (!loading) updateLibraryLoad({ complete:true });
    } catch (error) { console.warn('Local catalog event failed.', error); }
  });
}

async function pollProgress() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  try {
    const data = await json('/api/folder-stats');
    const folders = data.folders || [];
    const working = folders.find(folder => folder.pending && !folder.hashing) ||
      folders.find(folder => folder.hashing || folder.previewWarming || folder.previewQueueActive || folder.previewQueueBackground || folder.hashPending > 0);
    if (working) {
      const p = working.progress || {};
      const name = String(working.path).replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
      let phase, metric;
      if (working.available === false) {
        phase = 'Source offline';
      } else if (working.pending && !working.hashing) {
        phase = p.phase && p.phase !== 'Done' ? p.phase : 'Finding files';
        metric = `${Number(p.scanned || working.files || 0).toLocaleString()} files`;
      } else if (working.hashing) {
        phase = 'Hashing content';
        metric = `${Number(p.hashed || 0).toLocaleString()} hashed`;
      } else if (working.previewWarming || working.previewQueueActive || working.previewQueueBackground) {
        phase = working.previewPhase === 'waiting' ? 'Waiting to retry thumbnails' : 'Preparing thumbnails';
        metric = `${Number(working.previewGenerated || 0).toLocaleString()} generated`;
      } else {
        phase = 'Content hashes pending';
        metric = `${Number(working.hashPending || 0).toLocaleString()} remaining`;
      }
      updateLibraryWork({ phase, message:[name, metric].filter(Boolean).join(' · ') });
    } else updateLibraryWork(null);
  } catch (error) {
    if (!loading && !window.mochimonoLibrary.state().total) updateLibraryLoad({ error:error.message });
  } finally { pollTimer = setTimeout(pollProgress, loading ? 2000 : 5000); }
}

if (CLIENT) {
  void startLoading();
  window.mochimonoClientCatalog = { refresh:startLoading, sources:() => sourcePaths, loading:() => Boolean(loading) };
  connectEvents();
  pollTimer = setTimeout(pollProgress, 2000);
  addEventListener('mochimono:library-retry', () => { void startLoading(); void window.mochimonoLibrary.refresh().catch(() => {}); });
  addEventListener('beforeunload', () => { generation++; clearTimeout(pollTimer); events?.close(); }, { once:true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(pollTimer); events?.close(); events = null; }
    else { connectEvents(); void pollProgress(); }
  });
}
