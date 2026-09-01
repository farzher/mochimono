const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const prev = document.querySelector('#viewer-prev');
const next = document.querySelector('#viewer-next');
const actions = document.querySelector('.viewer-actions');
const infoButton = document.querySelector('#viewer-info-button');

if (viewer && viewerOpen && prev && next && actions) {
  const modes = {
    view: { label: 'Normal navigation', detail: 'Use the current library order' },
    similar: { label: 'Related files', detail: 'Group, folder, source, type, name & date' },
    nearby: { label: 'Nearby in time', detail: 'Browse the library by file date' },
    folder: { label: 'Same folder', detail: 'Only files from this folder' },
    origin: { label: 'Same source', detail: 'Only files from the same import/source' },
    type: { label: 'Same type', detail: 'Only files of this media type' },
    tags: { label: 'Same groups', detail: 'Files sharing any group with this file' }
  };
  const labels = Object.fromEntries(Object.entries(modes).map(([key, value]) => [key, value.label]));

  const style = document.createElement('style');
  style.textContent = `
    .viewer-related{position:relative}
    .viewer-related>summary{height:34px;min-width:34px;display:flex;align-items:center;justify-content:center;gap:6px;padding:0 7px;border-radius:8px;color:#d2c9c6;cursor:pointer;list-style:none;text-shadow:0 1px 4px rgba(0,0,0,.9)}
    .viewer-related>summary::-webkit-details-marker{display:none}
    .viewer-related>summary:hover,.viewer-related[open]>summary,.viewer-related.active>summary{background:rgba(255,255,255,.09);color:#fff}
    .viewer-related svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round}
    .viewer-related-label{display:none;font-size:9px;font-weight:700;white-space:nowrap}
    .viewer-related.active .viewer-related-label{display:inline}
    .viewer-related-popover{position:absolute;z-index:130;right:0;top:40px;width:246px;padding:6px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:#181619;box-shadow:0 16px 45px rgba(0,0,0,.5)}
    .viewer-related-popover button{display:grid;width:100%;min-height:43px;align-content:center;gap:2px;padding:6px 9px;border-radius:7px;background:transparent;color:#bdb4b1;text-align:left}
    .viewer-related-popover button:hover{background:#282428;color:#fff}
    .viewer-related-popover button.active{color:#efb0aa;background:rgba(239,160,154,.07)}
    .viewer-related-popover button strong{font-size:10px;font-weight:700;color:inherit}
    .viewer-related-popover button span{font-size:9px;font-weight:500;line-height:1.25;color:#7f7775}
    .viewer-related-popover button.active span,.viewer-related-popover button:hover span{color:#aaa19e}
    .viewer-related-hint{position:absolute;right:0;top:40px;display:none;align-items:center;gap:7px;padding:6px 9px;border-radius:8px;background:rgba(20,18,21,.88);color:#a89f9c;font-size:9px;font-weight:600;white-space:nowrap;pointer-events:none;box-shadow:0 5px 20px rgba(0,0,0,.25)}
    .viewer-related.active:not([open]) .viewer-related-hint.show{display:flex}
    .viewer-related-hint b{color:#eee7e3;font-size:10px;font-weight:700}
    @media(max-width:700px){
      .viewer-related.active .viewer-related-label{display:none}
      .viewer-related-popover{position:fixed;right:8px;top:50px;width:min(270px,calc(100vw - 16px))}
      .viewer-related-hint{right:-6px}
    }
  `;
  document.head.append(style);

  const control = document.createElement('details');
  control.className = 'viewer-related';
  control.innerHTML = `
    <summary title="Related navigation" aria-label="Related navigation">
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="6" cy="10" r="3"/><circle cx="14" cy="10" r="3"/><path d="M9 10h2"/></svg>
      <span class="viewer-related-label"></span>
    </summary>
    <div class="viewer-related-popover">
      ${Object.entries(modes).map(([value, item]) => `<button type="button" data-related-mode="${value}"><strong>${item.label}</strong><span>${item.detail}</span></button>`).join('')}
    </div>
    <div class="viewer-related-hint"><b></b><span>← → browse</span></div>`;
  actions.insertBefore(control, infoButton || actions.firstChild);

  const summary = control.querySelector('summary');
  const modeLabel = control.querySelector('.viewer-related-label');
  const hint = control.querySelector('.viewer-related-hint');
  const hintLabel = hint.querySelector('b');
  const modeButtons = [...control.querySelectorAll('[data-related-mode]')];

  let mode = 'view';
  let anchorHash = '';
  let context = [];
  let generation = 0;
  let catalogPromise = null;
  let hintTimer = 0;
  const collectionsCache = new Map();
  const collectionHashesCache = new Map();

  const currentHash = () => viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const parentPath = value => {
    const parts = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean);
    parts.pop();
    return parts.join('/').toLowerCase();
  };
  const extension = value => String(value || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  const type = file => {
    const mime = String(file?.mime || '');
    const base = mime.split('/')[0];
    if (base && base !== 'application') return base;
    const ext = extension(file?.filename);
    if (['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff'].includes(ext)) return 'image';
    if (['mp4','m4v','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp'].includes(ext)) return 'video';
    if (['mp3','m4a','aac','wav','flac','ogg','opus'].includes(ext)) return 'audio';
    return base || 'other';
  };
  const fileDate = file => {
    const date = new Date(file?.fileDate || file?.createdAt || 0);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
  };
  const importIds = file => Array.isArray(file?.importIds)
    ? file.importIds.map(Number).filter(Boolean)
    : String(file?.importIds || '').split(',').map(Number).filter(Boolean);
  const words = value => String(value || '').toLowerCase().replace(/\.[^.]+$/, '').split(/[^a-z0-9]+/).filter(word => word.length > 2);
  const intersects = (a, b) => {
    const set = new Set(a);
    return b.some(value => set.has(value));
  };

  async function json(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  }

  async function catalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      const files = [];
      let after = '';
      do {
        const page = await json(`/api/catalog?limit=5000&after=${encodeURIComponent(after)}`);
        files.push(...(page.files || []));
        after = page.nextAfter || '';
      } while (after);
      return files;
    })().catch(error => {
      catalogPromise = null;
      throw error;
    });
    return catalogPromise;
  }

  async function collectionsFor(hash) {
    if (!hash) return [];
    if (!collectionsCache.has(hash)) collectionsCache.set(hash, json(`/api/collections/file/${hash}`).then(data => data.collections || []).catch(() => []));
    return collectionsCache.get(hash);
  }

  async function hashesForCollection(id) {
    const key = String(id);
    if (!collectionHashesCache.has(key)) collectionHashesCache.set(key, json(`/api/collections/${encodeURIComponent(key)}/hashes`).then(data => new Set(data.hashes || [])).catch(() => new Set()));
    return collectionHashesCache.get(key);
  }

  async function tagHashes(hash) {
    const tags = await collectionsFor(hash);
    const sets = await Promise.all(tags.map(tag => hashesForCollection(tag.id)));
    const result = new Set();
    for (const set of sets) for (const value of set) result.add(value);
    return result;
  }

  const byDateDesc = items => items.sort((a, b) => fileDate(b) - fileDate(a) || String(a.hash).localeCompare(String(b.hash)));

  async function buildContext(nextMode, anchor) {
    const files = await catalog();
    const current = files.find(file => file.hash === anchor);
    if (!current) return [];
    if (nextMode === 'nearby') return [...files].sort((a, b) => fileDate(a) - fileDate(b) || String(a.hash).localeCompare(String(b.hash)));
    if (nextMode === 'folder') {
      const parent = parentPath(current.originalPath);
      return files.filter(file => parentPath(file.originalPath) === parent).sort((a, b) => String(a.filename || '').localeCompare(String(b.filename || ''), undefined, { numeric: true }));
    }
    if (nextMode === 'origin') {
      const ids = importIds(current);
      return byDateDesc(files.filter(file => intersects(ids, importIds(file))));
    }
    if (nextMode === 'type') return byDateDesc(files.filter(file => type(file) === type(current)));
    if (nextMode === 'tags') {
      const hashes = await tagHashes(anchor);
      hashes.add(anchor);
      return byDateDesc(files.filter(file => hashes.has(file.hash)));
    }
    if (nextMode === 'similar') {
      const tags = await tagHashes(anchor);
      const parent = parentPath(current.originalPath);
      const ids = importIds(current);
      const currentType = type(current);
      const currentExt = extension(current.filename);
      const currentWords = words(current.filename);
      const currentDate = fileDate(current);
      const scored = files.map(file => {
        if (file.hash === anchor) return { file, score: Number.POSITIVE_INFINITY };
        let score = 0;
        if (tags.has(file.hash)) score += 12;
        if (parent && parentPath(file.originalPath) === parent) score += 8;
        if (intersects(ids, importIds(file))) score += 4;
        if (type(file) === currentType) score += 3;
        if (currentExt && extension(file.filename) === currentExt) score += 2;
        score += Math.min(6, words(file.filename).filter(word => currentWords.includes(word)).length * 2);
        const days = Math.abs(fileDate(file) - currentDate) / 86400000;
        if (days < 1) score += 4;
        else if (days < 7) score += 3;
        else if (days < 31) score += 2;
        else if (days < 365) score += 1;
        return { file, score };
      }).filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || Math.abs(fileDate(a.file) - currentDate) - Math.abs(fileDate(b.file) - currentDate));
      return scored.slice(0, 300).map(item => item.file);
    }
    return [];
  }

  function showHint() {
    clearTimeout(hintTimer);
    if (mode === 'view') {
      hint.classList.remove('show');
      return;
    }
    hintLabel.textContent = `${labels[mode]} · ${context.length.toLocaleString()}`;
    hint.classList.add('show');
    hintTimer = setTimeout(() => hint.classList.remove('show'), 3200);
  }

  function syncUi(loading = false) {
    control.classList.toggle('active', mode !== 'view');
    for (const button of modeButtons) button.classList.toggle('active', button.dataset.relatedMode === mode);
    if (mode === 'view') {
      modeLabel.textContent = '';
      summary.title = 'Related navigation';
      hint.classList.remove('show');
      return;
    }
    const text = loading ? `${labels[mode]}…` : `${labels[mode]} · ${context.length.toLocaleString()}`;
    modeLabel.textContent = text;
    summary.title = `${text} · left/right arrows browse this set`;
  }

  function updateButtons() {
    if (mode === 'view') return;
    const index = context.findIndex(file => file.hash === currentHash());
    prev.disabled = index <= 0;
    next.disabled = index < 0 || index >= context.length - 1;
    syncUi(false);
  }

  async function setMode(value) {
    const previousMode = mode;
    mode = value in labels ? value : 'view';
    control.open = false;
    generation++;

    if (mode === 'view') {
      const returnHash = anchorHash;
      anchorHash = '';
      context = [];
      syncUi(false);
      if (previousMode !== 'view' && returnHash) window.mochimonoOpenViewer?.(returnHash);
      return;
    }

    if (previousMode === 'view' || !anchorHash) anchorHash = currentHash();
    const mine = generation;
    syncUi(true);
    try {
      const built = await buildContext(mode, anchorHash);
      if (mine !== generation || mode === 'view') return;
      context = built;
      if (!context.some(file => file.hash === currentHash())) window.mochimonoOpenViewer?.(anchorHash);
      requestAnimationFrame(() => {
        updateButtons();
        showHint();
      });
    } catch {
      if (mine !== generation) return;
      context = [];
      updateButtons();
      showHint();
    }
  }

  function navigate(step) {
    if (mode === 'view' || !context.length) return false;
    const index = context.findIndex(file => file.hash === currentHash());
    const file = context[index + step];
    if (!file) return true;
    window.mochimonoOpenViewer?.(file.hash, file);
    requestAnimationFrame(updateButtons);
    return true;
  }

  for (const button of modeButtons) button.addEventListener('click', () => setMode(button.dataset.relatedMode));
  prev.addEventListener('click', event => {
    if (mode === 'view') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(-1);
  }, true);
  next.addEventListener('click', event => {
    if (mode === 'view') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(1);
  }, true);

  document.addEventListener('pointerdown', event => {
    if (control.open && !control.contains(event.target)) control.open = false;
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && control.open) {
      control.open = false;
      summary.focus();
      return;
    }
    if (mode === 'view' || viewer.hidden || !['ArrowLeft','ArrowRight'].includes(event.key)) return;
    if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate(event.key === 'ArrowLeft' ? -1 : 1);
  }, true);

  new MutationObserver(() => {
    if (mode !== 'view') requestAnimationFrame(updateButtons);
  }).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });

  new MutationObserver(() => {
    if (!viewer.hidden) return;
    generation++;
    mode = 'view';
    anchorHash = '';
    context = [];
    control.open = false;
    clearTimeout(hintTimer);
    syncUi(false);
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  window.addEventListener('mochimono:groups-changed', () => {
    collectionsCache.clear();
    collectionHashesCache.clear();
    catalogPromise = null;
    if (mode === 'tags' || mode === 'similar') setMode(mode);
  });

  syncUi(false);
}
