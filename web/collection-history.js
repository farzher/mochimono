const filter = document.querySelector('#collectionFilter');

let restoring = false;

function activeUrlKey() {
  return new URL(location.href).searchParams.get('collection') || '';
}

function checkpoint(event) {
  if (restoring || event?.isTrusted === false) return;
  // Push the current state first. collections.js then replaces this new current
  // entry with the selected/cleared group URL, leaving the previous state behind
  // for Back without producing a second navigation step.
  history.pushState(history.state, '', location.href);
}

filter?.addEventListener('change', checkpoint, true);

// Filter/search history is handled by filter-history.js. When those controls
// clear an active group, collections.js replaces the already-created filter
// checkpoint instead of creating another entry.

document.addEventListener('click', event => {
  if (event.isTrusted && event.target.closest('[data-recent-collection]')) checkpoint(event);
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
if (filter) new MutationObserver(() => restoreCollection().catch(console.warn)).observe(filter, { childList:true, subtree:true });
queueMicrotask(() => restoreCollection().catch(console.warn));
