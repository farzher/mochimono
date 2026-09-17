if (document.documentElement.classList.contains('client-library')) {
  let parentApi = null;
  let hasParentShell = false;
  try {
    if (parent !== window) {
      parentApi = parent.mochimonoBrowserFolders || null;
      hasParentShell = Boolean(parent.mochimonoBrowserFolderShell);
    }
  } catch {}

  async function hasBrowserSources() {
    return new Promise(resolve => {
      const open = indexedDB.open('mochimono-browser-folders', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath:'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath:'key' });
      };
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        const db = open.result;
        const request = db.transaction('sources', 'readonly').objectStore('sources').count();
        request.onerror = () => { db.close(); resolve(false); };
        request.onsuccess = () => { const any = request.result > 0; db.close(); resolve(any); };
      };
    });
  }

  if (!parentApi && hasParentShell && await hasBrowserSources()) {
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
