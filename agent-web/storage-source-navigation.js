const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');
const storageButton = document.querySelector('[data-client-tab="storage"]');
const toastNode = document.querySelector('#toast');

const pathKey = value => String(value || '')
  .trim()
  .replaceAll('/', '\\')
  .replace(/[\\]+$/, '')
  .toLowerCase();

function toast(text) {
  if (!toastNode) return;
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
}

function sourceForRow(library, row) {
  const sources = library?.sources?.() || [];
  const wanted = pathKey(row?.dataset.folderPath);
  const configuredId = Number(row?.dataset.folderImportId) || 0;

  if (wanted) {
    const provider = sources.find(source => {
      const key = pathKey(source.providerKey);
      return key && (key === wanted || key.endsWith(wanted));
    });
    if (provider) return provider;
  }

  if (configuredId) {
    const configured = sources.find(source => Number(source.id) === configuredId);
    if (configured) return configured;
    return { id:configuredId };
  }

  const name = wanted.split('\\').filter(Boolean).at(-1) || '';
  if (name) {
    const named = sources.filter(source => String(source.sourceName || '').trim().toLowerCase() === name);
    if (named.length === 1) return named[0];
  }
  return null;
}

async function openStorageSource(row) {
  const child = frame?.contentWindow;
  const library = child?.mochimonoLibrary;
  if (!library?.openFolder) throw new Error('Library is still loading.');

  const source = sourceForRow(library, row);
  const importId = Number(source?.id);
  if (!Number.isFinite(importId) || importId === 0) throw new Error('Could not find this source in the library.');

  child.mochimonoHome?.('replace');
  const gridButton = frame.contentDocument?.querySelector('#views [data-view="grid"]');
  if (gridButton && !gridButton.classList.contains('active')) gridButton.click();
  await library.openFolder(importId, '');
  child.scrollTo({ top:0, left:0, behavior:'auto' });
  if (storagePane && !storagePane.hidden) storageButton?.click();
  child.focus();
}

// Capture at the window so this navigation wins before folder-modes handles the
// preview strip as a native Explorer action. The path text itself is untouched
// and still opens the physical folder in Explorer.
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
