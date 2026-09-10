const startupGrid = document.querySelector('#files');
const startupViewer = document.querySelector('#viewer');

function startupTypeFromUrl() {
  const url = new URL(location.href);
  const explicitType = url.searchParams.get('type');
  const explicitView = String(url.searchParams.get('view') || '');
  const view = ['grid','list','folders'].includes(explicitView)
    ? explicitView
    : url.searchParams.has('tree') ? 'folders' : 'grid';
  return explicitType == null && view === 'grid' ? 'media' : (explicitType || '');
}

function syncStartupType() {
  const control = document.querySelector('#typeFilter');
  if (!control) return;
  const wanted = startupTypeFromUrl();
  if (!control.querySelector(`option[value="${CSS.escape(wanted)}"]`)) return;
  control.value = wanted;
  // library-ui/filter-history can run before library-app's change listener exists.
  // Re-emit once startup is complete so the visible control and core filter state
  // cannot disagree because of module load order.
  control.dispatchEvent(new Event('change', { bubbles:true }));
}

// The client library used to wait for library-entry.js to rebuild the complete
// local snapshot before library-app.js was even imported. On a large index that
// made the UI and window.mochimonoLibrary unavailable for seconds. Start the
// cache and core library immediately; library-entry can reconcile local/offline
// state afterward and its later import of library-app is deduplicated by the
// browser module loader.
if (document.documentElement.classList.contains('client-library')) {
  import('./catalog-cache.js')
    .then(() => import('./library-app.js'))
    .then(() => {
      // Wait until all normal module scripts have completed. This deliberately
      // makes the URL/default rule the final startup authority, independent of
      // whether library-ui.js happened to restore its control before or after
      // library-app.js attached its listeners.
      if (document.readyState === 'complete') syncStartupType();
      else addEventListener('load', syncStartupType, { once:true });
    })
    .catch(error => console.error('Could not start Mochimono library.', error));
}

let settled = false;
let userTookFocus = false;
const navigationKeys = new Set([
  'PageUp','PageDown','Home','End',
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight'
]);

// A pointer action or an actual editing/activation key means the user already
// chose where focus belongs. Pure navigation keys do not: those are exactly
// the keys that should work without requiring a preliminary click.
document.addEventListener('pointerdown', () => { userTookFocus = true; }, true);
document.addEventListener('keydown', event => {
  if (!navigationKeys.has(event.key)) userTookFocus = true;
}, true);

function claimStartupGridFocus() {
  if (settled || userTookFocus || !startupViewer?.hidden || !startupGrid?.classList.contains('grid')) return;
  settled = true;
  startupGrid.tabIndex = -1;
  // The grid is focused only to give native PageUp/PageDown a keyboard target.
  // It is not an interactive control itself, so suppress the browser's default
  // focus ring here. Individual cards/buttons keep their own focus treatment.
  startupGrid.style.outline = 'none';
  startupGrid.focus({ preventScroll:true });
}

window.addEventListener('mochimono:stable-grid-installed', claimStartupGridFocus);

// Diagnostics only; no keyboard event is intercepted here. PageUp/PageDown stay
// native browser behavior once the grid owns startup focus.
window.mochimonoStartupFocus = {
  state:() => ({
    settled,
    userTookFocus,
    active:document.activeElement?.id || document.activeElement?.tagName || ''
  })
};
