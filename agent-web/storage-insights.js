const storagePane = document.querySelector('#storagePane');
const foldersSection = storagePane?.querySelector('.storage-folders-section');
const filesFrame = document.querySelector('#filesFrame');
const storageTab = document.querySelector('[data-client-tab="storage"]');

if (storagePane && foldersSection) {
  const style = document.createElement('style');
  style.textContent = `
.storage-space-section{display:grid;gap:18px;padding:0 3px}
.storage-space-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px}
.storage-space-head h2{font-size:16px}
.storage-space-total{color:#aaa19e;font-size:12px;font-weight:650;white-space:nowrap}
.storage-space-block{display:grid;gap:8px}
.storage-space-label{color:#8f8684;font-size:11px;font-weight:700}
.storage-space-types{display:grid;gap:8px}
.storage-space-type{display:grid;grid-template-columns:72px minmax(80px,1fr) auto auto;align-items:center;gap:10px;min-width:0}
.storage-space-type-name{color:#d8d0cd;font-size:12px;font-weight:680}
.storage-space-type-bar{height:6px;border-radius:999px;background:#292529;overflow:hidden}
.storage-space-type-bar i{display:block;height:100%;border-radius:inherit;background:#d69a95}
.storage-space-type-size{min-width:62px;color:#b8afac;font-size:11px;text-align:right;white-space:nowrap}
.storage-space-type-share{min-width:36px;color:#77706f;font-size:10px;text-align:right;white-space:nowrap}
.storage-space-list{display:block;border-top:1px solid #201e20}
.storage-space-row{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px;padding:9px 0;border:0;border-bottom:1px solid #201e20;border-radius:0;background:transparent;color:inherit;text-align:left;font-weight:500}
.storage-space-row:hover{background:rgba(255,255,255,.018)}
.storage-space-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d8d0cd;font-size:12px}
.storage-space-row-size{color:#a49b98;font-size:11px;white-space:nowrap}
.storage-space-row-note{min-width:118px;color:#d6a29d;font-size:11px;text-align:right;white-space:nowrap}
.storage-space-empty{padding:8px 0;color:#77706f;font-size:11px}
.storage-space-error{padding:8px 0;color:#c98f89;font-size:11px}
@media(max-width:700px){.storage-space-type{grid-template-columns:64px minmax(60px,1fr) auto}.storage-space-type-share{display:none}.storage-space-row{grid-template-columns:minmax(0,1fr) auto}.storage-space-row-note{grid-column:1/-1;min-width:0;text-align:left;margin-top:-7px}}
`;
  document.head.append(style);

  const section = document.createElement('section');
  section.className = 'dashboard-section storage-space-section';
  section.hidden = true;
  section.innerHTML = `
    <div class="storage-space-head"><h2>Space</h2><span class="storage-space-total" data-space-total></span></div>
    <div class="storage-space-block">
      <div class="storage-space-label">By type</div>
      <div class="storage-space-types" data-space-types></div>
    </div>
    <div class="storage-space-block">
      <div class="storage-space-label">Worth shrinking</div>
      <div class="storage-space-list" data-space-candidates></div>
    </div>
    <div class="storage-space-block">
      <div class="storage-space-label">Largest files</div>
      <div class="storage-space-list" data-space-largest></div>
    </div>
    <div class="storage-space-error" data-space-error hidden></div>`;
  storagePane.insertBefore(section, foldersSection);

  const totalNode = section.querySelector('[data-space-total]');
  const typesNode = section.querySelector('[data-space-types]');
  const candidatesNode = section.querySelector('[data-space-candidates]');
  const largestNode = section.querySelector('[data-space-largest]');
  const errorNode = section.querySelector('[data-space-error]');
  let loading = null;
  let loadedAt = 0;
  let generation = 0;

  const bytes = number => {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Math.max(0, Number(number) || 0);
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const ext = name => String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  const nameFromPath = value => String(value || '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean).at(-1) || String(value || '');

  function kind(file) {
    const mime = String(file.mime || '');
    if (mime.startsWith('video/')) return 'Video';
    if (mime.startsWith('image/')) return 'Images';
    if (mime.startsWith('audio/')) return 'Audio';
    return 'Other';
  }

  function compressionCandidate(file) {
    const size = Number(file.size) || 0;
    const extension = ext(file.filename || file.originalPath);
    if (['bmp'].includes(extension) && size >= 2_000_000) return { reason:'BMP → WebP', saving:.82, weight:3.4 };
    if (['tif','tiff'].includes(extension) && size >= 2_000_000) return { reason:'TIFF → WebP', saving:.65, weight:3.1 };
    if (extension === 'png' && size >= 2_000_000) return { reason:'PNG → WebP', saving:.50, weight:2.8 };
    if (['jpg','jpeg'].includes(extension) && size >= 20_000_000) return { reason:'Large JPEG', saving:.22, weight:1.3 };
    if (['heic','heif'].includes(extension) && size >= 50_000_000) return { reason:'Very large HEIC', saving:.10, weight:.8 };
    if (String(file.mime || '').startsWith('video/') && size >= 250_000_000) {
      const older = ['avi','mpg','mpeg','m2v','mts','m2ts','mov'].includes(extension);
      return { reason:older ? 'Older video format' : 'Large video', saving:older ? .45 : .25, weight:older ? 1.55 : 1 };
    }
    return null;
  }

  function addFiles(data, files, seen) {
    for (const file of data.files || []) {
      const hash = String(file.hash || '');
      if (hash && seen.has(hash)) continue;
      if (hash) seen.add(hash);
      files.push(file);
    }
  }

  async function catalog(url, token) {
    if (token !== generation) return null;
    const response = await fetch(url, { cache:'no-store' });
    if (!response.ok) throw new Error(`Could not inspect indexed files (${response.status})`);
    return response.json();
  }

  async function localFiles(token) {
    const files = [];
    const seen = new Set();

    // Match the normal library first. The non-paged catalog includes live
    // browse-staging rows while a local folder is being indexed/reconciled.
    const live = await catalog('/api/client/local-catalog?limit=5000', token);
    if (!live) return [];
    addFiles(live, files, seen);

    // Then walk the canonical SQLite catalog so completed indexes are analyzed
    // in full. Hash de-duplication above makes overlap with the live seed cheap.
    let offset = 0;
    for (;;) {
      const data = await catalog(`/api/client/local-catalog?limit=5000&offset=${offset}`, token);
      if (!data) return [];
      addFiles(data, files, seen);
      if (data.nextOffset == null) break;
      const next = Number(data.nextOffset);
      if (!Number.isFinite(next) || next <= offset) break;
      offset = next;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return files;
  }

  function renderTypes(files) {
    const totals = new Map([['Video',0],['Images',0],['Audio',0],['Other',0]]);
    let total = 0;
    for (const file of files) {
      const size = Number(file.size) || 0;
      totals.set(kind(file), (totals.get(kind(file)) || 0) + size);
      total += size;
    }
    totalNode.textContent = total ? `${bytes(total)} unique` : '';
    const rows = [...totals].filter(([,size]) => size > 0).sort((a,b) => b[1] - a[1]);
    typesNode.innerHTML = rows.length ? rows.map(([label,size]) => {
      const share = total ? size / total * 100 : 0;
      return `<div class="storage-space-type"><span class="storage-space-type-name">${label}</span><span class="storage-space-type-bar"><i style="width:${Math.max(1,share).toFixed(2)}%"></i></span><span class="storage-space-type-size">${esc(bytes(size))}</span><span class="storage-space-type-share">${share.toFixed(0)}%</span></div>`;
    }).join('') : '<div class="storage-space-empty">No indexed files yet</div>';
  }

  function row(file, note = '') {
    const name = file.filename || nameFromPath(file.originalPath);
    return `<button class="storage-space-row" data-space-hash="${esc(file.hash)}" title="${esc(file.originalPath || name)}"><span class="storage-space-row-name">${esc(name)}</span><span class="storage-space-row-size">${esc(bytes(file.size))}</span><span class="storage-space-row-note">${esc(note)}</span></button>`;
  }

  function renderCandidates(files) {
    const ranked = [];
    for (const file of files) {
      const candidate = compressionCandidate(file);
      if (!candidate) continue;
      const size = Number(file.size) || 0;
      ranked.push({ file, candidate, reclaim:size * candidate.saving, score:size * candidate.saving * candidate.weight });
    }
    ranked.sort((a,b) => b.score - a.score || b.reclaim - a.reclaim);
    const shown = ranked.slice(0, 8);
    candidatesNode.innerHTML = shown.length ? shown.map(({ file, candidate, reclaim }) => row(file, `${candidate.reason} · ~${bytes(reclaim)} potential`)).join('') : '<div class="storage-space-empty">No obvious compression wins yet</div>';
  }

  function renderLargest(files) {
    const shown = [...files].sort((a,b) => Number(b.size || 0) - Number(a.size || 0)).slice(0, 8);
    largestNode.innerHTML = shown.length ? shown.map(file => row(file, kind(file))).join('') : '<div class="storage-space-empty">No indexed files yet</div>';
  }

  function openFile(hash) {
    if (!hash) return;
    storageTab?.click();
    const open = () => filesFrame?.contentWindow?.mochimonoOpenViewer?.(hash);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!open()) setTimeout(open, 180);
    }));
  }

  section.addEventListener('click', event => {
    const button = event.target.closest('[data-space-hash]');
    if (button) openFile(String(button.dataset.spaceHash || ''));
  });

  async function refresh(force = false) {
    if (storagePane.hidden) return;
    if (!force && Date.now() - loadedAt < 60_000) return;
    if (loading) return loading;
    const token = ++generation;
    section.hidden = false;
    errorNode.hidden = true;
    loading = (async () => {
      try {
        const files = await localFiles(token);
        if (token !== generation) return;
        renderTypes(files);
        renderCandidates(files);
        renderLargest(files);
        loadedAt = Date.now();
      } catch (error) {
        if (token !== generation) return;
        totalNode.textContent = '';
        typesNode.innerHTML = '<div class="storage-space-empty">Analysis unavailable</div>';
        candidatesNode.innerHTML = '';
        largestNode.innerHTML = '';
        errorNode.textContent = error?.message || 'Could not analyze indexed files';
        errorNode.hidden = false;
      } finally {
        if (token === generation) loading = null;
      }
    })();
    return loading;
  }

  new MutationObserver(() => {
    if (storagePane.hidden) generation++;
    else refresh();
  }).observe(storagePane, { attributes:true, attributeFilter:['hidden'] });

  addEventListener('focus', () => refresh());
  setInterval(() => refresh(), 60_000);
}
