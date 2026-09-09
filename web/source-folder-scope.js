const CLIENT = document.documentElement.classList.contains('client-library');
const locationFilter = document.querySelector('#locationFilter');
const CACHE_MS = 5000;

let activePath = '';
let activeKind = 'Source folder';
let generation = 0;
const cache = new Map();

let scopebar = document.querySelector('#sourceFolderScopebar');
if (!scopebar) {
  scopebar = document.createElement('div');
  scopebar.id = 'sourceFolderScopebar';
  scopebar.className = 'source-folder-scopebar';
  scopebar.hidden = true;
  document.querySelector('#folderbar')?.after(scopebar);
}

const style = document.createElement('style');
style.textContent = `
.source-folder-scopebar{display:flex;align-items:center;min-width:0;padding:10px 2px 2px}
.source-folder-scopebar[hidden]{display:none!important}
.source-folder-scopebar .scope-breadcrumbs{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;white-space:nowrap}
.source-folder-scopebar button{flex:0 0 auto;padding:5px 7px;border-radius:7px;background:transparent;color:#bbb1ae;font-size:12px}
.source-folder-scopebar button:hover{background:#211e22;color:#fff}
.source-folder-scopebar .scope-separator{color:#676061;font-size:12px}
.source-folder-scopebar .scope-kind{color:#8f8583;font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:.045em}
.source-folder-scopebar strong{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#ddd4d0;font-size:12px;font-weight:650}
.source-folder-scopebar small{flex:0 0 auto;color:#746d6c;font-size:9px}
.source-folder-scopebar .scope-clear{width:27px;height:27px;display:grid;place-items:center;padding:0;color:#817978;font-size:17px;line-height:1}
@media(max-width:700px){.source-folder-scopebar{padding-top:8px}.source-folder-scopebar .scope-kind,.source-folder-scopebar small{display:none}}
`;
document.head.append(style);

const pathKey = value => String(value || '').trim().replaceAll('/', '\\').replace(/[\\]+$/, '').toLowerCase();
const urlPath = () => String(new URL(location.href).searchParams.get('folder') || '').trim();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'\"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function writeUrl(path, mode = 'replace') {
  const url = new URL(location.href);
  if (path) url.searchParams.set('folder', path);
  else url.searchParams.delete('folder');
  if (url.href === location.href) return;
  history[mode === 'push' ? 'pushState' : 'replaceState'](history.state, '', url);
}

function render(path = activePath, kind = activeKind, count = null) {
  if (!path) {
    scopebar.hidden = true;
    scopebar.replaceChildren();
    return;
  }
  scopebar.hidden = false;
  scopebar.innerHTML = `<div class="scope-breadcrumbs">
    <button type="button" data-source-folder-home>All files</button>
    <span class="scope-separator">›</span>
    <span class="scope-kind">${escapeHtml(kind)}</span>
    <span class="scope-separator">›</span>
    <strong title="${escapeHtml(path)}">${escapeHtml(path)}</strong>
    ${count == null ? '<small>Loading…</small>' : `<small>${Number(count).toLocaleString()} files</small>`}
    <button type="button" class="scope-clear" data-source-folder-clear title="Clear folder filter" aria-label="Clear folder filter">×</button>
  </div>`;
}

async function request(path) {
  const response = await fetch(path, { cache:'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function addHashes(target, files) {
  for (const file of files || []) {
    const hash = String(file?.hash || '');
    if (/^[a-f0-9]{64}$/.test(hash)) target.add(hash);
  }
}

async function nativeMembership(path) {
  const hashes = new Set();
  let offset = 0;
  for (;;) {
    const data = await request(`/api/client/local-catalog?limit=5000&path=${encodeURIComponent(path)}&offset=${offset}`);
    addHashes(hashes, data.files);
    if (data.nextOffset == null) break;
    const next = Number(data.nextOffset);
    if (!Number.isFinite(next) || next <= offset) break;
    offset = next;
  }
  return { hashes, kind:'Source folder' };
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

async function browserMembership(source, api) {
  const hashes = new Set();
  const pending = [browserTreeRoot(source)];
  const seen = new Set();
  while (pending.length) {
    const path = pending.shift();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const tree = await api.tree(path);
    for (const file of tree?.files || []) {
      if (String(file?.browserSourceId) !== String(source.id)) continue;
      const hash = String(file?.hash || '');
      if (/^[a-f0-9]{64}$/.test(hash)) hashes.add(hash);
    }
    for (const folder of tree?.folders || []) if (folder?.path) pending.push(String(folder.path));
  }
  return { hashes, kind:'Browser folder' };
}

async function resolveMembership(path) {
  const key = pathKey(path);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const browserApi = window.mochimonoBrowserFolders;
  if (browserApi?.list && browserApi?.tree) {
    const sources = await browserApi.list().catch(() => []);
    const source = sources.find(item => pathKey(item.rootPath || item.name) === key);
    if (source) {
      const value = await browserMembership(source, browserApi);
      cache.set(key, { at:Date.now(), value });
      return value;
    }
  }

  const value = await nativeMembership(path);
  cache.set(key, { at:Date.now(), value });
  return value;
}

function clearApplied({ clearLibrary = true } = {}) {
  const owned = window.mochimonoLibrary?.state?.().locationFilter === 'source-folder';
  activePath = '';
  activeKind = 'Source folder';
  render('');
  if (clearLibrary && owned) window.mochimonoLibrary?.setLocationFilter?.('', null);
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
}

async function apply(path, { reset = false } = {}) {
  const wanted = String(path || '').trim();
  if (!wanted) {
    clearApplied();
    return { path:'', kind:'Source folder', count:0 };
  }
  if (!window.mochimonoLibrary?.setLocationFilter) throw new Error('Library is still loading.');

  if (reset) window.mochimonoHome?.('replace');
  const token = ++generation;
  render(wanted, 'Source folder');
  const membership = await resolveMembership(wanted);
  if (token !== generation) return null;

  activePath = wanted;
  activeKind = membership.kind;
  window.mochimonoLibrary.setLocationFilter('source-folder', membership.hashes);
  render(wanted, membership.kind, membership.hashes.size);
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
  return { path:wanted, kind:membership.kind, count:membership.hashes.size };
}

function commit(path, mode = 'replace') {
  writeUrl(String(path || '').trim(), mode);
}

async function open(path, mode = 'push') {
  const result = await apply(path, { reset:true });
  if (!result) return null;
  commit(result.path, mode);
  window.scrollTo({ top:0, left:0, behavior:'auto' });
  return result;
}

async function restore() {
  const wanted = urlPath();
  if (!wanted) {
    generation++;
    clearApplied();
    return;
  }
  if (pathKey(wanted) === pathKey(activePath)) return;
  try { await apply(wanted); }
  catch (error) { console.warn('Could not restore source folder scope.', error); }
}

scopebar.addEventListener('click', event => {
  if (!event.target.closest('[data-source-folder-home],[data-source-folder-clear]')) return;
  window.mochimonoHome?.('push');
});

locationFilter?.addEventListener('change', () => {
  if (!activePath && !urlPath()) return;
  generation++;
  writeUrl('', 'replace');
  clearApplied({ clearLibrary:false });
});

window.addEventListener('popstate', () => void restore());
window.addEventListener('mochimono:catalog-updated', () => cache.clear());
window.addEventListener('mochimono:browser-folder-sync', () => cache.clear());

window.mochimonoSourceFolder = {
  apply,
  commit,
  open,
  clear({ updateUrl = true } = {}) {
    generation++;
    if (updateUrl) writeUrl('', 'replace');
    clearApplied();
  },
  current: () => activePath || urlPath()
};

if (CLIENT && urlPath()) queueMicrotask(() => void restore());
