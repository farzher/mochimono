if (document.documentElement.classList.contains('client-library')) {
  let parentApi = null;
  try { if (parent !== window) parentApi = parent.mochimonoBrowserFolders || null; } catch {}

  if (!parentApi) {
    await import('./browser-folder-sync.js').catch(error => console.warn('Browser folder sync unavailable', error));
  }

  await import('./browser-folder-catalog-reconcile.js')
    .catch(error => console.warn('Browser folder catalog reconciliation unavailable', error));

  if (parentApi) {
    window.mochimonoBrowserFolders = parentApi;
    dispatchEvent(new CustomEvent('mochimono:browser-folders-ready'));
  }

  await import('./browser-folder-drop.js')
    .catch(error => console.warn('Browser folder drop unavailable', error));
}
