const startupGrid = document.querySelector('#files');
const startupViewer = document.querySelector('#viewer');

let settled = false;
let userTookFocus = false;
const navigationKeys = new Set([
  'PageUp','PageDown','Home','End',
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight'
]);

// A pointer action or an actual editing/activation key means the user already
// chose where focus belongs. Pure navigation keys do not: those are exactly the
// keys that should work without requiring a preliminary click.
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
