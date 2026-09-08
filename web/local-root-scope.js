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

let activeScope = null;
let restoreGeneration = 0;
let suppressLocationChange = false;

const library = () => window.mochimonoLibrary;

function wantedScope() {
  const url = new URL(location.href);
  const root = String(url.searchParams.get('root') || '').trim();
  if (root) return { kind:'root', key:root };
  const browser = String(url.searchParams.get('browser') || '').trim();
  return browser ? { kind:'browser', key:browser } : null;
}

function sameScope(a, b) {
  return Boolean(a && b && a.kind === b.kind && a.key === b.key);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'\"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function pathName(path) {
  const clean = String(path || '').replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).filter(Boolean).at(-1) || clean || 'Source folder';
}

function syncUrl(scope, mode = 'replace') {
  const url = new URL(location.href);
  url.searchParams.delete('root');
  url.searchParams.delete('browser');
  if (scope?.kind === 'root') url.searchParams.set('root', scope.key);
  else if (scope?.kind === 'browser') url.searchParams.set('browser', scope.key);
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

async function waitForBrowserFolders(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const api = window.mochimonoBrowserFolders;
    if (api?.list && api?.tree) return api;
    await delay(50);
  }
  throw new Error('Browser folders could not finish loading.');
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

async function nativeScope(root) {
  const encoded = encodeURIComponent(root);
  const hashes = new Set();
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
  return { hashes, label:root, kindLabel:'Source folder', filterLabel:`Folder · ${pathName(root)}` };
}

function cleanParts(value) {
  return String(value || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.' && part !== '..');
}

function browserTreeRoot(item) {
  const raw = String(item?.rootPath || item?.name || '').trim();
  const normalized = raw.replaceAll('\\', '/');
  if (/^[a-z]:\//i.test(normalized)) {
    const parts = cleanParts(normalized);
    if (parts.length) parts[0] = parts[0].toUpperCase();
    return parts.join('/');
  }
  if (normalized.startsWith('/')) return ['Root', ...cleanParts(normalized)].join('/');
  return ['Browser', ...cleanParts(raw || item?.name || 'Folder')].join('/');
}

async function browserScope(id) {
  const api = await waitForBrowserFolders();
  const item = (await api.list()).find(source => String(source.id) === String(id));
  if (!item) throw new Error('Browser folder not found.');

  const hashes = new Set();
  const queue = [browserTreeRoot(item)];
  const seen = new Set();
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const tree = await api.tree(path);
    for (const file of tree?.files || []) {
      if (String(file?.browserSourceId) !== String(id)) continue;
      const hash = String(file?.hash || '');
      if (/^[a-f0-9]{64}$/.test(hash)) hashes.add(hash);
    }
    for (const folder of tree?.folders || []) if (folder?.path) queue.push(String(folder.path));
  }

  const label = String(item.rootPath || item.name || 'Browser folder');
  return { hashes, label, kindLabel:'Browser folder', filterLabel:`Browser · ${pathName(label)}` };
}

async function resolveScope(scope) {
  return scope.kind === 'browser' ? browserScope(scope.key) : nativeScope(scope.key);
}

function notifyFilterUi() {
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
}

function ensureScopeOption(info) {
  if (!locationFilter) return;
  let option = locationFilter.querySelector('option[data-local-root]');
  if (!option) {
    option = document.createElement('option');
    option.value = 'source-folder';
    option.dataset.localRoot = '';
    locationFilter.append(option);
  }
  option.textContent = info.filterLabel;
  option.title = info.label;
  suppressLocationChange = true;
  locationFilter.value = option.value;
  suppressLocationChange = false;
  notifyFilterUi();
}

function removeScopeOption() {
  locationFilter?.querySelector('option[data-local-root]')?.remove();
  if (locationFilter?.value === 'source-folder') locationFilter.value = '';
  notifyFilterUi();
}

function renderScope(info, count = null) {
  if (!info) {
    scopebar.hidden = true;
    scopebar.replaceChildren();
    return;
  }
  const countText = count == null ? '<small>Loading…</small>' : `<small>${Number(count).toLocaleString()} files</small>`;
  scopebar.hidden = false;
  scopebar.innerHTML = `<div class="scope-breadcrumbs">
    <button type="button" data-root-home>All files</button>
    <span class="scope-separator">›</span>
    <span class="scope-kind">${escapeHtml(info.kindLabel)}</span>
    <span class="scope-separator">›</span>
    <strong title="${escapeHtml(info.label)}">${escapeHtml(info.label)}</strong>
    ${countText}
    <button type="button" class="scope-clear" data-root-clear title="Clear folder filter" aria-label="Clear folder filter">×</button>
  </div>`;
}

function clearAppliedScope({ clearFilter = true } = {}) {
  const scopeFilterWasActive = locationFilter?.value === 'source-folder';
  activeScope = null;
  removeScopeOption();
  renderScope(null);
  if (clearFilter && scopeFilterWasActive) library()?.setLocationFilter?.('', null);
}

async function applyScope(scope) {
  const generation = ++restoreGeneration;
  const api = await waitForLibrary();
  const provisional = scope.kind === 'browser'
    ? { label:'Browser folder', kindLabel:'Browser folder', filterLabel:'Browser folder' }
    : { label:scope.key, kindLabel:'Source folder', filterLabel:`Folder · ${pathName(scope.key)}` };
  renderScope(provisional);
  const info = await resolveScope(scope);
  if (generation !== restoreGeneration || !sameScope(wantedScope(), scope)) return;
  ensureScopeOption(info);
  api.setLocationFilter('source-folder', info.hashes);
  activeScope = { ...scope, label:info.label, kindLabel:info.kindLabel };
  renderScope(info, info.hashes.size);
}

async function openScope(scope, historyMode = 'push') {
  if (!scope?.key) return;
  window.mochimonoHome?.('replace');
  syncUrl(scope, historyMode);
  await applyScope(scope);
  window.scrollTo({ top:0, left:0, behavior:'auto' });
}

async function open(root, historyMode = 'push') {
  const key = String(root || '').trim();
  if (key) await openScope({ kind:'root', key }, historyMode);
}

async function openBrowser(id, historyMode = 'push') {
  const key = String(id || '').trim();
  if (key) await openScope({ kind:'browser', key }, historyMode);
}

async function restore() {
  const wanted = wantedScope();
  if (!wanted) {
    if (activeScope || locationFilter?.value === 'source-folder') clearAppliedScope();
    return;
  }
  if (sameScope(wanted, activeScope)) return;
  try { await applyScope(wanted); }
  catch (error) { console.warn('Could not restore folder scope.', error); }
}

function leaveScopeForOtherScope({ clearFilter = true } = {}) {
  if (!activeScope && !wantedScope()) return;
  restoreGeneration++;
  syncUrl(null, 'replace');
  clearAppliedScope({ clearFilter });
}

scopebar.addEventListener('click', event => {
  if (!event.target.closest('[data-root-home],[data-root-clear]')) return;
  window.mochimonoHome?.('push');
});

locationFilter?.addEventListener('change', () => {
  if (suppressLocationChange) return;
  if (locationFilter.value !== 'source-folder') leaveScopeForOtherScope({ clearFilter:false });
});

source?.addEventListener('change', () => {
  if (source.value) leaveScopeForOtherScope();
});

window.addEventListener('mochimono:folder-changed', () => {
  if (library()?.folderState?.().importId) leaveScopeForOtherScope();
});
window.addEventListener('popstate', () => void restore());

window.mochimonoLocalRoot = {
  open,
  openBrowser,
  restore,
  current: () => activeScope || wantedScope()
};

if (CLIENT || wantedScope()) queueMicrotask(() => void restore());
