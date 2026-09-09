import './storage-clarity.js';

const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');
const manageButton = document.querySelector('[data-client-tab="storage"]');
const header = document.querySelector('.client-header');
const brand = document.querySelector('.client-header .app-brand');
const toastNode = document.querySelector('#toast');
const NAV_PARAMS = ['view', 'tree', 'source', 'path', 'folder', 'collection', 'file', 'q', 'origin', 'type', 'sort', 'where'];

let restoringPage = false;

function toast(text) {
  if (!toastNode) return;
  toastNode.textContent = text;
  toastNode.classList.add('show');
  clearTimeout(toastNode.timer);
  toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2800);
}

function libraryParamsFromShell() {
  const url = new URL(location.href);
  const params = {};
  for (const key of NAV_PARAMS) {
    const value = url.searchParams.get(key);
    if (value != null && value !== '') params[key] = value;
  }
  return params;
}

function mirrorChild(params = {}) {
  const url = new URL(location.href);
  for (const key of NAV_PARAMS) url.searchParams.delete(key);
  for (const key of NAV_PARAMS) {
    const value = params[key];
    if (value != null && String(value) !== '') url.searchParams.set(key, String(value));
  }
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

function sendChildState() {
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage({ type:'mochimono-shell-navigate', params:libraryParamsFromShell() }, location.origin);
}

function pageName() {
  return new URL(location.href).searchParams.get('page') === 'storage' ? 'storage' : 'files';
}

function pageUrl(page) {
  const url = new URL(location.href);
  if (page === 'storage') url.searchParams.set('page', 'storage');
  else url.searchParams.delete('page');
  return url;
}

function pushPage(page) {
  const url = pageUrl(page);
  if (url.href !== location.href) history.pushState(history.state, '', url);
}

function applyPageFromUrl() {
  if (!manageButton || !storagePane) return;
  const wantStorage = pageName() === 'storage';
  const showingStorage = !storagePane.hidden;
  if (wantStorage === showingStorage) return;
  restoringPage = true;
  try { manageButton.click(); }
  finally { restoringPage = false; }
}

manageButton?.addEventListener('click', () => {
  if (restoringPage) return;
  pushPage(storagePane.hidden ? 'files' : 'storage');
});

function isLibraryHome() {
  if (pageName() === 'storage') return false;
  const url = new URL(location.href);
  return NAV_PARAMS.every(key => !url.searchParams.has(key));
}

function checkpointHomeNavigation(event) {
  if (event.type === 'keydown' && event.key !== 'Enter' && event.code !== 'Space') return;
  if (isLibraryHome()) return;
  history.pushState(history.state, '', pageUrl('files'));
}

brand?.addEventListener('click', checkpointHomeNavigation, true);
brand?.addEventListener('keydown', checkpointHomeNavigation, true);

function libraryWindow() {
  if (!frame?.contentWindow || !storagePane?.hidden || document.querySelector('dialog[open]')) return null;
  return frame.contentWindow;
}

function editableTarget(target) {
  return target?.closest?.('input,select,textarea,[contenteditable="true"]');
}

window.addEventListener('keydown', event => {
  if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
  if (editableTarget(event.target)) return;
  const child = libraryWindow();
  if (!child) return;
  const viewport = child.innerHeight || frame.clientHeight || innerHeight;
  child.scrollBy({ top: (event.key === 'PageUp' ? -1 : 1) * Math.max(1, Math.floor(viewport * .9)), behavior: 'auto' });
  child.focus();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

header?.addEventListener('wheel', event => {
  if (event.ctrlKey || !event.deltaY || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
  const child = libraryWindow();
  if (!child) return;
  const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (child.innerHeight || frame.clientHeight || innerHeight) : 1;
  child.scrollBy({ top: event.deltaY * multiplier, behavior: 'auto' });
  event.preventDefault();
}, { passive: false });

function sourcePath(row) {
  return String(row?.dataset.folderPath || row?.querySelector('.storage-title strong')?.title || '').trim();
}

function sourceLibraryUrl(path) {
  const url = new URL(location.href);
  url.searchParams.delete('page');
  for (const key of NAV_PARAMS) url.searchParams.delete(key);
  url.searchParams.set('folder', path);
  return url;
}

async function waitForSourceNavigation(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = frame?.contentWindow;
    const scope = child?.mochimonoSourceFolder;
    if (scope?.apply && scope?.commit && child?.mochimonoLibrary?.setLocationFilter && child?.mochimonoHome) return { child, scope };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Library is still loading.');
}

async function openSourceFolder(row) {
  const path = sourcePath(row);
  if (!path) throw new Error('Folder path is unavailable.');

  // Resolve and apply the complete filter before touching the visible page or
  // outer URL. If anything fails, Storage remains exactly where it was.
  const { child, scope } = await waitForSourceNavigation();
  const result = await scope.apply(path, { reset:true });
  if (!result) return;

  history.pushState(history.state, '', sourceLibraryUrl(result.path));
  scope.commit(result.path, 'replace');

  // The Client shell owns the actual tab toggle. Suppress this module's normal
  // Storage-button history listener because the destination URL was committed
  // atomically above.
  if (!storagePane.hidden) {
    restoringPage = true;
    try { manageButton?.click(); }
    finally { restoringPage = false; }
  }
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
  openSourceFolder(row).catch(error => toast(error.message));
}, true);

window.addEventListener('message', event => {
  if (event.source !== frame?.contentWindow || event.origin !== location.origin) return;
  if (event.data?.type !== 'mochimono-navigation-state') return;
  mirrorChild(event.data.params && typeof event.data.params === 'object' ? event.data.params : {});
});

window.addEventListener('popstate', () => {
  applyPageFromUrl();
  sendChildState();
});

frame?.addEventListener('load', sendChildState);
applyPageFromUrl();
queueMicrotask(sendChildState);
