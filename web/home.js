const homeButton = document.querySelector('#homeButton');
const headerBrand = document.querySelector('.topbar .app-brand');
const search = document.querySelector('#search');
const source = document.querySelector('#source');
const collection = document.querySelector('#collectionFilter');
const locationFilter = document.querySelector('#locationFilter');
const type = document.querySelector('#typeFilter');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');

function dispatch(control, typeName = 'change') {
  control?.dispatchEvent(new Event(typeName, { bubbles:true }));
}

function cleanHomeUrl() {
  const url = new URL(location.href);
  for (const key of ['collection', 'source', 'path', 'folder', 'tree', 'view', 'file', 'q', 'origin', 'type', 'sort', 'where']) {
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

  window.mochimonoSourceFolder?.clear?.({ updateUrl:false });
  window.mochimonoTags?.setFilter?.('');

  // Set every control first, then dispatch its normal UI event. This makes each
  // listener observe the complete home state instead of temporarily rebuilding
  // URL/filter state from controls that have not been reset yet.
  if (search) search.value = '';
  if (collection) collection.value = '';
  if (locationFilter) locationFilter.value = '';
  if (source) source.value = '';
  if (sort) sort.value = 'date-desc';

  if (activeView === 'folders') {
    window.mochimonoNavigation?.suppressNextView?.();
    views?.querySelector('[data-view="grid"]')?.click();
  }

  // Home means the default content for the active presentation: Grid is the
  // visual media browser; List is the complete file browser.
  if (window.mochimonoNavigation?.resetTypeDefault) {
    window.mochimonoNavigation.resetTypeDefault();
  } else if (type) {
    type.value = (views?.querySelector('[data-view].active')?.dataset.view || 'grid') === 'grid' ? 'media' : '';
  }

  // Always dispatch, even when a control already visually shows its default.
  // Its owning module may still have active internal state from navigation or a
  // previously applied smart/dynamic filter.
  dispatch(search, 'input');
  dispatch(collection);
  dispatch(locationFilter);
  dispatch(source);
  dispatch(sort);
  dispatch(type);

  // Event handlers above also maintain URL state. Make the home URL canonical
  // after they finish their synchronous reset work.
  const finalUrl = cleanHomeUrl();
  if (finalUrl.href !== location.href) history.replaceState(history.state, '', finalUrl);

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
