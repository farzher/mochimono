const CLIENT = document.documentElement.classList.contains('client-library');
const sourceFilter = document.querySelector('#source');
const locationFilter = document.querySelector('#locationFilter');
let activePath = '';

const scopebar = document.createElement('div');
scopebar.id = 'sourceFolderScopebar';
scopebar.className = 'source-folder-scopebar';
scopebar.hidden = true;
document.querySelector('#folderbar')?.after(scopebar);
const style = document.createElement('style');
style.textContent = `
.source-folder-scopebar{display:flex;align-items:center;min-width:0;padding:10px 2px 2px}
.source-folder-scopebar[hidden]{display:none!important}
.scope-breadcrumbs{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;white-space:nowrap}
.scope-breadcrumbs button{flex:none;padding:5px 7px;border-radius:7px;background:transparent;color:#bbb1ae;font-size:12px}
.scope-breadcrumbs button:hover{background:#211e22;color:#fff}
.scope-separator{color:#676061;font-size:12px}
.scope-breadcrumbs strong{min-width:0;overflow:hidden;text-overflow:ellipsis;color:#ddd4d0;font-size:12px;font-weight:650}
.scope-breadcrumbs .scope-clear{width:27px;height:27px;padding:0;color:#817978;font-size:17px}
`;
document.head.append(style);
const urlPath = () => new URL(location.href).searchParams.get('folder') || '';
const escapeHtml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function render() {
  scopebar.hidden = !activePath;
  scopebar.innerHTML = activePath ? `<div class="scope-breadcrumbs"><button data-source-folder-home>All files</button><span class="scope-separator">›</span><strong title="${escapeHtml(activePath)}">${escapeHtml(activePath)}</strong><button class="scope-clear" data-source-folder-clear aria-label="Clear folder filter">×</button></div>` : '';
}

function writeUrl(path, mode = 'replace') {
  const url = new URL(location.href);
  if (path) { url.searchParams.set('folder', path); url.searchParams.delete('origin'); }
  else url.searchParams.delete('folder');
  if (url.href !== location.href) history[mode === 'push' ? 'pushState' : 'replaceState'](history.state, '', url);
}

async function apply(path, { reset = false } = {}) {
  const library = window.mochimonoLibrary;
  if (!library) throw new Error('Library is opening');
  if (reset) window.mochimonoHome?.('replace');
  activePath = String(path || '').trim();
  // Root-path metadata already accompanies every local/browser file. Switching
  // sources must not enumerate hundreds of thousands of hashes over HTTP first.
  library.setSourcePath(activePath);
  render();
  dispatchEvent(new CustomEvent('mochimono:filters-changed'));
  return { path:activePath };
}

function commit(path, mode = 'replace') {
  writeUrl(path, mode);
  dispatchEvent(new CustomEvent('mochimono:filters-changed'));
}

async function open(path, mode = 'push', options = {}) {
  const result = await apply(path, { ...options, reset:true });
  commit(result.path, mode);
  scrollTo({ top:0, left:0, behavior:'auto' });
  return result;
}

function clear({ updateUrl = true } = {}) {
  activePath = '';
  if (updateUrl) writeUrl('', 'replace');
  window.mochimonoLibrary?.setSourcePath('');
  render();
}

scopebar.onclick = event => {
  if (event.target.closest('[data-source-folder-home],[data-source-folder-clear]')) window.mochimonoHome?.('push');
};
for (const control of [sourceFilter, locationFilter]) control?.addEventListener('change', event => {
  if (event.isTrusted && activePath) clear();
});
window.addEventListener('popstate', () => { if (window.mochimonoLibrary) void apply(urlPath()); });
window.mochimonoSourceFolder = { apply, commit, open, clear, current:() => activePath || urlPath() };
if (CLIENT && urlPath()) queueMicrotask(() => { if (window.mochimonoLibrary) void apply(urlPath()); });
window.addEventListener('mochimono:library-ready', () => { if (urlPath()) void apply(urlPath()); }, { once:true });
