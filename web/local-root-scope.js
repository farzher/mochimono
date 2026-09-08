const CLIENT = document.documentElement.classList.contains('client-library');
const locationFilter = document.querySelector('#locationFilter');
const scopebar = document.querySelector('#scopebar');
const source = document.querySelector('#source');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
}

function removeRootOption() {
  locationFilter?.querySelector('option[data-local-root]')?.remove();
  if (locationFilter?.value === 'source-folder') locationFilter.value = '';
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
}

function renderScope(root, count = null) {
  if (!scopebar) return;
  if (!root) {
    scopebar.hidden = true;
    scopebar.replaceChildren();
    return;
  }
  const countText = count == null ? '' : `<small>${Number(count).toLocaleString()} files</small>`;
  scopebar.hidden = false;
  scopebar.innerHTML = `<div class="scope-breadcrumbs">
    <button type="button" data-root-home>All files</button>
    <span>›</span>
    <span class="scope-kind">Source folder</span>
    <span>›</span>
    <strong title="${escapeHtml(root)}">${escapeHtml(root)}</strong>
    ${countText}
    <button type="button" class="scope-clear" data-root-clear title="Clear folder filter" aria-label="Clear folder filter">×</button>
  </div>`;
}

function clearAppliedRoot({ clearFilter = true } = {}) {
  activeRoot = '';
  removeRootOption();
  renderScope('');
  if (clearFilter) library()?.setLocationFilter?.('', null);
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

function leaveRootForOtherScope() {
  if (!activeRoot && !urlRoot()) return;
  restoreGeneration++;
  syncUrl('', 'replace');
  clearAppliedRoot({ clearFilter:false });
}

scopebar?.addEventListener('click', event => {
  if (!event.target.closest('[data-root-home],[data-root-clear]')) return;
  window.mochimonoHome?.('push');
});

locationFilter?.addEventListener('change', () => {
  if (suppressLocationChange) return;
  if (locationFilter.value !== 'source-folder') leaveRootForOtherScope();
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
