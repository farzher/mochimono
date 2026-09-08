const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');
const storageButton = document.querySelector('[data-client-tab="storage"]');
const toastNode = document.querySelector('#toast');

function toast(text) {
  if (!toastNode) return;
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
}

async function request(path) {
  const response = await fetch(path, { cache:'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForLibrary(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = frame?.contentWindow;
    const library = child?.mochimonoLibrary;
    if (child && library?.setLocationFilter) return { child, library };
    await delay(50);
  }
  throw new Error('Library could not finish loading.');
}

function addHashes(target, data) {
  for (const file of data?.files || []) {
    const hash = String(file?.hash || '');
    if (/^[a-f0-9]{64}$/.test(hash)) target.add(hash);
  }
}

async function localFolderHashes(path) {
  const encoded = encodeURIComponent(path);
  const hashes = new Set();

  // The non-paged request includes any live browse-stage rows. Then page the
  // persisted local index so large folders are complete instead of preview-sized.
  addHashes(hashes, await request(`/api/client/local-catalog?limit=5000&path=${encoded}`));

  let offset = 0;
  for (;;) {
    const page = await request(`/api/client/local-catalog?limit=5000&path=${encoded}&offset=${offset}`);
    addHashes(hashes, page);
    if (page.nextOffset == null) break;
    const next = Number(page.nextOffset);
    if (!Number.isFinite(next) || next <= offset) break;
    offset = next;
  }
  return hashes;
}

function resetLibraryScope(child, library) {
  const document = child.document;
  const search = document.querySelector('#search');
  const source = document.querySelector('#source');
  const collection = document.querySelector('#collectionFilter');
  const location = document.querySelector('#locationFilter');
  const type = document.querySelector('#typeFilter');

  if (search) {
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles:true }));
  }
  if (source) {
    source.value = '';
    source.dispatchEvent(new Event('change', { bubbles:true }));
  }
  if (type) {
    type.value = '';
    type.dispatchEvent(new Event('change', { bubbles:true }));
  }
  if (collection) {
    collection.value = '';
    child.mochimonoSetCollectionHashes?.(null);
  }
  if (location) location.value = '';
  library.setLocationFilter('', null);
}

function selectLocalFolderFilter(child, path) {
  const control = child.document.querySelector('#locationFilter');
  if (!control) return;
  let option = control.querySelector('option[data-storage-source-folder]');
  if (!option) {
    option = child.document.createElement('option');
    option.value = 'source-folder';
    option.dataset.storageSourceFolder = '';
    option.hidden = true;
    control.append(option);
  }
  const clean = String(path || '').replace(/[\\/]+$/, '');
  option.textContent = clean.split(/[\\/]/).filter(Boolean).at(-1) || 'Source folder';
  control.value = option.value;
}

async function openStorageSource(row) {
  const path = String(row?.dataset.folderPath || '').trim();
  if (!path) throw new Error('Folder path is unavailable.');

  // Show the Library immediately. It may still be restoring its cached catalog,
  // but clicking a Storage source should navigate, not fail just because startup
  // work is still in progress.
  if (storagePane && !storagePane.hidden) storageButton?.click();

  const { child, library } = await waitForLibrary();
  resetLibraryScope(child, library);
  const gridButton = frame.contentDocument?.querySelector('#views [data-view="grid"]');
  if (gridButton && !gridButton.classList.contains('active')) gridButton.click();

  // A Storage source is an exact physical root. Do not try to map it through a
  // Cloud import/source ID: local-only roots have no import ID, and multiple roots
  // may belong to the same device source. Filter by the hashes indexed for this
  // exact root instead.
  const hashes = await localFolderHashes(path);
  if (!hashes.size) throw new Error('No indexed files found in this folder.');
  selectLocalFolderFilter(child, path);
  library.setLocationFilter('source-folder', hashes);

  child.scrollTo({ top:0, left:0, behavior:'auto' });
  child.focus();
}

// Capture at the window so this wins before folder-modes' legacy preview click
// handler. The path text itself is untouched and still opens Explorer.
window.addEventListener('click', event => {
  const preview = event.target.closest?.('#folders .storage-folder-samples');
  if (!preview) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const row = preview.closest('[data-folder-path]');
  if (!row) return;
  openStorageSource(row).catch(error => toast(error.message));
}, true);
