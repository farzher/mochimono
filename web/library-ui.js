const UI_KEY = 'mochimono-library-ui';
const files = document.querySelector('#files');
const folderbar = document.querySelector('#folderbar');
const source = document.querySelector('#source');
const collectionFilter = document.querySelector('#collectionFilter');
const search = document.querySelector('#search');
const typeFilter = document.querySelector('#typeFilter');
const sort = document.querySelector('#sort');
const selectToggle = document.querySelector('#selectFiles');
const selectionBar = document.querySelector('#selectionBar');
const selectionCount = document.querySelector('#selectionCount');
const selectAll = document.querySelector('#selectAll');
const selectionCollection = document.querySelector('#selectionCollection');
const selectionDelete = document.querySelector('#selectionDelete');
const selectionIgnore = document.querySelector('#selectionIgnore');
const selectionClear = document.querySelector('#selectionClear');

let selectionMode = false;
let anchorHash = '';
let selected = new Set();

const currentView = () => document.querySelector('#views [data-view].active')?.dataset.view || 'grid';

function saveUi() {
  localStorage.setItem(UI_KEY, JSON.stringify({ view: currentView(), sort: sort.value, type: typeFilter.value }));
}

function restoreUi() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch {}
  if (['date-desc','date-added','date-asc','size-desc'].includes(saved.sort)) {
    sort.value = saved.sort;
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (['','media','image','video','audio','application','other'].includes(saved.type)) {
    typeFilter.value = saved.type;
    typeFilter.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (['grid','list','folders'].includes(saved.view)) document.querySelector(`#views [data-view="${saved.view}"]`)?.click();
}

function syncSelectedClasses() {
  files.querySelectorAll('[data-hash]').forEach(item => item.classList.toggle('selected', selected.has(item.dataset.hash)));
}

function syncSelectionUi() {
  const count = selected.size;
  selectionBar.hidden = !selectionMode && !count;
  selectToggle.classList.toggle('active', selectionMode);
  selectionCount.textContent = count ? `${count.toLocaleString()} selected` : 'Select files';
  selectionCollection.disabled = selectionDelete.disabled = selectionIgnore.disabled = !count;
  syncSelectedClasses();
}

function clearSelection(exit = true) {
  selected.clear();
  anchorHash = '';
  if (exit) selectionMode = false;
  syncSelectionUi();
}

function renderedHashes() {
  return [...files.querySelectorAll('[data-hash]')].map(item => item.dataset.hash);
}

function toggleHash(hash, extend) {
  if (extend && anchorHash) {
    const hashes = renderedHashes();
    const a = hashes.indexOf(anchorHash);
    const b = hashes.indexOf(hash);
    if (a >= 0 && b >= 0) {
      for (const item of hashes.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(item);
      anchorHash = hash;
      return;
    }
  }
  selected.has(hash) ? selected.delete(hash) : selected.add(hash);
  anchorHash = hash;
}

function breadcrumbPath() {
  return [...folderbar.querySelectorAll('[data-folder-depth]')]
    .filter(button => Number(button.dataset.folderDepth) > 0)
    .map(button => button.textContent.trim()).join('/');
}

async function selectionUniverse() {
  const sourceId = Number(source.value) || 0;
  if (currentView() === 'folders' && sourceId) {
    const response = await fetch(`/api/folders?import=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(breadcrumbPath())}`);
    if (!response.ok) throw new Error('Could not read this folder.');
    return (await response.json()).files.map(file => file.hash);
  }
  return window.mochimonoLibrary?.filteredHashes?.() || renderedHashes();
}

async function deleteSelected(ignore) {
  const hashes = [...selected];
  if (!hashes.length) return;
  const label = ignore ? 'Delete + Ignore' : 'Delete';
  if (!confirm(`${label} ${hashes.length.toLocaleString()} file${hashes.length === 1 ? '' : 's'}?`)) return;

  selectionDelete.disabled = selectionIgnore.disabled = selectAll.disabled = true;
  let next = 0;
  let done = 0;
  const failed = [];
  const succeeded = [];
  await Promise.all(Array.from({ length: Math.min(8, hashes.length) }, async () => {
    while (next < hashes.length) {
      const hash = hashes[next++];
      try {
        const response = await fetch(`/api/objects/${hash}/delete`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ignore })
        });
        if (!response.ok) throw new Error(String(response.status));
        succeeded.push(hash);
      } catch { failed.push(hash); }
      selectionCount.textContent = `Deleting ${++done} / ${hashes.length}`;
    }
  }));

  window.mochimonoLibrary?.remove?.(succeeded);
  clearSelection(true);
  selectAll.disabled = false;
  if (failed.length) alert(`${failed.length.toLocaleString()} file${failed.length === 1 ? '' : 's'} could not be deleted.`);
}

selectToggle.addEventListener('click', () => {
  if (selectionMode || selected.size) clearSelection(true);
  else { selectionMode = true; syncSelectionUi(); }
});
selectionClear.addEventListener('click', () => clearSelection(true));
selectAll.addEventListener('click', async () => {
  selectionMode = true;
  selectAll.disabled = true;
  selectionCount.textContent = 'Selecting…';
  try { selected = new Set(await selectionUniverse()); }
  catch (error) { alert(error.message); }
  finally { anchorHash = ''; selectAll.disabled = false; syncSelectionUi(); }
});
selectionCollection.addEventListener('click', () => {
  if (selected.size) window.dispatchEvent(new CustomEvent('mochimono:add-to-collection', { detail: { hashes: [...selected] } }));
});
selectionDelete.addEventListener('click', () => deleteSelected(false));
selectionIgnore.addEventListener('click', () => deleteSelected(true));

files.addEventListener('click', event => {
  const item = event.target.closest('[data-hash]');
  if (!item || (!selectionMode && !event.ctrlKey && !event.metaKey && !event.shiftKey)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  selectionMode = true;
  toggleHash(item.dataset.hash, event.shiftKey);
  syncSelectionUi();
}, true);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.querySelector('#viewer').hidden && (selectionMode || selected.size)) clearSelection(true);
});
for (const control of [sort, typeFilter]) control.addEventListener('change', saveUi);
document.querySelector('#views').addEventListener('click', event => {
  if (!event.target.closest('[data-view]')) return;
  clearSelection(true);
  setTimeout(saveUi);
});
for (const control of [source, collectionFilter]) control.addEventListener('change', () => clearSelection(true));
search.addEventListener('input', () => { if (selected.size) clearSelection(true); });
new MutationObserver(syncSelectedClasses).observe(files, { childList: true });

restoreUi();
syncSelectionUi();
