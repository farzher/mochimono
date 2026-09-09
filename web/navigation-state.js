const views = document.querySelector('#views');
const typeFilter = document.querySelector('#typeFilter');
const GRID_MEDIA_STATE = 'mochimonoGridDefaultMedia';

let restoring = false;
let suppressNextView = false;
let automaticGridMedia = Boolean(history.state?.[GRID_MEDIA_STATE]);

const currentView = () => views?.querySelector('[data-view].active')?.dataset.view || 'grid';
const validView = value => ['grid', 'list', 'folders'].includes(String(value || '')) ? String(value) : '';
const historyState = automatic => ({ ...(history.state || {}), [GRID_MEDIA_STATE]: Boolean(automatic) });

function wantedView() {
  const url = new URL(location.href);
  const explicit = validView(url.searchParams.get('view'));
  if (explicit) return explicit;
  if (url.searchParams.has('tree')) return 'folders';
  return 'grid';
}

function writeView(mode = 'push') {
  if (restoring) return;
  const next = currentView();
  const url = new URL(location.href);
  if (next === 'grid') url.searchParams.delete('view');
  else url.searchParams.set('view', next);
  if (next !== 'folders') url.searchParams.delete('tree');
  if (url.href === location.href) return;
  history[mode === 'replace' ? 'replaceState' : 'pushState'](history.state, '', url);
}

function setType(value) {
  if (!typeFilter || typeFilter.value === value) return;
  typeFilter.value = value;
  typeFilter.dispatchEvent(new Event('change', { bubbles:true }));
}

function resetTypeDefault() {
  const useMedia = currentView() === 'grid';
  automaticGridMedia = useMedia;
  history.replaceState(historyState(useMedia), '', location.href);
  setType(useMedia ? 'media' : '');
}

function syncGridMediaDefault() {
  const next = currentView();
  const url = new URL(location.href);

  if (next === 'grid') {
    // Grid is a visual browser. Unless the user explicitly chose another type,
    // default it to image/video media instead of showing document/file tiles.
    if (automaticGridMedia) {
      setType('media');
      return;
    }
    if (!url.searchParams.has('type') && !typeFilter?.value) {
      automaticGridMedia = true;
      history.replaceState(historyState(true), '', location.href);
      setType('media');
    }
    return;
  }

  // List is the complete file browser. If Media was only applied automatically
  // for Grid, remove it again when leaving Grid. Explicit user filters survive.
  if (automaticGridMedia && typeFilter?.value === 'media') {
    automaticGridMedia = false;
    history.replaceState(historyState(false), '', location.href);
    setType('');
  }
}

function restoreView() {
  automaticGridMedia = Boolean(history.state?.[GRID_MEDIA_STATE]);
  const next = wantedView();
  if (currentView() !== next) {
    const button = views?.querySelector(`[data-view="${CSS.escape(next)}"]`);
    if (!button) return;
    restoring = true;
    try { button.click(); }
    finally { restoring = false; }
  }
  syncGridMediaDefault();
}

views?.addEventListener('click', event => {
  if (!event.target.closest('[data-view]')) return;
  const trusted = event.isTrusted;
  queueMicrotask(() => {
    if (restoring) return;
    if (suppressNextView) {
      suppressNextView = false;
      writeView('replace');
      syncGridMediaDefault();
      return;
    }
    writeView(trusted ? 'push' : 'replace');
    syncGridMediaDefault();
  });
});

typeFilter?.addEventListener('change', event => {
  if (!event.isTrusted) return;
  automaticGridMedia = false;
  history.replaceState(historyState(false), '', location.href);
}, true);

window.addEventListener('popstate', () => queueMicrotask(restoreView));

window.mochimonoNavigation = {
  suppressNextView() { suppressNextView = true; },
  syncView(mode = 'replace') { writeView(mode); },
  resetTypeDefault,
  restoreView
};

queueMicrotask(restoreView);
