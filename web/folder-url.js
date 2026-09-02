const views = document.querySelector('#views');
const mediaSizeControl = document.querySelector('#mediaSizeControl');
const GRID_FOLDERS_KEY = 'mochimono-grid-folders';

let restoring = false;
let restoreComplete = false;
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
document.querySelector('#folderbar').after(gridFolderStrip);

const library = () => window.mochimonoLibrary;
const currentView = () => views.querySelector('[data-view].active')?.dataset.view || 'grid';
const state = () => library()?.folderState?.() || { importId: '', path: '', sourceName: '' };

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

function syncUrl() {
  if (restoring) return;
  const folder = state();
  const url = new URL(location.href);
  if (folder.sourceName) {
    url.searchParams.set('source', folder.sourceName);
    if (folder.path) url.searchParams.set('path', folder.path);
    else url.searchParams.delete('path');
  } else {
    url.searchParams.delete('source');
    url.searchParams.delete('path');
  }
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

function sourceCards(items) {
  return items.map(item => `
    <button class="grid-folder-card source-card" data-grid-folder-source="${escapeHtml(item.id)}">
      <span class="grid-folder-icon" aria-hidden="true"></span>
      <span class="grid-folder-copy"><strong>${escapeHtml(item.sourceName)}</strong><small>${Number(item.files || 0).toLocaleString()} files · ${formatBytes(item.referencedBytes)}</small></span>
      <span class="grid-folder-arrow" aria-hidden="true">›</span>
    </button>`).join('');
}

function folderCards(items) {
  return items.map(folder => `
    <button class="grid-folder-card" data-grid-folder-name="${escapeHtml(folder.name)}">
      <span class="grid-folder-icon" aria-hidden="true"></span>
      <span class="grid-folder-copy"><strong>${escapeHtml(folder.name)}</strong><small>${Number(folder.files || 0).toLocaleString()} files</small></span>
      <span class="grid-folder-arrow" aria-hidden="true">›</span>
    </button>`).join('');
}

function renderStrip(label, cards) {
  if (!cards) {
    gridFolderStrip.hidden = true;
    gridFolderStrip.replaceChildren();
    return;
  }
  gridFolderStrip.hidden = false;
  gridFolderStrip.innerHTML = `<div class="grid-folder-head"><span>${escapeHtml(label)}</span></div><div class="grid-folder-grid">${cards}</div>`;
}

function refresh() {
  const grid = currentView() === 'grid';
  gridFolderToggle.hidden = !grid;
  gridFolderToggle.classList.toggle('active', gridFoldersEnabled);
  gridFolderToggle.setAttribute('aria-pressed', String(gridFoldersEnabled));
  if (!grid || !gridFoldersEnabled || restoring) return renderStrip('', '');

  const folder = state();
  if (!folder.importId) return renderStrip('Sources', sourceCards(library()?.sources?.() || []));
  return renderStrip('Folders', folderCards(library()?.folderContents?.()?.folders || []));
}

async function openFolder(importId, path = '') {
  await library()?.openFolder?.(importId, path);
  syncUrl();
  refresh();
}

async function restoreFolder() {
  if (restoreComplete) return;
  const url = new URL(location.href);
  const wantedSource = url.searchParams.get('source');
  if (!wantedSource) {
    restoreComplete = true;
    return;
  }
  const source = library()?.sources?.().find(item => item.sourceName === wantedSource);
  if (!source) return;

  restoring = true;
  try {
    await library().openFolder(source.id, url.searchParams.get('path') || '');
    restoreComplete = true;
  } catch (error) {
    console.warn(error);
  } finally {
    restoring = false;
    syncUrl();
  }
}

async function catalogChanged() {
  await restoreFolder();
  refresh();
}

gridFolderToggle.addEventListener('click', () => {
  gridFoldersEnabled = !gridFoldersEnabled;
  localStorage.setItem(GRID_FOLDERS_KEY, gridFoldersEnabled ? '1' : '0');
  refresh();
});

gridFolderStrip.addEventListener('click', event => {
  const sourceCard = event.target.closest('[data-grid-folder-source]');
  if (sourceCard) return void openFolder(sourceCard.dataset.gridFolderSource).catch(console.warn);
  const folderCard = event.target.closest('[data-grid-folder-name]');
  if (!folderCard) return;
  const folder = state();
  const path = folder.path ? `${folder.path}/${folderCard.dataset.gridFolderName}` : folderCard.dataset.gridFolderName;
  openFolder(folder.importId, path).catch(console.warn);
});

window.addEventListener('mochimono:folder-changed', () => {
  syncUrl();
  refresh();
});
window.addEventListener('mochimono:catalog-cache-restored', catalogChanged);
window.addEventListener('mochimono:catalog-updated', catalogChanged);
new MutationObserver(refresh).observe(views, { subtree: true, attributes: true, attributeFilter: ['class'] });

refresh();
restoreFolder().catch(console.warn);
