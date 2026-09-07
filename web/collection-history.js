const filter = document.querySelector('#collectionFilter');
const source = document.querySelector('#source');
const type = document.querySelector('#typeFilter');
const sort = document.querySelector('#sort');
const search = document.querySelector('#search');

let restoring = false;
let lastCheckpointUrl = '';

function activeUrlKey() {
  return new URL(location.href).searchParams.get('collection') || '';
}

function checkpoint() {
  if (restoring) return;
  // Push the current state first. collections.js then replaces this new current
  // entry with the selected/cleared group URL, leaving the previous state behind
  // for Back without producing a second navigation step.
  history.pushState(history.state, '', location.href);
  lastCheckpointUrl = location.href;
}

filter?.addEventListener('change', checkpoint, true);

// Leaving a group by changing one of its defining controls is also meaningful
// navigation. Only checkpoint while the URL still points at the group, so typing
// a search does not create an entry per character.
for (const control of [source, type, sort]) {
  control?.addEventListener('change', () => { if (activeUrlKey()) checkpoint(); }, true);
}
search?.addEventListener('input', () => { if (activeUrlKey()) checkpoint(); }, true);

// Recent-group buttons call setActiveCollection directly instead of changing the
// select element, so give those clicks the same single history checkpoint.
document.addEventListener('click', event => {
  if (event.target.closest('[data-recent-collection]')) checkpoint();
}, true);

async function restoreCollection() {
  if (!filter) return;
  const wanted = activeUrlKey();
  if (filter.value === wanted) return;
  if (wanted && !filter.querySelector(`option[value="${CSS.escape(wanted)}"]`)) return;
  restoring = true;
  try {
    filter.value = wanted;
    filter.dispatchEvent(new Event('change', { bubbles:true }));
  } finally {
    restoring = false;
  }
}

window.addEventListener('popstate', () => queueMicrotask(() => restoreCollection().catch(console.warn)));
new MutationObserver(() => restoreCollection().catch(console.warn)).observe(filter, { childList:true, subtree:true });

// If a direct URL arrives after the Groups module has already populated options,
// normalize the control once without creating history.
queueMicrotask(() => restoreCollection().catch(console.warn));
