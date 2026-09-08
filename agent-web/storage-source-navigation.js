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

async function waitForLibrary(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = frame?.contentWindow;
    const library = child?.mochimonoLibrary;
    if (child && library?.openFolder && library?.setLocationFilter) return { child, library };
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

  // Include live browse-stage rows immediately, then page through the persisted
  // local index so large source folders are not truncated at the preview limit.
  addHashes(hashes, await request(`/api/client/local-catalog?limit=5000&path=${encoded}`));

  let offset = 0;
  for (;;) {
    const page = await request(`/api/client/local-catalog?limit=5000&path=${encoded}&offset=${offset}`);
    addHashes(hashes, page);
    const next = Number(page.nextOffset);
    if (!Number.isFinite(next) || next <= offset) break;
    offset = next;
  }
  return hashes;
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

async function openLocalFolder(child, library, path) {
  const hashes = await localFolderHashes(path);
  selectLocalFolderFilter(child, path);
  library.setLocationFilter('source-folder', hashes);
}

async function openStorageSource(row) {
  const path = String(row?.dataset.folderPath || '').trim();
  if (!path) throw new Error('Folder path is unavailable.');

  const { child, library } = await waitForLibrary();
  child.mochimonoHome?.('replace');
  const gridButton = frame.contentDocument?.querySelector('#views [data-view="grid"]');
  if (gridButton && !gridButton.classList.contains('active')) gridButton.click();

  const importId = Number(row?.dataset.folderImportId) || 0;
  if (importId) {
    try {
      await library.openFolder(importId, '');
    } catch {
      // The local index is authoritative for Storage. If the server-side source
      // is stale/offline, the physical root can still be opened exactly.
      await openLocalFolder(child, library, path);
    }
  } else {
    await openLocalFolder(child, library, path);
  }

  child.scrollTo({ top:0, left:0, behavior:'auto' });
  if (storagePane && !storagePane.hidden) storageButton?.click();
  child.focus();
}

// Capture at the window so this navigation wins before folder-modes handles the
// preview strip. The path text itself is untouched and still opens Explorer.
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
