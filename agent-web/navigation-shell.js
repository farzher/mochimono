import './storage-clarity.js';
import './storage-live-previews.js';

const frame = document.querySelector('#filesFrame');
const storagePane = document.querySelector('#storagePane');
const manageButton = document.querySelector('[data-client-tab="storage"]');
const header = document.querySelector('.client-header');
const brand = document.querySelector('.client-header .app-brand');
const toastNode = document.querySelector('#toast');
const folders = document.querySelector('#folders');
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

function libraryUrl(params = {}) {
  const url = new URL(location.href);
  url.searchParams.delete('page');
  for (const key of NAV_PARAMS) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params || {})) {
    if (!NAV_PARAMS.includes(key) || value == null || String(value) === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function openLibrary(params = {}, mode = 'push') {
  const url = libraryUrl(params);
  if (url.href !== location.href) history[mode === 'replace' ? 'replaceState' : 'pushState'](history.state, '', url);
  applyPageFromUrl();
  sendChildState();
  frame?.contentWindow?.focus();
}

window.mochimonoNavigationShell = { open:openLibrary };

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

function libraryHomeUrl() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  return url;
}

function checkpointHomeNavigation(event) {
  if (event.type === 'keydown' && event.key !== 'Enter' && event.code !== 'Space') return;
  const url = libraryHomeUrl();
  if (url.href === location.href) return;
  history.pushState(history.state, '', url);
  queueMicrotask(sendChildState);
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
  return libraryUrl({ folder:path });
}

const sourceLinkStyle = document.createElement('style');
sourceLinkStyle.textContent = `
#folders a.storage-folder-samples{display:block;color:inherit;text-decoration:none;cursor:pointer}
#folders a.storage-folder-samples.opening{opacity:.62;cursor:progress;pointer-events:none}
`;
document.head.append(sourceLinkStyle);

function decorateSourceLinks() {
  if (!folders) return;
  for (const preview of folders.querySelectorAll('.storage-folder-samples')) {
    const row = preview.closest('[data-folder-path],[data-browser-folder]');
    const path = sourcePath(row);
    if (!row || !path) continue;
    let link = preview;
    if (preview.tagName !== 'A') {
      link = document.createElement('a');
      for (const attribute of preview.attributes) {
        if (attribute.name === 'data-open-library-folder') continue;
        link.setAttribute(attribute.name, attribute.value);
      }
      link.innerHTML = preview.innerHTML;
      preview.replaceWith(link);
    }
    link.removeAttribute('data-open-library-folder');
    link.href = sourceLibraryUrl(path).href;
    link.title = `View ${path} in Library`;
  }
}

async function openSourceFolder(row, preview) {
  const path = sourcePath(row);
  if (!path) throw new Error('Folder path is unavailable.');
  const browserId = String(row?.dataset.browserFolder || '').trim();
  const importId = Number(row?.dataset.folderImportId) || 0;
  const child = frame?.contentWindow;
  const scope = child?.mochimonoSourceFolder;

  // If the iframe is not ready, use the real link as a hard-navigation fallback
  // instead of polling internal state and leaving the click apparently stuck.
  if (!scope?.apply || !scope?.commit || !child?.mochimonoHome) {
    location.href = preview.href;
    return;
  }

  preview.classList.add('opening');
  try {
    const result = await scope.apply(path, { reset:true, browserId, importId });
    if (!result) return;
    history.pushState(history.state, '', sourceLibraryUrl(result.path));
    scope.commit(result.path, 'replace');
    if (!storagePane.hidden) {
      restoringPage = true;
      try { manageButton?.click(); }
      finally { restoringPage = false; }
    }
    child.focus();
  } finally {
    preview.classList.remove('opening');
  }
}

folders?.addEventListener('click', event => {
  const preview = event.target.closest?.('a.storage-folder-samples');
  if (!preview) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const row = preview.closest('[data-folder-path],[data-browser-folder]');
  if (!row) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openSourceFolder(row, preview).catch(error => toast(error.message));
}, true);

if (folders) {
  new MutationObserver(decorateSourceLinks).observe(folders, { childList:true, subtree:true });
  decorateSourceLinks();
}

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
