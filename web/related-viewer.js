const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const prev = document.querySelector('#viewer-prev');
const next = document.querySelector('#viewer-next');
const actions = document.querySelector('.viewer-actions');

if (viewer && viewerOpen && prev && next && actions) {
  const style = document.createElement('style');
  style.textContent = `
    .viewer-related{display:flex;align-items:center;gap:5px;height:30px;padding:0 7px;border:1px solid rgba(255,255,255,.09);border-radius:8px;background:rgba(255,255,255,.045)}
    .viewer-related span{color:#8f8583;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
    .viewer-related select{max-width:145px;height:26px;padding:0 19px 0 2px;border:0;background:transparent;color:#ddd5d1;font:600 10px/1 Inter,system-ui,sans-serif;outline:none;cursor:pointer}
    .viewer-related select option{background:#1b191c;color:#eee7e3}
    .viewer-related small{min-width:16px;color:#766f6d;font-size:9px;text-align:right}
    @media(max-width:700px){.viewer-related span{display:none}.viewer-related{padding:0 5px}.viewer-related select{max-width:108px}}
  `;
  document.head.append(style);

  const control = document.createElement('label');
  control.className = 'viewer-related';
  control.innerHTML = `<span>Browse</span><select aria-label="Browse related files">
    <option value="view">Current view</option>
    <option value="similar">Similar</option>
    <option value="nearby">Nearby in time</option>
    <option value="folder">Same folder</option>
    <option value="origin">Same origin</option>
    <option value="type">Same type</option>
    <option value="tags">Same tags / groups</option>
  </select><small></small>`;
  actions.insertBefore(control, document.querySelector('#viewer-info-button'));
  const select = control.querySelector('select');
  const count = control.querySelector('small');

  let mode = 'view';
  let anchorHash = '';
  let context = [];
  let generation = 0;
  let catalogPromise = null;
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
    if (!collectionsCache.has(hash)) {
      collectionsCache.set(hash, json(`/api/collections/file/${hash}`).then(data => data.collections || []).catch(() => []));
    }
    return collectionsCache.get(hash);
  }

  async function hashesForCollection(id) {
    const key = String(id);
    if (!collectionHashesCache.has(key)) {
      collectionHashesCache.set(key, json(`/api/collections/${encodeURIComponent(key)}/hashes`).then(data => new Set(data.hashes || [])).catch(() => new Set()));
    }
    return collectionHashesCache.get(key);
  }

  async function tagHashes(hash) {
    const tags = await collectionsFor(hash);
    const sets = await Promise.all(tags.map(tag => hashesForCollection(tag.id)));
    const result = new Set();
    for (const set of sets) for (const value of set) result.add(value);
    return result;
  }

  function byDateDesc(items) {
    return items.sort((a, b) => fileDate(b) - fileDate(a) || String(a.hash).localeCompare(String(b.hash)));
  }

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
        const sharedWords = words(file.filename).filter(word => currentWords.includes(word)).length;
        score += Math.min(6, sharedWords * 2);
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

  function updateButtons() {
    if (mode === 'view') {
      count.textContent = '';
      return;
    }
    const index = context.findIndex(file => file.hash === currentHash());
    prev.disabled = index <= 0;
    next.disabled = index < 0 || index >= context.length - 1;
    count.textContent = context.length ? context.length.toLocaleString() : '0';
  }

  async function setMode(value) {
    mode = value;
    select.value = mode;
    generation++;
    if (mode === 'view') {
      anchorHash = '';
      context = [];
      count.textContent = '';
      window.mochimonoLibrary?.refreshViewerNav?.();
      return;
    }
    anchorHash = currentHash();
    const mine = generation;
    count.textContent = '…';
    try {
      const built = await buildContext(mode, anchorHash);
      if (mine !== generation || mode === 'view') return;
      context = built;
      updateButtons();
    } catch {
      if (mine !== generation) return;
      context = [];
      count.textContent = '0';
      updateButtons();
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

  select.addEventListener('change', () => setMode(select.value));
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

  document.addEventListener('keydown', event => {
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
    select.value = 'view';
    count.textContent = '';
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  window.addEventListener('mochimono:groups-changed', () => {
    collectionsCache.clear();
    collectionHashesCache.clear();
    catalogPromise = null;
    if (mode === 'tags' || mode === 'similar') setMode(mode);
  });
}
