const pane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const backups = document.querySelector('#backups');

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
    .folder-item.storage-indexing .storage-preview-warm{display:none}
    .storage-preview-warm{
      --p:0;
      position:absolute;z-index:7;right:9px;bottom:9px;
      min-width:78px;height:27px;padding:0 9px;
      display:flex;align-items:center;justify-content:center;gap:6px;
      border:1px solid rgba(255,255,255,.1);border-radius:9px;
      background:linear-gradient(90deg,rgba(112,178,132,.20) calc(var(--p) * 1%),rgba(17,16,18,.88) 0);
      backdrop-filter:blur(7px);color:#aaa29e;font-size:9px;font-weight:720;
      font-variant-numeric:tabular-nums;cursor:pointer;
    }
    .storage-preview-warm:hover{border-color:#5a5158;color:#ded6d2}
    .storage-preview-warm.running{border-color:#35513d;color:#a8d2b3}
    .storage-preview-warm.complete{border-color:#35513d;color:#8ec89d}
    .storage-preview-warm span{font-size:11px;line-height:1}
    .storage-status-card.storage-verify-action .storage-status-main{cursor:pointer}
    .storage-status-card.storage-verify-action .storage-status-main:focus-visible{outline:2px solid #d9b776;outline-offset:5px;border-radius:14px}
    @keyframes storage-index-spin{to{transform:rotate(360deg)}}
    @keyframes storage-index-slide{0%{transform:translateX(-105%)}50%{transform:translateX(165%)}100%{transform:translateX(365%)}}
    @media(prefers-reduced-motion:reduce){.storage-index-spinner,.storage-index-track i{animation:none}.storage-index-track i{width:100%;opacity:.55}}
  `;
  document.head.append(style);

  const PREVIEW_WARM_KEY = 'mochimono-preview-warm-v1';
  const clean = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => clean(a) === clean(b);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const warmers = new Map();
  let enabledWarmPaths = new Set();
  try { enabledWarmPaths = new Set(JSON.parse(localStorage.getItem(PREVIEW_WARM_KEY) || '[]').map(String)); } catch {}
  const saveWarmPaths = () => {
    try { localStorage.setItem(PREVIEW_WARM_KEY, JSON.stringify([...enabledWarmPaths])); } catch {}
  };

  const formatBytes = number => {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Number(number) || 0;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${unit ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
  };

  function syncStorageLanguage() {
    const hero = pane.querySelector('.storage-dashboard-hero');
    if (!hero) return;
    const cloudRoute = hero.querySelector('[data-route="cloud"] b');
    const backupRoute = hero.querySelector('[data-route="backup"] b');
    const backupMetric = hero.querySelector('[data-metric="backup"] > span');
    const filesMetric = hero.querySelector('[data-metric="files"] > span');
    if (cloudRoute && cloudRoute.textContent !== 'Cloud') cloudRoute.textContent = 'Cloud';
    if (backupRoute && backupRoute.textContent !== 'Local backup') backupRoute.textContent = 'Local backup';
    if (backupMetric && backupMetric.textContent !== 'Local backup') backupMetric.textContent = 'Local backup';
    if (filesMetric && filesMetric.textContent !== 'Cloud files') filesMetric.textContent = 'Cloud files';
    for (const label of pane.querySelectorAll('.storage-folder-node[data-cloud] b')) {
      if (label.textContent !== 'Cloud') label.textContent = 'Cloud';
    }

    const status = hero.querySelector('.storage-status-card');
    const main = status?.querySelector('.storage-status-main');
    const verify = status?.querySelector('.storage-status-word')?.textContent.trim() === 'Verify';
    status?.classList.toggle('storage-verify-action', verify);
    if (main) {
      if (verify) {
        main.tabIndex = 0;
        main.setAttribute('role', 'button');
        main.setAttribute('aria-label', 'Verify local backup');
        main.title = 'Verify local backup';
      } else {
        main.removeAttribute('tabindex');
        main.removeAttribute('role');
        main.removeAttribute('aria-label');
        main.removeAttribute('title');
      }
    }
  }

  function backupNeedsVerification(location) {
    const desired = Number(location?.remote?.desiredBytes) || 0;
    const backed = Number(location?.remote?.protectedBytes) || 0;
    if (desired && backed / desired < .995) return false;
    if (Number(location?.meta?.lastVerifyBad) > 0 || location?.meta?.lastVerifyCatalogHealthy === false) return true;
    const verifiedAt = new Date(location?.meta?.lastVerifiedAt || location?.local?.oldestVerification || 0).getTime();
    if (!Number.isFinite(verifiedAt) || !verifiedAt || Date.now() - verifiedAt > 180 * 86400000) return true;
    const updatedAt = new Date(location?.meta?.lastBackupAt || 0).getTime();
    return Number.isFinite(updatedAt) && updatedAt > verifiedAt;
  }

  async function runHeroVerify() {
    const status = pane.querySelector('.storage-status-card.storage-verify-action');
    if (!status || !backups) return false;
    let index = -1;
    try {
      const response = await fetch('/api/backups', { cache:'no-store' });
      const data = await response.json();
      index = (data.backups || []).findIndex(backupNeedsVerification);
    } catch {}
    const selector = index >= 0 ? `[data-verify="${index}"]:not(:disabled)` : '[data-verify].primary-action:not(:disabled)';
    const button = backups.querySelector(selector) || backups.querySelector('[data-verify]:not(:disabled)');
    if (!button) return false;
    button.click();
    return true;
  }

  pane.addEventListener('click', event => {
    if (!event.target.closest('.storage-status-card.storage-verify-action .storage-status-main')) return;
    event.preventDefault();
    runHeroVerify();
  });
  pane.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key) || !event.target.closest('.storage-status-card.storage-verify-action .storage-status-main')) return;
    event.preventDefault();
    runHeroVerify();
  });

  function rowForPath(path) {
    return [...folders.querySelectorAll('[data-folder-path]')].find(node => samePath(node.dataset.folderPath, path));
  }

  function previewControl(row) {
    let button = row?.querySelector('.storage-preview-warm');
    if (button) return button;
    const samples = row?.querySelector('.storage-folder-samples');
    if (!samples) return null;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'storage-preview-warm';
    button.innerHTML = '<span>▦</span><b>Previews</b>';
    samples.append(button);
    return button;
  }

  function renderWarmer(path) {
    const row = rowForPath(path);
    const button = previewControl(row);
    if (!button) return;
    const state = warmers.get(clean(path)) || {};
    const enabled = enabledWarmPaths.has(path) || enabledWarmPaths.has(clean(path));
    const total = Number(state.total) || 0;
    const ready = Number(state.ready) || 0;
    const failed = Number(state.failed) || 0;
    const percent = total ? Math.max(0, Math.min(100, ready / total * 100)) : 0;
    button.style.setProperty('--p', percent.toFixed(2));
    button.classList.toggle('running', Boolean(state.running && enabled));
    button.classList.toggle('complete', Boolean(state.complete && !failed));
    if (state.discovering) button.innerHTML = '<span>▦</span><b>…</b>';
    else if (state.running && enabled) button.innerHTML = `<span>Ⅱ</span><b>${Math.round(percent)}%</b>`;
    else if (state.complete && !failed) button.innerHTML = '<span>✓</span><b>Previews</b>';
    else button.innerHTML = '<span>▦</span><b>Previews</b>';
    const detail = state.discovering ? 'Finding indexed media…'
      : total ? `${ready.toLocaleString()} / ${total.toLocaleString()} previews${failed ? ` · ${failed.toLocaleString()} unavailable` : ''}`
      : 'Generate local thumbnails in the background';
    button.title = state.running && enabled ? `Pause · ${detail}` : `${state.complete ? 'Refresh' : 'Start'} · ${detail}`;
    button.setAttribute('aria-label', button.title);
  }

  function syncPreviewControls() {
    for (const row of folders.querySelectorAll('[data-folder-path]')) {
      const path = row.dataset.folderPath || '';
      previewControl(row);
      renderWarmer(path);
      if ([...enabledWarmPaths].some(saved => samePath(saved, path)) && !warmers.get(clean(path))?.running) startWarmer(path);
    }
  }

  async function indexedMedia(path, state) {
    const files = [];
    const seen = new Set();
    let offset = 0;
    state.discovering = true;
    state.total = 0;
    state.ready = 0;
    state.failed = 0;
    renderWarmer(path);
    do {
      if (!state.enabled) break;
      const response = await fetch(`/api/client/local-catalog?path=${encodeURIComponent(path)}&limit=2000&offset=${offset}`, { cache:'no-store' });
      if (!response.ok) throw new Error('Could not read local index');
      const data = await response.json();
      for (const file of data.files || []) {
        if (!/^(image|video)\//.test(String(file?.mime || '')) || seen.has(file.hash)) continue;
        seen.add(file.hash);
        files.push(file);
      }
      state.total = files.length;
      renderWarmer(path);
      if (data.nextOffset == null) break;
      offset = Number(data.nextOffset) || 0;
      await sleep(0);
    } while (state.enabled);
    state.discovering = false;
    state.total = files.length;
    renderWarmer(path);
    return files;
  }

  async function checkPreviewBatch(batch) {
    const response = await fetch('/api/thumbs/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ background:true, hashes:batch.map(file => file.hash) })
    });
    if (!response.ok) return new Set();
    const data = await response.json();
    return new Set((data.thumbnails || [])
      .filter(item => Number(item.width) > 0 && Number(item.height) > 0)
      .map(item => String(item.hash)));
  }

  async function warmBatch(path, state, batch) {
    const pending = new Map(batch.map(file => [file.hash, file]));
    let quietRounds = 0;
    while (state.enabled && pending.size && quietRounds < 240) {
      const before = pending.size;
      const ready = await checkPreviewBatch([...pending.values()]);
      for (const hash of ready) pending.delete(hash);
      const gained = before - pending.size;
      if (gained) {
        state.ready += gained;
        quietRounds = 0;
      } else quietRounds++;
      renderWarmer(path);
      if (pending.size && state.enabled) await sleep(700);
    }
    if (state.enabled && pending.size) state.failed += pending.size;
  }

  async function runWarmer(path, state) {
    try {
      const media = await indexedMedia(path, state);
      if (!state.enabled) return;
      for (let offset = 0; offset < media.length && state.enabled; offset += 6) {
        await warmBatch(path, state, media.slice(offset, offset + 6));
      }
      if (state.enabled) {
        state.complete = true;
        enabledWarmPaths = new Set([...enabledWarmPaths].filter(saved => !samePath(saved, path)));
        saveWarmPaths();
      }
    } catch (error) {
      state.error = String(error?.message || error);
    } finally {
      state.running = false;
      state.discovering = false;
      renderWarmer(path);
    }
  }

  function startWarmer(path) {
    const key = clean(path);
    if (!key) return;
    let state = warmers.get(key);
    if (state?.running) return;
    state = { ...(state || {}), path, enabled:true, running:true, complete:false, error:'' };
    warmers.set(key, state);
    enabledWarmPaths.add(path);
    saveWarmPaths();
    renderWarmer(path);
    runWarmer(path, state);
  }

  function stopWarmer(path) {
    const key = clean(path);
    const state = warmers.get(key);
    if (state) state.enabled = false;
    enabledWarmPaths = new Set([...enabledWarmPaths].filter(saved => !samePath(saved, path)));
    saveWarmPaths();
    renderWarmer(path);
  }

  folders.addEventListener('click', event => {
    const button = event.target.closest('.storage-preview-warm');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const row = button.closest('[data-folder-path]');
    const path = row?.dataset.folderPath || '';
    const state = warmers.get(clean(path));
    if (state?.running && state.enabled) stopWarmer(path);
    else startWarmer(path);
  });

  // The base Storage renderer also owns a hidden [data-folder-size] node and
  // refreshes it every five seconds. The visual dashboard originally reused
  // that same hook, so two formatters alternated values such as 132 MB and
  // 131.9 MB. Give the visible dashboard value its own hook and mirror the
  // canonical base value instead. MutationObservers run before paint, so the
  // hidden refresh cannot produce a visible one-frame flip.
  function claimVisibleSize(row) {
    const facts = row.querySelector('.storage-folder-facts');
    if (!facts) return null;
    let visible = facts.querySelector('[data-dashboard-folder-size]');
    if (visible) return visible;
    visible = facts.querySelector('[data-folder-size]');
    if (!visible) return null;
    visible.removeAttribute('data-folder-size');
    visible.setAttribute('data-dashboard-folder-size', '');
    return visible;
  }

  function mirrorCanonicalSize(row) {
    const visible = claimVisibleSize(row);
    const canonical = row.querySelector('.storage-meta [data-folder-size]');
    const text = canonical?.textContent?.trim();
    if (visible && text && text !== '—' && visible.textContent !== text) visible.textContent = text;
  }

  function syncVisibleSizes() {
    for (const row of folders.querySelectorAll('[data-folder-path]')) mirrorCanonicalSize(row);
  }

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
      mirrorCanonicalSize(row);
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
    const row = rowForPath(item.path);
    if (!row) return;
    const size = claimVisibleSize(row);
    const count = row.querySelector('.storage-folder-facts [data-folder-count]');
    const formatted = formatBytes(item.bytes);
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
    const row = rowForPath(path);
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
      syncStorageLanguage();
      syncPreviewControls();
      if (runningPath && !active) await settle(runningPath);
      runningPath = path;
    } catch {}
    finally {
      busy = false;
      if (!pane.hidden) timer = setTimeout(poll, active ? 550 : delay < 1200 ? 700 : 2200, 2200);
    }
  }

  const wake = () => { clearTimeout(timer); timer = setTimeout(() => poll(250), 40); };
  let sizeSyncQueued = false;
  const syncBeforePaint = () => {
    if (sizeSyncQueued) return;
    sizeSyncQueued = true;
    queueMicrotask(() => {
      sizeSyncQueued = false;
      syncVisibleSizes();
      syncStorageLanguage();
      syncPreviewControls();
    });
  };

  new MutationObserver(wake).observe(pane, { attributes:true, attributeFilter:['hidden'] });
  new MutationObserver(wake).observe(folders, { childList:true, subtree:false });
  new MutationObserver(syncBeforePaint).observe(folders, { childList:true, subtree:true, characterData:true });
  const hero = pane.querySelector('.storage-dashboard-hero');
  if (hero) new MutationObserver(syncStorageLanguage).observe(hero, { childList:true, subtree:true, characterData:true });
  syncVisibleSizes();
  syncStorageLanguage();
  syncPreviewControls();
  if (!pane.hidden) wake();
}
