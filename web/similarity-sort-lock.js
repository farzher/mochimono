const sort = document.querySelector('#sort');
const views = document.querySelector('#views');

let locked = false;

function syncClass() {
  document.documentElement.classList.toggle('similarity-sort-locked', locked);
}

sort?.addEventListener('change', event => {
  const value = String(sort.value || '');

  if (event.isTrusted) {
    locked = value === 'similar';
    syncClass();
    return;
  }

  if (value === 'similar') {
    locked = true;
    syncClass();
    return;
  }

  if (!locked) return;

  // Similar is a user-selected Library mode. Background/history/catalog code
  // must not silently replace it with another sort. Only an actual user sort
  // choice (or an explicit UI action below) may leave the mode.
  sort.value = 'similar';
  syncClass();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

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
    syncClass();
  }
};
