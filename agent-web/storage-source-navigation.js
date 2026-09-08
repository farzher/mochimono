const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');
const storageButton = document.querySelector('[data-client-tab="storage"]');
const toastNode = document.querySelector('#toast');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function toast(text) {
  if (!toastNode) return;
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
}

async function waitForRootNavigation(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = frame?.contentWindow;
    const navigation = child?.mochimonoLocalRoot;
    if (child && navigation?.open) return { child, navigation };
    await delay(50);
  }
  throw new Error('Library could not finish loading.');
}

async function openStorageSource(row) {
  const path = String(row?.dataset.folderPath || '').trim();
  if (!path) throw new Error('Folder path is unavailable.');

  // Reveal the Library immediately; the child owns the actual root scope, URL,
  // visible filter state, refresh restoration, and back/forward navigation.
  if (storagePane && !storagePane.hidden) storageButton?.click();
  const { child, navigation } = await waitForRootNavigation();
  await navigation.open(path, 'push');
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
