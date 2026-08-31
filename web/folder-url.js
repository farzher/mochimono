import './context-ui.js';

const folderbar = document.querySelector('#folderbar');
const files = document.querySelector('#files');
const source = document.querySelector('#source');
const views = document.querySelector('#views');
const mediaSizeControl = document.querySelector('#mediaSizeControl');
const GRID_FOLDERS_KEY = 'mochimono-grid-folders';

let restoring = false;
let syncFrame = 0;
let gridFolderGeneration = 0;
let gridFoldersEnabled = localStorage.getItem(GRID_FOLDERS_KEY) !== '0';

const gridFolderToggle = document.createElement('button');
gridFolderToggle.type = 'button';
gridFolderToggle.className = 'grid-folders-toggle';
gridFolderToggle.title = 'Show folders in grid';
gridFolderToggle.setAttribute('aria-label', 'Show folders in grid');
gridFolderToggle.innerHTML = '<span class="grid-folder-toggle-icon" aria-hidden="true"></span>';
mediaSizeControl.after(gridFolderToggle);

const gridFolderStrip = document.createElement('section');
gridFolderStrip.className = 'grid-folder-strip';
gridFolderStrip.hidden = true;
folderbar.after(gridFolderStrip);

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
  if (!restoring) replaceFolderParams(folderState());
}

function scheduleSync() {
  if (!syncFrame) syncFrame = requestAnimationFrame(syncUrl);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function syncGridFolderToggle() {
  gridFolderToggle.hidden = currentView() !== 'grid';
  gridFolderToggle.classList.toggle('active', gridFoldersEnabled);
  gridFolderToggle.setAttribute('aria-pressed', String(gridFoldersEnabled));
}

function sourceCards(imports) {
  return imports.map(item => `
    <button class="grid-folder-card source-card" data-grid-folder-source="${escapeHtml(item.id)}">
      <span class="grid-folder-icon" aria-hidden="true"></span>
      <span class="grid-folder-copy"><strong>${escapeHtml(item.sourceName)}</strong><small>${Number(item.files || 0).toLocaleString()} files · ${formatBytes(item.referencedBytes)}</small></span>
      <span class="grid-folder-arrow" aria-hidden="true">›</span>
    </button>`).join('');
}

function folderCards(folders) {
  return folders.map(folder => `
    <button class="grid-folder-card" data-grid-folder-name="${escapeHtml(folder.name)}">
      <span class="grid-folder-icon" aria-hidden="true"></span>
      <span class="grid-folder-copy"><strong>${escapeHtml(folder.name)}</strong><small>${Number(folder.files || 0).toLocaleString()} files</small></span>
      <span class="grid-folder-arrow" aria-hidden="true">›</span>
    </button>`).join('');
}

function renderGridFolderStrip(label, cards) {
  if (!cards) {
    gridFolderStrip.hidden = true;
    gridFolderStrip.replaceChildren();
    return;
  }
  gridFolderStrip.hidden = false;
  gridFolderStrip.innerHTML = `<div class="grid-folder-head"><span>${escapeHtml(label)}</span></div><div class="grid-folder-grid">${cards}</div>`;
}

function waitFor(find, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      const value = find();
      if (value) return resolve(value);
      if (performance.now() - started >= timeout) return reject(new Error('Folder location is no longer available.'));
      setTimeout(check, 30);
    };
    check();
  });
}

function dispatchFolderClick(attribute, value) {
  const bridge = document.createElement('button');
  bridge.type = 'button';
  bridge.hidden = true;
  bridge.dataset[attribute] = value;
  files.append(bridge);
  bridge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  bridge.remove();
}

async function enterSource(id) {
  const option = [...source.options].find(item => item.value === String(id));
  if (!option) return;
  dispatchFolderClick('folderSource', option.value);
  await waitFor(() => folderState()?.source === option.textContent.trim());
}

async function enterFolder(name) {
  const before = folderState();
  if (!before) return;
  const wantedPath = before.path ? `${before.path}/${name}` : name;
  dispatchFolderClick('folderName', name);
  await waitFor(() => folderState()?.path === wantedPath);
}

async function refreshGridFolders() {
  syncGridFolderToggle();
  const generation = ++gridFolderGeneration;
  if (!gridFoldersEnabled || currentView() !== 'grid' || restoring) {
    gridFolderStrip.hidden = true;
    return;
  }

  const state = folderState();
  try {
    if (!state) {
      const response = await fetch('/api/imports');
      if (!response.ok) throw new Error(`${response.status}`);
      const imports = (await response.json()).imports || [];
      if (generation !== gridFolderGeneration || !gridFoldersEnabled || currentView() !== 'grid' || folderState()) return;
      renderGridFolderStrip('Sources', sourceCards(imports));
      return;
    }

    const importId = source.value;
    if (!importId) return renderGridFolderStrip('', '');
    const response = await fetch(`/api/folders?import=${encodeURIComponent(importId)}&path=${encodeURIComponent(state.path)}`);
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    if (generation !== gridFolderGeneration || !gridFoldersEnabled || currentView() !== 'grid') return;
    const current = folderState();
    if (!current || current.source !== state.source || current.path !== state.path) return;
    renderGridFolderStrip('Folders', folderCards(data.folders || []));
  } catch (error) {
    if (generation === gridFolderGeneration) {
      console.warn('Could not load grid folders.', error);
      gridFolderStrip.hidden = true;
    }
  }
}

async function restoreFolder() {
  const url = new URL(location.href);
  const wantedSource = url.searchParams.get('source');
  if (!wantedSource) return;
  const parts = String(url.searchParams.get('path') || '').split('/').filter(Boolean);

  restoring = true;
  try {
    const option = await waitFor(() => [...source.options].find(item => item.textContent === wantedSource));
    await enterSource(option.value);
    for (const part of parts) await enterFolder(part);
  } catch (error) {
    console.warn(error.message);
  } finally {
    restoring = false;
    scheduleSync();
    refreshGridFolders();
  }
}

gridFolderToggle.addEventListener('click', () => {
  gridFoldersEnabled = !gridFoldersEnabled;
  localStorage.setItem(GRID_FOLDERS_KEY, gridFoldersEnabled ? '1' : '0');
  refreshGridFolders();
});

gridFolderStrip.addEventListener('click', event => {
  const sourceCard = event.target.closest('[data-grid-folder-source]');
  const folderCard = event.target.closest('[data-grid-folder-name]');
  const action = sourceCard
    ? enterSource(sourceCard.dataset.gridFolderSource)
    : folderCard
      ? enterFolder(folderCard.dataset.gridFolderName)
      : null;
  action?.then(() => {
    scheduleSync();
    refreshGridFolders();
  }).catch(error => console.warn(error.message));
});

new MutationObserver(() => {
  scheduleSync();
  refreshGridFolders();
}).observe(folderbar, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden']
});

new MutationObserver(refreshGridFolders).observe(source, { childList: true });

source.addEventListener('change', () => {
  if (!restoring && currentView() !== 'folders') {
    clearFolderUi();
    replaceFolderParams(null);
  }
  setTimeout(() => {
    scheduleSync();
    refreshGridFolders();
  });
});

views.addEventListener('click', () => setTimeout(() => {
  scheduleSync();
  refreshGridFolders();
}));

files.addEventListener('click', event => {
  if (event.target.closest('[data-folder-source], [data-folder-name]')) setTimeout(() => {
    scheduleSync();
    refreshGridFolders();
  });
});

folderbar.addEventListener('click', () => setTimeout(() => {
  scheduleSync();
  refreshGridFolders();
}));

syncGridFolderToggle();
refreshGridFolders();
restoreFolder().catch(console.warn);
