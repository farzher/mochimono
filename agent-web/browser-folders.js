const folders = document.querySelector('#folders');
const addFolder = document.querySelector('#showFolderAdd');
const frame = document.querySelector('#filesFrame');

if (folders && addFolder && frame) {
  const list = document.createElement('div');
  list.id = 'browserFolders';
  list.className = 'item-list browser-folder-list';
  folders.after(list);

  const style = document.createElement('style');
  style.textContent = `
    .browser-folder-list:empty{display:none}
    .browser-folder-item .storage-title{display:flex;align-items:center;gap:7px}
    .browser-folder-item .browser-folder-path{max-width:min(640px,55vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#817976;font-size:10px}
    .browser-folder-item .browser-folder-scope{border:1px solid #302b30;border-radius:7px;background:#151316;color:#aaa19e;padding:4px 6px;font-size:10px}
    .browser-folder-item .browser-folder-warning{color:#c9977e}
    @media(max-width:700px){.browser-folder-item .browser-folder-path{max-width:52vw}}
  `;
  document.head.append(style);

  let refreshTimer = 0;
  let rendering = false;

  const api = () => frame.contentWindow?.mochimonoBrowserFolders;
  const pathLabel = source => source.rootPath && source.rootPath !== source.name ? source.rootPath : `Browser · ${source.name}`;
  const relative = value => {
    if (!value) return 'Never synced';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return 'Never synced';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return 'Synced just now';
    if (seconds < 3600) return `Synced ${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `Synced ${Math.floor(seconds / 3600)}h ago`;
    return `Synced ${Math.floor(seconds / 86400)}d ago`;
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }

  function card(source) {
    const permission = source.permission || 'prompt';
    const state = source.lastError || (permission === 'granted' ? relative(source.lastSynced) : 'Permission required');
    return `<article class="storage-item folder-item browser-folder-item" data-browser-folder="${escapeHtml(source.id)}">
      <div class="storage-copy">
        <div class="storage-title"><strong title="${escapeHtml(source.name)}">${escapeHtml(source.name)}</strong><span class="storage-modes">Browser</span><time class="item-state ${permission === 'granted' ? '' : 'browser-folder-warning'}">${escapeHtml(state)}</time></div>
        <div class="storage-meta"><span class="browser-folder-path" title="${escapeHtml(pathLabel(source))}">${escapeHtml(pathLabel(source))}</span></div>
      </div>
      <div class="item-actions">
        <select class="browser-folder-scope" data-browser-scope title="What this folder indexes and syncs" aria-label="Folder scope">
          <option value="media" ${source.scope === 'all' ? '' : 'selected'}>Media</option>
          <option value="all" ${source.scope === 'all' ? 'selected' : ''}>Everything</option>
        </select>
        <button class="action-link" data-browser-path title="Set the full native folder path Mochimono should remember">Path</button>
        <button class="action-link primary-action" data-browser-sync>${permission === 'granted' ? 'Sync' : 'Allow'}</button>
      </div>
    </article>`;
  }

  async function refresh() {
    if (rendering) return;
    const bridge = api();
    if (!bridge?.list) return;
    rendering = true;
    try {
      const sources = await bridge.list();
      list.innerHTML = sources.map(card).join('');
    } catch {} finally { rendering = false; }
  }

  function schedule(delay = 80) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, delay);
  }

  list.addEventListener('click', async event => {
    const row = event.target.closest('[data-browser-folder]');
    if (!row) return;
    const bridge = api();
    if (!bridge) return;
    const id = row.dataset.browserFolder;

    if (event.target.closest('[data-browser-sync]')) {
      const button = event.target.closest('[data-browser-sync]');
      button.disabled = true;
      button.textContent = 'Syncing…';
      try { await bridge.sync(id, { userGesture:true }); }
      catch (error) { button.title = error.message || String(error); }
      finally { schedule(0); }
      return;
    }

    if (event.target.closest('[data-browser-path]')) {
      const sources = await bridge.list();
      const source = sources.find(item => item.id === id);
      if (!source) return;
      const value = prompt('Full folder path', source.rootPath || source.name);
      if (value == null) return;
      await bridge.setRootPath(id, value);
      schedule(0);
    }
  });

  list.addEventListener('change', async event => {
    const select = event.target.closest('[data-browser-scope]');
    if (!select) return;
    const row = select.closest('[data-browser-folder]');
    const bridge = api();
    if (!row || !bridge) return;
    select.disabled = true;
    try {
      await bridge.setScope(row.dataset.browserFolder, select.value);
      await bridge.sync(row.dataset.browserFolder, { userGesture:true });
    } catch (error) {
      select.title = error.message || String(error);
    } finally {
      select.disabled = false;
      schedule(0);
    }
  });

  frame.addEventListener('load', () => schedule(500));
  window.addEventListener('focus', () => schedule());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  setInterval(() => schedule(0), 5000);
  schedule(1200);
}
