if (document.documentElement.classList.contains('client-library')) {
  let parentApi = null;
  let ingesting = null;
  let retryTimer = 0;

  async function libraryApi() {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (window.mochimonoLibrary?.upsertMany) return window.mochimonoLibrary;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return null;
  }

  function retryIngest(delay = 150) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void ingestParentCatalog(), delay);
  }

  async function readParentCatalog() {
    if (parent !== window && typeof parent.mochimonoBrowserFolderCatalog === 'function') {
      return parent.mochimonoBrowserFolderCatalog();
    }
    if (typeof parentApi?.catalog === 'function') return parentApi.catalog();
    return null;
  }

  async function ingestParentCatalog() {
    if (ingesting) return ingesting;
    ingesting = (async () => {
      let files;
      try { files = await readParentCatalog(); }
      catch { retryIngest(250); return null; }
      if (!Array.isArray(files)) return null;

      const library = await libraryApi();
      if (!library) { retryIngest(100); return null; }
      if (files.length) library.upsertMany(files);
      dispatchEvent(new CustomEvent('mochimono:browser-catalog-ready', { detail:{ count:files.length } }));
      return files;
    })().finally(() => { ingesting = null; });
    return ingesting;
  }

  try {
    if (parent !== window && parent.mochimonoBrowserFolderShell?.activate) {
      parentApi = await parent.mochimonoBrowserFolderShell.activate();
    }
  } catch {}

  if (!parentApi) {
    await import('./browser-folder-sync.js').catch(error => console.warn('Browser folder sync unavailable', error));
    parentApi = window.mochimonoBrowserFolders || null;
  }

  await import('./browser-folder-catalog-reconcile.js')
    .catch(error => console.warn('Browser folder catalog reconciliation unavailable', error));

  if (parentApi) {
    window.mochimonoBrowserFolders = parentApi;
    dispatchEvent(new CustomEvent('mochimono:browser-folders-ready'));
  }

  await Promise.all([
    import('./browser-folder-viewer.js'),
    import('./browser-folder-thumbnail-repair.js')
  ]).catch(error => console.warn('Browser folder media bridge unavailable', error));

  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin) return;
    if (event.data?.type === 'mochimono-browser-catalog-changed') void ingestParentCatalog();
  });

  // A normal Cloud refresh replaces the Library catalog wholesale. Browser
  // folders live in browser IndexedDB, so merge them back immediately after
  // every replacement instead of waiting for the next folder sync event.
  addEventListener('mochimono:catalog-updated', () => retryIngest(0));
  addEventListener('mochimono:browser-folders-changed', () => retryIngest(0));
  addEventListener('mochimono:browser-folder-sync', event => {
    if (event.detail?.state === 'done') retryIngest(0);
  });

  addEventListener('beforeunload', () => clearTimeout(retryTimer), { once:true });

  await ingestParentCatalog();

  await import('./browser-folder-drop.js')
    .catch(error => console.warn('Browser folder drop unavailable', error));
}
