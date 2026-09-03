const search = document.querySelector('#search');
const fileCount = document.querySelector('#fileCount');
const mediaSizes = document.querySelector('#mediaSizeControl');
const views = document.querySelector('#views');
const filterMenu = document.querySelector('.library-filter-menu');
const sizeMenu = document.querySelector('.library-size-menu');
const viewMenu = document.querySelector('.library-view-menu');

const controls = [
  document.querySelector('#source'),
  document.querySelector('#collectionFilter'),
  document.querySelector('#locationFilter'),
  document.querySelector('#typeFilter'),
  document.querySelector('#sort')
].filter(Boolean);

function activeCount() {
  let count = 0;
  for (const control of controls) {
    if (control.id === 'sort') {
      if (control.value && control.value !== 'date-desc') count++;
    } else if (control.value) count++;
  }
  return count;
}

function sync() {
  if (!filterMenu || !search) return;
  const count = activeCount();
  const badge = filterMenu.querySelector('.library-filter-count');
  badge.hidden = count === 0;
  badge.textContent = count ? String(count) : '';
  filterMenu.querySelector('summary').title = count ? `Filters · ${count} active` : 'Filters';
  const searching = Boolean(search.value.trim());
  if (fileCount) fileCount.hidden = !searching && !count;
  if (sizeMenu && mediaSizes) {
    sizeMenu.hidden = mediaSizes.hidden;
    if (sizeMenu.hidden) sizeMenu.open = false;
  }
}

for (const control of controls) control.addEventListener('change', sync);
search?.addEventListener('input', sync);
if (mediaSizes) new MutationObserver(sync).observe(mediaSizes, { attributes: true, attributeFilter: ['hidden'] });

mediaSizes?.addEventListener('click', event => {
  if (event.target.closest('[data-media-size]') && sizeMenu) sizeMenu.open = false;
});
views?.addEventListener('click', event => {
  if (event.target.closest('[data-view]') && viewMenu) viewMenu.open = false;
});

const menus = [filterMenu, sizeMenu, viewMenu].filter(Boolean);
for (const menu of menus) {
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    for (const other of menus) if (other !== menu) other.open = false;
  });
}

function closePopovers() {
  for (const item of document.querySelectorAll('.library-filter-menu[open],.library-size-menu[open],.library-view-menu[open],.viewer-related[open]')) item.open = false;
}

document.addEventListener('pointerdown', event => {
  for (const menu of menus) if (menu.open && !menu.contains(event.target)) menu.open = false;
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const open = menus.find(menu => menu.open);
  if (!open) return;
  open.open = false;
  open.querySelector('summary')?.focus();
}, true);

window.addEventListener('blur', closePopovers);
window.addEventListener('message', event => {
  if (event.data?.type === 'mochimono-close-popovers') closePopovers();
});

sync();
