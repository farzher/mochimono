const homeButton = document.querySelector('#homeButton');
const headerBrand = document.querySelector('.topbar .app-brand');
const search = document.querySelector('#search');
const source = document.querySelector('#source');
const collection = document.querySelector('#collectionFilter');
const locationFilter = document.querySelector('#locationFilter');
const type = document.querySelector('#typeFilter');
const views = document.querySelector('#views');

function clearValue(control) {
  if (!control) return false;
  const changed = Boolean(control.value);
  control.value = '';
  return changed;
}

function cleanHomeUrl() {
  const url = new URL(location.href);
  for (const key of ['collection', 'source', 'path', 'tree', 'view', 'file', 'q', 'origin', 'type', 'sort', 'where']) {
    url.searchParams.delete(key);
  }
  return url;
}

export function showAllFiles(historyMode = 'push') {
  const activeView = views?.querySelector('[data-view].active')?.dataset.view || 'grid';
  const cleanUrl = cleanHomeUrl();

  if (historyMode === 'push' && cleanUrl.href !== location.href) {
    history.pushState(history.state, '', location.href);
  }
  if (cleanUrl.href !== location.href) history.replaceState(history.state, '', cleanUrl);

  if (search) search.value = '';
  clearValue(collection);
  const typeChanged = clearValue(type);
  const locationChanged = clearValue(locationFilter);
  clearValue(source);

  if (activeView === 'folders') {
    window.mochimonoNavigation?.suppressNextView?.();
    views?.querySelector('[data-view="grid"]')?.click();
  }
  if (typeChanged) type.dispatchEvent(new Event('change', { bubbles: true }));
  if (locationChanged) locationFilter.dispatchEvent(new Event('change', { bubbles: true }));
  source?.dispatchEvent(new Event('change', { bubbles: true }));

  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

window.mochimonoHome = showAllFiles;
homeButton?.addEventListener('click', () => showAllFiles('push'));

if (headerBrand) {
  headerBrand.tabIndex = 0;
  headerBrand.setAttribute('role', 'button');
  headerBrand.title = 'All files';
  headerBrand.addEventListener('click', () => showAllFiles('push'));
  headerBrand.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.code !== 'Space') return;
    event.preventDefault();
    showAllFiles('push');
  });
}
