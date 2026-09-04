const files = document.querySelector('#files');
const CLIENT = document.documentElement.classList.contains('client-library');

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    .file-context-menu{position:fixed;z-index:90;width:min(330px,calc(100vw - 16px));padding:7px;border:1px solid #373238;border-radius:13px;background:rgba(24,22,25,.98);box-shadow:0 18px 55px rgba(0,0,0,.52);backdrop-filter:blur(18px);color:#eee8e4;font-size:11px;user-select:none}
    .file-context-menu[hidden]{display:none}
    .file-context-summary{padding:9px 9px 10px;border-bottom:1px solid #2d292d;user-select:text}
    .file-context-summary strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:1.35;color:#f3eeeb}
    .file-context-path{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8f8785;font:9px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace}
    .file-context-facts{display:flex;gap:10px;margin-top:7px;color:#777071;font-size:9px}
    .file-context-facts span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .file-context-actions{display:grid;gap:1px;padding-top:5px}
    .file-context-action{width:100%;min-height:33px;display:flex;align-items:center;gap:9px;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:#d9d1ce;text-align:left;font-size:10px;font-weight:650;cursor:pointer}
    .file-context-action:hover,.file-context-action:focus-visible{outline:none;background:#2b272c;color:#fff}
    .file-context-action[disabled]{opacity:.38;cursor:default;background:transparent}
    .file-context-action i{width:17px;height:17px;display:grid;place-items:center;flex:0 0 17px;color:#9e9694;font-style:normal;font-size:13px}
    .file-context-action.primary{color:#f1d7d3}
    .file-context-action.primary i{color:#e9aaa4}
    .file-context-status{min-height:0;padding:0 9px;color:#d89089;font-size:9px;line-height:1.3}
    .file-context-status:not(:empty){padding-top:5px;padding-bottom:4px}
    @media(max-width:700px){.file-context-menu{width:min(310px,calc(100vw - 12px))}}
  `;
  document.head.append(style);

  const menu = document.createElement('div');
  menu.className = 'file-context-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="file-context-summary">
      <strong data-context-filename></strong>
      <div class="file-context-path" data-context-path></div>
      <div class="file-context-facts"><span data-context-date></span><span data-context-size></span><span data-context-type></span></div>
    </div>
    <div class="file-context-actions">
      <button type="button" class="file-context-action primary" data-context-action="open"><i>↗</i><span>Open</span></button>
      <button type="button" class="file-context-action" data-context-action="reveal"><i>⌕</i><span>Show in Explorer</span></button>
      <button type="button" class="file-context-action" data-context-action="tab"><i>□</i><span>Open in new tab</span></button>
      <button type="button" class="file-context-action" data-context-action="save"><i>↓</i><span>Save as</span></button>
      <button type="button" class="file-context-action" data-context-action="copy-path"><i>⧉</i><span>Copy path</span></button>
    </div>
    <div class="file-context-status" data-context-status></div>`;
  document.body.append(menu);

  let generation = 0;
  let active = null;
  let dismissPointerId = null;
  let swallowDismissClick = false;
  let dismissGuardTimer = 0;

  const filenameNode = menu.querySelector('[data-context-filename]');
  const pathNode = menu.querySelector('[data-context-path]');
  const dateNode = menu.querySelector('[data-context-date]');
  const sizeNode = menu.querySelector('[data-context-size]');
  const typeNode = menu.querySelector('[data-context-type]');
  const statusNode = menu.querySelector('[data-context-status]');
  const revealButton = menu.querySelector('[data-context-action="reveal"]');
  const copyPathButton = menu.querySelector('[data-context-action="copy-path"]');

  function formatBytes(value) {
    let size = Number(value) || 0;
    if (!size) return '';
    const units = ['B','KB','MB','GB','TB'];
    let unit = 0;
    while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit++; }
    return `${size < 10 && unit ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, { year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }

  function joinedPath(root, relative) {
    root = String(root || '').replace(/[\\/]+$/, '');
    relative = String(relative || '').replace(/^[\\/]+/, '');
    if (!root) return relative;
    if (!relative) return root;
    const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
    return `${root}${separator}${relative.replace(/[\\/]+/g, separator)}`;
  }

  function localPath(hash) {
    const location = window.mochimonoLocations?.forHash?.(hash)?.[0];
    return location ? joinedPath(location.rootPath, location.relativePath) : '';
  }

  function objectUrl(hash) {
    return `/api/objects/${encodeURIComponent(hash)}`;
  }

  function viewerUrl(hash) {
    const url = new URL(location.href);
    url.searchParams.set('file', hash);
    return url.href;
  }

  function render() {
    if (!active) return;
    filenameNode.textContent = active.filename || active.hash;
    pathNode.textContent = active.path || 'Path unavailable';
    pathNode.title = active.path || '';
    dateNode.textContent = active.date ? `Date  ${formatDate(active.date)}` : 'Date  —';
    sizeNode.textContent = active.size ? `Size  ${formatBytes(active.size)}` : 'Size  —';
    typeNode.textContent = active.mime ? String(active.mime).split('/').pop().toUpperCase() : '';
    revealButton.hidden = !CLIENT;
    revealButton.disabled = CLIENT && active.local === false;
    copyPathButton.disabled = !active.path;
  }

  function close() {
    generation++;
    active = null;
    menu.hidden = true;
    statusNode.textContent = '';
  }

  function clearDismissGuard() {
    dismissPointerId = null;
    swallowDismissClick = false;
    clearTimeout(dismissGuardTimer);
    dismissGuardTimer = 0;
  }

  function armDismissGuard(pointerId) {
    dismissPointerId = pointerId;
    swallowDismissClick = true;
    clearTimeout(dismissGuardTimer);
    dismissGuardTimer = setTimeout(clearDismissGuard, 800);
  }

  function place(x, y) {
    menu.hidden = false;
    menu.style.left = `${Math.max(6, x)}px`;
    menu.style.top = `${Math.max(6, y)}px`;
    requestAnimationFrame(() => {
      if (menu.hidden) return;
      const rect = menu.getBoundingClientRect();
      const left = Math.max(6, Math.min(x, innerWidth - rect.width - 6));
      const top = Math.max(6, Math.min(y, innerHeight - rect.height - 6));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    });
  }

  async function clientPath(hash) {
    if (!CLIENT) return '';
    try {
      const response = await fetch(`/api/client/locations?hash=${encodeURIComponent(hash)}`, { cache:'no-store' });
      if (!response.ok) return '';
      const data = await response.json();
      const locations = new Map((data.locations || []).map(item => [item.id, item]));
      for (const [fileHash, id, relativePath] of data.files || []) {
        if (fileHash !== hash) continue;
        const location = locations.get(id);
        if (location) return joinedPath(location.rootPath, relativePath);
      }
    } catch {}
    return '';
  }

  async function enrich(hash, mine) {
    const [detailsResult, headResult, clientResult] = await Promise.allSettled([
      fetch(`/api/files/${encodeURIComponent(hash)}/details`, { cache:'no-store' }).then(async response => response.ok ? await response.json() : null),
      fetch(objectUrl(hash), { method:'HEAD', cache:'no-store' }),
      clientPath(hash)
    ]);
    if (!active || generation !== mine || active.hash !== hash) return;

    const details = detailsResult.status === 'fulfilled' ? detailsResult.value : null;
    const head = headResult.status === 'fulfilled' ? headResult.value : null;
    const local = clientResult.status === 'fulfilled' ? clientResult.value : '';
    const object = details?.object || {};
    const source = details?.sources?.[0] || {};
    const sourcePath = joinedPath(source.rootPath, source.path || source.originalPath);

    active.filename = source.filename || object.filename || active.filename;
    active.path = local || active.path || sourcePath;
    active.local = Boolean(local || localPath(hash));
    active.date = source.mtime || object.fileDate || object.createdAt || active.date;
    active.size = Number(object.size) || Number(head?.headers?.get?.('content-length')) || active.size;
    active.mime = object.mime || head?.headers?.get?.('content-type') || active.mime;
    render();
  }

  function open(card, x, y) {
    const hash = String(card.dataset.hash || '');
    if (!hash) return;
    const mine = ++generation;
    const initialLocal = localPath(hash);
    active = {
      hash,
      filename: card.dataset.filename || card.getAttribute('title') || hash,
      path: initialLocal,
      local: Boolean(initialLocal),
      date: card.dataset.day || '',
      size: 0,
      mime: card.classList.contains('video-card') ? 'video' : 'image'
    };
    statusNode.textContent = '';
    render();
    place(x, y);
    enrich(hash, mine).catch(() => {});
  }

  files.addEventListener('contextmenu', event => {
    if (!files.classList.contains('grid')) return;
    const card = event.target.closest('.file-card.media-card[data-hash]');
    if (!card || !files.contains(card)) return;
    event.preventDefault();
    event.stopPropagation();
    card.focus({ preventScroll:true });
    open(card, event.clientX, event.clientY);
  });

  menu.addEventListener('contextmenu', event => event.preventDefault());
  menu.addEventListener('click', async event => {
    const button = event.target.closest('[data-context-action]');
    if (!button || button.disabled || !active) return;
    const action = button.dataset.contextAction;
    const snapshot = { ...active };
    statusNode.textContent = '';

    if (action === 'open') {
      close();
      window.mochimonoOpenViewer?.(snapshot.hash);
      return;
    }
    if (action === 'tab') {
      window.open(viewerUrl(snapshot.hash), '_blank', 'noopener');
      close();
      return;
    }
    if (action === 'save') {
      const link = document.createElement('a');
      link.href = objectUrl(snapshot.hash);
      link.download = snapshot.filename || snapshot.hash;
      document.body.append(link);
      link.click();
      link.remove();
      close();
      return;
    }
    if (action === 'copy-path') {
      try {
        await navigator.clipboard.writeText(snapshot.path);
        statusNode.textContent = 'Path copied';
      } catch {
        statusNode.textContent = 'Could not copy path';
      }
      return;
    }
    if (action === 'reveal') {
      button.disabled = true;
      try {
        const response = await fetch('/api/reveal-file', {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ hash:snapshot.hash })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not show file');
        close();
      } catch (error) {
        statusNode.textContent = error?.message || 'Could not show file';
        button.disabled = false;
      }
    }
  });

  document.addEventListener('pointerdown', event => {
    if (menu.hidden || menu.contains(event.target)) return;
    close();
    armDismissGuard(event.pointerId);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('pointerup', event => {
    if (!swallowDismissClick || (dismissPointerId != null && event.pointerId !== dismissPointerId)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('click', event => {
    if (!swallowDismissClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearDismissGuard();
  }, true);
  document.addEventListener('contextmenu', event => {
    if (!swallowDismissClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearDismissGuard();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || menu.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }, true);
  addEventListener('blur', close);
  addEventListener('resize', close, { passive:true });
  addEventListener('scroll', close, { passive:true, capture:true });
}
