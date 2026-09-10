const folders = document.querySelector('#folders');
const frame = document.querySelector('#filesFrame');

if (folders && frame) {
  const style = document.createElement('style');
  style.textContent = `
    .browser-folder-item .browser-folder-warning{color:#c9977e}
    .browser-folder-item .browser-folder-source{color:#817976;font-size:10px}
    .browser-folder-item .browser-folder-meter{opacity:.35}
    .browser-folder-item .item-actions .browser-folder-mode{min-width:52px}
    .browser-folder-item .browser-sync-progress{display:grid;gap:6px}
    .browser-folder-item .browser-sync-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
    .browser-folder-item .browser-sync-head strong{color:#d8cfcb;font-size:10px;font-weight:720}
    .browser-folder-item .browser-sync-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8d8582;font-size:9px}
    .browser-folder-item .browser-sync-progress .progress-bar{margin:0}
  `;
  document.head.append(style);

  let refreshTimer = 0;
  let progressTimer = 0;
  let rendering = false;
  let writingRows = false;
  let renderedKey = '';
  let bridgeWindow = null;
  let activeSyncId = '';
  const liveProgress = new Map();
  const sourceCache = new Map();
  const livePreviewHashes = new Map();

  const api = () => frame.contentWindow?.mochimonoBrowserFolders;
  const relative = value => {
    if (!value) return 'Never indexed';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return 'Never indexed';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }

  function bytes(number) {
    const units = ['B','KB','MB','GB','TB'];
    let value = Number(number) || 0;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  function pathParts(path) {
    const clean = String(path || '').replace(/[\\/]+$/, '');
    const index = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
    if (index < 0) return { parent:'', name:clean || path };
    return { parent:clean.slice(0, index + 1), name:clean.slice(index + 1) || clean };
  }

  function titleHtml(source) {
    const shown = source.rootPath || source.name;
    const { parent, name } = pathParts(shown);
    return `${parent ? `<span class="storage-path-parent">${escapeHtml(parent)}</span>` : ''}<b class="storage-path-name">${escapeHtml(name)}</b>`;
  }

  function previewCell(file, index) {
    if (!file) return `<span class="storage-folder-sample">${index === 0 ? '<span class="sample-glyph">▱</span>' : ''}</span>`;
    const video = String(file.mime || '').startsWith('video/');
    return `<span class="storage-folder-sample ${video ? 'video' : ''}" data-preview-hash="${escapeHtml(file.hash || '')}">
      <span class="sample-glyph">${video ? '▶' : '▧'}</span>
      <small class="sample-name">${escapeHtml(file.filename || '')}</small>
      <img src="/api/thumbs/${encodeURIComponent(file.hash)}" alt="" loading="eager" decoding="async" onload="this.parentElement.classList.add('thumb-ready')">
    </span>`;
  }

  function previews(source) {
    const items = source.previews || [];
    return `<a class="storage-folder-samples storage-source-link" href="#" title="View in Library">${[0,1,2].map(index => previewCell(items[index], index)).join('')}</a>`;
  }

  function card(source) {
    const permission = source.permission || 'prompt';
    const scope = source.scope === 'all' ? 'Everything' : 'Media';
    const state = source.lastError || (permission === 'granted' ? relative(source.lastSynced) : 'Permission required');
    const mode = source.cloud ? `Cloud · ${scope}` : scope;
    const sourceLabel = source.rootPath && source.rootPath !== source.name ? 'Browser folder' : `Browser · ${source.name}`;
    return `<article class="storage-item folder-item browser-folder-item" data-browser-folder="${escapeHtml(source.id)}">
      ${previews(source)}
      <div class="storage-copy">
        <div class="storage-title">
          <strong title="${escapeHtml(source.rootPath || source.name)}">${titleHtml(source)}</strong>
          <span class="storage-modes" title="${source.cloud ? 'Browser folder with a Cloud copy' : 'Browser folder · local only'}">${escapeHtml(mode)}</span>
          <time class="item-state ${permission === 'granted' ? '' : 'browser-folder-warning'}">${escapeHtml(state)}</time>
        </div>
        <div class="storage-meta">
          <span data-browser-files>${Number(source.files || 0).toLocaleString()} files</span><span>·</span><span data-browser-bytes>${bytes(source.bytes)}</span><span>·</span><span class="browser-folder-source">${escapeHtml(sourceLabel)}</span>
        </div>
        <div class="storage-meter browser-folder-meter"><i style="width:${source.files ? '2px' : '0'}"></i></div>
        <div class="item-progress" hidden></div>
      </div>
      <div class="item-actions">
        <button class="action-link browser-folder-mode" data-browser-scope title="Index ${scope === 'Media' ? 'all files' : 'photos and videos only'}">${escapeHtml(scope)}</button>
        <button class="action-link" data-browser-path title="Set the full native folder path Mochimono should remember">Path</button>
        <button class="action-link" data-browser-cloud title="${source.cloud ? 'Stop uploading future changes to Cloud; existing Cloud copies are kept' : 'Keep a Cloud copy'}">${source.cloud ? 'Local' : '+ Cloud'}</button>
        <button class="action-link primary-action" data-browser-sync title="${source.cloud ? 'Sync browser folder and Cloud copy' : 'Re-index browser folder locally'}">${permission === 'granted' ? (source.cloud ? 'Sync' : 'Index') : 'Allow'}</button>
        <button class="icon tiny" data-browser-remove aria-label="Remove browser folder" title="Remove browser folder">×</button>
      </div>
    </article>`;
  }

  function sourceRenderKey(source) {
    const previewKey = (source.previews || []).slice(0, 3).map(file => [file?.hash || '', file?.filename || '', file?.mime || '']);
    return [source.id || '', source.name || '', source.rootPath || '', source.permission || 'prompt', source.scope || 'media', Boolean(source.cloud), Number(source.files) || 0, Number(source.bytes) || 0, source.lastError || '', previewKey];
  }

  function progressTitle(source) {
    if (source?.cloud) return 'Syncing';
    return source?.lastSynced ? 'Checking folder' : 'Indexing folder';
  }

  function renderProgress(row, source, progress = liveProgress.get(String(source?.id || ''))) {
    const container = row?.querySelector('.item-progress');
    if (!container) return;
    if (!progress || progress.state !== 'running') {
      container.hidden = true;
      container.replaceChildren();
      delete container.dataset.key;
      return;
    }

    const scanned = Math.max(0, Number(progress.scanned) || 0);
    const transferred = Math.max(0, Number(progress.transferred) || 0);
    const skipped = Math.max(0, Number(progress.skipped) || 0);
    const title = progressTitle(source);
    const details = [];
    if (scanned) details.push(`${scanned.toLocaleString()} file${scanned === 1 ? '' : 's'} found`);
    if (transferred) details.push(`${transferred.toLocaleString()} new/changed`);
    if (skipped) details.push(`${skipped.toLocaleString()} unchanged`);
    const summary = details.join(' · ') || 'Starting…';
    const key = `${title}|${summary}`;
    if (container.dataset.key !== key) {
      container.dataset.key = key;
      container.innerHTML = `<div class="browser-sync-progress">
        <div class="browser-sync-head"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(summary)}</span></div>
        <div class="progress-bar indeterminate"><i style="width:32%"></i></div>
      </div>`;
    }
    container.hidden = false;

    const filesNode = row.querySelector('[data-browser-files]');
    const bytesNode = row.querySelector('[data-browser-bytes]');
    if (filesNode) filesNode.textContent = `${scanned.toLocaleString()} file${scanned === 1 ? '' : 's'}`;
    if (bytesNode && !Number(source?.bytes)) bytesNode.textContent = scanned ? 'Indexing…' : 'Starting…';
  }

  function updateRowState(source) {
    const id = String(source.id || '');
    const row = [...folders.querySelectorAll(':scope > [data-browser-folder]')].find(node => node.dataset.browserFolder === id);
    if (!row) return false;
    const permission = source.permission || 'prompt';
    const state = source.lastError || (permission === 'granted' ? relative(source.lastSynced) : 'Permission required');
    const node = row.querySelector('.item-state');
    if (node) {
      if (node.textContent !== state) node.textContent = state;
      node.classList.toggle('browser-folder-warning', permission !== 'granted');
    }
    renderProgress(row, source);
    return true;
  }

  function replaceBrowserRows(sources) {
    sourceCache.clear();
    for (const source of sources || []) sourceCache.set(String(source.id || ''), source);
    const nextKey = JSON.stringify((sources || []).map(sourceRenderKey));
    if (renderedKey !== nextKey) {
      renderedKey = nextKey;
      writingRows = true;
      for (const row of folders.querySelectorAll(':scope > [data-browser-folder]')) row.remove();
      if (sources.length) {
        const holder = document.createElement('div');
        holder.innerHTML = sources.map(card).join('');
        folders.append(...holder.children);
      }
      requestAnimationFrame(() => { writingRows = false; });
    }
    for (const source of sources || []) updateRowState(source);
  }

  async function refresh() {
    if (rendering) return;
    const bridge = api();
    if (!bridge?.list) return;
    rendering = true;
    try { replaceBrowserRows(await bridge.list()); }
    catch {} finally { rendering = false; }
  }

  function schedule(delay = 80) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, delay);
  }

  function flushProgress() {
    progressTimer = 0;
    for (const [id, progress] of liveProgress) {
      const source = sourceCache.get(id);
      const row = [...folders.querySelectorAll(':scope > [data-browser-folder]')].find(node => node.dataset.browserFolder === id);
      if (!source || !row) continue;
      renderProgress(row, source, progress);
    }
  }

  function scheduleProgress() {
    if (!progressTimer) progressTimer = setTimeout(flushProgress, 100);
  }

  function onBrowserSync(event) {
    const detail = event.detail || {};
    const id = String(detail.id || '');
    if (!id) return;
    if (detail.state === 'running') {
      activeSyncId = id;
      liveProgress.set(id, detail);
      if (!sourceCache.has(id)) schedule(0);
      scheduleProgress();
      return;
    }
    if (activeSyncId === id) activeSyncId = '';
    liveProgress.delete(id);
    livePreviewHashes.delete(id);
    schedule(0);
  }

  function onBrowserThumbnail(event) {
    const hash = String(event.detail?.hash || '');
    const id = activeSyncId;
    if (!id || !/^[a-f0-9]{64}$/.test(hash)) return;
    const row = [...folders.querySelectorAll(':scope > [data-browser-folder]')].find(node => node.dataset.browserFolder === id);
    const strip = row?.querySelector('.storage-folder-samples');
    if (!strip || strip.querySelector(`[data-preview-hash="${CSS.escape(hash)}"]`)) return;
    const seen = livePreviewHashes.get(id) || new Set();
    if (seen.has(hash)) return;
    seen.add(hash);
    livePreviewHashes.set(id, seen);

    const holder = document.createElement('div');
    holder.innerHTML = previewCell({ hash, filename:'', mime:'image/*' }, 0);
    const cell = holder.firstElementChild;
    if (!cell) return;
    strip.prepend(cell);
    while (strip.children.length > 3) strip.lastElementChild?.remove();
  }

  function onBrowserSourcesChanged() {
    schedule(0);
  }

  function bindBridgeEvents() {
    const child = frame.contentWindow;
    if (!child || child === bridgeWindow) return;
    if (bridgeWindow) {
      try {
        bridgeWindow.removeEventListener('mochimono:browser-folder-sync', onBrowserSync);
        bridgeWindow.removeEventListener('mochimono:browser-thumbnail-ready', onBrowserThumbnail);
        bridgeWindow.removeEventListener('mochimono:browser-folders-changed', onBrowserSourcesChanged);
      } catch {}
    }
    bridgeWindow = child;
    try {
      child.addEventListener('mochimono:browser-folder-sync', onBrowserSync);
      child.addEventListener('mochimono:browser-thumbnail-ready', onBrowserThumbnail);
      child.addEventListener('mochimono:browser-folders-changed', onBrowserSourcesChanged);
    } catch {}
  }

  folders.addEventListener('click', async event => {
    const row = event.target.closest('[data-browser-folder]');
    if (!row) return;
    const bridge = api();
    if (!bridge) return;
    const id = row.dataset.browserFolder;

    if (event.target.closest('[data-browser-sync]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      const button = event.target.closest('[data-browser-sync]');
      button.disabled = true; button.textContent = 'Working…';
      try { await bridge.sync(id, { userGesture:true }); }
      catch (error) { button.title = error.message || String(error); }
      finally { schedule(0); }
      return;
    }

    if (event.target.closest('[data-browser-scope]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      const sources = await bridge.list();
      const source = sources.find(item => item.id === id);
      if (!source) return;
      const next = source.scope === 'all' ? 'media' : 'all';
      await bridge.setScope(id, next);
      await bridge.sync(id, { userGesture:true });
      schedule(0); return;
    }

    if (event.target.closest('[data-browser-cloud]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      const sources = await bridge.list();
      const source = sources.find(item => item.id === id);
      if (!source) return;
      if (source.cloud) {
        if (!confirm('Stop uploading future changes from this browser folder to Cloud? Existing Cloud copies will stay in Mochimono.')) return;
        await bridge.setCloud(id, false);
      } else {
        await bridge.setCloud(id, true);
        await bridge.sync(id, { userGesture:true });
      }
      schedule(0); return;
    }

    if (event.target.closest('[data-browser-path]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      const sources = await bridge.list();
      const source = sources.find(item => item.id === id);
      if (!source) return;
      const value = prompt('Full folder path', source.rootPath || source.name);
      if (value == null) return;
      await bridge.setRootPath(id, value);
      schedule(0); return;
    }

    if (event.target.closest('[data-browser-remove]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      await bridge.remove(id); schedule(0);
    }
  }, true);

  frame.addEventListener('load', () => {
    bindBridgeEvents();
    schedule(0);
  });
  window.addEventListener('focus', () => {
    bindBridgeEvents();
    schedule();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    bindBridgeEvents();
    schedule();
  });

  new MutationObserver(records => {
    if (writingRows) return;
    if (records.some(record => record.addedNodes.length || record.removedNodes.length)) schedule(30);
  }).observe(folders, { childList:true });

  bindBridgeEvents();
  schedule(1200);
}