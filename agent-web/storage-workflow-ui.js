const folders = document.querySelector('#folders');
const storagePane = document.querySelector('#storagePane');

if (folders && storagePane) {
  const style = document.createElement('style');
  style.textContent = `
    #storagePane [data-preview-progress],#storagePane .folder-item .item-progress{display:none!important}
    #storagePane .folder-workflow{margin-top:11px;padding-top:10px;border-top:1px solid #292429}
    #storagePane .folder-workflow[hidden]{display:none!important}
    #storagePane .folder-work-line{display:flex;align-items:center;gap:8px;min-width:0;height:18px;color:#aaa19e;font-size:10px;font-weight:680;font-variant-numeric:tabular-nums}
    #storagePane .folder-work-dot{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#746d6f}
    #storagePane .folder-workflow.active .folder-work-dot{background:#efa09a;animation:folder-work-pulse 1s ease-in-out infinite}
    #storagePane .folder-workflow.waiting .folder-work-dot{background:#777071;opacity:.6}
    #storagePane .folder-workflow.paused .folder-work-dot{background:#655f60;opacity:.45}
    #storagePane .folder-work-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aaa19e}
    #storagePane .folder-work-metric{margin-left:auto;flex:0 0 auto;color:#817978;font-weight:650}
    #storagePane .folder-work-cancel{display:none;flex:0 0 auto;width:18px;height:18px;padding:0;border:0;border-radius:5px;background:transparent;color:#746d6d;font-size:15px;line-height:18px;cursor:pointer}
    #storagePane .folder-workflow:hover .folder-work-cancel{display:block}
    #storagePane .folder-work-cancel:hover{background:#262226;color:#ddd4d0}
    #storagePane .folder-work-track{position:relative;height:3px;margin-top:6px;overflow:hidden;border-radius:999px;background:#292429}
    #storagePane .folder-work-track>i{position:absolute;inset:0;background:#e99b95;transform:scaleX(var(--folder-work-progress,0));transform-origin:left center;transition:transform .55s cubic-bezier(.22,1,.36,1),opacity .2s ease}
    #storagePane .folder-workflow.waiting .folder-work-track>i,#storagePane .folder-workflow.paused .folder-work-track>i{opacity:.35}
    #storagePane .folder-workflow.indeterminate .folder-work-track>i{width:26%;transform:none;animation:folder-work-slide 1.15s ease-in-out infinite}
    @keyframes folder-work-pulse{0%,100%{opacity:.45;transform:scale(.75)}50%{opacity:1;transform:scale(1.15)}}
    @keyframes folder-work-slide{0%{transform:translateX(-120%)}50%{transform:translateX(145%)}100%{transform:translateX(420%)}}
    @media(prefers-reduced-motion:reduce){#storagePane .folder-work-dot,#storagePane .folder-work-track>i{animation:none!important;transition:none!important}}
  `;
  document.head.append(style);

  const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => pathKey(a) === pathKey(b);
  const previewMemory = new Map();
  let timer = 0;
  let busy = false;

  function eta(seconds) {
    seconds = Number(seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 90) return `${Math.max(10, Math.round(seconds / 10) * 10)}s`;
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { cache:'no-store', headers:{ 'content-type':'application/json', ...(options.headers || {}) }, ...options });
    if (!response.ok) throw new Error(response.statusText);
    return response.json();
  }

  function currentFolderJob(folder, state) {
    const job = state?.job;
    if (!job || job.status !== 'running' || job.type !== 'sync') return null;
    const path = job.progress?.path;
    return path && samePath(path, folder.path) ? job : null;
  }

  function previewProgress(folder) {
    const total = Number(folder.previewTotal) || 0;
    const completeNow = Math.min(total || Infinity,
      (Number(folder.previewReady) || 0) +
      (Number(folder.previewFailed) || 0) +
      (Number(folder.previewDeferred) || 0) +
      (Number(folder.previewGenerated) || 0));
    const run = `${Number(folder.previewStartedAt) || 0}:${total}`;
    const key = pathKey(folder.path);
    const now = Date.now();
    const previous = previewMemory.get(key);
    let ratio = total ? Math.min(.995, completeNow / total) : 0;
    let rate = previous?.run === run ? Number(previous.rate) || 0 : 0;
    let lastProgressAt = previous?.run === run ? Number(previous.lastProgressAt) || now : now;

    if (previous?.run === run) {
      ratio = Math.max(Number(previous.ratio) || 0, ratio);
      const elapsed = Math.max(.001, (now - Number(previous.sampleAt || now)) / 1000);
      const delta = Math.max(0, completeNow - Number(previous.complete || 0));
      if (delta > 0) {
        const instant = delta / elapsed;
        rate = rate > 0 ? rate * .72 + instant * .28 : instant;
        lastProgressAt = now;
      } else if (now - lastProgressAt > 12_000) rate = 0;
    }

    const done = String(folder.previewPhase || '') === 'done' || !folder.previewWarming;
    if (done) ratio = 1;
    previewMemory.set(key, { run, ratio, complete:completeNow, rate, sampleAt:now, lastProgressAt });

    const remaining = total ? Math.max(0, total - Math.round(ratio * total)) : 0;
    const scanComplete = total > 0 && Number(folder.previewProcessed) >= total;
    const etaText = scanComplete && rate > 0 && now - lastProgressAt < 8000 && completeNow >= Math.min(20, total)
      ? eta(remaining / rate)
      : '';
    return { total, ratio, etaText, done };
  }

  function cloudModel(folder, state) {
    const job = currentFolderJob(folder, state);
    if (!job) {
      if (!folder.pending) return null;
      return { label:'Waiting', tone:'waiting', ratio:0, indeterminate:false, metric:'', cancel:false, title:'Waiting to sync' };
    }

    const progress = job.progress || {};
    const phase = String(progress.phase || '').toLowerCase();
    const total = Number(progress.totalBytes) || 0;
    const done = Math.min(total, Number(progress.doneBytes) || 0);
    const ratio = total ? Math.max(0, Math.min(1, done / total)) : 0;
    const percentage = total ? `${Math.floor(ratio * 100)}%` : '';
    const etaText = Number(progress.etaSeconds) > 0 ? eta(progress.etaSeconds) : '';
    const label = phase.includes('upload') ? 'Uploading'
      : phase.includes('hash') ? 'Hashing'
        : phase.includes('sav') ? 'Finishing'
          : phase.includes('scan') ? 'Indexing'
            : 'Syncing';
    return {
      label,
      tone:'active',
      ratio,
      indeterminate:!total,
      metric:[percentage, etaText].filter(Boolean).join(' · '),
      cancel:true,
      title:String(progress.current || label)
    };
  }

  function localModel(folder, mode, state) {
    const job = currentFolderJob(folder, state);
    const indexed = Boolean(folder.lastIndexed);
    const indexRunning = Boolean(job) || Boolean(folder.diagnostics?.running && folder.diagnostics?.jobType !== 'hash');
    if (!indexed) {
      const waiting = Boolean(folder.waitingForIdle || (folder.pending && !indexRunning));
      return {
        label:waiting ? 'Waiting' : 'Indexing',
        tone:waiting ? 'waiting' : 'active',
        ratio:0,
        indeterminate:!waiting,
        metric:'',
        cancel:Boolean(job),
        title:waiting ? 'Waiting to index' : 'Indexing folder'
      };
    }

    const preview = previewProgress(folder);
    const previewActive = folder.previewWarming && mode !== 'off' && !folder.previewWaiting &&
      (Number(folder.previewQueueActive) > 0 || Number(folder.previewQueueBackground) > 0);
    if (previewActive && !preview.done) {
      return {
        label:'Thumbnails',
        tone:'active',
        ratio:preview.ratio,
        indeterminate:!preview.total,
        metric:[preview.total ? `${Math.floor(preview.ratio * 100)}%` : '', preview.etaText].filter(Boolean).join(' · '),
        cancel:false,
        title:'Preparing thumbnails'
      };
    }

    if (folder.previewWarming && !preview.done) {
      const paused = mode === 'off';
      return {
        label:paused ? 'Paused' : 'Waiting',
        tone:paused ? 'paused' : 'waiting',
        ratio:preview.ratio,
        indeterminate:false,
        metric:preview.total ? `${Math.floor(preview.ratio * 100)}%` : '',
        cancel:false,
        title:paused ? 'Thumbnail work paused' : 'Thumbnail work waiting'
      };
    }

    return null;
  }

  function workflowNode(row) {
    let node = row.querySelector('[data-folder-workflow]');
    if (node) return node;
    node = document.createElement('div');
    node.dataset.folderWorkflow = '';
    node.innerHTML = `
      <div class="folder-work-line">
        <i class="folder-work-dot"></i>
        <span class="folder-work-label"></span>
        <span class="folder-work-metric"></span>
        <button type="button" class="folder-work-cancel" data-cancel-folder-work title="Cancel" aria-label="Cancel">×</button>
      </div>
      <div class="folder-work-track"><i></i></div>`;
    const meta = row.querySelector('.storage-meta');
    if (meta) meta.insertAdjacentElement('afterend', node);
    else row.querySelector('.storage-copy')?.append(node);
    return node;
  }

  function renderFolder(row, folder, state) {
    const mode = String(state?.settings?.thumbnailMode || 'idle');
    const model = folder.protected === false ? localModel(folder, mode, state) : cloudModel(folder, state);
    const node = workflowNode(row);
    if (!model) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.className = `folder-workflow ${model.tone}${model.indeterminate ? ' indeterminate' : ''}`;
    node.title = model.title || model.label;
    node.querySelector('.folder-work-label').textContent = model.label;
    node.querySelector('.folder-work-metric').textContent = model.metric || '';
    node.querySelector('.folder-work-cancel').hidden = !model.cancel;
    node.style.setProperty('--folder-work-progress', String(Math.max(0, Math.min(1, Number(model.ratio) || 0))));
  }

  function mergeFolders(stats, state) {
    const configured = new Map((state?.settings?.folders || []).map(folder => [pathKey(folder.path), folder]));
    return (stats || []).map(folder => ({ ...configured.get(pathKey(folder.path)), ...folder }));
  }

  function render(stats, state) {
    const all = mergeFolders(stats, state);
    const byPath = new Map(all.map(folder => [pathKey(folder.path), folder]));
    let working = false;
    for (const row of folders.querySelectorAll(':scope > [data-folder-path]')) {
      const folder = byPath.get(pathKey(row.dataset.folderPath));
      if (!folder) continue;
      renderFolder(row, folder, state);
      working ||= Boolean(folder.pending || folder.previewWarming || currentFolderJob(folder, state));
    }
    return working;
  }

  async function refresh() {
    clearTimeout(timer);
    timer = 0;
    if (busy) return schedule(500);
    busy = true;
    let working = false;
    try {
      const [folderData, state] = await Promise.all([request('/api/folder-stats'), request('/api/state')]);
      working = render(folderData.folders || [], state);
    } catch {
    } finally {
      busy = false;
      schedule(working ? 800 : 5000);
    }
  }

  function schedule(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(refresh, Math.max(0, delay));
  }

  folders.addEventListener('click', async event => {
    const button = event.target.closest('[data-cancel-folder-work]');
    if (!button || button.hidden) return;
    button.disabled = true;
    try { await request('/api/job/cancel', { method:'POST', body:'{}' }); }
    catch { button.disabled = false; }
    schedule(0);
  });

  new MutationObserver(() => schedule(50)).observe(folders, { childList:true });
  window.addEventListener('mochimono:preview-mode', () => schedule(0));
  schedule(80);
}
