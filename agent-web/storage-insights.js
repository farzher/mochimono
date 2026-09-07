const storagePane = document.querySelector('#storagePane');
const foldersSection = storagePane?.querySelector('.storage-folders-section');
const filesFrame = document.querySelector('#filesFrame');

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
.storage-space-empty{padding:8px 0;color:#77706f;font-size:11px}
.storage-space-error{padding:8px 0;color:#c98f89;font-size:11px}
@media(max-width:700px){.storage-space-type{grid-template-columns:64px minmax(60px,1fr) auto}.storage-space-type-share{display:none}}
`;
  document.head.append(style);

  const section = document.createElement('section');
  section.className = 'dashboard-section storage-space-section';
  section.hidden = true;
  section.innerHTML = `
    <div class="storage-space-head"><h2>Space</h2><span class="storage-space-total" data-space-total></span></div>
    <div class="storage-space-block"><div class="storage-space-label">By type</div><div class="storage-space-types" data-space-types></div></div>
    <div class="storage-space-error" data-space-error hidden></div>`;
  storagePane.insertBefore(section, foldersSection);

  const totalNode = section.querySelector('[data-space-total]');
  const typesNode = section.querySelector('[data-space-types]');
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

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));

  function kind(file) {
    const mime = String(file.mime || '');
    if (mime.startsWith('video/')) return 'Video';
    if (mime.startsWith('image/')) return 'Images';
    if (mime.startsWith('audio/')) return 'Audio';
    return 'Other';
  }

  function addFiles(data, files, seen) {
    for (const file of data?.files || []) {
      const hash = String(file?.hash || '');
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      files.push(file);
    }
  }

  async function json(url, token, optional = false) {
    if (token !== generation) return null;
    try {
      const response = await fetch(url, { cache:'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (optional) return null;
      throw error;
    }
  }

  async function libraryCache(token, files, seen) {
    const frame = filesFrame?.contentWindow;
    for (let attempt = 0; attempt < 8 && token === generation && !frame?.mochimonoLibrary; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    if (token !== generation) return { visibleTotal:0, cached:0 };
    const visibleTotal = Number(frame?.mochimonoLibrary?.state?.().total) || 0;
    let snapshot = null;
    try { snapshot = await frame?.mochimonoCatalogCache?.load?.(); } catch {}
    if (token !== generation) return { visibleTotal, cached:0 };
    addFiles(snapshot, files, seen);
    return { visibleTotal, cached:Number(snapshot?.files?.length) || 0 };
  }

  async function mergeLocal(token, files, seen) {
    let offset = 0;
    for (;;) {
      const data = await json(`/api/client/local-catalog?limit=5000&offset=${offset}`, token, true);
      if (!data) break;
      addFiles(data, files, seen);
      if (data.nextOffset == null) break;
      const next = Number(data.nextOffset);
      if (!Number.isFinite(next) || next <= offset) break;
      offset = next;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  async function mergeServer(token, files, seen) {
    let after = '';
    do {
      const data = await json(`/api/catalog?limit=5000&after=${encodeURIComponent(after)}`, token, true);
      if (!data) return;
      addFiles(data, files, seen);
      after = String(data.nextAfter || '');
      await new Promise(resolve => setTimeout(resolve, 0));
    } while (after && token === generation);
  }

  async function libraryFiles(token) {
    const files = [];
    const seen = new Set();
    const cache = await libraryCache(token, files, seen);
    if (token !== generation) return [];

    await mergeLocal(token, files, seen);
    if (token !== generation) return [];

    if (!cache.cached || cache.cached !== cache.visibleTotal) await mergeServer(token, files, seen);
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

    totalNode.textContent = files.length ? `${bytes(total)} · ${files.length.toLocaleString()} files` : '';
    const rows = [...totals].filter(([, size]) => size > 0).sort((a, b) => b[1] - a[1]);
    typesNode.innerHTML = rows.length ? rows.map(([label, size]) => {
      const share = total ? size / total * 100 : 0;
      return `<div class="storage-space-type"><span class="storage-space-type-name">${label}</span><span class="storage-space-type-bar"><i style="width:${Math.max(1, share).toFixed(2)}%"></i></span><span class="storage-space-type-size">${esc(bytes(size))}</span><span class="storage-space-type-share">${share.toFixed(0)}%</span></div>`;
    }).join('') : '<div class="storage-space-empty">No files in library</div>';
  }

  async function refresh(force = false) {
    if (storagePane.hidden) return;
    if (!force && Date.now() - loadedAt < 60_000) return;
    if (loading) return loading;
    const token = ++generation;
    section.hidden = false;
    errorNode.hidden = true;

    loading = (async () => {
      try {
        const files = await libraryFiles(token);
        if (token !== generation) return;
        renderTypes(files);
        loadedAt = Date.now();
      } catch (error) {
        if (token !== generation) return;
        totalNode.textContent = '';
        typesNode.innerHTML = '<div class="storage-space-empty">Analysis unavailable</div>';
        errorNode.textContent = error?.message || 'Could not analyze library';
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
