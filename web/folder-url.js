const folderbar = document.querySelector('#folderbar');
const files = document.querySelector('#files');
const source = document.querySelector('#source');
const views = document.querySelector('#views');

let restoring = false;
let syncFrame = 0;

function currentView() {
  return views.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function clearFolderUi() {
  folderbar.hidden = true;
  folderbar.replaceChildren();
}

function folderState() {
  if (folderbar.hidden) return null;
  const sourceCrumb = folderbar.querySelector('[data-folder-depth="0"]');
  if (!sourceCrumb) return null;
  const path = [...folderbar.querySelectorAll('[data-folder-depth]')]
    .filter(button => Number(button.dataset.folderDepth) > 0)
    .map(button => button.textContent.trim())
    .join('/');
  return { source: sourceCrumb.textContent.trim(), path };
}

function replaceFolderParams(state) {
  const url = new URL(location.href);
  if (state?.source) {
    url.searchParams.set('source', state.source);
    if (state.path) url.searchParams.set('path', state.path);
    else url.searchParams.delete('path');
  } else {
    url.searchParams.delete('source');
    url.searchParams.delete('path');
  }
  history.replaceState(history.state, '', url);
}

function syncUrl() {
  syncFrame = 0;
  if (restoring) return;
  replaceFolderParams(folderState());
}

function scheduleSync() {
  if (!syncFrame) syncFrame = requestAnimationFrame(syncUrl);
}

function waitFor(find, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      const value = find();
      if (value) return resolve(value);
      if (performance.now() - started >= timeout) return reject(new Error('Folder location is no longer available.'));
      setTimeout(check, 60);
    };
    check();
  });
}

async function restoreFolder() {
  const url = new URL(location.href);
  const wantedSource = url.searchParams.get('source');
  if (!wantedSource) return;
  const parts = String(url.searchParams.get('path') || '').split('/').filter(Boolean);

  restoring = true;
  try {
    const option = await waitFor(() => [...source.options].find(item => item.textContent === wantedSource));
    const desiredView = currentView();
    if (desiredView !== 'folders') views.querySelector('[data-view="folders"]')?.click();
    await waitFor(() => currentView() === 'folders');

    source.value = option.value;
    source.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => folderbar.querySelector('[data-folder-depth="0"]')?.textContent.trim() === wantedSource);

    for (let depth = 0; depth < parts.length; depth++) {
      const part = parts[depth];
      const row = await waitFor(() => [...files.querySelectorAll('[data-folder-name]')].find(item => item.dataset.folderName === part));
      row.click();
      await waitFor(() => folderbar.querySelector(`[data-folder-depth="${depth + 1}"]`)?.textContent.trim() === part);
    }

    if (desiredView !== 'folders') views.querySelector(`[data-view="${desiredView}"]`)?.click();
  } catch (error) {
    console.warn(error.message);
  } finally {
    restoring = false;
    scheduleSync();
  }
}

new MutationObserver(scheduleSync).observe(folderbar, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden']
});

source.addEventListener('change', () => {
  if (!restoring && currentView() !== 'folders') {
    clearFolderUi();
    replaceFolderParams(null);
  }
  setTimeout(scheduleSync);
});

views.addEventListener('click', () => setTimeout(scheduleSync));

files.addEventListener('click', event => {
  if (event.target.closest('[data-folder-source], [data-folder-name]')) setTimeout(scheduleSync);
});

folderbar.addEventListener('click', () => setTimeout(scheduleSync));

restoreFolder().catch(console.warn);
