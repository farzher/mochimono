const folders = document.querySelector('#folders');
const startBrowse = document.querySelector('#startBrowse');
const startProtect = document.querySelector('#startImport');
const importPath = document.querySelector('#importPath');
const folderAdd = document.querySelector('#folderAdd');
const showFolderAdd = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');
let loading = false;
let queued = false;

const style = document.createElement('style');
style.textContent = `
  .storage-mode{display:inline-flex;margin-left:8px;padding:2px 6px;border-radius:999px;background:#211e22;color:#8f8784;font-size:9px;font-weight:700;vertical-align:1px}
  .storage-mode.protected{color:#b8d1be}.storage-mode.local{color:#9da3af}
  .storage-open-folder svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round}
`;
document.head.append(style);

const samePath = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };

function toast(text) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove('show'), 2800);
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type':'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function refreshLibrary() {
  frame?.contentWindow?.mochimonoLibrary?.refresh?.().catch?.(() => {});
  frame?.contentWindow?.mochimonoLocations?.refresh?.().catch?.(() => {});
}

function decorateRow(row, folder) {
  const protectedFolder = folder.protected !== false;
  const title = row.querySelector('.storage-title strong');
  if (title) {
    setText(title, folder.path);
    title.title = 'Show in folder';
    title.dataset.openNativeFolderPath = folder.path;
  }

  let badge = row.querySelector('[data-folder-mode]');
  if (!badge) {
    badge = document.createElement('span');
    badge.dataset.folderMode = '';
    title?.after(badge);
  }
  badge.className = `storage-mode ${protectedFolder ? 'protected' : 'local'}`;
  setText(badge, protectedFolder ? 'Protected' : 'Browse only');

  const actions = row.querySelector('.item-actions');
  let open = actions?.querySelector('[data-open-native-folder]');
  if (actions && !open) {
    open = document.createElement('button');
    open.type = 'button';
    open.className = 'icon tiny storage-open-folder';
    open.dataset.openNativeFolder = '';
    open.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.8 5.7h5l1.5-1.8h2.5l1.3 1.8h4.1v9.4H2.8z"/></svg>';
    actions.prepend(open);
  }
  if (open) {
    open.dataset.path = folder.path;
    open.title = 'Show in folder';
    open.setAttribute('aria-label', 'Show in folder');
  }

  const sync = row.querySelector('[data-sync-folder]');
  if (sync) setText(sync, protectedFolder ? 'Sync' : 'Index');
  const status = row.querySelector('[data-folder-status]');
  if (!protectedFolder && status) setText(status, 'Local');
  else if (protectedFolder && status && !folder.lastSynced) setText(status, 'Waiting to sync');

  const remove = row.querySelector('[data-remove-folder]');
  if (remove) {
    const label = protectedFolder ? 'Stop protecting' : 'Stop browsing';
    remove.title = label;
    remove.setAttribute('aria-label', label);
  }

  const existingProtect = actions?.querySelector('[data-protect-folder]');
  if (!protectedFolder && actions && !existingProtect) {
    const button = document.createElement('button');
    button.className = 'action-link primary-action';
    button.dataset.protectFolder = folder.path;
    button.textContent = 'Protect';
    actions.prepend(button);
  } else if (protectedFolder) existingProtect?.remove();
}

async function annotate() {
  if (loading) { queued = true; return; }
  loading = true;
  queued = false;
  try {
    const state = await request('/api/state');
    const configured = state.settings?.folders || [];
    for (const row of folders?.querySelectorAll('[data-folder-path]') || []) {
      const folder = configured.find(item => samePath(item.path, row.dataset.folderPath));
      if (folder) decorateRow(row, folder);
    }
  } catch {}
  finally {
    loading = false;
    if (queued) queueMicrotask(annotate);
  }
}

const annotateSoon = () => {
  if (queued) return;
  queued = true;
  queueMicrotask(annotate);
};

startBrowse?.addEventListener('click', async () => {
  const path = importPath.value.trim();
  if (!path) return;
  startBrowse.disabled = true;
  try {
    await request('/api/browse-folders', { method:'POST', body:JSON.stringify({ path }) });
    importPath.value = '';
    folderAdd.hidden = true;
    showFolderAdd.classList.remove('active');
    annotateSoon();
    setTimeout(refreshLibrary, 350);
  } catch (error) { toast(error.message); }
  finally { startBrowse.disabled = false; }
});

folders?.addEventListener('click', async event => {
  const open = event.target.closest('[data-open-native-folder]');
  const title = event.target.closest('[data-open-native-folder-path]');
  if (open || title) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const path = open?.dataset.path || title?.dataset.openNativeFolderPath;
    try { await request('/api/open-folder', { method:'POST', body:JSON.stringify({ path }) }); }
    catch (error) { toast(error.message); }
    return;
  }

  const protect = event.target.closest('[data-protect-folder]');
  if (!protect) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  protect.disabled = true;
  try {
    await request('/api/browse-folders/protect', { method:'POST', body:JSON.stringify({ path:protect.dataset.protectFolder }) });
    annotateSoon();
    setTimeout(refreshLibrary, 350);
  } catch (error) { toast(error.message); }
  finally { protect.disabled = false; }
}, true);

window.addEventListener('mochimono-folder-intent-ui', event => {
  if (folderAdd.hidden) showFolderAdd?.click();
  if (event.detail?.mode === 'browse') startBrowse?.focus();
  else startProtect?.focus();
});

if (folders) new MutationObserver(annotateSoon).observe(folders, { childList:true, subtree:true });
annotateSoon();
