const viewerOpen = document.querySelector('#viewer-open');
const viewerMenu = document.querySelector('#viewer-menu');
const viewerCollections = document.querySelector('#viewerCollections');

function currentHash() {
  return viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
}

function sync() {
  const hash = currentHash();
  if (!hash) return;
  const serverStored = window.mochimonoLocations?.isServerStored?.(hash) ?? true;
  if (viewerMenu) {
    viewerMenu.hidden = !serverStored;
    if (!serverStored) viewerMenu.open = false;
  }
  if (viewerCollections) viewerCollections.hidden = !serverStored;
}

new MutationObserver(sync).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
window.addEventListener('mochimono:locations-updated', sync);
sync();
