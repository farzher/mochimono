const folders = document.querySelector('#folders');
const storagePane = document.querySelector('#storagePane');

if (folders && storagePane) {
  const style = document.createElement('style');
  style.textContent = `
    /* One stable storage-work story. The older thumbnail phase UI exposed
       scheduler internals (Checking/Generating/Next); keep it out of view. */
    #storagePane [data-preview-progress]{display:none!important}
    #storagePane .folder-item .item-progress{display:none!important}
    #storagePane .folder-workflow{margin-top:12px;padding-top:11px;border-top:1px solid #292429}
    #storagePane .folder-workflow-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
    #storagePane .folder-workflow-state{display:flex;align-items:center;gap:7px;min-width:0;color:#d9cfcb;font-size:11px;font-weight:720;line-height:1.2}
    #storagePane .folder-workflow-state:before{content:'';width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#81797a}
    #storagePane .folder-workflow.ready .folder-workflow-state:before{background:#91a68d}
    #storagePane .folder-workflow.active .folder-workflow-state:before{background:#efa09a;animation:storage-work-pulse 1s ease-in-out infinite}
    #storagePane .folder-workflow.waiting .folder-workflow-state:before{background:#8b8283;opacity:.68}
    #storagePane .folder-workflow-note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#766f6e;font-size:9px;font-weight:590}
    #storagePane .folder-workflow-stages{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
    #storagePane .folder-stage{display:inline-flex;align-items:center;gap:5px;min-height:22px;padding:3px 7px;border:1px solid #2b272b;border-radius:999px;background:#171518;color:#777071;font-size:9px;font-weight:660;font-variant-numeric:tabular-nums;white-space:nowrap}
    #storagePane .folder-stage:before{content:'';width:5px;height:5px;border-radius:50%;background:#5f595b}
    #storagePane .folder-stage.done{border-color:#293129;color:#9ca998;background:#151916}
    #storagePane .folder-stage.done:before{background:#83977f}
    #storagePane .folder-stage.active{border-color:#483438;color:#d7aaa5;background:#1f181a}
    #storagePane .folder-stage.active:before{background:#efa09a}
    #storagePane .folder-stage.waiting{color:#8c8382}
    #storagePane .folder-stage.waiting:before{background:#756d6f}
    #storagePane .folder-work-list{display:grid;gap:9px;margin-top:10px}
    #storagePane .folder-work-row{display:grid;gap:5px;min-width:0}
    #storagePane .folder-work-copy{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:9px;line-height:1.2;font-variant-numeric:tabular-nums}
    #storagePane .folder-work-copy strong{flex:0 0 auto;color:#aaa19e;font-weight:700}
    #storagePane .folder-work-copy span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#777071}
    #storagePane .folder-work-copy em{flex:0 0 auto;color:#b8aeaa;font-style:normal;font-weight:700}
    #storagePane .folder-work-cancel{flex:0 0 auto;padding:1px 0 1px 7px;border:0;background:transparent;color:#8f8583;font:inherit;font-weight:680;cursor:pointer}
    #storagePane .folder-work-cancel:hover{color:#eee6e2}
    #storagePane .folder-work-track{height:4px;overflow:hidden;border-radius:999px;background:#292429}
    #storagePane .folder-work-track>i{display:block;height:100%;border-radius:inherit;background:#e99b95;transform:scaleX(var(--folder-work-progress,0));transform-origin:left center;transition:transform .5s cubic-bezier(.22,1,.36,1),opacity .2s ease}
    #storagePane .folder-work-row.waiting .folder-work-track>i{opacity:.38}
    #storagePane .folder-work-row.scan .folder-work-track{display:none}
    #storagePane .folder-work-row.active .folder-work-track>i{position:relative}
    #storagePane .folder-work-row.active .folder-work-track>i:after{content:'';position:absolute;inset:0;width:32%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);transform:translateX(-140%);animation:storage-work-sheen 1.25s linear infinite}
    @keyframes storage-work-pulse{0%,100%{opacity:.55;transform:scale(.75)}50%{opacity:1;transform:scale(1.15)}}
    @keyframes storage-work-sheen{to{transform:translateX(420%)}}
    @media(max-width:700px){
      #storagePane .folder-workflow-head{align-items:flex-start;flex-direction:column;gap:3px}
      #storagePane .folder-workflow-note{max-width:100%}
    }
    @media(prefers-reduced-motion:reduce){
      #storagePane .folder-workflow-state:before,#storagePane .folder-work-track>i,#storagePane .folder-work-track>i:after{animation:none!important;transition:none!important}
    }
  `;
  document.head.append(style);

  const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => pathKey(a) === pathKey(b);
  const previewMemory = new Map();
  let timer = 0;
  let busy = false;

  function bytes(number) {
    const units = ['B','KB','MB','GB','TB'];
    let value = Math.max(0, Number(number) || 0);
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  function eta(seconds) {
    seconds = Number(seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 90) return `~${Math.max(10, Math.round(seconds / 10) * 10)}s`;
    if (seconds < 3600) return `~${Math.max(1, Math.round(seconds / 60))}m`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return `~${hours}h${minutes ? ` ${minutes}m` : ''}`;
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
    if (path && samePath(path, folder.path)) return job;
    return null;
  }

  function percentRatio(done, total) {
    total = Number(total) || 0;
    done = Number(done) || 0;
    return total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  }

  function previewProgress(folder, mode) {
    const total = Number(folder.previewTotal) || 0;
    const ready = Number(folder.previewReady) || 0;
    const failed = Number(folder.previewFailed) || 0;
    const deferred = Number(folder.previewDeferred) || 0;
    const generated = Number(folder.previewGenerated) || 0;
    const active = Number(folder.previewQueueActive) || 0;
    const queued = Number(folder.previewQueueBackground) || 0;
    const done = String(folder.previewPhase || '') === 'done' || !folder.previewWarming;
    const run = `${Number(folder.previewStartedAt) || 0}:${total}`;
    const key = pathKey(folder.path);
    const now = Date.now();
    const resolved = Math.min(total || Infinity, ready + failed + deferred + generated);
    const previous = previewMemory.get(key);
    let ratio = total ? Math.min(done ? 1 : .995, resolved / total) : 0;
    let rate = previous?.run === run ? Number(previous.rate) || 0 : 0;
    let lastProgressAt = previous?.run === run ? Number(previous.lastProgressAt) || now : now;

    if (previous?.run === run) {
      ratio = Math.max(Number(previous.ratio) || 0, ratio);
      const elapsed = Math.max(.001, (now - Number(previous.sampleAt || now)) / 1000);
      const delta = Math.max(0, resolved - Number(previous.resolved || 0));
      if (delta > 0) {
        const instant = delta / elapsed;
        rate = rate > 0 ? rate * .72 + instant * .28 : instant;
        lastProgressAt = now;
      } else if (now - lastProgressAt > 12_000) {
        rate = 0;
      }
    }

    const waitingIdle = Boolean(folder.previewWaiting) || mode === 'idle' && folder.previewWarming && folder.previewWaiting;
    const paused = mode === 'off';
    const waiting = !done && !paused && !waitingIdle && String(folder.previewPhase || '') === 'generating' && active <= 0;
    const working = !done && !paused && !waitingIdle && !waiting;
    const remaining = total ? Math.max(0, total - Math.round(ratio * total)) : 0;
    const scanComplete = total > 0 && Number(folder.previewProcessed) >= total;
    const etaText = working && scanComplete && total && rate > 0 && now - lastProgressAt < 8000 && resolved >= Math.min(20, total)
      ? eta(remaining / rate)
      : '';

    previewMemory.set(key, { run, ratio, resolved, rate, sampleAt:now, lastProgressAt });

    let state = 'active';
    let status = 'Preparing';
    if (done) { state = 'done'; status = 'Ready'; ratio = 1; }
    else if (paused) { state = 'waiting'; status = 'Paused'; }
    else if (waitingIdle || waiting) { state = 'waiting'; status = 'Waiting'; }

    const percentage = total ? `${Math.floor(ratio * 100)}%` : '';
    const estimating = working && total && !etaText ? 'Estimating…' : '';
    const detail = [status, percentage, etaText || estimating].filter(Boolean).join(' · ');
    const count = total ? `${resolved.toLocaleString()} / ${total.toLocaleString()}` : '';
    const activity = done ? ''
      : waitingIdle ? 'waiting for idle'
        : waiting ? 'waiting'
          : String(folder.previewPhase || '') === 'checking' ? 'checking cache'
            : active > 0 ? `${active.toLocaleString()} generating`
              : queued > 0 ? `${queued.toLocaleString()} queued`
                : 'preparing';
    const note = [count, activity].filter(Boolean).join(' · ');

    return { total, ratio, percentage, state, status, detail, note, done, working, resolved };
  }

  function protectedWork(folder, state) {
    const job = currentFolderJob(folder, state);
    const p = job?.progress || {};
    if (!job) {
      if (folder.pending) {
        const note = folder.waitingForIdle ? 'Waiting for idle' : 'Waiting to sync';
        return {
          headline:'Waiting',
          tone:'waiting',
          note,
          stages:[{ label:'Cloud', value:'Waiting', state:'waiting' }],
          rows:[]
        };
      }
      const synced = Boolean(folder.lastSynced);
      return {
        headline: synced ? 'Backed up' : 'Cloud',
        tone: synced ? 'ready' : 'waiting',
        note: synced ? 'Cloud copy complete' : 'Not synced yet',
        stages:[{ label:'Cloud', value:synced ? 'Ready' : 'Waiting', state:synced ? 'done' : 'waiting' }],
        rows:[]
      };
    }

    const phase = String(p.phase || 'Working');
    const totalBytes = Number(p.totalBytes) || 0;
    const doneBytes = Math.min(totalBytes, Number(p.doneBytes) || 0);
    const ratio = percentRatio(doneBytes, totalBytes);
    const percentage = totalBytes ? `${Math.floor(ratio * 100)}%` : '';
    const etaText = Number(p.etaSeconds) > 0 ? eta(p.etaSeconds) : '';
    const phaseLower = phase.toLowerCase();
    const headline = phaseLower.includes('upload') ? 'Backing up'
      : phaseLower.includes('sav') ? 'Finishing'
        : phaseLower.includes('hash') ? 'Preparing files'
          : phaseLower.includes('scan') ? 'Indexing'
            : 'Syncing';
    const meta = totalBytes
      ? `${bytes(doneBytes)} / ${bytes(totalBytes)}${etaText ? ` · ${etaText}` : ''}`
      : p.scanned != null ? `${Number(p.scanned).toLocaleString()} files found`
        : '';
    const row = {
      label:'Cloud copy',
      detail:[phase, percentage, etaText].filter(Boolean).join(' · '),
      note:meta,
      ratio,
      bar:Boolean(totalBytes),
      state:'active',
      cancel:true
    };
    const step = phaseLower.includes('scan') ? 0
      : phaseLower.includes('hash') ? 1
        : phaseLower.includes('upload') ? 2
          : phaseLower.includes('sav') ? 3
            : 0;
    const labels = ['Index','Hash','Upload','Finish'];
    const stages = labels.map((label, index) => ({
      label,
      value:index < step ? 'Ready' : index === step ? percentage || 'Working' : '',
      state:index < step ? 'done' : index === step ? 'active' : ''
    }));
    return { headline, tone:'active', note:meta || phase, stages, rows:[row] };
  }

  function localWork(folder, mode, state) {
    const job = currentFolderJob(folder, state);
    const indexed = Boolean(folder.lastIndexed);
    const indexRunning = Boolean(job) || Boolean(folder.diagnostics?.running && folder.diagnostics?.jobType !== 'hash');
    const indexing = Boolean(folder.pending && indexRunning);
    const waitingIndex = Boolean(folder.waitingForIdle || (!indexed && folder.pending && !indexRunning));
    const tracked = Number(folder.hashTracked) || 0;
    const hashReady = Number(folder.hashReady) || 0;
    const hashPending = Number(folder.hashPending) || 0;
    const hashDone = tracked > 0 ? hashPending <= 0 : indexed && hashPending <= 0;
    const hashRatio = tracked ? Math.max(0, Math.min(1, hashReady / tracked)) : hashDone ? 1 : 0;
    const previews = previewProgress(folder, mode);
    const stages = [];
    const rows = [];

    stages.push({
      label:'Index',
      value:indexed ? 'Ready' : waitingIndex ? 'Waiting' : indexing ? 'Working' : 'Waiting',
      state:indexed ? 'done' : waitingIndex ? 'waiting' : indexing ? 'active' : 'waiting'
    });

    if (tracked || hashPending) {
      const value = hashDone ? 'Ready' : tracked ? `${Math.floor(hashRatio * 100)}%` : 'Waiting';
      const stageState = hashDone ? 'done' : folder.hashing ? 'active' : 'waiting';
      stages.push({ label:'Verify', value, state:stageState });
      if (!hashDone) {
        const detail = folder.hashing ? `Verifying · ${value}` : folder.hashWaiting ? `Waiting · ${value}` : `Waiting · ${value}`;
        rows.push({
          label:'Content', detail,
          note:tracked ? `${hashReady.toLocaleString()} / ${tracked.toLocaleString()} files` : '',
          ratio:hashRatio, bar:Boolean(tracked), state:folder.hashing ? 'active' : 'waiting'
        });
      }
    }

    if (folder.previewWarming || folder.previewPhase) {
      stages.push({ label:'Thumbnails', value:previews.done ? 'Ready' : previews.percentage || previews.status, state:previews.done ? 'done' : previews.state });
      if (!previews.done) {
        rows.push({
          label:'Thumbnails', detail:previews.detail, note:previews.note,
          ratio:previews.ratio, bar:Boolean(previews.total), state:previews.state
        });
      }
    }

    let headline = 'Ready';
    let tone = 'ready';
    let note = '';
    if (!indexed) {
      headline = waitingIndex ? 'Waiting' : 'Indexing';
      tone = waitingIndex ? 'waiting' : 'active';
      note = waitingIndex ? 'Waiting for idle' : `${Number(folder.files || 0).toLocaleString()} files found`;
      rows.unshift({
        label:'Index', detail:waitingIndex ? 'Waiting' : 'Indexing', note,
        ratio:0, bar:false, state:waitingIndex ? 'waiting' : 'active', scan:true, cancel:Boolean(job)
      });
    } else if (!hashDone || !previews.done) {
      headline = 'Ready to browse';
      note = 'Background work continues';
    } else {
      headline = 'Ready to browse';
      note = 'All background work complete';
    }

    return { headline, tone, note, stages, rows };
  }

  function stageMarkup(stage) {
    const value = stage.value ? `<span>${stage.value}</span>` : '';
    return `<span class="folder-stage ${stage.state || ''}"><b>${stage.label}</b>${value}</span>`;
  }

  function rowMarkup(row) {
    const percentage = row.bar ? `<em>${Math.floor(Math.max(0, Math.min(1, Number(row.ratio) || 0)) * 100)}%</em>` : '';
    const cancel = row.cancel ? '<button type="button" class="folder-work-cancel" data-cancel-folder-work>Cancel</button>' : '';
    const bar = row.bar ? `<div class="folder-work-track"><i style="--folder-work-progress:${Math.max(0, Math.min(1, Number(row.ratio) || 0))}"></i></div>` : '';
    return `<div class="folder-work-row ${row.state || ''} ${row.scan ? 'scan' : ''}">
      <div class="folder-work-copy"><strong>${row.label}</strong><span title="${String(row.note || '').replaceAll('"','&quot;')}">${row.detail || row.note || ''}</span>${percentage}${cancel}</div>
      ${bar}
    </div>`;
  }

  function workflowNode(row) {
    let node = row.querySelector('[data-folder-workflow]');
    if (node) return node;
    node = document.createElement('div');
    node.className = 'folder-workflow';
    node.dataset.folderWorkflow = '';
    const meta = row.querySelector('.storage-meta');
    if (meta) meta.insertAdjacentElement('afterend', node);
    else row.querySelector('.storage-copy')?.append(node);
    return node;
  }

  function renderFolder(row, folder, state) {
    const mode = String(state?.settings?.thumbnailMode || 'idle');
    const model = folder.protected === false ? localWork(folder, mode, state) : protectedWork(folder, state);
    const node = workflowNode(row);
    const key = JSON.stringify(model);
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.className = `folder-workflow ${model.tone || ''}`;
    node.innerHTML = `
      <div class="folder-workflow-head">
        <span class="folder-workflow-state">${model.headline}</span>
        <span class="folder-workflow-note">${model.note || ''}</span>
      </div>
      <div class="folder-workflow-stages">${model.stages.map(stageMarkup).join('')}</div>
      ${model.rows.length ? `<div class="folder-work-list">${model.rows.map(rowMarkup).join('')}</div>` : ''}`;
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
      working ||= Boolean(folder.pending || folder.hashPending || folder.previewWarming || currentFolderJob(folder, state));
    }
    return working;
  }

  async function refresh() {
    clearTimeout(timer);
    timer = 0;
    if (busy) return schedule(400);
    busy = true;
    let working = false;
    try {
      const [folderData, state] = await Promise.all([request('/api/folder-stats'), request('/api/state')]);
      working = render(folderData.folders || [], state);
    } catch {
    } finally {
      busy = false;
      schedule(working ? 900 : 5000);
    }
  }

  function schedule(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(refresh, Math.max(0, delay));
  }

  folders.addEventListener('click', async event => {
    const button = event.target.closest('[data-cancel-folder-work]');
    if (!button) return;
    button.disabled = true;
    button.textContent = 'Canceling…';
    try { await request('/api/job/cancel', { method:'POST', body:'{}' }); }
    catch { button.disabled = false; button.textContent = 'Cancel'; }
    schedule(0);
  });

  new MutationObserver(() => schedule(50)).observe(folders, { childList:true });
  window.addEventListener('mochimono:preview-mode', () => schedule(0));
  schedule(80);
}
