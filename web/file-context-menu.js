const files = document.querySelector('#files');
const CLIENT = document.documentElement.classList.contains('client-library');

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    .file-context-menu{position:fixed;z-index:90;width:min(360px,calc(100vw - 16px));padding:7px;border:1px solid #373238;border-radius:13px;background:rgba(24,22,25,.98);box-shadow:0 18px 55px rgba(0,0,0,.52);backdrop-filter:blur(18px);color:#eee8e4;font-size:11px;user-select:none}
    .file-context-menu[hidden]{display:none}
    .file-context-close{position:absolute;top:8px;right:8px;width:24px;height:24px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:#837b7d;cursor:pointer}
    .file-context-close:hover,.file-context-close:focus-visible{outline:none;background:#2b272c;color:#f5f0ed}
    .file-context-close svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
    .file-context-summary{padding:10px 38px 11px 10px;border-bottom:1px solid #2d292d}
    .file-context-summary>strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:1.35;color:#f5f0ed;user-select:text}
    .file-context-path-wrap{margin-top:9px}
    .file-context-label{display:block;margin-bottom:4px;color:#716a6d;font-size:8px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}
    .file-context-path{max-height:46px;overflow:auto;padding:6px 7px;border:1px solid #302c31;border-radius:7px;background:#161417;color:#aaa19f;font:9.5px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;user-select:text;scrollbar-width:thin}
    .file-context-facts{display:grid;grid-template-columns:1fr auto;gap:18px;margin-top:9px}
    .file-context-fact{min-width:0}
    .file-context-fact b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d8d0cd;font-size:10px;font-weight:600;line-height:1.35;user-select:text}
    .file-context-actions{display:grid;gap:1px;padding-top:5px}
    .file-context-action{width:100%;min-height:34px;display:flex;align-items:center;gap:10px;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:#d9d1ce;text-align:left;font-size:10.5px;font-weight:650;cursor:pointer}
    .file-context-action:hover,.file-context-action:focus-visible{outline:none;background:#2b272c;color:#fff}
    .file-context-action[disabled]{opacity:.38;cursor:default;background:transparent}
    .file-context-action i{width:18px;height:18px;display:grid;place-items:center;flex:0 0 18px;color:#a49c99;font-style:normal}
    .file-context-action i svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round}
    .file-context-status{min-height:0;padding:0 9px;color:#d89089;font-size:9px;line-height:1.3}
    .file-context-status:not(:empty){padding-top:5px;padding-bottom:4px}
    @media(max-width:700px){.file-context-menu{width:min(330px,calc(100vw - 12px))}}
  `;
  document.head.append(style);

  const icon = path => `<svg viewBox="0 0 20 20" aria-hidden="true">${path}</svg>`;
  const folderIcon = icon('<path d="M2.8 5.8h5l1.5-1.9h2.8l1.4 1.9h3.7v9.3H2.8z"/><path d="M5.3 9.1h9.4"/>');
  const openIcon = icon('<path d="M8 4.2h7.8V12"/><path d="M15.8 4.2 8.7 11.3"/><path d="M12.8 9.3v6.2H4.5V7.2h6.2"/>');
  const saveIcon = icon('<path d="M3.5 3.5h10.1l2.9 2.9v10.1h-13z"/><path d="M6.1 3.5v5h7.2v-5"/><path d="M6.2 12.1h7.6v4.4H6.2z"/>');
  const copyIcon = icon('<rect x="6.4" y="6.4" width="9.1" height="9.1" rx="1.3"/><path d="M13.2 6.4V4.5H4.5v8.7h1.9"/>');
  const closeIcon = icon('<path d="M6 6l8 8M14 6l-8 8"/>');

  const menu = document.createElement('div');
  menu.className = 'file-context-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" class="file-context-close" data-context-action="close" aria-label="Close" title="Close">${closeIcon}</button>
    <div class="file-context-summary">
      <strong data-context-filename></strong>
      <div class="file-context-path-wrap">
        <span class="file-context-label">Path</span>
        <div class="file-context-path" data-context-path></div>
      </div>
      <div class="file-context-facts">
        <div class="file-context-fact"><span class="file-context-label">Date</span><b data-context-date></b></div>
        <div class="file-context-fact"><span class="file-context-label">Size</span><b data-context-size></b></div>
      </div>
    </div>
    <div class="file-context-actions">
      <button type="button" class="file-context-action" data-context-action="reveal"><i>${folderIcon}</i><span>Open in Explorer</span></button>
      <button type="button" class="file-context-action" data-context-action="tab"><i>${openIcon}</i><span>Open in new tab</span></button>
      <button type="button" class="file-context-action" data-context-action="save"><i>${saveIcon}</i><span>Save as</span></button>
      <button type="button" class="file-context-action" data-context-action="copy-path"><i>${copyIcon}</i><span>Copy path</span></button>
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
  const statusNode = menu.querySelector('[data-context-status]');
  const revealButton = menu.querySelector('[data-context-action="reveal"]');
  const copyPathButton = menu.querySelector('[data-context-action="copy-path"]');

  function formatBytes(value) {
    let size = Number(value) || 0;
    if (!size) return '—';
    const units = ['B','KB','MB','GB','TB'];
    let unit = 0;
    while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit++; }
    return `${size < 10 && unit ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
      year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'
    });
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

  function render() {
    if (!active) return;
    filenameNode.textContent = active.filename || active.hash;
    pathNode.textContent = active.path || 'Path unavailable';
    pathNode.title = active.path || '';
    dateNode.textContent = formatDate(active.date);
    sizeNode.textContent = formatBytes(active.size);
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
      size: 0
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

    if (action === 'close') {
      close();
      return;
    }
    if (action === 'tab') {
      window.open(objectUrl(snapshot.hash), '_blank', 'noopener');
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
      navigator.clipboard.writeText(snapshot.path).catch(() => {});
      close();
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
        if (!response.ok) throw new Error(data.error || 'Could not open file in Explorer');
        close();
      } catch (error) {
        statusNode.textContent = error?.message || 'Could not open file in Explorer';
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
