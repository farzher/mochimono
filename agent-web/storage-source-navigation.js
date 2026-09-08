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
    if (child && navigation?.open && navigation?.openBrowser) return { child, navigation };
    await delay(50);
  }
  throw new Error('Library could not finish loading.');
}

async function openStorageSource(row) {
  const { child, navigation } = await waitForRootNavigation();
  const browserId = String(row?.dataset.browserFolder || '').trim();
  const path = String(row?.dataset.folderPath || '').trim();

  // Apply the complete scope while the Library iframe is still hidden behind the
  // Storage page. Revealing the already-rendered Grid first caused a brief flash
  // of whatever photos were visible in the previous scope.
  if (browserId) await navigation.openBrowser(browserId, 'push');
  else if (path) await navigation.open(path, 'push');
  else throw new Error('Folder is unavailable.');

  if (storagePane && !storagePane.hidden) storageButton?.click();
  child.focus();
}

window.addEventListener('click', event => {
  const preview = event.target.closest?.('#folders .storage-folder-samples');
  if (!preview) return;
  const row = preview.closest('[data-folder-path],[data-browser-folder]');
  if (!row) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openStorageSource(row).catch(error => toast(error.message));
}, true);
