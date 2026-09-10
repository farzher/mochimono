const sort = document.querySelector('#sort');
const views = document.querySelector('#views');

let locked = false;
let sortIntentUntil = 0;

function syncClass() {
  document.documentElement.classList.toggle('similarity-sort-locked', locked);
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
    locked = value === 'similar';
    syncClass();
    if (locked) queueMicrotask(() => sort.blur());
    return;
  }

  if (value === 'similar') {
    locked = true;
    syncClass();
    queueMicrotask(() => sort.blur());
    return;
  }

  if (!locked) return;

  // Similar is a user-selected Library mode. Background/history/catalog code
  // and wheel/focus behavior must not silently replace it with another sort.
  // Only a deliberate click/tap/keyboard action on Sort may leave the mode.
  sort.value = 'similar';
  syncClass();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

sort?.addEventListener('wheel', () => {
  if (locked) sort.blur();
}, { capture:true, passive:true });

views?.addEventListener('click', event => {
  const view = event.target.closest('[data-view]')?.dataset.view;
  if (!event.isTrusted || !view || view === 'grid') return;
  locked = false;
  syncClass();
}, true);

document.addEventListener('click', event => {
  if (!event.isTrusted || !event.target.closest('.similarity-sort-close')) return;
  locked = false;
  syncClass();
}, true);

const style = document.createElement('style');
style.textContent = 'html.similarity-sort-locked #dateRail{display:none!important}';
document.head.append(style);

window.mochimonoSimilaritySortLock = {
  active: () => locked,
  release() {
    locked = false;
    sortIntentUntil = 0;
    syncClass();
  }
};