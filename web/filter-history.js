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

function historySignature(url = new URL(location.href)) {
  const copy = new URL(url);
  copy.searchParams.delete('file');
  copy.hash = '';
  copy.searchParams.sort();
  return `${copy.pathname}?${copy.searchParams}`;
}

let lastHistorySignature = historySignature();

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

  // Media is the Grid's implicit default. Keep the canonical home URL clean;
  // only serialize type when the user has selected a non-default type.
  if (kind && !(kind === 'media' && currentViewFromUrl(url) === 'grid')) url.searchParams.set('type', kind);
  else url.searchParams.delete('type');

  if (order && order !== 'date-desc') url.searchParams.set('sort', order); else url.searchParams.delete('sort');
  if (location) url.searchParams.set('where', location); else url.searchParams.delete('where');
  return url;
}

function commitControlChange(event) {
  if (restoring) return;
  const url = targetUrl();
  if (url.href === location.href) {
    lastHistorySignature = historySignature(url);
    return;
  }
  if (event?.isTrusted) history.pushState(history.state, '', location.href);
  history.replaceState(history.state, '', url);
  lastHistorySignature = historySignature(url);
}

for (const control of [source, type, sort, where]) control?.addEventListener('change', commitControlChange);

search?.addEventListener('input', event => {
  if (restoring) return;
  const url = targetUrl();
  if (url.href === location.href) {
    lastHistorySignature = historySignature(url);
    return;
  }
  if (event.isTrusted && !searchEditing) {
    history.pushState(history.state, '', location.href);
    searchEditing = true;
  }
  history.replaceState(history.state, '', url);
  lastHistorySignature = historySignature(url);
});
search?.addEventListener('blur', () => { searchEditing = false; });
search?.addEventListener('keydown', event => { if (event.key === 'Enter') searchEditing = false; });

function dispatchIfChanged(control, value, typeName = 'change') {
  if (!control || control.value === value) return;
  control.value = value;
  control.dispatchEvent(new Event(typeName, { bubbles:true }));
}

function restoreSource(url = new URL(location.href)) {
  if (!source || url.searchParams.has('source')) return;
  const wantedOrigin = url.searchParams.get('origin') || '';
  if (wantedOrigin && !source.querySelector(`option[value="${CSS.escape(wantedOrigin)}"]`)) return;
  const wasRestoring = restoring;
  restoring = true;
  try { dispatchIfChanged(source, wantedOrigin); }
  finally {
    restoring = wasRestoring;
    lastHistorySignature = historySignature(url);
  }
}

function restoreFilters(preserveInitialOwnedSort = false) {
  const url = new URL(location.href);

  // Similar and Visual can be restored from local UI state before this module
  // installs. Preserve that initial choice and make the URL canonical instead
  // of interpreting an absent sort= parameter as Newest.
  const initialSort = String(sort?.value || '');
  if (preserveInitialOwnedSort && !url.searchParams.has('sort') && ['similar','visual'].includes(initialSort)) {
    url.searchParams.set('sort', initialSort);
    history.replaceState(history.state, '', url);
  }

  restoring = true;
  try {
    dispatchIfChanged(search, url.searchParams.get('q') || '', 'input');
    restoreSource(url);

    const explicitType = url.searchParams.get('type');
    const wantedType = explicitType == null && currentViewFromUrl(url) === 'grid' ? 'media' : (explicitType || '');
    const safeType = type?.querySelector(`option[value="${CSS.escape(wantedType)}"]`) ? wantedType : '';
    dispatchIfChanged(type, safeType);

    const wantedSort = url.searchParams.get('sort') || 'date-desc';
    const safeSort = sort?.querySelector(`option[value="${CSS.escape(wantedSort)}"]`) ? wantedSort : 'date-desc';
    dispatchIfChanged(sort, safeSort);

    const wantedWhere = url.searchParams.get('where') || '';
    const safeWhere = where?.querySelector(`option[value="${CSS.escape(wantedWhere)}"]`) ? wantedWhere : '';
    dispatchIfChanged(where, safeWhere);
  } finally {
    restoring = false;
    searchEditing = false;
    lastHistorySignature = historySignature(url);
  }
}

window.addEventListener('popstate', () => {
  const nextSignature = historySignature();
  // Opening/closing the viewer only changes ?file=. It must never restore
  // Library controls, especially Sort, because the Library view did not change.
  if (nextSignature === lastHistorySignature) return;
  lastHistorySignature = nextSignature;
  queueMicrotask(() => restoreFilters(false));
});
views?.addEventListener('click', () => queueMicrotask(() => restoreFilters(false)));
// Import/source option lists are rebuilt when catalog data changes. That DOM
// mutation only needs to restore the source selection; restoring every control
// here can silently replace a user-selected sort such as Similar or Visual.
if (source) new MutationObserver(() => restoreSource()).observe(source, { childList:true, subtree:true });
queueMicrotask(() => restoreFilters(true));