import './minimal-toolbar.js';

const filter = document.querySelector('#collectionFilter');
const viewerGroups = document.querySelector('#viewerCollections');
const strip = document.querySelector('#collectionStrip');
const search = document.querySelector('#search');

const text = (element, value) => {
  if (element && element.textContent !== value) element.textContent = value;
};

function sync() {
  if (search) search.placeholder = 'Search';

  for (const group of filter?.querySelectorAll('optgroup') || []) {
    if (group.label === 'Collections') group.label = 'Groups';
    if (group.label === 'Smart') group.label = 'Smart groups';
  }

  const add = viewerGroups?.querySelector('[data-add-collection]');
  if (add) text(add, '+ Group');

  const picker = document.querySelector('.collection-picker:not(.save-view-dialog)');
  text(picker?.querySelector('.collection-picker-head strong'), 'Add to group');
  const input = picker?.querySelector('[data-picker-input]');
  if (input) input.placeholder = 'Find or create a group';

  text(strip?.querySelector('[data-save-view]'), 'Save as smart group');
  const saveDialog = document.querySelector('.save-view-dialog');
  text(saveDialog?.querySelector('.collection-picker-head strong'), 'Save smart group');
  const saveName = saveDialog?.querySelector('[data-save-name]');
  if (saveName) saveName.placeholder = 'Group name';
  text(saveDialog?.querySelector('.collection-create'), 'Save smart group');
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    sync();
  });
}

const observer = new MutationObserver(schedule);
for (const target of [filter, viewerGroups, strip]) {
  if (target) observer.observe(target, { childList: true, subtree: true });
}

function closePopovers() {
  for (const item of document.querySelectorAll('.library-filter-menu[open],.library-size-menu[open],.library-view-menu[open],.viewer-related[open]')) item.open = false;
}

window.addEventListener('blur', closePopovers);
window.addEventListener('message', event => {
  if (event.data?.type === 'mochimono-close-popovers') closePopovers();
});

sync();
