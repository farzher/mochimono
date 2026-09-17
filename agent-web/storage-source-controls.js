const folders = document.querySelector('#folders');
const toastNode = document.querySelector('#toast');

if (folders) {
  const style = document.createElement('style');
  style.textContent = `
    #storagePane .folder-item .storage-modes{display:none!important}
    #storagePane .folder-item .item-actions [data-sync-folder],
    #storagePane .folder-item .item-actions [data-protect-folder],
    #storagePane .browser-folder-item .item-actions [data-browser-scope],
    #storagePane .browser-folder-item .item-actions [data-browser-cloud],
    #storagePane .browser-folder-item .item-actions [data-browser-sync],
    #storagePane .browser-folder-item .item-actions [data-browser-path]{display:none!important}
    #storagePane .folder-item .source-controls{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid #292429}
    #storagePane .source-control-group{display:flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:#1a171b}
    #storagePane .source-control{width:31px;height:27px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:#6f6869;cursor:pointer}
    #storagePane .source-control:hover{background:#272328;color:#d8cfcb}
    #storagePane .source-control.active{background:#30272c;color:#efa09a}
    #storagePane .source-control.fixed{cursor:default;color:#b2a9a6;background:#242125}
    #storagePane .source-control:disabled{opacity:.42;cursor:wait}
    #storagePane .source-control svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}
    #storagePane .source-control.sync{margin-left:auto;background:transparent;color:#837b79}
    #storagePane .source-control.sync:hover{background:#272328;color:#eee5e1}
    #storagePane .folder-item.source-busy .source-control.sync svg{animation:source-spin .9s linear infinite}
    #storagePane .source-health{width:7px;height:7px;margin-left:1px;border-radius:50%;background:#5f595a}
    #storagePane .source-health.ok{background:#7d9d84}.source-health.warn{background:#c28f76}.source-health.bad{background:#b96e72}
    #storagePane .folder-browser-mode span,#storagePane .folder-browser-scope span,.multi-folder-browser .folder-browser-mode span,.multi-folder-browser .folder-browser-scope span,.folder-drop-copy span,.folder-mode-option span,.folder-mode-note{display:none!important}
    .multi-folder-browser .folder-browser-mode,.multi-folder-browser .folder-browser-scope{display:flex!important;gap:3px!important;padding-bottom:8px!important}
    .multi-folder-browser .folder-browser-mode button,.multi-folder-browser .folder-browser-scope button{min-height:34px!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:6px 13px!important;text-align:center!important}
    .multi-folder-browser .folder-browser-mode strong,.multi-folder-browser .folder-browser-scope strong{font-size:10px!important}
    .multi-folder-browser .folder-browser-count{display:none!important}
    #protectionDashboard .protection-copy>span{display:none!important}
    #protectionDashboard .protection-main{padding-top:5px!important;padding-bottom:5px!important}
    .storage-shortcut{display:none!important}
    @keyframes source-spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){#storagePane .folder-item.source-busy .source-control.sync svg{animation:none!important}}
  `;
  document.head.append(style);

  const icon = {
    local:'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="10" rx="1.5"/><path d="M7 17h6M10 14v3"/></svg>',
    cloud:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.2 15.2h8a3 3 0 0 0 .5-5.95A4.8 4.8 0 0 0 5.5 8a3.6 3.6 0 0 0 .7 7.2z"/></svg>',
    media:'<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7" cy="8" r="1.2"/><path d="M4.5 14l4-4 2.4 2.3 1.8-1.8 2.8 3.5"/></svg>',
    all:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5h6l3 3v10H6z"/><path d="M12 3.5v3h3M3.5 6.5v10h9"/></svg>',
    sync:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 7A6 6 0 0 0 5.2 5.5L3.5 7.2"/><path d="M3.5 3.8v3.4h3.4M4.5 13A6 6 0 0 0 14.8 14.5l1.7-1.7"/><path d="M16.5 16.2v-3.4h-3.4"/></svg>'
  };

  const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  let native = new Map();
  let refreshTimer = 0;
  let refreshing = false;

  function toast(text) {
    if (!toastNode) return;
    toastNode.textContent = text;
    toastNode.classList.add('show');
    clearTimeout(toastNode.timer);
    toastNode.timer = setTimeout(() => toastNode.classList.remove('show'), 2400);
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      cache:'no-store',
      ...options,
      headers:{ 'content-type':'application/json', ...(options.headers || {}) },
      body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function controls(row, cloud, scope, health = '') {
    let node = row.querySelector(':scope .source-controls');
    if (!node) {
      node = document.createElement('div');
      node.className = 'source-controls';
      node.innerHTML = `
        <div class="source-control-group">
          <span class="source-control fixed" title="Local" aria-label="Local">${icon.local}</span>
          <button type="button" class="source-control" data-source-cloud-toggle title="Cloud" aria-label="Cloud">${icon.cloud}</button>
        </div>
        <div class="source-control-group">
          <button type="button" class="source-control" data-source-scope="media" title="Media" aria-label="Media">${icon.media}</button>
          <button type="button" class="source-control" data-source-scope="all" title="All files" aria-label="All files">${icon.all}</button>
        </div>
        <i class="source-health" hidden></i>
        <button type="button" class="source-control sync" data-source-sync title="Refresh" aria-label="Refresh">${icon.sync}</button>`;
      row.querySelector('.storage-copy')?.append(node);
    }
    row.dataset.sourceCloud = cloud ? '1' : '0';
    row.dataset.sourceScope = scope === 'all' ? 'all' : 'media';
    const cloudButton = node.querySelector('[data-source-cloud-toggle]');
    cloudButton.classList.toggle('active', Boolean(cloud));
    cloudButton.setAttribute('aria-pressed', cloud ? 'true' : 'false');
    for (const button of node.querySelectorAll('[data-source-scope]')) {
      const active = button.dataset.sourceScope === row.dataset.sourceScope;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const dot = node.querySelector('.source-health');
    if (health) {
      dot.hidden = false;
      dot.className = `source-health ${health}`;
      dot.title = health === 'ok' ? 'Ready' : health === 'warn' ? 'Needs permission' : 'Error';
    } else dot.hidden = true;
  }

  function decorateBrowserRows() {
    for (const row of folders.querySelectorAll(':scope > [data-browser-folder]')) {
      controls(row, row.dataset.sourceCloud === '1', row.dataset.sourceScope || 'media', row.dataset.sourceHealth || '');
    }
  }

  function decorateNativeRows() {
    for (const row of folders.querySelectorAll(':scope > [data-folder-path]:not([data-browser-folder])')) {
      const source = native.get(pathKey(row.dataset.folderPath));
      if (!source) continue;
      controls(row, source.protected !== false, source.scope === 'all' ? 'all' : 'media');
    }
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    refreshTimer = 0;
    decorateBrowserRows();
    if (refreshing) return;
    refreshing = true;
    try {
      const state = await request('/api/state');
      native = new Map((state?.settings?.folders || []).map(source => [pathKey(source.path), source]));
      decorateNativeRows();
    } catch {}
    finally { refreshing = false; }
  }

  function schedule(delay = 0) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, Math.max(0, delay));
  }

  function lock(row, locked) {
    row?.querySelectorAll('.source-controls button').forEach(button => button.disabled = locked);
    row?.classList.toggle('source-busy', locked);
  }

  async function setNativeCloud(row, enabled) {
    const path = row.dataset.folderPath;
    const source = native.get(pathKey(path));
    if (!source) throw new Error('Folder unavailable');
    if (enabled) {
      await request('/api/browse-folders/protect', { method:'POST', body:{ path } });
    } else {
      const scope = source.scope === 'all' ? 'all' : 'media';
      await request('/api/folders/remove', { method:'POST', body:{ path } });
      try { await request('/api/browse-folders', { method:'POST', body:{ path, scope } }); }
      catch (error) {
        await request('/api/folders', { method:'POST', body:{ path, scope } }).catch(() => {});
        throw error;
      }
    }
  }

  async function setNativeScope(row, scope) {
    const path = row.dataset.folderPath;
    const source = native.get(pathKey(path));
    if (!source) throw new Error('Folder unavailable');
    await request(source.protected === false ? '/api/browse-folders' : '/api/folders', { method:'POST', body:{ path, scope } });
  }

  folders.addEventListener('click', async event => {
    const row = event.target.closest('.folder-item');
    const button = event.target.closest('.source-control');
    if (!row || !button) return;
    const browserId = row.dataset.browserFolder || '';
    const shell = window.mochimonoBrowserFolderShell;
    try {
      lock(row, true);
      if (button.matches('[data-source-cloud-toggle]')) {
        const enabled = row.dataset.sourceCloud !== '1';
        if (browserId) {
          if (!shell?.setCloud) throw new Error('Browser folder is still loading');
          await shell.setCloud(browserId, enabled);
        } else await setNativeCloud(row, enabled);
      } else if (button.matches('[data-source-scope]')) {
        const scope = button.dataset.sourceScope;
        if (scope === row.dataset.sourceScope) return;
        if (browserId) {
          if (!shell?.setScope) throw new Error('Browser folder is still loading');
          await shell.setScope(browserId, scope);
        } else await setNativeScope(row, scope);
      } else if (button.matches('[data-source-sync]')) {
        if (browserId) {
          if (!shell?.sync) throw new Error('Browser folder is still loading');
          shell.sync(browserId).catch(error => toast(error.message));
        } else {
          await request('/api/folders/sync', { method:'POST', body:{ path:row.dataset.folderPath } });
        }
      }
    } catch (error) { toast(error.message); }
    finally {
      lock(row, false);
      schedule(0);
      window.dispatchEvent(new CustomEvent('mochimono:sources-changed'));
    }
  }, true);

  new MutationObserver(records => {
    if (records.some(record => record.addedNodes.length || record.removedNodes.length)) schedule(20);
  }).observe(folders, { childList:true, subtree:false });
  window.addEventListener('mochimono:sources-changed', () => schedule(0));

  // Remove wording that duplicates the visual controls.
  for (const node of document.querySelectorAll('[data-browser-scope="all"] strong')) node.textContent = 'All';
  schedule(0);
  window.mochimonoSourceControls = { refresh:() => schedule(0) };
}
