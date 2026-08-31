const source = document.querySelector('#source');
const filter = document.querySelector('#collectionFilter');
const selectionGroup = document.querySelector('#selectionCollection');
const viewerGroups = document.querySelector('#viewerCollections');

function text(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function sync() {
  source?.setAttribute('aria-label', 'Origin');
  if (source?.options[0]) text(source.options[0], 'Origin');

  filter?.setAttribute('aria-label', 'Groups');
  if (filter?.options[0]) text(filter.options[0], 'Groups');
  for (const group of filter?.querySelectorAll('optgroup') || []) {
    if (group.label === 'Collections') group.label = 'Groups';
    if (group.label === 'Smart') group.label = 'Smart groups';
  }

  if (selectionGroup) {
    text(selectionGroup, 'Add to group');
    selectionGroup.title = selectionGroup.disabled && selectionGroup.title
      ? selectionGroup.title
      : 'Add selected files to a group';
  }

  const add = viewerGroups?.querySelector('[data-add-collection]');
  if (add) text(add, '+ Group');

  const picker = document.querySelector('.collection-picker:not(.save-view-dialog)');
  const heading = picker?.querySelector('.collection-picker-head strong');
  if (heading) text(heading, 'Add to group');
  const input = picker?.querySelector('[data-picker-input]');
  if (input && input.placeholder !== 'Find or create a group') input.placeholder = 'Find or create a group';
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

new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
sync();
