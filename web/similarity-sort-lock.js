const sort = document.querySelector('#sort');
const views = document.querySelector('#views');
const OWNED_SORTS = new Set(['similar','visual']);

let lockedValue = '';
let sortIntentUntil = 0;

function syncClass() {
  document.documentElement.classList.toggle('similarity-sort-locked', Boolean(lockedValue));
}

function markSortIntent() {
  sortIntentUntil = performance.now() + 2000;
}

sort?.addEventListener('pointerdown', markSortIntent, true);
sort?.addEventListener('keydown', markSortIntent, true);

sort?.addEventListener('change', event => {
  const value = String(sort.value || '');
  const deliberateUserChange = event.isTrusted && performance.now() <= sortIntentUntil;
  sortIntentUntil = 0;

  if (deliberateUserChange) {
    lockedValue = OWNED_SORTS.has(value) ? value : '';
    syncClass();
    if (lockedValue) queueMicrotask(() => sort.blur());
    return;
  }

  if (OWNED_SORTS.has(value) && !lockedValue) {
    lockedValue = value;
    syncClass();
    queueMicrotask(() => sort.blur());
    return;
  }

  if (!lockedValue || value === lockedValue) return;

  // Similar and Visual are user-selected Library modes. Background/history/
  // catalog code and wheel/focus behavior must not silently replace them.
  // Only a deliberate interaction with Sort may leave the current mode.
  sort.value = lockedValue;
  syncClass();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

sort?.addEventListener('wheel', () => {
  if (lockedValue) sort.blur();
}, { capture:true, passive:true });

views?.addEventListener('click', event => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (!event.isTrusted || !view || view === 'grid') return;
  lockedValue = '';
  syncClass();
}, true);

document.addEventListener('click', event => {
  if (!event.isTrusted || !event.target.closest('.similarity-sort-close,.visual-sort-close')) return;
  lockedValue = '';
  syncClass();
}, true);

const style = document.createElement('style');
style.textContent = 'html.similarity-sort-locked #dateRail{display:none!important}';
document.head.append(style);

window.mochimonoSimilaritySortLock = {
  active: () => Boolean(lockedValue),
  value: () => lockedValue,
  release() {
    lockedValue = '';
    sortIntentUntil = 0;
    syncClass();
  }
};