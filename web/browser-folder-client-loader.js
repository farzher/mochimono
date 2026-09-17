if (document.documentElement.classList.contains('client-library')) {
  let parentApi = null;
  let hasParentShell = false;
  try {
    if (parent !== window) {
      parentApi = parent.mochimonoBrowserFolders || null;
      hasParentShell = Boolean(parent.mochimonoBrowserFolderShell);
    }
  } catch {}

  if (!parentApi && hasParentShell) {
    for (let attempt = 0; attempt < 40 && !parentApi; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      try { parentApi = parent.mochimonoBrowserFolders || null; } catch { break; }
    }
  }

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
