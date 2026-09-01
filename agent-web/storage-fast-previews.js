const pane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');

if (pane && folders) {
  const CACHE_KEY = 'mochimono-preview-auto-v1';
  const LEGACY_KEY = 'mochimono-preview-warm-v1';
  const POLL_MS = 100;
  const IMAGE_BATCH = 96;
  const VIDEO_BATCH = 24;

  const style = document.createElement('style');
  style.textContent = `
    #storagePane .storage-preview-warm{display:none!important}
    #storagePane .storage-copy[data-open-where^="folder:"]{cursor:default!important}
    .storage-preview-auto-status{
      position:absolute;z-index:7;right:9px;bottom:9px;min-width:96px;
      display:grid;gap:4px;padding:6px 8px;border:1px solid rgba(255,255,255,.09);
      border-radius:9px;background:rgba(13,12,14,.88);backdrop-filter:blur(7px);
      color:#9b9390;font-size:8px;font-weight:700;pointer-events:none;
      font-variant-numeric:tabular-nums
    }
    .storage-preview-auto-status[hidden]{display:none!important}
    .storage-preview-auto-status>span{white-space:nowrap}
    .storage-preview-auto-track{width:100%;height:3px;overflow:hidden;border-radius:99px;background:#302c31}
    .storage-preview-auto-track i{display:block;height:100%;border-radius:inherit;background:#80b88e;transition:width .12s linear}
  `;
  document.head.append(style);

  let completed = {};
  try { completed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch {}
  // The old per-folder button warmer is intentionally retired. If an earlier
  // session left a folder queued, do not resurrect that slow six-at-a-time loop.
  try { localStorage.removeItem(LEGACY_KEY); } catch {}

  let running = false;
  let timer = 0;
  let mutationFrame = 0;

  const clean = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => clean(a) === clean(b);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function request(path, options = {}) {
    const response = await fetch(path, {
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  function saveCompleted() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(completed)); } catch {}
  }

  function rowFor(path) {
    return [...folders.querySelectorAll('[data-folder-path]')]
      .find(row => samePath(row.dataset.folderPath, path));
  }

  function disableFolderCardNavigation() {
    for (const copy of folders.querySelectorAll('.storage-copy[data-open-where^="folder:"]')) {
      copy.removeAttribute('data-open-where');
      if (/click to view folder/i.test(copy.title || '')) copy.removeAttribute('title');
    }
  }

  function stopLegacyWarmer() {
    disableFolderCardNavigation();
    for (const button of folders.querySelectorAll('.storage-preview-warm.running')) {
      if (button.dataset.fastPreviewStopped) continue;
      button.dataset.fastPreviewStopped = '1';
      button.click();
    }
  }

  function statusFor(path) {
    const row = rowFor(path);
    const strip = row?.querySelector('.storage-folder-samples');
    if (!strip) return null;
    let status = strip.querySelector('.storage-preview-auto-status');
    if (status) return status;
    status = document.createElement('div');
    status.className = 'storage-preview-auto-status';
    status.hidden = true;
    status.innerHTML = '<span></span><div class="storage-preview-auto-track"><i></i></div>';
    strip.append(status);
    return status;
  }

  function renderProgress(path, ready, total, label = 'Caching previews') {
    const status = statusFor(path);
    if (!status) return;
    const percent = total ? Math.max(0, Math.min(100, ready / total * 100)) : 0;
    status.hidden = false;
    status.querySelector('span').textContent = total
      ? `${label} · ${Math.round(percent)}%`
      : label;
    status.querySelector('i').style.width = `${percent}%`;
  }

  function hideProgress(path) {
    const status = statusFor(path);
    if (status) status.hidden = true;
  }

  async function indexedMedia(path) {
    const result = [];
    const seen = new Set();
    let offset = 0;
    do {
      const data = await request(`/api/client/local-catalog?path=${encodeURIComponent(path)}&limit=2000&offset=${offset}`);
      for (const file of data.files || []) {
        const mime = String(file?.mime || '');
        if (!/^(image|video)\//.test(mime) || !file.hash || seen.has(file.hash)) continue;
        seen.add(file.hash);
        result.push({ hash: String(file.hash), video: mime.startsWith('video/') });
      }
      if (data.nextOffset == null) break;
      offset = Number(data.nextOffset) || 0;
      await sleep(0);
    } while (true);
    return result;
  }

  async function readyHashes(records) {
    if (!records.length) return new Set();
    const data = await request('/api/thumbs/check', {
      method: 'POST',
      body: JSON.stringify({ background: true, hashes: records.map(file => file.hash) })
    });
    return new Set((data.thumbnails || [])
      .filter(item => Number(item.width) > 0 && Number(item.height) > 0)
      .map(item => String(item.hash)));
  }

  async function warmBatch(path, records, progress, timeoutMs) {
    const pending = new Map(records.map(file => [file.hash, file]));
    const deadline = Date.now() + timeoutMs;
    while (pending.size && Date.now() < deadline) {
      const ready = await readyHashes([...pending.values()]);
      for (const hash of ready) {
        if (!pending.delete(hash)) continue;
        progress.ready++;
      }
      renderProgress(path, progress.ready, progress.total);
      if (pending.size) await sleep(POLL_MS);
    }
    progress.failed += pending.size;
  }

  async function warmFolder(path, signature) {
    renderProgress(path, 0, 0, 'Finding media');
    const media = await indexedMedia(path);
    const images = media.filter(file => !file.video);
    const videos = media.filter(file => file.video);
    const progress = { ready: 0, failed: 0, total: media.length };
    renderProgress(path, 0, progress.total);

    for (let offset = 0; offset < images.length; offset += IMAGE_BATCH) {
      await warmBatch(path, images.slice(offset, offset + IMAGE_BATCH), progress, 30_000);
    }
    for (let offset = 0; offset < videos.length; offset += VIDEO_BATCH) {
      await warmBatch(path, videos.slice(offset, offset + VIDEO_BATCH), progress, 120_000);
    }

    completed[clean(path)] = { signature, failed: progress.failed, at: Date.now() };
    saveCompleted();
    hideProgress(path);
  }

  function signature(item) {
    return `${Number(item.files) || 0}:${Number(item.bytes) || 0}`;
  }

  async function run() {
    clearTimeout(timer);
    if (running) return;
    running = true;
    try {
      stopLegacyWarmer();
      const [state, stats] = await Promise.all([
        request('/api/state'),
        request('/api/folder-stats')
      ]);
      const activePath = state.job?.status === 'running' && /^Indexing$/i.test(String(state.job?.progress?.phase || ''))
        ? String(state.job?.progress?.path || '')
        : '';

      for (const item of stats.folders || []) {
        const path = String(item.path || '');
        if (!path || samePath(path, activePath)) continue;
        const nextSignature = signature(item);
        const previous = completed[clean(path)];
        if (previous?.signature === nextSignature) continue;
        await warmFolder(path, nextSignature);
        break;
      }
    } catch (error) {
      console.warn('Could not warm local previews.', error);
    } finally {
      running = false;
      timer = setTimeout(run, 900);
    }
  }

  function scheduleImmediate() {
    if (mutationFrame) return;
    mutationFrame = requestAnimationFrame(() => {
      mutationFrame = 0;
      stopLegacyWarmer();
      clearTimeout(timer);
      timer = setTimeout(run, 40);
    });
  }

  new MutationObserver(scheduleImmediate).observe(folders, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-open-where', 'class']
  });
  window.addEventListener('focus', scheduleImmediate, { passive: true });
  scheduleImmediate();
}
