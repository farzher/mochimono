const frame = document.querySelector('#filesFrame');
const filesPane = document.querySelector('#filesPane');
const storagePane = document.querySelector('#storagePane');
const folders = document.querySelector('#folders');
const menu = document.querySelector('.client-menu');
const manageButton = document.querySelector('[data-client-tab="storage"]');
const pageKeys = new Set(['PageUp', 'PageDown', 'Home', 'End']);

const pathKey = value => String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

let storageShortcut = null;
if (menu && manageButton) {
  storageShortcut = document.createElement('button');
  storageShortcut.type = 'button';
  storageShortcut.className = 'storage-shortcut';
  storageShortcut.innerHTML = `
    <svg class="storage-shortcut-storage" viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="5" rx="6.5" ry="2.5"/><path d="M3.5 5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5"/><path d="M3.5 10v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5"/></svg>
    <svg class="storage-shortcut-library" viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="5" height="5" rx=".7"/><rect x="11.5" y="3.5" width="5" height="5" rx=".7"/><rect x="3.5" y="11.5" width="5" height="5" rx=".7"/><rect x="11.5" y="11.5" width="5" height="5" rx=".7"/></svg>`;
  menu.before(storageShortcut);
  storageShortcut.addEventListener('click', () => manageButton.click());
}

function syncStorageShortcut() {
  if (!storageShortcut) return;
  const storage = storagePane && !storagePane.hidden;
  storageShortcut.classList.toggle('active', Boolean(storage));
  storageShortcut.title = storage ? 'Library' : 'Storage';
  storageShortcut.setAttribute('aria-label', storageShortcut.title);
}
syncStorageShortcut();
if (storagePane) new MutationObserver(syncStorageShortcut).observe(storagePane, { attributes: true, attributeFilter: ['hidden'] });

const style = document.createElement('style');
style.textContent = `
  .storage-shortcut{width:31px;height:31px;display:grid;place-items:center;padding:0;border:0;border-radius:8px;background:transparent;color:#8d8584}
  .storage-shortcut:hover,.storage-shortcut.active{background:#211e22;color:#eee7e3}
  .storage-shortcut svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}
  .storage-shortcut .storage-shortcut-library{display:none}
  .storage-shortcut.active .storage-shortcut-storage{display:none}
  .storage-shortcut.active .storage-shortcut-library{display:block}
  [data-folder-status][data-waiting-idle="1"]{font-size:0}
  [data-folder-status][data-waiting-idle="1"]:after{content:'Waiting for idle';font-size:9px;color:#b9aaa5}
  .folder-item[data-waiting-idle="1"] .item-progress .progress-bar.indeterminate>i{animation:none!important;transform:none!important;left:0!important;opacity:.45}
  .storage-diagnostics{margin:4px 0 24px;border:1px solid #282429;border-radius:10px;background:#121013;color:#9d9491}
  .storage-diagnostics>summary{padding:9px 11px;cursor:pointer;font-size:10px;font-weight:720;color:#8f8683;user-select:none}
  .storage-diagnostics[open]>summary{border-bottom:1px solid #252126;color:#c9c0bd}
  .storage-diagnostics-body{padding:10px;display:grid;gap:8px}
  .storage-diagnostics-actions{display:flex;justify-content:flex-end}
  .storage-diagnostics button{border:0;border-radius:6px;padding:5px 8px;background:#252126;color:#aaa19e;font:inherit;font-size:9px;cursor:pointer}
  .storage-diagnostics button:hover{background:#302b30;color:#eee7e3}
  .storage-diagnostics pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:#9f9693}
  .storage-diagnostics .diag-stalled{color:#df9d82}
`;
document.head.append(style);

const pendingThumbs = new Set();
let thumbTimer = 0;
let checkingThumbs = false;

function thumbHash(img) {
  try {
    const match = new URL(img.src, location.href).pathname.match(/^\/api\/thumbs\/([a-f0-9]{64})$/);
    return match?.[1] || '';
  } catch { return ''; }
}

function collectSampleThumbs(root = folders) {
  if (!root) return;
  const images = root.matches?.('.storage-folder-sample img') ? [root] : [...root.querySelectorAll?.('.storage-folder-sample img') || []];
  for (const image of images) {
    const hash = thumbHash(image);
    if (!hash || image.dataset.previewQueued === hash) continue;
    image.dataset.previewQueued = hash;
    pendingThumbs.add(hash);
  }
  if (pendingThumbs.size && !thumbTimer) thumbTimer = setTimeout(flushSampleThumbs, 40);
}

async function flushSampleThumbs() {
  thumbTimer = 0;
  if (checkingThumbs || !pendingThumbs.size) return;
  checkingThumbs = true;
  try {
    while (pendingThumbs.size) {
      const hashes = [...pendingThumbs].slice(0, 500);
      hashes.forEach(hash => pendingThumbs.delete(hash));
      await request('/api/thumbs/check', { method: 'POST', body: { hashes } });
    }
  } catch {
  } finally {
    checkingThumbs = false;
    if (pendingThumbs.size && !thumbTimer) thumbTimer = setTimeout(flushSampleThumbs, 250);
  }
}

collectSampleThumbs();
if (folders) new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) collectSampleThumbs(node);
  schedulePreviewProgress(80);
}).observe(folders, { childList: true, subtree: true });

let progressTimer = 0;
let progressBusy = false;
const previewMemory = new Map();
let latestFolderStats = [];

const previewMode = () => window.mochimonoPreviewMode?.() || 'idle';

function previewInfo(folder) {
  const key = pathKey(folder.path);
  const previous = previewMemory.get(key) || null;
  const phase = String(folder.previewPhase || '');
  const mode = previewMode();
  const waiting = Boolean(folder.previewWaiting);
  let total = Number(folder.previewTotal) || 0;
  let processed = Number(folder.previewProcessed) || 0;
  let ready = Number(folder.previewReady) || 0;
  const failed = Number(folder.previewFailed) || 0;
  const deferred = Number(folder.previewDeferred) || 0;
  const queued = Number(folder.previewQueued) || 0;

  if (!phase) {
    if (!previous) return null;
    total = previous.total;
    processed = previous.processed;
    ready = previous.ready;
    const done = previous.done;
    return {
      key, phase:'', total, processed, failed:previous.failed || 0, deferred:previous.deferred || 0, queued:0,
      text:done ? 'Ready' : mode === 'off' ? 'Paused' : waiting ? 'Waiting for idle' : 'Waiting…',
      percent:total ? `${done ? 100 : Math.floor(Math.min(1, ready / total) * 100)}%` : '',
      ratio:total ? Math.min(1, done ? 1 : ready / total) : 0,
      indeterminate:false, done, waiting, working:!done && mode !== 'off' && !waiting
    };
  }

  const done = phase === 'done';
  let ratio = 0;
  let percent = '';
  let text = '';
  let indeterminate = false;

  if (done) {
    if (total) processed = total;
    ratio = 1;
    percent = total ? '100%' : '';
    const unavailable = failed + deferred;
    text = unavailable ? `Ready · ${unavailable.toLocaleString()} retry on demand` : 'Ready';
  } else if (mode === 'off') {
    const count = total ? `${Math.min(ready, total).toLocaleString()} / ${total.toLocaleString()}` : processed ? `${processed.toLocaleString()} checked` : '';
    text = [count, 'Paused'].filter(Boolean).join(' · ');
    ratio = total ? Math.min(.99, ready / total) : 0;
    percent = total ? `${Math.floor(ratio * 100)}%` : '';
  } else if (waiting) {
    const count = total ? `${Math.min(ready, total).toLocaleString()} / ${total.toLocaleString()}` : processed ? `${processed.toLocaleString()} checked` : '';
    text = [count, 'Waiting for idle'].filter(Boolean).join(' · ');
    ratio = total ? Math.min(.99, ready / total) : 0;
    percent = total ? `${Math.floor(ratio * 100)}%` : '';
  } else if (phase === 'checking') {
    if (total) {
      ratio = Math.min(.99, processed / total);
      percent = `${Math.floor(ratio * 100)}%`;
      text = `${Math.min(processed,total).toLocaleString()} / ${total.toLocaleString()} · Checking cache…`;
    } else {
      text = `${processed ? `${processed.toLocaleString()} checked · ` : ''}Checking cache…`;
      indeterminate = true;
    }
  } else if (phase === 'generating') {
    ratio = total ? Math.min(.99, ready / total) : 0;
    percent = total ? `${Math.floor(ratio * 100)}%` : '';
    text = queued
      ? `Generating ${queued.toLocaleString()} missing…`
      : 'Generating missing thumbnails…';
    indeterminate = !total;
  } else if (phase === 'verifying') {
    ratio = total ? Math.min(.99, processed / total) : 0;
    percent = total ? `${Math.floor(ratio * 100)}%` : '';
    text = total
      ? `${Math.min(processed,total).toLocaleString()} / ${total.toLocaleString()} · Verifying…`
      : 'Verifying thumbnails…';
    indeterminate = !total;
  } else {
    text = 'Checking cache…';
    indeterminate = true;
  }

  const info = {
    key, phase, total, processed, ready, failed, deferred, queued, text, percent, ratio, indeterminate, done, waiting,
    working: Boolean(folder.previewWarming && mode !== 'off' && !waiting)
  };
  previewMemory.set(key, { total, processed, ready, failed, deferred, done });
  return info;
}

function previewNode(row) {
  let node = row.querySelector('[data-preview-progress]');
  if (node) return node;
  node = document.createElement('div');
  node.dataset.previewProgress = '';
  node.innerHTML = `<div class="preview-progress-head"><span class="preview-progress-title">Thumbnails</span><span data-preview-progress-text></span><strong data-preview-percent></strong></div><div class="preview-progress-track"><i></i></div>`;
  const copy = row.querySelector('.storage-copy');
  const meter = row.querySelector('.storage-meter');
  if (meter) meter.insertAdjacentElement('afterend', node);
  else copy?.append(node);
  return node;
}

function renderPreviewProgress(stats) {
  const byPath = new Map((stats || []).map(folder => [pathKey(folder.path), folder]));
  let warming = false;
  for (const row of folders?.querySelectorAll(':scope > [data-folder-path]') || []) {
    const folder = byPath.get(pathKey(row.dataset.folderPath));
    if (!folder) {
      row.querySelector('[data-preview-progress]')?.remove();
      continue;
    }

    const waitingForIdle = Boolean(folder.waitingForIdle);
    if (waitingForIdle) row.dataset.waitingIdle = '1';
    else delete row.dataset.waitingIdle;
    const status = row.querySelector('[data-folder-status]');
    if (status) {
      if (waitingForIdle) status.dataset.waitingIdle = '1';
      else delete status.dataset.waitingIdle;
    }
    const jobTitle = row.querySelector('[data-item-progress] .inline-progress-head strong');
    if (jobTitle && waitingForIdle) jobTitle.textContent = 'Waiting for idle';

    const info = previewInfo(folder);
    if (!info) {
      row.querySelector('[data-preview-progress]')?.remove();
      continue;
    }
    warming ||= Boolean(info.working);
    const node = previewNode(row);
    node.classList.toggle('preview-indeterminate', info.indeterminate);
    node.querySelector('[data-preview-progress-text]').textContent = info.text;
    node.querySelector('[data-preview-percent]').textContent = info.percent;
    node.style.setProperty('--preview-progress', String(info.ratio));
    node.title = info.done ? 'Local thumbnails ready'
      : previewMode() === 'off' ? 'Automatic thumbnail work is paused; visible files still generate on demand'
        : info.waiting ? 'Thumbnail work is waiting until this computer is idle'
          : info.phase === 'checking' ? 'Checking the existing local thumbnail cache'
            : info.phase === 'verifying' ? 'Verifying generated thumbnails'
              : 'Generating missing local thumbnails';
  }
  return warming;
}

const diagnosticHistory = new Map();
let diagnostics = null;
let diagnosticsOutput = null;
let diagnosticsTimer = 0;
let diagnosticsBusy = false;

function duration(value) {
  const ms = Math.max(0, Number(value) || 0);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round(ms % 3_600_000 / 60_000)}m`;
}

function shortPath(value) {
  const text = String(value || '');
  return text.length > 100 ? `…${text.slice(-99)}` : text;
}

function diagnosticProgress(folder) {
  const key = pathKey(folder.path);
  const signature = [
    folder.previewPhase, folder.previewProcessed, folder.previewReady, folder.previewFailed,
    folder.previewDeferred, folder.previewQueued, folder.previewCursor,
    folder.pending, folder.waitingForIdle, folder.diagnostics?.pendingChanges
  ].join('|');
  const previous = diagnosticHistory.get(key);
  const now = Date.now();
  if (!previous || previous.signature !== signature) {
    const next = { signature, changedAt: now };
    diagnosticHistory.set(key, next);
    return next;
  }
  return previous;
}

function diagnosticsText(stats, state) {
  const now = Date.now();
  const lines = [];
  const background = state?.background || {};
  const cpu = Number.isFinite(Number(background.cpuLoad)) ? `${Math.round(Number(background.cpuLoad) * 100)}% CPU` : '';
  const idle = Number.isFinite(Number(background.idleMs)) ? `idle ${duration(background.idleMs)}` : '';
  lines.push(`Background  ${background.mode || previewMode()} · ${background.allowed ? 'allowed' : background.reason || 'waiting'}${cpu ? ` · ${cpu}` : ''}${idle ? ` · ${idle}` : ''}`);

  const job = state?.job;
  if (job?.status === 'running') {
    const phase = job.progress?.phase ? ` · ${job.progress.phase}` : '';
    lines.push(`Job         ${job.background ? 'background' : 'foreground'} · ${job.label || job.type}${phase}`);
  } else lines.push('Job         none');

  for (const folder of stats || []) {
    const name = String(folder.path || '').split(/[\\/]/).filter(Boolean).at(-1) || folder.path || 'Folder';
    const tracker = diagnosticProgress(folder);
    const unchanged = now - tracker.changedAt;
    const phase = String(folder.previewPhase || '');
    const activelyChecking = folder.previewWarming && !folder.previewWaiting && previewMode() !== 'off' && (phase === 'checking' || phase === 'verifying');
    const queueMoving = Number(folder.previewQueueActive) > 0 || Number(folder.previewQueueBackground) > 0;
    const stalled = activelyChecking && !queueMoving && unchanged > 15_000;
    const diag = folder.diagnostics || {};

    lines.push('');
    lines.push(`${stalled ? 'STALLED  ' : 'Folder    '} ${name}`);
    lines.push(`  path       ${folder.path}`);
    lines.push(`  index      ${(Number(folder.files) || 0).toLocaleString()} files · ${folder.pending ? 'pending' : 'settled'}${folder.waitingForIdle ? ' · waiting for idle' : ''}`);
    if (folder.lastIndexed) lines.push(`  indexed    ${folder.lastIndexed}`);
    if (Object.keys(diag).length) {
      lines.push(`  watcher    ${diag.watcher ? 'on' : 'off'} · full=${diag.fullCheckQueued ? 'queued' : 'no'} · incremental=${diag.incrementalQueued ? 'queued' : 'no'} · changes=${Number(diag.pendingChanges) || 0}`);
    }
    if (phase) {
      lines.push(`  thumbnails ${phase} · checked=${Number(folder.previewProcessed) || 0} · ready=${Number(folder.previewReady) || 0} · failed=${Number(folder.previewFailed) || 0} · deferred=${Number(folder.previewDeferred) || 0}`);
      lines.push(`  queue      queued=${Number(folder.previewQueueBackground) || 0} · active=${Number(folder.previewQueueActive) || 0} · urgent=${Number(folder.previewQueueUrgent) || 0} · requested=${Number(folder.previewQueued) || 0}`);
      lines.push(`  progress   ${duration(now - (Number(folder.previewLastProgressAt) || now))} ago · pass=${Number(folder.previewPasses) || 0}${stalled ? '  ← no progress' : ''}`);
      if (folder.previewPauseUntil > now) lines.push(`  pause      ${duration(folder.previewPauseUntil - now)} remaining`);
      if (folder.previewCursor) lines.push(`  cursor     ${shortPath(folder.previewCursor)}`);
      if (folder.previewError) lines.push(`  error      ${folder.previewError} · count=${Number(folder.previewErrorCount) || 1}`);
    }
  }
  return lines.join('\n');
}

async function refreshDiagnostics() {
  clearTimeout(diagnosticsTimer);
  diagnosticsTimer = 0;
  if (!diagnostics?.open || diagnosticsBusy) return;
  diagnosticsBusy = true;
  try {
    const [folderData, state] = await Promise.all([
      request('/api/folder-stats'),
      request('/api/state')
    ]);
    latestFolderStats = folderData.folders || latestFolderStats;
    diagnosticsOutput.textContent = diagnosticsText(latestFolderStats, state);
  } catch (error) {
    diagnosticsOutput.textContent = `Diagnostics unavailable: ${error.message}`;
  } finally {
    diagnosticsBusy = false;
    if (diagnostics?.open) diagnosticsTimer = setTimeout(refreshDiagnostics, 2000);
  }
}

if (storagePane) {
  diagnostics = document.createElement('details');
  diagnostics.className = 'storage-diagnostics';
  diagnostics.innerHTML = `<summary>Diagnostics</summary><div class="storage-diagnostics-body"><div class="storage-diagnostics-actions"><button type="button" data-copy-diagnostics>Copy</button></div><pre data-diagnostics-output>Open to inspect storage activity.</pre></div>`;
  diagnosticsOutput = diagnostics.querySelector('[data-diagnostics-output]');
  storagePane.append(diagnostics);
  diagnostics.addEventListener('toggle', () => {
    clearTimeout(diagnosticsTimer);
    diagnosticsTimer = 0;
    if (diagnostics.open) refreshDiagnostics();
  });
  diagnostics.querySelector('[data-copy-diagnostics]')?.addEventListener('click', async event => {
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(diagnosticsOutput.textContent || '');
      event.currentTarget.textContent = 'Copied';
      setTimeout(() => { event.currentTarget.textContent = 'Copy'; }, 1000);
    } catch {}
  });
}

function schedulePreviewProgress(delay = 0) {
  if (progressTimer) {
    if (delay > 0) return;
    clearTimeout(progressTimer);
  }
  progressTimer = setTimeout(refreshPreviewProgress, Math.max(0, delay));
}

async function refreshPreviewProgress() {
  progressTimer = 0;
  if (progressBusy) return schedulePreviewProgress(500);
  progressBusy = true;
  let warming = false;
  try {
    latestFolderStats = (await request('/api/folder-stats')).folders || [];
    warming = renderPreviewProgress(latestFolderStats);
  } catch {}
  finally {
    progressBusy = false;
    schedulePreviewProgress(warming ? 1200 : 7000);
  }
}
schedulePreviewProgress(120);
window.addEventListener('mochimono:preview-mode', () => schedulePreviewProgress(0));

addEventListener('keydown', event => {
  if (!pageKeys.has(event.key) || filesPane?.hidden || document.querySelector('dialog[open]')) return;
  if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
  if (!frame?.contentWindow?.mochimonoPageKeys?.press?.(event.key)) return;
  frame.contentWindow.focus();
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
