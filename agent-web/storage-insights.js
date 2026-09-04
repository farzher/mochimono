const storagePane = document.querySelector('#storagePane');
const foldersSection = storagePane?.querySelector('.storage-folders-section');
const filesFrame = document.querySelector('#filesFrame');
const storageTab = document.querySelector('[data-client-tab="storage"]');

if (storagePane && foldersSection) {
  const style = document.createElement('style');
  style.textContent = `
.storage-space-section{display:grid;gap:14px}
.storage-space-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:0 3px}
.storage-space-head h2{font-size:16px}
.storage-space-total{color:#d8d0cd;font-size:13px;font-weight:700;white-space:nowrap}
.storage-space-folders{display:grid;gap:9px;padding:0 3px}
.storage-space-folder{display:grid;grid-template-columns:minmax(90px,170px) minmax(80px,1fr) auto;align-items:center;gap:10px;min-width:0}
.storage-space-folder>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b7aeab;font-size:12px}
.storage-space-folder>i{height:4px;border-radius:999px;background:#272327;overflow:hidden}
.storage-space-folder>i>b{display:block;height:100%;border-radius:inherit;background:#d69a95}
.storage-space-folder>strong{min-width:62px;color:#968d8b;font-size:11px;font-weight:650;text-align:right;white-space:nowrap}
.storage-space-types{display:flex;flex-wrap:wrap;gap:5px 12px;padding:1px 3px 0;color:#8f8684;font-size:11px}
.storage-space-types b{color:#b7aeab;font-weight:650}
.storage-space-candidates{padding:3px 3px 0}
.storage-space-candidates[hidden]{display:none!important}
.storage-space-candidates-head{margin:3px 0 5px;color:#8f8684;font-size:11px;font-weight:700}
.storage-space-candidate{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px;padding:8px 0;border-radius:0;border-bottom:1px solid #201e20;background:transparent;color:inherit;text-align:left;font-weight:500}
.storage-space-candidate:last-child{border-bottom:0}
.storage-space-candidate:hover{background:rgba(255,255,255,.018)}
.storage-space-candidate-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d8d0cd;font-size:12px}
.storage-space-candidate-size{color:#a49b98;font-size:11px;white-space:nowrap}
.storage-space-candidate-hint{min-width:86px;color:#d6a29d;font-size:11px;text-align:right;white-space:nowrap}
@media(max-width:700px){.storage-space-folder{grid-template-columns:minmax(70px,1fr) minmax(70px,1fr) auto}.storage-space-candidate{grid-template-columns:minmax(0,1fr) auto}.storage-space-candidate-hint{grid-column:1/-1;min-width:0;text-align:left;margin-top:-7px}.storage-space-candidate-size{align-self:start}}
`;
  document.head.append(style);

  const section = document.createElement('section');
  section.className = 'dashboard-section storage-space-section';
  section.hidden = true;
  section.innerHTML = `
    <div class="storage-space-head"><h2>Space</h2><span class="storage-space-total" data-space-total></span></div>
    <div class="storage-space-folders" data-space-folders></div>
    <div class="storage-space-types" data-space-types title="Unique indexed content"></div>
    <div class="storage-space-candidates" data-space-candidates hidden>
      <div class="storage-space-candidates-head">Worth shrinking</div>
      <div data-space-candidate-list></div>
    </div>`;
  storagePane.insertBefore(section, foldersSection);

  const totalNode = section.querySelector('[data-space-total]');
  const foldersNode = section.querySelector('[data-space-folders]');
  const typesNode = section.querySelector('[data-space-types]');
  const candidatesNode = section.querySelector('[data-space-candidates]');
  const candidateList = section.querySelector('[data-space-candidate-list]');
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

  function candidateHint(file) {
    const size = Number(file.size) || 0;
    const extension = ext(file.filename || file.originalPath);
    if (['png','bmp','tif','tiff'].includes(extension) && size >= 2_000_000) return { text: `${extension.toUpperCase()} → WebP`, weight: 3 };
    if (['jpg','jpeg','heic','heif'].includes(extension) && size >= 20_000_000) return { text: `Large ${extension.toUpperCase()}`, weight: 1.35 };
    if (String(file.mime || '').startsWith('video/') && size >= 250_000_000) {
      const older = ['avi','mpg','mpeg','m2v','mts','m2ts','mov'].includes(extension);
      return { text: older ? 'Older video' : 'Large video', weight: older ? 1.5 : .9 };
    }
    return null;
  }

  function renderFolders(folders) {
    const sorted = folders.filter(item => Number(item.bytes) > 0).sort((a,b) => Number(b.bytes) - Number(a.bytes));
    const total = sorted.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
    totalNode.textContent = bytes(total);
    if (!sorted.length) {
      foldersNode.replaceChildren();
      section.hidden = true;
      return false;
    }
    const shown = sorted.slice(0, 5);
    const restBytes = sorted.slice(5).reduce((sum, item) => sum + Number(item.bytes || 0), 0);
    if (restBytes) shown.push({ path: 'Other', bytes: restBytes });
    foldersNode.innerHTML = shown.map(item => {
      const share = total ? Math.max(1, Math.min(100, Number(item.bytes) / total * 100)) : 0;
      return `<div class="storage-space-folder" title="${esc(item.path)}"><span>${esc(nameFromPath(item.path))}</span><i><b style="width:${share.toFixed(2)}%"></b></i><strong>${esc(bytes(item.bytes))}</strong></div>`;
    }).join('');
    section.hidden = false;
    return true;
  }

  async function localFiles(token) {
    const files = [];
    const seen = new Set();
    let offset = 0;
    for (;;) {
      if (token !== generation) return [];
      const response = await fetch(`/api/client/local-catalog?limit=5000&offset=${offset}`, { cache:'no-store' });
      if (!response.ok) throw new Error('Could not inspect local files');
      const data = await response.json();
      for (const file of data.files || []) {
        const hash = String(file.hash || '');
        if (hash && seen.has(hash)) continue;
        if (hash) seen.add(hash);
        files.push(file);
      }
      if (data.nextOffset == null) break;
      offset = Number(data.nextOffset) || 0;
      if (!offset) break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return files;
  }

  function renderTypes(files) {
    const totals = { Videos:0, Images:0, Audio:0, Other:0 };
    for (const file of files) {
      const mime = String(file.mime || '');
      const size = Number(file.size) || 0;
      if (mime.startsWith('video/')) totals.Videos += size;
      else if (mime.startsWith('image/')) totals.Images += size;
      else if (mime.startsWith('audio/')) totals.Audio += size;
      else totals.Other += size;
    }
    typesNode.innerHTML = Object.entries(totals)
      .filter(([,size]) => size > 0)
      .sort((a,b) => b[1] - a[1])
      .map(([label,size]) => `<span><b>${label}</b> ${esc(bytes(size))}</span>`)
      .join('');
  }

  function renderCandidates(files) {
    const ranked = [];
    for (const file of files) {
      const hint = candidateHint(file);
      if (!hint) continue;
      ranked.push({ file, hint, score: Number(file.size || 0) * hint.weight });
    }
    ranked.sort((a,b) => b.score - a.score || Number(b.file.size || 0) - Number(a.file.size || 0));
    const shown = ranked.slice(0, 7);
    candidatesNode.hidden = !shown.length;
    candidateList.innerHTML = shown.map(({ file, hint }) => `<button class="storage-space-candidate" data-space-hash="${esc(file.hash)}" title="${esc(file.originalPath || file.filename)}"><span class="storage-space-candidate-name">${esc(file.filename || nameFromPath(file.originalPath))}</span><span class="storage-space-candidate-size">${esc(bytes(file.size))}</span><span class="storage-space-candidate-hint">${esc(hint.text)}</span></button>`).join('');
  }

  async function refresh(force = false) {
    if (storagePane.hidden) return;
    if (!force && Date.now() - loadedAt < 60_000) return;
    if (loading) return loading;
    const token = ++generation;
    loading = (async () => {
      try {
        const statsResponse = await fetch('/api/folder-stats', { cache:'no-store' });
        if (!statsResponse.ok) throw new Error('Could not load storage');
        const stats = await statsResponse.json();
        if (token !== generation || !renderFolders(stats.folders || [])) return;
        const files = await localFiles(token);
        if (token !== generation) return;
        renderTypes(files);
        renderCandidates(files);
        loadedAt = Date.now();
      } catch {
        if (!foldersNode.children.length) section.hidden = true;
      } finally {
        if (token === generation) loading = null;
      }
    })();
    return loading;
  }

  candidateList.addEventListener('click', event => {
    const button = event.target.closest('[data-space-hash]');
    if (!button) return;
    const hash = String(button.dataset.spaceHash || '');
    if (!hash) return;
    storageTab?.click();
    const open = () => filesFrame?.contentWindow?.mochimonoOpenViewer?.(hash);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!open()) setTimeout(open, 180);
    }));
  });

  new MutationObserver(() => {
    if (storagePane.hidden) generation++;
    else refresh();
  }).observe(storagePane, { attributes:true, attributeFilter:['hidden'] });

  addEventListener('focus', () => refresh());
  setInterval(() => refresh(), 60_000);
}
