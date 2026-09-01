const pane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');

if (pane && folders) {
  const style = document.createElement('style');
  style.textContent = `
    #storagePane .storage-index-live{display:none!important}
    #storagePane .storage-folder-samples{position:relative}
    #storagePane .storage-folder-sample[data-live-sample]{display:grid!important}
    #storagePane .storage-local-indexing .storage-preview-warm{display:none!important}
    .storage-local-index-live{
      position:absolute;z-index:8;left:10px;right:10px;bottom:9px;
      min-height:32px;display:flex;align-items:center;gap:9px;padding:7px 10px;
      border:1px solid rgba(255,255,255,.1);border-radius:10px;
      background:rgba(11,10,12,.9);backdrop-filter:blur(9px);pointer-events:none;
      box-shadow:0 6px 22px rgba(0,0,0,.28);font-variant-numeric:tabular-nums
    }
    .storage-local-index-live[hidden]{display:none!important}
    .storage-local-index-copy{display:flex;align-items:baseline;gap:7px;flex:0 0 auto;white-space:nowrap}
    .storage-local-index-copy strong{color:#e2dad6;font-size:10px;font-weight:720}
    .storage-local-index-copy span{color:#918986;font-size:9px;font-weight:650}
    .storage-local-index-track{position:relative;flex:1;min-width:52px;height:4px;overflow:hidden;border-radius:999px;background:#302c31}
    .storage-local-index-track i{position:absolute;top:0;bottom:0;width:34%;border-radius:999px;background:#d0a75f;animation:storage-local-index-slide 1.05s ease-in-out infinite}
    @keyframes storage-local-index-slide{0%{left:-36%}50%{left:52%}100%{left:104%}}
  `;
  document.head.append(style);

  const states = new Map();
  let timer = 0;
  let polling = false;
  let mutationFrame = 0;

  const clean = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => clean(a) === clean(b);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[char]));

  async function request(path, options = {}) {
    const response = await fetch(path, {
      cache:'no-store',
      headers:{ 'content-type':'application/json' },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function rowFor(path) {
    return [...folders.querySelectorAll('[data-folder-path]')]
      .find(row => samePath(row.dataset.folderPath, path));
  }

  function ensureStrip(row) {
    let strip = row?.querySelector('.storage-folder-samples');
    if (strip) return strip;
    const copy = row?.querySelector('.storage-copy');
    if (!copy) return null;
    strip = document.createElement('div');
    strip.className = 'storage-folder-samples';
    copy.prepend(strip);
    return strip;
  }

  function glyph(file) {
    const base = String(file?.mime || '').split('/')[0];
    return base === 'video' ? '▶' : base === 'image' ? '·' : '▤';
  }

  function renderSamples(row, media, ready) {
    const strip = ensureStrip(row);
    if (!strip) return;
    const key = JSON.stringify(media.map(file => [file.hash, file.filename, file.mime, ready.has(file.hash)]));
    if (strip.dataset.liveKey === key && strip.querySelector(':scope > [data-live-sample]')) return;
    strip.dataset.liveKey = key;

    for (const cell of strip.querySelectorAll(':scope > .storage-folder-sample')) cell.remove();
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 5; index++) {
      const file = media[index];
      const cell = document.createElement('span');
      cell.className = 'storage-folder-sample';
      cell.dataset.liveSample = '';
      if (!file) {
        fragment.append(cell);
        continue;
      }
      const video = String(file.mime || '').startsWith('video/');
      if (video) cell.classList.add('video');
      cell.title = file.filename || '';
      if (ready.has(file.hash)) {
        cell.innerHTML = `<img src="/api/thumbs/${file.hash}?v=3" alt="" loading="eager" decoding="async">`;
      } else {
        cell.innerHTML = `<b>${glyph(file)}</b><small>${esc(file.filename || '')}</small>`;
      }
      fragment.append(cell);
    }
    strip.prepend(fragment);
  }

  async function refreshSamples(row, active = false, force = false) {
    const path = row.dataset.folderPath || '';
    if (!path) return false;
    const id = clean(path);
    const state = states.get(id) || { next:0, busy:false, pending:false };
    states.set(id, state);
    const now = Date.now();
    if (state.busy || (!force && now < state.next)) return state.pending;
    state.busy = true;
    try {
      // Non-paged local-catalog reads include Browse staging rows, so samples
      // become available while the first index is still being built.
      const data = await request(`/api/client/local-catalog?path=${encodeURIComponent(path)}&limit=240`);
      const media = (data.files || [])
        .filter(file => /^(image|video)\//.test(String(file.mime || '')))
        .slice(0, 5);
      const hashes = media.map(file => file.hash).filter(Boolean);
      let ready = new Set();
      if (hashes.length) {
        const checked = await request('/api/thumbs/check', {
          method:'POST',
          body:JSON.stringify({ hashes })
        });
        ready = new Set((checked.thumbnails || [])
          .filter(item => Number(item.width) > 0 && Number(item.height) > 0)
          .map(item => String(item.hash)));
      }
      renderSamples(row, media, ready);
      state.pending = Boolean(hashes.length && hashes.some(hash => !ready.has(hash)));
      state.next = Date.now() + (state.pending ? 500 : active ? 900 : 7000);
      return state.pending;
    } catch {
      state.next = Date.now() + 1500;
      return state.pending;
    } finally {
      state.busy = false;
    }
  }

  function progressOverlay(row) {
    const strip = ensureStrip(row);
    if (!strip) return null;
    let live = strip.querySelector('.storage-local-index-live');
    if (live) return live;
    live = document.createElement('div');
    live.className = 'storage-local-index-live';
    live.hidden = true;
    live.innerHTML = '<span class="storage-local-index-copy"><strong>Indexing</strong><span data-live-index-count>starting…</span></span><span class="storage-local-index-track"><i></i></span>';
    strip.append(live);
    return live;
  }

  function renderProgress(job) {
    const progress = job?.progress || {};
    const path = String(progress.path || '');
    const active = job?.status === 'running' && /^Indexing$/i.test(String(progress.phase || '')) && path;
    for (const row of folders.querySelectorAll('[data-folder-path]')) {
      const current = Boolean(active && samePath(row.dataset.folderPath, path));
      row.classList.toggle('storage-local-indexing', current);
      const live = progressOverlay(row);
      if (!live) continue;
      live.hidden = !current;
      if (!current) continue;
      const scanned = Number(progress.scanned) || 0;
      const hashed = Number(progress.hashed) || 0;
      const reused = Number(progress.reused) || 0;
      const count = Math.max(scanned, hashed + reused);
      const label = live.querySelector('[data-live-index-count]');
      if (label) label.textContent = count ? `${count.toLocaleString()} files` : 'starting…';
      live.title = progress.current || path;
    }
    return active ? path : '';
  }

  async function poll(delay = 250) {
    clearTimeout(timer);
    if (polling) return;
    if (pane.hidden) {
      timer = setTimeout(() => poll(800), 800);
      return;
    }
    polling = true;
    let activePath = '';
    let pending = false;
    try {
      const state = await request('/api/state');
      activePath = renderProgress(state.job);
      const rows = [...folders.querySelectorAll('[data-folder-path]')];
      const results = await Promise.all(rows.map(row => refreshSamples(row, samePath(row.dataset.folderPath, activePath))));
      pending = results.some(Boolean);
    } catch {} finally {
      polling = false;
      const next = activePath || pending ? 350 : Math.max(900, delay);
      timer = setTimeout(() => poll(next), next);
    }
  }

  function scheduleImmediate() {
    if (mutationFrame) return;
    mutationFrame = requestAnimationFrame(() => {
      mutationFrame = 0;
      for (const state of states.values()) state.next = 0;
      poll(0);
    });
  }

  new MutationObserver(scheduleImmediate).observe(folders, { childList:true, subtree:true });
  new MutationObserver(() => { if (!pane.hidden) scheduleImmediate(); }).observe(pane, { attributes:true, attributeFilter:['hidden'] });
  window.addEventListener('focus', scheduleImmediate, { passive:true });
  poll(0);
}
