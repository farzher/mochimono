const CLIENT = document.documentElement.classList.contains('client-library');
const locationFilter = document.querySelector('#locationFilter');
const sourceFilter = document.querySelector('#source');
const CACHE_MS = 30000;

let activePath = '';
let activeMode = '';
let activeHashes = null;
let activeImportId = 0;
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
.source-folder-scopebar strong{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#ddd4d0;font-size:12px;font-weight:650}
.source-folder-scopebar .scope-clear{width:27px;height:27px;display:grid;place-items:center;padding:0;color:#817978;font-size:17px;line-height:1}
html.source-scope-switching #files,
html.source-scope-switching #gridFolderStrip{visibility:hidden!important}
`;
document.head.append(style);

const pathKey = value => String(value || '').trim().replaceAll('/', '\\').replace(/[\\]+$/, '').toLowerCase();
const urlPath = () => String(new URL(location.href).searchParams.get('folder') || '').trim();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'\"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function writeUrl(path, mode = 'replace') {
  const url = new URL(location.href);
  if (path) {
    url.searchParams.set('folder', path);
    url.searchParams.delete('origin');
  } else url.searchParams.delete('folder');
  if (url.href !== location.href) history[mode === 'push' ? 'pushState' : 'replaceState'](history.state, '', url);
}

function render(path = activePath) {
  if (!path) {
    scopebar.hidden = true;
    scopebar.replaceChildren();
    return;
  }
  scopebar.hidden = false;
  scopebar.innerHTML = `<div class="scope-breadcrumbs">
    <button type="button" data-source-folder-home>All files</button>
    <span class="scope-separator">›</span>
    <strong title="${escapeHtml(path)}">${escapeHtml(path)}</strong>
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
  return hashes;
}

function browserManifestHashes(id) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('mochimono-browser-folders', 1);
    open.onerror = () => reject(open.error || new Error('Browser folder database is unavailable.'));
    open.onsuccess = () => {
      const db = open.result;
      const hashes = new Set();
      try {
        const request = db.transaction('files', 'readonly').objectStore('files').openCursor();
        const prefix = `${id}\u0000`;
        request.onerror = () => { db.close(); reject(request.error || new Error('Could not read browser folder.')); };
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { db.close(); resolve(hashes); return; }
          const row = cursor.value;
          if (String(row?.key || '').startsWith(prefix)) {
            const hash = String(row?.hash || '');
            if (/^[a-f0-9]{64}$/.test(hash)) hashes.add(hash);
          }
          cursor.continue();
        };
      } catch (error) {
        db.close();
        reject(error);
      }
    };
  });
}

async function configuredImportId(path) {
  const key = `import:${pathKey(path)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const state = await request('/api/state').catch(() => null);
  const wanted = pathKey(path);
  const folder = (state?.settings?.folders || []).find(item => pathKey(item?.path || item) === wanted && item?.protected !== false);
  const value = Number(folder?.importId) || 0;
  cache.set(key, { at:Date.now(), value });
  return value;
}

function applyImport(importId) {
  if (!sourceFilter || !importId) return false;
  const value = String(importId);
  let option = sourceFilter.querySelector(`option[value="${CSS.escape(value)}"]`);
  let temporary = false;
  if (!option) {
    option = document.createElement('option');
    option.value = value;
    option.hidden = true;
    sourceFilter.append(option);
    temporary = true;
  }
  sourceFilter.value = value;
  sourceFilter.dispatchEvent(new Event('change', { bubbles:true }));
  sourceFilter.value = '';
  if (temporary) option.remove();
  const url = new URL(location.href);
  url.searchParams.delete('origin');
  if (url.href !== location.href) history.replaceState(history.state, '', url);
  return true;
}

function clearImportFilter() {
  if (!sourceFilter) return;
  sourceFilter.value = '';
  sourceFilter.dispatchEvent(new Event('change', { bubbles:true }));
}

function clearHashFilter() {
  if (window.mochimonoLibrary?.state?.().locationFilter === 'source-folder') {
    window.mochimonoLibrary.setLocationFilter('', null);
  }
}

function beginGridTransition() {
  if (window.mochimonoLibrary?.state?.().view !== 'grid') return null;
  document.documentElement.classList.add('source-scope-switching');

  let settled = false;
  let resolveReady;
  let timer = 0;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    window.removeEventListener('mochimono:stable-grid-installed', onInstalled);
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('source-scope-switching');
      resolveReady();
    });
  };
  const onInstalled = () => finish();
  window.addEventListener('mochimono:stable-grid-installed', onInstalled);
  timer = setTimeout(finish, 1500);

  return {
    async wait() {
      // Empty results and geometry-identical models install synchronously and do
      // not emit a replacement-layout event. In those cases the grid is already safe.
      if (!window.mochimonoStableGrid?.state?.().building) finish();
      await ready;
    },
    finish
  };
}

function clearApplied({ clearLibrary = true } = {}) {
  const mode = activeMode;
  activePath = '';
  activeMode = '';
  activeHashes = null;
  activeImportId = 0;
  render('');
  if (clearLibrary) {
    if (mode === 'import') clearImportFilter();
    else if (mode === 'hash') clearHashFilter();
  }
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
}

async function resolveHashes(path, browserId = '') {
  const key = browserId ? `browser:${browserId}` : `path:${pathKey(path)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const hashes = browserId ? await browserManifestHashes(browserId) : await nativeMembership(path);
  cache.set(key, { at:Date.now(), value:hashes });
  return hashes;
}

async function apply(path, { reset = false, browserId = '', importId = 0 } = {}) {
  const wanted = String(path || '').trim();
  if (!wanted) {
    clearApplied();
    return { path:'' };
  }
  if (!window.mochimonoLibrary?.setLocationFilter || !window.mochimonoHome) throw new Error('Library is still loading.');

  if (reset) window.mochimonoHome('replace');
  const token = ++generation;
  render(wanted);

  let nativeImportId = browserId ? 0 : Number(importId) || 0;
  if (!browserId && !nativeImportId) nativeImportId = await configuredImportId(wanted);
  if (token !== generation) return null;

  activePath = wanted;
  activeHashes = null;
  activeImportId = 0;
  activeMode = '';

  if (nativeImportId) {
    const transition = beginGridTransition();
    try {
      if (applyImport(nativeImportId)) {
        activeMode = 'import';
        activeImportId = nativeImportId;
        clearHashFilter();
        await transition?.wait();
      } else transition?.finish();
    } catch (error) {
      transition?.finish();
      throw error;
    }
  }

  if (!activeMode) {
    const hashes = await resolveHashes(wanted, browserId);
    if (token !== generation) return null;
    const transition = beginGridTransition();
    try {
      activeMode = 'hash';
      activeHashes = hashes;
      window.mochimonoLibrary.setLocationFilter('source-folder', hashes);
      await transition?.wait();
    } catch (error) {
      transition?.finish();
      throw error;
    }
  }

  if (token !== generation) return null;
  render(wanted);
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
  return { path:wanted };
}

function commit(path, mode = 'replace') {
  writeUrl(String(path || '').trim(), mode);
  window.dispatchEvent(new CustomEvent('mochimono:filters-changed'));
}

async function open(path, mode = 'push', options = {}) {
  const result = await apply(path, { ...options, reset:true });
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

sourceFilter?.addEventListener('change', event => {
  if (!event.isTrusted || (!activePath && !urlPath())) return;
  if (activeMode === 'hash') clearHashFilter();
  generation++;
  writeUrl('', 'replace');
  clearApplied({ clearLibrary:false });
});

locationFilter?.addEventListener('change', event => {
  if (!event.isTrusted || (!activePath && !urlPath())) return;
  if (activeMode === 'import') clearImportFilter();
  generation++;
  writeUrl('', 'replace');
  clearApplied({ clearLibrary:false });
});

window.addEventListener('popstate', () => void restore());
window.addEventListener('mochimono:catalog-updated', () => cache.clear());
window.addEventListener('mochimono:browser-folder-sync', () => cache.clear());
window.addEventListener('mochimono:local-catalog-event', event => {
  if (activeMode !== 'hash' || !activePath || !activeHashes || window.mochimonoLibrary?.state?.().locationFilter !== 'source-folder') return;
  let changed = false;
  for (const file of event.detail?.files || []) {
    if (pathKey(file?.rootPath) !== pathKey(activePath)) continue;
    const hash = String(file?.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash) || activeHashes.has(hash)) continue;
    activeHashes.add(hash);
    changed = true;
  }
  if (changed) window.mochimonoLibrary.setLocationFilter('source-folder', activeHashes);
});

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
