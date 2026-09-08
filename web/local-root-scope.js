const CLIENT = document.documentElement.classList.contains('client-library');
const locationFilter = document.querySelector('#locationFilter');
const source = document.querySelector('#source');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let scopebar = document.querySelector('#localRootScopebar');
if (!scopebar) {
  scopebar = document.createElement('div');
  scopebar.id = 'localRootScopebar';
  scopebar.className = 'local-root-scopebar';
  scopebar.hidden = true;
  const folderbar = document.querySelector('#folderbar');
  if (folderbar) folderbar.after(scopebar);
  else document.querySelector('.commandbar')?.after(scopebar);
}

const style = document.createElement('style');
style.textContent = `
  .local-root-scopebar{display:flex;align-items:center;min-width:0;padding:10px 2px 2px}
  .local-root-scopebar[hidden]{display:none!important}
  .local-root-scopebar .scope-breadcrumbs{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;white-space:nowrap}
  .local-root-scopebar button{flex:0 0 auto;padding:5px 7px;border-radius:7px;background:transparent;color:#bbb1ae;font-size:12px}
  .local-root-scopebar button:hover{background:#211e22;color:#fff}
  .local-root-scopebar .scope-separator{flex:0 0 auto;color:#676061;font-size:12px}
  .local-root-scopebar .scope-kind{flex:0 0 auto;color:#8f8583;font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.045em}
  .local-root-scopebar strong{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#ddd4d0;font-size:12px;font-weight:650}
  .local-root-scopebar small{flex:0 0 auto;color:#746d6c;font-size:9px}
  .local-root-scopebar .scope-clear{width:27px;height:27px;display:grid;place-items:center;padding:0;color:#817978;font-size:17px;line-height:1}
  @media(max-width:700px){.local-root-scopebar{padding-top:8px}.local-root-scopebar .scope-kind,.local-root-scopebar small{display:none}}
`;
document.head.append(style);

let activeRoot = '';
let restoreGeneration = 0;
let suppressLocationChange = false;

const library = () => window.mochimonoLibrary;
const urlRoot = () => new URL(location.href).searchParams.get('root') || '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'\"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function pathName(path) {
  const clean = String(path || '').replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).filter(Boolean).at(-1) || clean || 'Source folder';
}

function syncUrl(root, mode = 'replace') {
  const url = new URL(location.href);
  if (root) url.searchParams.set('root', root);
  else url.searchParams.delete('root');
  if (url.href === location.href) return;
  history[mode === 'push' ? 'pushState' : 'replaceState'](history.state, '', url);
}

async function waitForLibrary(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (library()?.setLocationFilter) return library();
    await delay(50);
  }
  throw new Error('Library could not finish loading.');
}

async function request(path) {
  const response = await fetch(path, { cache:'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function addHashes(target, data) {
  for (const file of data?.files || []) {
    const hash = String(file?.hash || '');
    if (/^[a-f0-9]{64}$/.test(hash)) target.add(hash);
  }
}

async function hashesForRoot(root) {
  const encoded = encodeURIComponent(root);
  const hashes = new Set();

  // Include live browse-stage rows, then page the persisted local index so the
  // scope is complete even for very large folders.
  addHashes(hashes, await request(`/api/client/local-catalog?limit=5000&path=${encoded}`));
  let offset = 0;
  for (;;) {
    const page = await request(`/api/client/local-catalog?limit=5000&path=${encoded}&offset=${offset}`);
    addHashes(hashes, page);
    if (page.nextOffset == null) break;
    const next = Number(page.nextOffset);
    if (!Number.isFinite(next) || next <= offset) break;
    offset = next;
  }
  return hashes;
}

function notifyFilterUi() {
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
}

function ensureRootOption(root) {
  if (!locationFilter) return;
  let option = locationFilter.querySelector('option[data-local-root]');
  if (!option) {
    option = document.createElement('option');
    option.value = 'source-folder';
    option.dataset.localRoot = '';
    locationFilter.append(option);
  }
  option.textContent = `Folder · ${pathName(root)}`;
  option.title = root;
  suppressLocationChange = true;
  locationFilter.value = option.value;
  suppressLocationChange = false;
  notifyFilterUi();
}

function removeRootOption() {
  locationFilter?.querySelector('option[data-local-root]')?.remove();
  if (locationFilter?.value === 'source-folder') locationFilter.value = '';
  notifyFilterUi();
}

function renderScope(root, count = null) {
  if (!root) {
    scopebar.hidden = true;
    scopebar.replaceChildren();
    return;
  }
  const countText = count == null ? '' : `<small>${Number(count).toLocaleString()} files</small>`;
  scopebar.hidden = false;
  scopebar.innerHTML = `<div class="scope-breadcrumbs">
    <button type="button" data-root-home>All files</button>
    <span class="scope-separator">›</span>
    <span class="scope-kind">Source folder</span>
    <span class="scope-separator">›</span>
    <strong title="${escapeHtml(root)}">${escapeHtml(root)}</strong>
    ${countText}
    <button type="button" class="scope-clear" data-root-clear title="Clear folder filter" aria-label="Clear folder filter">×</button>
  </div>`;
}

function clearAppliedRoot({ clearFilter = true } = {}) {
  const rootFilterWasActive = locationFilter?.value === 'source-folder';
  activeRoot = '';
  removeRootOption();
  renderScope('');
  if (clearFilter && rootFilterWasActive) library()?.setLocationFilter?.('', null);
}

async function applyRoot(root) {
  const generation = ++restoreGeneration;
  const wanted = String(root || '').trim();
  if (!wanted) {
    clearAppliedRoot();
    return;
  }

  renderScope(wanted);
  ensureRootOption(wanted);
  const api = await waitForLibrary();
  const hashes = await hashesForRoot(wanted);
  if (generation !== restoreGeneration || urlRoot() !== wanted) return;
  activeRoot = wanted;
  api.setLocationFilter('source-folder', hashes);
  renderScope(wanted, hashes.size);
}

async function open(root, historyMode = 'push') {
  const wanted = String(root || '').trim();
  if (!wanted) return;

  // A Storage-folder click is navigation to a new scope, not an extra hidden
  // filter layered on top of whatever the user happened to be viewing before.
  window.mochimonoHome?.('replace');
  syncUrl(wanted, historyMode);
  await applyRoot(wanted);
  window.scrollTo({ top:0, left:0, behavior:'auto' });
}

async function restore() {
  const wanted = urlRoot();
  if (!wanted) {
    if (activeRoot || locationFilter?.value === 'source-folder') clearAppliedRoot();
    return;
  }
  if (wanted === activeRoot) {
    renderScope(wanted);
    return;
  }
  try { await applyRoot(wanted); }
  catch (error) { console.warn('Could not restore local folder scope.', error); }
}

function leaveRootForOtherScope({ clearFilter = true } = {}) {
  if (!activeRoot && !urlRoot()) return;
  restoreGeneration++;
  syncUrl('', 'replace');
  clearAppliedRoot({ clearFilter });
}

scopebar.addEventListener('click', event => {
  if (!event.target.closest('[data-root-home],[data-root-clear]')) return;
  window.mochimonoHome?.('push');
});

locationFilter?.addEventListener('change', () => {
  if (suppressLocationChange) return;
  if (locationFilter.value !== 'source-folder') leaveRootForOtherScope({ clearFilter:false });
});

source?.addEventListener('change', () => {
  if (source.value) leaveRootForOtherScope();
});

window.addEventListener('mochimono:folder-changed', () => {
  if (library()?.folderState?.().importId) leaveRootForOtherScope();
});
window.addEventListener('popstate', () => void restore());

window.mochimonoLocalRoot = {
  open,
  restore,
  current: () => activeRoot || urlRoot()
};

if (CLIENT || urlRoot()) queueMicrotask(() => void restore());
