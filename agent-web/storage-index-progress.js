const pane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');

if (pane && folders) {
  const style = document.createElement('style');
  style.textContent = `
    .storage-folder-samples{position:relative}
    .storage-index-live{
      position:absolute;
      z-index:6;
      left:10px;right:10px;bottom:9px;
      display:flex;align-items:center;gap:9px;
      min-height:30px;padding:6px 9px;
      border:1px solid rgba(255,255,255,.08);
      border-radius:10px;
      background:rgba(12,11,13,.86);
      backdrop-filter:blur(8px);
      box-shadow:0 5px 20px rgba(0,0,0,.24);
      pointer-events:none;
    }
    .storage-index-live[hidden]{display:none}
    .storage-index-spinner{
      width:15px;height:15px;flex:0 0 auto;
      border:2px solid #49434a;border-top-color:#d7b06d;border-radius:50%;
      animation:storage-index-spin .8s linear infinite;
    }
    .storage-index-copy{min-width:0;display:flex;align-items:baseline;gap:7px;font-variant-numeric:tabular-nums}
    .storage-index-copy strong{color:#ded6d2;font-size:10px;font-weight:720;white-space:nowrap}
    .storage-index-copy span{min-width:6.5ch;color:#918986;font-size:9px;font-weight:650;white-space:nowrap;text-align:left}
    .storage-index-track{height:3px;flex:1;min-width:36px;overflow:hidden;border-radius:99px;background:#302c31}
    .storage-index-track i{display:block;width:38%;height:100%;border-radius:inherit;background:#d0a75f;animation:storage-index-slide 1.25s ease-in-out infinite}
    .folder-item.storage-indexing .storage-folder-facts{visibility:hidden}
    @keyframes storage-index-spin{to{transform:rotate(360deg)}}
    @keyframes storage-index-slide{0%{transform:translateX(-105%)}50%{transform:translateX(165%)}100%{transform:translateX(365%)}}
    @media(prefers-reduced-motion:reduce){.storage-index-spinner,.storage-index-track i{animation:none}.storage-index-track i{width:100%;opacity:.55}}
  `;
  document.head.append(style);

  const clean = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => clean(a) === clean(b);

  function liveFor(row) {
    let live = row.querySelector('.storage-index-live');
    if (live) return live;
    const samples = row.querySelector('.storage-folder-samples');
    if (!samples) return null;
    live = document.createElement('div');
    live.className = 'storage-index-live';
    live.hidden = true;
    live.innerHTML = '<span class="storage-index-spinner"></span><span class="storage-index-copy"><strong>Indexing</strong><span data-index-count></span></span><span class="storage-index-track"><i></i></span>';
    samples.append(live);
    return live;
  }

  function show(job) {
    const progress = job?.progress || {};
    const path = progress.path || '';
    const active = job?.status === 'running' && /^Indexing$/i.test(String(progress.phase || '')) && path;
    let matched = false;
    for (const row of folders.querySelectorAll('[data-folder-path]')) {
      const isCurrent = Boolean(active && samePath(row.dataset.folderPath, path));
      const live = liveFor(row);
      if (!live) continue;
      row.classList.toggle('storage-indexing', isCurrent);
      live.hidden = !isCurrent;
      if (!isCurrent) continue;
      matched = true;
      const count = Number(progress.scanned) || 0;
      const hashed = Number(progress.hashed) || 0;
      const reused = Number(progress.reused) || 0;
      const visible = Math.max(count, hashed + reused);
      const counter = live.querySelector('[data-index-count]');
      const text = visible ? `${visible.toLocaleString()} files` : 'starting…';
      if (counter.textContent !== text) counter.textContent = text;
      live.title = progress.current || path;
    }
    return matched;
  }

  function setStableStats(item) {
    const row = [...folders.querySelectorAll('[data-folder-path]')].find(node => samePath(node.dataset.folderPath, item.path));
    if (!row) return;
    const size = row.querySelector('.storage-folder-facts [data-folder-size]');
    const count = row.querySelector('.storage-folder-facts [data-folder-count]');
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Number(item.bytes) || 0;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    const formatted = unit === 0 ? `${Math.round(value)} B` : `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
    if (size && size.textContent !== formatted) size.textContent = formatted;
    if (count) {
      const text = `${Number(item.files || 0).toLocaleString()} files`;
      if (count.textContent !== text) count.textContent = text;
    }
  }

  let timer = 0;
  let runningPath = '';
  let busy = false;

  async function settle(path) {
    try {
      const response = await fetch('/api/folder-stats', { cache:'no-store' });
      const data = await response.json();
      const item = (data.folders || []).find(folder => samePath(folder.path, path));
      if (item) setStableStats(item);
    } catch {}
    const row = [...folders.querySelectorAll('[data-folder-path]')].find(node => samePath(node.dataset.folderPath, path));
    row?.classList.remove('storage-indexing');
    const live = row?.querySelector('.storage-index-live');
    if (live) live.hidden = true;
  }

  async function poll(delay = 250) {
    clearTimeout(timer);
    if (busy || pane.hidden) return;
    busy = true;
    let active = false;
    try {
      const response = await fetch('/api/state', { cache:'no-store' });
      const state = await response.json();
      const job = state.job;
      active = Boolean(job?.status === 'running' && /^Indexing$/i.test(String(job?.progress?.phase || '')) && job?.progress?.path);
      const path = active ? String(job.progress.path) : '';
      show(job);
      if (runningPath && !active) await settle(runningPath);
      runningPath = path;
    } catch {}
    finally {
      busy = false;
      if (!pane.hidden) timer = setTimeout(poll, active ? 550 : delay < 1200 ? 700 : 2200, 2200);
    }
  }

  const wake = () => { clearTimeout(timer); timer = setTimeout(() => poll(250), 40); };
  new MutationObserver(wake).observe(pane, { attributes:true, attributeFilter:['hidden'] });
  new MutationObserver(wake).observe(folders, { childList:true, subtree:false });
  if (!pane.hidden) wake();
}
