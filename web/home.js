const commandbar = document.querySelector('.commandbar');
const headerBrand = document.querySelector('.topbar .app-brand');
const search = document.querySelector('#search');
const source = document.querySelector('#source');
const collection = document.querySelector('#collectionFilter');
const locationFilter = document.querySelector('#locationFilter');
const type = document.querySelector('#typeFilter');
const views = document.querySelector('#views');

const style = document.createElement('style');
style.textContent = `
  .command-home{flex:0 0 32px;width:32px;height:34px;padding:0;display:grid;place-items:center;border-radius:10px;background:transparent;color:inherit}
  .command-home:hover,.command-home:focus-visible{background:var(--surface2);outline:none}
  .command-home .mini{transform:scale(.72);transform-origin:center;pointer-events:none}
  .topbar .app-brand[role="button"]{cursor:pointer}
`;
document.head.append(style);

const homeButton = document.createElement('button');
homeButton.type = 'button';
homeButton.className = 'command-home';
homeButton.title = 'All files';
homeButton.setAttribute('aria-label', 'All files');
homeButton.innerHTML = '<span class="mini" aria-hidden="true"></span>';
commandbar?.prepend(homeButton);

function clearValue(control) {
  if (!control) return false;
  const changed = Boolean(control.value);
  control.value = '';
  return changed;
}

export function showAllFiles() {
  const activeView = views?.querySelector('[data-view].active')?.dataset.view || 'grid';

  // Put every control into its final visual state first. Then update the few
  // internal filter states that need events. This avoids rendering a chain of
  // intermediate filter states (and the delayed search render) on Home.
  if (search) search.value = '';
  clearValue(collection);
  const typeChanged = clearValue(type);
  const locationChanged = clearValue(locationFilter);
  clearValue(source);

  if (activeView === 'folders') views?.querySelector('[data-view="grid"]')?.click();
  if (typeChanged) type.dispatchEvent(new Event('change', { bubbles: true }));
  if (locationChanged) locationFilter.dispatchEvent(new Event('change', { bubbles: true }));

  // Always finish through Source. Besides updating the library's source state,
  // Collections uses this event to silently drop its active indicator without
  // replaying a Smart Collection's source/type/search/sort reset sequence.
  source?.dispatchEvent(new Event('change', { bubbles: true }));

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
