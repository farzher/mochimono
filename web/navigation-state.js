const views = document.querySelector('#views');

let restoring = false;
let suppressNextView = false;

const currentView = () => views?.querySelector('[data-view].active')?.dataset.view || 'grid';
const validView = value => ['grid', 'list', 'folders'].includes(String(value || '')) ? String(value) : '';

function wantedView() {
  const url = new URL(location.href);
  const explicit = validView(url.searchParams.get('view'));
  if (explicit) return explicit;
  // Older folder links only had ?tree=. Keep them working and normalize them
  // to the explicit view state the next time the URL changes.
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

function restoreView() {
  const next = wantedView();
  if (currentView() === next) return;
  const button = views?.querySelector(`[data-view="${CSS.escape(next)}"]`);
  if (!button) return;
  restoring = true;
  try { button.click(); }
  finally { restoring = false; }
}

views?.addEventListener('click', event => {
  if (!event.target.closest('[data-view]')) return;
  queueMicrotask(() => {
    if (restoring) return;
    if (suppressNextView) {
      suppressNextView = false;
      writeView('replace');
      return;
    }
    writeView('push');
  });
});

window.addEventListener('popstate', () => queueMicrotask(restoreView));

window.mochimonoNavigation = {
  suppressNextView() { suppressNextView = true; },
  syncView(mode = 'replace') { writeView(mode); },
  restoreView
};

// Imports finish before this microtask runs, so folder-tree's view listener is
// already installed when an initial ?view=folders URL is restored.
queueMicrotask(restoreView);
