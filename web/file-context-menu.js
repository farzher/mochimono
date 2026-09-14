const files = document.querySelector('#files');
const CLIENT = document.documentElement.classList.contains('client-library');

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes file-context-in{from{opacity:0;transform:translateY(-3px) scale(.985)}to{opacity:1;transform:none}}
    .file-context-menu{position:fixed;z-index:90;width:min(326px,calc(100vw - 16px));padding:7px;border:1px solid rgba(255,255,255,.105);border-radius:14px;background:rgba(22,20,23,.975);box-shadow:0 24px 70px rgba(0,0,0,.55),0 4px 16px rgba(0,0,0,.34);backdrop-filter:blur(22px) saturate(1.08);color:#eee8e4;font:11px/1.25 system-ui;user-select:none;animation:file-context-in 105ms cubic-bezier(.2,.8,.2,1)}
    .file-context-menu[hidden]{display:none}
    .file-context-summary{position:relative;display:grid;grid-template-columns:52px minmax(0,1fr) 22px;align-items:center;gap:10px;padding:5px 5px 7px}
    .file-context-preview{position:relative;width:52px;height:52px;overflow:hidden;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:#111013;box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)}
    .file-context-preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 100ms ease}
    .file-context-preview.loaded img{opacity:1}
    .file-context-preview-fallback{position:absolute;inset:0;display:grid;place-items:center;color:#746d70;font:750 8px/1 system-ui;letter-spacing:.04em}
    .file-context-preview.loaded .file-context-preview-fallback{opacity:0}
    .file-context-identity{min-width:0;align-self:center}
    .file-context-filename{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f4efec;font-size:12.5px;font-weight:720;line-height:1.3;user-select:text}
    .file-context-meta{display:flex;align-items:center;min-width:0;margin-top:5px;overflow:hidden;color:#81797c;font-size:9px;line-height:1.2;white-space:nowrap}
    .file-context-meta span:empty{display:none}
    .file-context-meta span+span:not(:empty)::before{content:'·';margin:0 5px;color:#514b4f}
    .file-context-type{padding:2px 5px;border-radius:5px;background:#2a262b;color:#aaa1a4;font-size:8px;font-weight:800;letter-spacing:.03em}
    .file-context-location.local{color:#9fb8a3}.file-context-location.cloud{color:#aaa1bd}
    .file-context-close{align-self:start;width:22px;height:22px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:#6f686b;cursor:pointer}
    .file-context-close:hover,.file-context-close:focus-visible{outline:0;background:#302b31;color:#f5f0ed}
    .file-context-close svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round}
    .file-context-path-row{width:100%;height:31px;display:grid;grid-template-columns:18px minmax(0,1fr) 18px;align-items:center;gap:6px;padding:0 7px;margin:1px 0 0;border:1px solid rgba(255,255,255,.06);border-radius:8px;background:#151316;color:#948c8f;text-align:left;cursor:pointer}
    .file-context-path-row:hover,.file-context-path-row:focus-visible{outline:0;border-color:rgba(255,255,255,.11);background:#1d1a1e;color:#b9b0ad}
    .file-context-path-row[disabled]{opacity:.48;cursor:default;background:#151316;border-color:rgba(255,255,255,.05)}
    .file-context-path-icon,.file-context-copy-icon{display:grid;place-items:center;color:#756e71}.file-context-copy-icon{opacity:.58}
    .file-context-path-row:hover .file-context-copy-icon{opacity:1;color:#bdb4b1}
    .file-context-path-icon svg,.file-context-copy-icon svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round}
    .file-context-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:9px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;user-select:text}
    .file-context-actions{display:flex;flex-wrap:wrap;gap:5px;padding-top:7px;margin-top:6px;border-top:1px solid rgba(255,255,255,.065)}
    .file-context-actions>.file-context-action{flex:1 1 120px;width:auto;min-width:0;min-height:42px;display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid rgba(255,255,255,.055);border-radius:9px;background:#211e22;color:#d9d1ce;text-align:left;font:700 10px/1.15 system-ui;cursor:pointer;transition:background 80ms ease,border-color 80ms ease,transform 80ms ease}
    .file-context-actions>.file-context-action:hover,.file-context-actions>.file-context-action:focus-visible{outline:0;border-color:rgba(255,255,255,.11);background:#2b272d;color:#fff;transform:translateY(-1px)}
    .file-context-actions>.file-context-action[disabled]{opacity:.38;cursor:default;transform:none;background:#211e22}
    .file-context-actions>.file-context-action i{width:25px;height:25px;display:grid;place-items:center;flex:0 0 25px;border-radius:7px;background:#18161a;color:#aaa1a0;font-style:normal;font-size:13px}
    .file-context-actions>.file-context-action i svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round}
    .file-context-actions>.file-context-action[data-tag-context] i{background:#292331;color:#c7b3dc}
    .file-context-actions>.file-context-action[data-context-similarity] i{background:#202a30;color:#adcad8}
    .file-context-standard-actions{flex:1 0 100%;display:grid;gap:1px;padding-top:4px}
    .file-context-standard-actions>.file-context-action{width:100%;min-height:33px;display:flex;align-items:center;gap:9px;padding:6px 7px;border:0;border-radius:7px;background:transparent;color:#cfc7c4;text-align:left;font:620 10.5px/1.15 system-ui;cursor:pointer}
    .file-context-standard-actions>.file-context-action:hover,.file-context-standard-actions>.file-context-action:focus-visible{outline:0;background:#2a262b;color:#fff}
    .file-context-standard-actions>.file-context-action[disabled]{opacity:.36;cursor:default;background:transparent}
    .file-context-standard-actions>.file-context-action i{width:20px;height:20px;display:grid;place-items:center;flex:0 0 20px;color:#91898b;font-style:normal}
    .file-context-standard-actions>.file-context-action i svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
    .file-context-action-text{display:grid;gap:1px;min-width:0}.file-context-action-text>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-context-action-text small{color:#716a6d;font-size:8.5px;font-weight:550}
    .file-context-status{min-height:0;margin:0 3px;color:#d79690;font-size:9px;line-height:1.3}
    .file-context-status.success{color:#9fbea4}
    .file-context-status:not(:empty){margin-top:5px;padding:6px 8px;border-radius:7px;background:#171519}
    @media(max-width:700px){.file-context-menu{width:min(318px,calc(100vw - 12px))}}
    @media(prefers-reduced-motion:reduce){.file-context-menu{animation:none}.file-context-preview img,.file-context-actions>.file-context-action{transition:none}}
  `;
  document.head.append(style);

  const icon = path => `<svg viewBox="0 0 20 20" aria-hidden="true">${path}</svg>`;
  const folderIcon = icon('<path d="M2.8 5.8h5l1.5-1.9h2.8l1.4 1.9h3.7v9.3H2.8z"/><path d="M5.3 9.1h9.4"/>');
  const viewIcon = icon('<path d="M2.7 10s2.7-4.4 7.3-4.4 7.3 4.4 7.3 4.4-2.7 4.4-7.3 4.4S2.7 10 2.7 10Z"/><circle cx="10" cy="10" r="2.2"/>');
  const openIcon = icon('<path d="M8 4.2h7.8V12"/><path d="M15.8 4.2 8.7 11.3"/><path d="M12.8 9.3v6.2H4.5V7.2h6.2"/>');
  const saveIcon = icon('<path d="M10 2.8v9.1"/><path d="m6.6 8.8 3.4 3.4 3.4-3.4"/><path d="M4 13.4v3h12v-3"/>');
  const copyIcon = icon('<rect x="6.4" y="6.4" width="9.1" height="9.1" rx="1.3"/><path d="M13.2 6.4V4.5H4.5v8.7h1.9"/>');
  const closeIcon = icon('<path d="M6 6l8 8M14 6l-8 8"/>');

  const menu = document.createElement('div');
  menu.className = 'file-context-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'File actions');
  menu.innerHTML = `
    <div class="file-context-summary">
      <div class="file-context-preview" data-context-preview>
        <span class="file-context-preview-fallback" data-context-preview-fallback>FILE</span>
        <img data-context-thumb alt="">
      </div>
      <div class="file-context-identity">
        <strong class="file-context-filename" data-context-filename></strong>
        <div class="file-context-meta">
          <span class="file-context-type" data-context-type></span>
          <span data-context-size></span>
          <span data-context-date></span>
          <span class="file-context-location" data-context-location></span>
        </div>
      </div>
      <button type="button" class="file-context-close" data-context-action="close" aria-label="Close" title="Close">${closeIcon}</button>
    </div>
    <button type="button" class="file-context-path-row" data-context-action="copy-path" title="Copy path">
      <span class="file-context-path-icon">${folderIcon}</span>
      <span class="file-context-path" data-context-path></span>
      <span class="file-context-copy-icon">${copyIcon}</span>
    </button>
    <div class="file-context-actions">
      <div class="file-context-standard-actions">
        <button type="button" class="file-context-action" data-context-action="open"><i>${viewIcon}</i><span class="file-context-action-text"><span>Open</span></span></button>
        <button type="button" class="file-context-action" data-context-action="reveal"><i>${folderIcon}</i><span class="file-context-action-text"><span>Show in Explorer</span><small data-context-reveal-note></small></span></button>
        <button type="button" class="file-context-action" data-context-action="tab"><i>${openIcon}</i><span class="file-context-action-text"><span>Open in new tab</span></span></button>
        <button type="button" class="file-context-action" data-context-action="save"><i>${saveIcon}</i><span class="file-context-action-text"><span>Save a copy</span></span></button>
      </div>
    </div>
    <div class="file-context-status" data-context-status aria-live="polite"></div>`;
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
  const locationNode = menu.querySelector('[data-context-location]');
  const previewNode = menu.querySelector('[data-context-preview]');
  const previewFallbackNode = menu.querySelector('[data-context-preview-fallback]');
  const thumbNode = menu.querySelector('[data-context-thumb]');
  const statusNode = menu.querySelector('[data-context-status]');
  const revealButton = menu.querySelector('[data-context-action="reveal"]');
  const revealNote = menu.querySelector('[data-context-reveal-note]');
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
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date();
    const sameYear = today.getFullYear() === date.getFullYear();
    return date.toLocaleDateString(undefined, sameYear
      ? { month:'short', day:'numeric' }
      : { month:'short', day:'numeric', year:'numeric' });
  }

  function fileType(filename) {
    const match = String(filename || '').match(/\.([^.\\/]+)$/);
    const extension = String(match?.[1] || '').toUpperCase();
    return extension && extension.length <= 7 ? extension : 'FILE';
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

  function setStatus(message = '', success = false) {
    statusNode.textContent = message;
    statusNode.classList.toggle('success', Boolean(message && success));
  }

  function setPreview(hash, filename) {
    previewNode.classList.remove('loaded');
    previewFallbackNode.textContent = fileType(filename);
    thumbNode.onload = () => {
      if (active?.hash === hash) previewNode.classList.add('loaded');
    };
    thumbNode.onerror = () => {
      if (active?.hash === hash) previewNode.classList.remove('loaded');
    };
    thumbNode.src = `/api/thumbs/${encodeURIComponent(hash)}`;
  }

  function render() {
    if (!active) return;
    const filename = active.filename || active.hash;
    filenameNode.textContent = filename;
    filenameNode.title = filename;
    typeNode.textContent = fileType(filename);
    previewFallbackNode.textContent = fileType(filename);
    pathNode.textContent = active.path || 'Path unavailable';
    copyPathButton.title = active.path ? `Copy ${active.path}` : 'Path unavailable';
    dateNode.textContent = formatDate(active.date);
    sizeNode.textContent = formatBytes(active.size);

    locationNode.textContent = CLIENT ? (active.local ? 'On this PC' : 'Cloud') : '';
    locationNode.className = `file-context-location ${CLIENT ? (active.local ? 'local' : 'cloud') : ''}`;

    revealButton.hidden = !CLIENT;
    revealButton.disabled = CLIENT && active.local === false;
    revealNote.textContent = CLIENT && active.local === false ? 'Cloud only' : '';
    copyPathButton.disabled = !active.path;
  }

  function close() {
    generation++;
    active = null;
    menu.hidden = true;
    setStatus();
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

  function visibleActionButtons() {
    return [...menu.querySelectorAll('button:not([disabled])')].filter(button => {
      if (button.dataset.contextAction === 'close') return false;
      return !button.hidden && button.getClientRects().length;
    });
  }

  function place(x, y) {
    const preferredX = x + 3;
    const preferredY = y + 3;
    menu.hidden = false;
    menu.style.left = `${Math.max(6, preferredX)}px`;
    menu.style.top = `${Math.max(6, preferredY)}px`;
    requestAnimationFrame(() => {
      if (menu.hidden) return;
      const rect = menu.getBoundingClientRect();
      const left = Math.max(6, Math.min(preferredX, innerWidth - rect.width - 6));
      const top = Math.max(6, Math.min(preferredY, innerHeight - rect.height - 6));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      visibleActionButtons()[0]?.focus({ preventScroll:true });
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
    const previousFilename = active.filename;

    active.filename = source.filename || object.filename || active.filename;
    active.path = local || active.path || sourcePath;
    active.local = Boolean(local || localPath(hash));
    active.date = source.mtime || object.fileDate || object.createdAt || active.date;
    active.size = Number(object.size) || Number(head?.headers?.get?.('content-length')) || active.size;
    if (active.filename !== previousFilename) previewFallbackNode.textContent = fileType(active.filename);
    render();
  }

  function open(card, x, y) {
    const hash = String(card.dataset.hash || '');
    if (!hash) return;
    const mine = ++generation;
    const initialLocal = localPath(hash);
    const filename = card.dataset.filename || card.getAttribute('title') || hash;
    active = {
      hash,
      card,
      filename,
      path: initialLocal,
      local: Boolean(initialLocal),
      date: card.dataset.day || '',
      size: 0
    };
    setStatus();
    setPreview(hash, filename);
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
    setStatus();

    if (action === 'close') {
      close();
      return;
    }
    if (action === 'open') {
      close();
      snapshot.card?.click();
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
      try {
        await navigator.clipboard.writeText(snapshot.path);
        setStatus('Path copied', true);
      } catch {
        setStatus('Could not copy path');
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
        if (!response.ok) throw new Error(data.error || 'Could not show file in Explorer');
        close();
      } catch (error) {
        setStatus(error?.message || 'Could not show file in Explorer');
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
    if (menu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    const buttons = visibleActionButtons();
    if (!buttons.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    let index = buttons.indexOf(document.activeElement);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = buttons.length - 1;
    else if (event.key === 'ArrowDown') index = index < 0 ? 0 : (index + 1) % buttons.length;
    else index = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
    buttons[index]?.focus({ preventScroll:true });
  }, true);
  addEventListener('blur', close);
  addEventListener('resize', close, { passive:true });
  addEventListener('scroll', close, { passive:true, capture:true });
}
