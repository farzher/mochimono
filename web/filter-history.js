const search = document.querySelector('#search');
const source = document.querySelector('#source');
const type = document.querySelector('#typeFilter');
const sort = document.querySelector('#sort');
const where = document.querySelector('#locationFilter');
const views = document.querySelector('#views');

let restoring = false;
let searchEditing = false;

function currentViewFromUrl(url = new URL(location.href)) {
  const explicit = String(url.searchParams.get('view') || '');
  if (['grid', 'list', 'folders'].includes(explicit)) return explicit;
  if (url.searchParams.has('tree')) return 'folders';
  return 'grid';
}

const hasFolderScope = url => url.searchParams.has('root') || url.searchParams.has('browser');

function targetUrl() {
  const url = new URL(location.href);
  const query = String(search?.value || '').trim();
  const origin = String(source?.value || '');
  const kind = String(type?.value || '');
  const order = String(sort?.value || 'date-desc');
  const location = String(where?.value || '');

  if (query) url.searchParams.set('q', query); else url.searchParams.delete('q');
  if (url.searchParams.has('source')) url.searchParams.delete('origin');
  else if (origin) url.searchParams.set('origin', origin);
  else url.searchParams.delete('origin');
  if (kind) url.searchParams.set('type', kind); else url.searchParams.delete('type');
  if (order && order !== 'date-desc') url.searchParams.set('sort', order); else url.searchParams.delete('sort');

  // Native and browser source-folder navigation own their exact hash sets. The
  // visible Where selector mirrors that scope, but must not create a second
  // generic ?where=source-folder filter.
  if (location && !(location === 'source-folder' && hasFolderScope(url))) url.searchParams.set('where', location);
  else url.searchParams.delete('where');
  return url;
}

function commitControlChange(event) {
  if (restoring) return;
  const url = targetUrl();
  if (url.href === location.href) return;
  if (event?.isTrusted) history.pushState(history.state, '', location.href);
  history.replaceState(history.state, '', url);
}

for (const control of [source, type, sort, where]) control?.addEventListener('change', commitControlChange);

search?.addEventListener('input', event => {
  if (restoring) return;
  const url = targetUrl();
  if (url.href === location.href) return;
  if (event.isTrusted && !searchEditing) {
    history.pushState(history.state, '', location.href);
    searchEditing = true;
  }
  history.replaceState(history.state, '', url);
});
search?.addEventListener('blur', () => { searchEditing = false; });
search?.addEventListener('keydown', event => { if (event.key === 'Enter') searchEditing = false; });

function dispatchIfChanged(control, value, typeName = 'change') {
  if (!control || control.value === value) return;
  control.value = value;
  control.dispatchEvent(new Event(typeName, { bubbles:true }));
}

function restoreFilters() {
  const url = new URL(location.href);
  restoring = true;
  try {
    const q = url.searchParams.get('q') || '';
    dispatchIfChanged(search, q, 'input');

    if (!url.searchParams.has('source')) {
      const wantedOrigin = url.searchParams.get('origin') || '';
      if (!wantedOrigin || source?.querySelector(`option[value="${CSS.escape(wantedOrigin)}"]`)) {
        dispatchIfChanged(source, wantedOrigin);
      }
    }

    const explicitType = url.searchParams.get('type');
    const wantedType = explicitType == null && currentViewFromUrl(url) === 'grid' ? 'media' : (explicitType || '');
    const safeType = type?.querySelector(`option[value="${CSS.escape(wantedType)}"]`) ? wantedType : '';
    dispatchIfChanged(type, safeType);

    const wantedSort = url.searchParams.get('sort') || 'date-desc';
    const safeSort = sort?.querySelector(`option[value="${CSS.escape(wantedSort)}"]`) ? wantedSort : 'date-desc';
    dispatchIfChanged(sort, safeSort);

    if (!hasFolderScope(url)) {
      const wantedWhere = url.searchParams.get('where') || '';
      const safeWhere = where?.querySelector(`option[value="${CSS.escape(wantedWhere)}"]`) ? wantedWhere : '';
      dispatchIfChanged(where, safeWhere);
    }
  } finally {
    restoring = false;
    searchEditing = false;
  }
}

window.addEventListener('popstate', () => queueMicrotask(restoreFilters));
views?.addEventListener('click', () => queueMicrotask(restoreFilters));
if (source) new MutationObserver(restoreFilters).observe(source, { childList:true, subtree:true });
queueMicrotask(restoreFilters);
