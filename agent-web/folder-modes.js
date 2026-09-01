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
  #folders:has(.folder-mode-group){gap:26px!important}
  .folder-mode-group{display:grid;gap:10px;min-width:0}
  .folder-group-head{display:flex;align-items:center;gap:8px;padding:0 2px;color:#a9a19e}
  .folder-group-head span{font-size:12px;font-weight:700;letter-spacing:-.01em}
  .folder-group-head small{color:#6f6866;font-size:10px;font-weight:650}
  .folder-mode-list{display:grid;gap:0;min-width:0}
`;
document.head.append(groupStyle);

const samePath = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();

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
  badge.textContent = protectedFolder ? 'Cloud synced' : 'Browse only';
  badge.title = protectedFolder
    ? 'This folder is indexed locally and copied to Mochimono.'
    : 'This folder is indexed on this device only. Nothing is uploaded.';
}

function ensureOpenButton(row, path) {
  const actions = row.querySelector('.item-actions');
  if (!actions) return;
  let button = actions.querySelector('[data-open-native-folder]');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon tiny storage-open-folder';
    button.dataset.openNativeFolder = '';
    button.setAttribute('aria-label', 'Open folder');
    button.title = 'Open folder';
    button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.8 5.7h5l1.5-1.8h2.5l1.3 1.8h4.1v9.4H2.8z"/></svg>';
    actions.prepend(button);
  }
  button.dataset.path = path;
}

function cleanFolderTitle(row) {
  const path = row.dataset.folderPath || '';
  const strong = row.querySelector('.storage-title strong');
  if (strong) {
    strong.textContent = path;
    strong.title = `Open ${path}`;
    strong.dataset.openNativeFolderPath = path;
  }
  row.querySelector('.storage-path')?.remove();
  ensureOpenButton(row, path);
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
    const label = mode === 'protected' ? 'Cloud synced' : 'Browse only';
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
        remove.title = protectedFolder ? 'Stop syncing this folder' : 'Stop browsing this folder';
        remove.setAttribute('aria-label', remove.title);
      }

      const existingProtect = actions?.querySelector('[data-protect-folder]');
      if (!protectedFolder && actions && !existingProtect) {
        const button = document.createElement('button');
        button.className = 'action-link primary-action';
        button.dataset.protectFolder = item.path;
        button.textContent = 'Protect';
        button.title = 'Add this folder to Mochimono cloud storage';
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

async function openFolder(path) {
  if (!path) return;
  await request('/api/open-folder', { method: 'POST', body: JSON.stringify({ path }) });
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
  const openButton = event.target.closest('[data-open-native-folder]');
  const pathTitle = event.target.closest('[data-open-native-folder-path]');
  if (openButton || pathTitle) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const path = openButton?.dataset.path || pathTitle?.dataset.openNativeFolderPath;
    try { await openFolder(path); } catch {}
    return;
  }

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
