const files = document.querySelector('#files');
const views = document.querySelector('#views');
const folderbar = document.querySelector('#folderbar');
const CLIENT = document.documentElement.classList.contains('client-library');

let treePath = new URL(location.href).searchParams.get('tree') || '';
let generation = 0;
let active = false;
let currentFiles = [];

const currentView = () => views?.querySelector('[data-view].active')?.dataset.view || 'grid';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}

function formatBytes(number) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let value = Number(number) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function typeLabel(file) {
  const mime = String(file?.mime || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || mime.startsWith('application/')) return 'document';
  return 'file';
}

async function request(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function parts(path = treePath) {
  return String(path || '').split('/').filter(Boolean);
}

function cleanTreePath(path) {
  return String(path || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.' && part !== '..').join('/');
}

function syncUrl(mode = 'replace') {
  const url = new URL(location.href);
  url.searchParams.set('view', 'folders');
  url.searchParams.delete('source');
  url.searchParams.delete('path');
  if (treePath) url.searchParams.set('tree', treePath);
  else url.searchParams.delete('tree');
  if (url.href === location.href) return;
  history[mode === 'push' ? 'pushState' : 'replaceState'](history.state, '', url);
}

function breadcrumbs() {
  const pathParts = parts();
  const crumbs = ['<button data-tree-home>Folders</button>'];
  pathParts.forEach((part, index) => crumbs.push(`<span>›</span><button data-tree-depth="${index + 1}">${escapeHtml(part)}</button>`));
  folderbar.hidden = false;
  folderbar.innerHTML = `<div class="breadcrumbs tree-breadcrumbs">${crumbs.join('')}</div>`;
}

function folderRows(folders) {
  return (folders || []).map(folder => `
    <button class="folder-row" data-tree-folder="${escapeHtml(folder.path)}">
      <span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(folder.name)}</strong></span>
      <span>${Number(folder.references || 0).toLocaleString()}</span>
      <span>Folder</span>
    </button>`).join('');
}

function fileRows(items) {
  return (items || []).map(file => `
    <button class="folder-row file-folder-row" data-hash="${escapeHtml(file.hash)}" data-filename="${escapeHtml(file.filename)}" title="${escapeHtml(file.virtualPath || file.originalPath || file.filename)}">
      <span class="folder-name"><i class="document-icon"></i><strong>${escapeHtml(file.filename)}</strong></span>
      <span>${formatBytes(file.size)}</span>
      <span>${escapeHtml(typeLabel(file))}</span>
    </button>`).join('');
}

function mergeTrees(trees) {
  const folders = new Map();
  const fileMap = new Map();
  for (const tree of trees) {
    for (const folder of tree?.folders || []) {
      const key = cleanTreePath(folder.path);
      if (!key) continue;
      const previous = folders.get(key);
      if (!previous) folders.set(key, { ...folder, path:key });
      else previous.references = Math.max(Number(previous.references) || 0, Number(folder.references) || 0);
    }
    for (const file of tree?.files || []) {
      const virtualPath = cleanTreePath(file.virtualPath || '');
      const key = `${String(file.hash || '')}\u0000${virtualPath}`;
      const previous = fileMap.get(key);
      if (!previous) {
        fileMap.set(key, { ...file, virtualPath });
        continue;
      }
      if ((!previous.width || !previous.height) && file.width && file.height) {
        previous.width = Number(file.width) || 0;
        previous.height = Number(file.height) || 0;
      }
      if (!previous.rootPath && file.rootPath) previous.rootPath = file.rootPath;
      if (!previous.originalPath && file.originalPath) previous.originalPath = file.originalPath;
      if (file.local) previous.local = true;
      if (file.protected) previous.protected = true;
      if (file.browser) previous.browser = true;
    }
  }
  return {
    path:treePath,
    folders:[...folders.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric:true, sensitivity:'base' })),
    files:[...fileMap.values()].sort((a, b) => String(a.filename).localeCompare(String(b.filename), undefined, { numeric:true, sensitivity:'base' }))
  };
}

async function treeData(path) {
  const encoded = encodeURIComponent(path);
  if (!CLIENT) return request(`/api/folder-tree?path=${encoded}`);

  const browserTree = window.mochimonoBrowserFolders?.tree
    ? window.mochimonoBrowserFolders.tree(path)
    : Promise.resolve(null);
  const [cloud, local, browser] = await Promise.allSettled([
    request(`/api/folder-tree?path=${encoded}`),
    request(`/api/client/folder-tree?path=${encoded}`),
    browserTree
  ]);
  const trees = [];
  if (cloud.status === 'fulfilled') trees.push(cloud.value);
  if (local.status === 'fulfilled') trees.push(local.value);
  if (browser.status === 'fulfilled' && browser.value) trees.push(browser.value);
  if (!trees.length) throw cloud.reason || local.reason || browser.reason || new Error('Could not load folders');
  return mergeTrees(trees);
}

function render(data) {
  if (!active || currentView() !== 'folders') return;
  currentFiles = data.files || [];
  files.className = 'files folders';
  document.querySelector('#scroll-sentinel').hidden = true;
  const rail = document.querySelector('#dateRail');
  if (rail) rail.hidden = true;
  breadcrumbs();
  const rows = `${folderRows(data.folders)}${fileRows(data.files)}`;
  files.innerHTML = rows
    ? `<div class="folder-list-head"><span>Name</span><span>${treePath ? 'Size' : 'References'}</span><span>Type</span></div>${rows}`
    : '<div class="empty">Empty.</div>';
  const count = document.querySelector('#fileCount');
  if (count) {
    const refs = Number(data.folders?.reduce((sum, folder) => sum + (Number(folder.references) || 0), 0)) || 0;
    count.textContent = treePath ? `${currentFiles.length.toLocaleString()} files` : `${refs.toLocaleString()} references`;
    count.title = treePath ? 'Files directly in this folder' : 'Physical/source file references';
  }
}

async function load(path = treePath, historyMode = 'push') {
  const mine = ++generation;
  treePath = cleanTreePath(path);
  if (!active || currentView() !== 'folders') return;
  if (historyMode !== 'none') syncUrl(historyMode);
  breadcrumbs();
  files.className = 'files folders';
  files.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const data = await treeData(treePath);
    if (mine !== generation || !active || currentView() !== 'folders') return;
    render(data);
  } catch (error) {
    if (mine !== generation || !active) return;
    files.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function activate() {
  if (currentView() !== 'folders') return;
  active = true;
  const url = new URL(location.href);
  if (url.searchParams.has('tree')) treePath = cleanTreePath(url.searchParams.get('tree') || '');
  try { await window.mochimonoLibrary?.openFolder?.('', ''); } catch {}
  if (currentView() !== 'folders') return;
  await load(treePath, 'replace');
}

function deactivate() {
  if (currentView() === 'folders') return;
  active = false;
  generation++;
}

views?.addEventListener('click', event => {
  if (!event.target.closest('[data-view]')) return;
  queueMicrotask(() => currentView() === 'folders' ? activate() : deactivate());
});

folderbar?.addEventListener('click', event => {
  if (!active || currentView() !== 'folders') return;
  const home = event.target.closest('[data-tree-home]');
  const crumb = event.target.closest('[data-tree-depth]');
  if (!home && !crumb) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (home) void load('', 'push');
  else void load(parts().slice(0, Number(crumb.dataset.treeDepth)).join('/'), 'push');
}, true);

files?.addEventListener('click', event => {
  if (!active || currentView() !== 'folders') return;
  const folder = event.target.closest('[data-tree-folder]');
  if (!folder) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void load(folder.dataset.treeFolder, 'push');
}, true);

window.addEventListener('popstate', () => {
  queueMicrotask(() => {
    treePath = cleanTreePath(new URL(location.href).searchParams.get('tree') || '');
    if (active && currentView() === 'folders') load(treePath, 'none');
  });
});
window.addEventListener('mochimono:catalog-updated', () => {
  if (active && currentView() === 'folders') load(treePath, 'none');
});
window.addEventListener('mochimono:browser-folders-ready', () => {
  if (active && currentView() === 'folders') load(treePath, 'none');
});
window.addEventListener('mochimono:browser-folders-changed', () => {
  if (active && currentView() === 'folders') load(treePath, 'none');
});

window.mochimonoFolderTree = {
  path:() => treePath,
  files:() => currentFiles.map(file => ({ ...file })),
  open:path => load(path, 'push')
};

if (currentView() === 'folders') activate();
