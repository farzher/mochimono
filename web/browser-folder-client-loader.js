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

  async function ingestParentCatalog() {
    if (ingesting) return ingesting;
    ingesting = (async () => {
      let files;
      try {
        if (parent !== window && typeof parent.mochimonoBrowserFolderCatalog === 'function') {
          files = await parent.mochimonoBrowserFolderCatalog();
        } else if (typeof parentApi?.catalog === 'function') files = await parentApi.catalog();
        else return null;
      } catch {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void ingestParentCatalog(), 250);
        return null;
      }

      const library = await libraryApi();
      if (!library) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void ingestParentCatalog(), 100);
        return null;
      }
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
  }

  await import('./browser-folder-catalog-reconcile.js')
    .catch(error => console.warn('Browser folder catalog reconciliation unavailable', error));

  if (parentApi) {
    window.mochimonoBrowserFolders = parentApi;
    dispatchEvent(new CustomEvent('mochimono:browser-folders-ready'));
  }

  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin) return;
    if (event.data?.type === 'mochimono-browser-catalog-changed') void ingestParentCatalog();
  });
  addEventListener('beforeunload', () => clearTimeout(retryTimer), { once:true });

  await ingestParentCatalog();

  await import('./browser-folder-drop.js')
    .catch(error => console.warn('Browser folder drop unavailable', error));
}
