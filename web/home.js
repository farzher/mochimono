const commandbar = document.querySelector('.commandbar');
const headerBrand = document.querySelector('.topbar .app-brand');
const search = document.querySelector('#search');
const source = document.querySelector('#source');
const collection = document.querySelector('#collectionFilter');
const locationFilter = document.querySelector('#locationFilter');
const type = document.querySelector('#typeFilter');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');

const homeButton = document.createElement('button');
homeButton.type = 'button';
homeButton.className = 'command-home';
homeButton.title = 'All files';
homeButton.setAttribute('aria-label', 'All files');
homeButton.innerHTML = '<span class="mini" aria-hidden="true"></span>';
commandbar?.prepend(homeButton);

function resetSelect(control) {
  if (!control) return;
  control.value = '';
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

export function showAllFiles() {
  const preservedSort = sort?.value || 'date-desc';
  const activeView = views?.querySelector('[data-view].active')?.dataset.view || 'grid';

  if (activeView === 'folders') views?.querySelector('[data-view="grid"]')?.click();
  resetSelect(collection);
  resetSelect(source);
  resetSelect(locationFilter);
  resetSelect(type);
  window.mochimonoSearch?.setRaw?.('', true);

  // Smart collections may temporarily apply their own sort while clearing.
  // Restore whatever the user was already using.
  if (sort && sort.value !== preservedSort) {
    sort.value = preservedSort;
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const url = new URL(location.href);
  url.searchParams.delete('collection');
  url.searchParams.delete('source');
  url.searchParams.delete('path');
  history.replaceState(history.state, '', url);
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
}

window.mochimonoHome = showAllFiles;
homeButton.addEventListener('click', showAllFiles);

if (headerBrand) {
  headerBrand.tabIndex = 0;
  headerBrand.setAttribute('role', 'button');
  headerBrand.title = 'All files';
  headerBrand.addEventListener('click', showAllFiles);
  headerBrand.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.code !== 'Space') return;
    event.preventDefault();
    showAllFiles();
  });
}
