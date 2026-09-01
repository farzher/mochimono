import './storage-minimal-actions.js';

const folders = document.querySelector('#folders');
const startBrowse = document.querySelector('#startBrowse');
const startProtect = document.querySelector('#startImport');
const importPath = document.querySelector('#importPath');
const folderAdd = document.querySelector('#folderAdd');
const showFolderAdd = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');
let loading = false;
let queued = false;

const groupStyle = document.createElement('style');
groupStyle.textContent = `
  #folders:has(.folder-mode-group){gap:22px!important}
  .folder-mode-group{display:grid;gap:7px;min-width:0}
  .folder-group-head{display:flex;align-items:center;gap:7px;padding:0 2px;color:#8d8582}
  .folder-group-head span{font-size:11px;font-weight:680;letter-spacing:.01em}
  .folder-group-head small{color:#67615f;font-size:9px;font-weight:650}
  .folder-mode-list{display:grid;gap:0;min-width:0}
`;
document.head.append(groupStyle);

const samePath = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
const pathName = path => String(path || '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean).at(-1) || String(path || 'Folder');

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function refreshLibrary() {
  frame?.contentWindow?.mochimonoLibrary?.refresh?.().catch?.(() => {});
  frame?.contentWindow?.mochimonoLocations?.refresh?.().catch?.(() => {});
}

function modeBadge(row, protectedFolder) {
  let badge = row.querySelector('[data-folder-mode]');
  if (!badge) {
    badge = document.createElement('span');
    badge.dataset.folderMode = '';
    row.querySelector('.storage-title strong')?.after(badge);
  }
  badge.className = `storage-mode ${protectedFolder ? 'protected' : 'local'}`;
  badge.textContent = protectedFolder ? 'Local + Mochimono' : 'Local only';
  badge.title = protectedFolder
    ? 'Files stay on this device and Mochimono keeps a Server copy. Local files are never deleted automatically.'
    : 'This folder is indexed on this device only. Nothing is uploaded.';
}

function cleanFolderTitle(row) {
  const path = row.dataset.folderPath || '';
  const strong = row.querySelector('.storage-title strong');
  if (strong) {
    strong.textContent = pathName(path);
    strong.title = path;
  }
  let pathLine = row.querySelector('.storage-path');
  if (!pathLine) {
    pathLine = document.createElement('div');
    pathLine.className = 'storage-path';
    row.querySelector('.storage-title')?.after(pathLine);
  }
  pathLine.textContent = path;
  pathLine.title = path;
}

function groupingMatches(groups) {
  const current = [...folders.querySelectorAll(':scope > .folder-mode-group')];
  if (current.length !== groups.length) return false;
  return groups.every(([mode, rows], index) => {
    const group = current[index];
    if (group.dataset.folderGroup !== mode) return false;
    const currentRows = [...group.querySelectorAll(':scope > .folder-mode-list > [data-folder-path]')];
    return currentRows.length === rows.length && currentRows.every((row, rowIndex) => row === rows[rowIndex]);
  });
}

function groupFolders() {
  const rows = [...folders.querySelectorAll('[data-folder-path]')];
  if (!rows.length) return;

  const protectedRows = rows.filter(row => row.classList.contains('protected-folder'));
  const browseRows = rows.filter(row => row.classList.contains('browse-only'));
  const groups = [
    ['protected', protectedRows],
    ['browse', browseRows]
  ].filter(([, items]) => items.length);

  if (groupingMatches(groups)) return;

  const fragment = document.createDocumentFragment();
  for (const [mode, items] of groups) {
    const group = document.createElement('section');
    group.className = 'folder-mode-group';
    group.dataset.folderGroup = mode;

    const head = document.createElement('div');
    head.className = 'folder-group-head';
    const label = mode === 'protected' ? 'Protected' : 'Browse only';
    head.innerHTML = `<span>${label}</span><small>${items.length.toLocaleString()}</small>`;

    const list = document.createElement('div');
    list.className = 'folder-mode-list';
    for (const row of items) list.append(row);
    group.append(head, list);
    fragment.append(group);
  }
  folders.replaceChildren(fragment);
}

async function annotate() {
  if (loading) { queued = true; return; }
  loading = true;
  queued = false;
  try {
    const state = await request('/api/state');
    const configured = state.settings?.folders || [];
    const empty = folders.querySelector(':scope > .empty-state');
    if (empty) empty.textContent = 'No folders';

    for (const row of folders.querySelectorAll('[data-folder-path]')) {
      const item = configured.find(folder => samePath(folder.path, row.dataset.folderPath));
      if (!item) continue;
      const protectedFolder = item.protected !== false;
      cleanFolderTitle(row);
      modeBadge(row, protectedFolder);
      row.classList.toggle('browse-only', !protectedFolder);
      row.classList.toggle('protected-folder', protectedFolder);

      const sync = row.querySelector('[data-sync-folder]');
      const status = row.querySelector('[data-folder-status]');
      const progressVisible = Boolean(row.querySelector('[data-item-progress]:not([hidden])'));
      const actions = row.querySelector('.item-actions');
      const remove = row.querySelector('[data-remove-folder]');

      if (sync) sync.textContent = protectedFolder ? 'Sync' : 'Index';
      if (!progressVisible && status && !protectedFolder) status.textContent = 'Indexed locally';
      if (!progressVisible && status && protectedFolder && !item.lastSynced) status.textContent = 'Waiting to sync';
      if (remove) {
        remove.title = protectedFolder ? 'Stop protecting this folder' : 'Stop browsing this folder';
        remove.setAttribute('aria-label', remove.title);
      }

      const existingProtect = actions?.querySelector('[data-protect-folder]');
      if (!protectedFolder && actions && !existingProtect) {
        const button = document.createElement('button');
        button.className = 'action-link primary-action';
        button.dataset.protectFolder = item.path;
        button.textContent = 'Protect';
        button.title = 'Keep this local folder and add a Mochimono copy';
        actions.prepend(button);
      } else if (protectedFolder) existingProtect?.remove();
    }

    groupFolders();
  } catch {}
  finally {
    loading = false;
    if (queued) queueMicrotask(annotate);
  }
}

function annotateSoon() {
  if (queued) return;
  queued = true;
  queueMicrotask(annotate);
}

function suggest(mode = '') {
  startBrowse?.classList.toggle('suggested', mode === 'browse');
  startProtect?.classList.toggle('suggested', mode === 'protect');
}

startBrowse?.addEventListener('click', async () => {
  const path = importPath.value.trim();
  if (!path) return;
  startBrowse.disabled = true;
  try {
    await request('/api/browse-folders', { method: 'POST', body: JSON.stringify({ path }) });
    importPath.value = '';
    folderAdd.hidden = true;
    showFolderAdd.classList.remove('active');
    suggest();
    annotateSoon();
    setTimeout(refreshLibrary, 350);
  } finally { startBrowse.disabled = false; }
});

startProtect?.addEventListener('click', () => suggest());

folders?.addEventListener('click', async event => {
  const button = event.target.closest('[data-protect-folder]');
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  button.disabled = true;
  try {
    await request('/api/browse-folders/protect', { method: 'POST', body: JSON.stringify({ path: button.dataset.protectFolder }) });
    annotateSoon();
    setTimeout(refreshLibrary, 350);
  } finally { button.disabled = false; }
}, true);

window.addEventListener('mochimono-folder-intent-ui', event => {
  const mode = event.detail?.mode === 'browse' ? 'browse' : 'protect';
  suggest(mode);
  if (folderAdd.hidden) showFolderAdd?.click();
});

if (folders) new MutationObserver(annotateSoon).observe(folders, { childList: true, subtree: true });
annotateSoon();
