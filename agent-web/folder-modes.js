const folders = document.querySelector('#folders');
const startBrowse = document.querySelector('#startBrowse');
const importPath = document.querySelector('#importPath');
const folderAdd = document.querySelector('#folderAdd');
const showFolderAdd = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');
let loading = false;

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

async function annotate() {
  if (loading || !folders) return;
  loading = true;
  try {
    const state = await request('/api/state');
    const browse = (state.settings?.folders || []).filter(folder => folder.protected === false);
    for (const row of folders.querySelectorAll('[data-folder-path]')) {
      const item = browse.find(folder => samePath(folder.path, row.dataset.folderPath));
      row.classList.toggle('browse-only', Boolean(item));
      const sync = row.querySelector('[data-sync-folder]');
      const status = row.querySelector('[data-folder-status]');
      const actions = row.querySelector('.item-actions');
      if (item) {
        if (sync) sync.textContent = 'Index';
        if (status && !row.querySelector('[data-item-progress]:not([hidden])')) status.textContent = 'Browse only';
        if (actions && !actions.querySelector('[data-protect-folder]')) {
          const button = document.createElement('button');
          button.className = 'action-link primary-action';
          button.dataset.protectFolder = item.path;
          button.textContent = 'Protect';
          actions.prepend(button);
        }
      } else {
        if (sync) sync.textContent = 'Sync';
        actions?.querySelector('[data-protect-folder]')?.remove();
      }
    }
  } catch {}
  finally { loading = false; }
}

const annotateSoon = () => {
  setTimeout(annotate, 120);
  setTimeout(annotate, 700);
};

startBrowse?.addEventListener('click', async () => {
  const path = importPath.value.trim();
  if (!path) return;
  startBrowse.disabled = true;
  try {
    await request('/api/browse-folders', { method: 'POST', body: JSON.stringify({ path }) });
    importPath.value = '';
    folderAdd.hidden = true;
    showFolderAdd.classList.remove('active');
    annotateSoon();
    setTimeout(refreshLibrary, 500);
  } finally { startBrowse.disabled = false; }
});

folders?.addEventListener('click', async event => {
  const button = event.target.closest('[data-protect-folder]');
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  button.disabled = true;
  try {
    await request('/api/browse-folders/protect', { method: 'POST', body: JSON.stringify({ path: button.dataset.protectFolder }) });
    annotateSoon();
    setTimeout(refreshLibrary, 500);
  } finally { button.disabled = false; }
}, true);

annotateSoon();
