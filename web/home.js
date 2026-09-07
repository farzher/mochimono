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
  for (const key of ['collection', 'source', 'path', 'tree', 'view', 'file']) url.searchParams.delete(key);
  return url;
}

export function showAllFiles(historyMode = 'push') {
  const activeView = views?.querySelector('[data-view].active')?.dataset.view || 'grid';
  const cleanUrl = cleanHomeUrl();

  // Home is one navigation step. Create a checkpoint first, then let all of the
  // control-reset events replace the new current entry instead of overwriting the
  // page the user should be able to return to with Back.
  if (historyMode === 'push' && cleanUrl.href !== location.href) {
    history.pushState(history.state, '', location.href);
  }
  if (cleanUrl.href !== location.href) history.replaceState(history.state, '', cleanUrl);

  // Put every control into its final visual state first. Then update the few
  // internal filter states that need events. This avoids rendering a chain of
  // intermediate filter states (and the delayed search render) on Home.
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

  // Always finish through Source. Besides updating the library's source state,
  // Collections uses this event to silently drop its active indicator without
  // replaying a Smart Collection's source/type/search/sort reset sequence.
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
