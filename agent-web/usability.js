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
const previewDriveOwners = new Map();

const previewMode = () => window.mochimonoPreviewMode?.() || 'idle';
const previewDrive = value => {
  const text = String(value || '');
  const match = text.match(/^([a-z]:)[\\/]/i);
  return match ? match[1].toLowerCase() : '/';
};
const folderName = value => String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || String(value || '');

function syncPreviewDriveOwners(stats) {
  const byPath = new Map((stats || []).map(folder => [pathKey(folder.path), folder]));
  const drives = new Map();
  for (const folder of stats || []) {
    if (Number(folder.previewQueueActive) <= 0) continue;
    const drive = previewDrive(folder.path);
    if (!drives.has(drive)) drives.set(drive, folder.path);
  }
  for (const [drive, owner] of previewDriveOwners) {
    if (drives.has(drive)) continue;
    const folder = byPath.get(pathKey(owner));
    if (folder?.previewWarming) drives.set(drive, owner);
  }
  for (const folder of stats || []) {
    const drive = previewDrive(folder.path);
    if (!drives.has(drive) && folder.previewWarming) drives.set(drive, folder.path);
  }
  previewDriveOwners.clear();
  for (const [drive, owner] of drives) previewDriveOwners.set(drive, owner);
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return `~${Math.max(10, Math.round(seconds / 10) * 10)}s`;
  if (seconds < 3600) return `~${Math.max(1, Math.round(seconds / 60))}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `~${hours}h${minutes ? ` ${minutes}m` : ''}`;
}

function previewInfo(folder) {
  const key = pathKey(folder.path);
  const previous = previewMemory.get(key) || null;
  const phase = String(folder.previewPhase || '');
  const mode = previewMode();
  const waiting = Boolean(folder.previewWaiting);
  const driveOwner = previewDriveOwners.get(previewDrive(folder.path)) || '';
  const driveBlocked = Boolean(folder.previewWarming && driveOwner && pathKey(driveOwner) !== key);
  let total = Number(folder.previewTotal) || 0;
  let processed = Number(folder.previewProcessed) || 0;
  let ready = Number(folder.previewReady) || 0;
  const failed = Number(folder.previewFailed) || 0;
  const deferred = Number(folder.previewDeferred) || 0;
  const generated = Number(folder.previewGenerated) || 0;
  const workerQueued = Number(folder.previewQueueBackground) || 0;
  const workerActive = Number(folder.previewQueueActive) || 0;
  const complete = total ? Math.min(total, ready + failed + deferred + generated) : ready + failed + deferred + generated;
  const remaining = total ? Math.max(0, total - complete) : 0;
  const now = Date.now();
  let rate = Number(previous?.rate) || 0;
  let lastGeneratedAt = Number(previous?.lastGeneratedAt) || 0;
  if (previous && workerActive > 0 && generated > Number(previous.generated || 0)) {
    const elapsed = Math.max(.001, (now - Number(previous.sampleAt || now)) / 1000);
    const instant = (generated - Number(previous.generated || 0)) / elapsed;
    rate = rate > 0 ? rate * .7 + instant * .3 : instant;
    lastGeneratedAt = now;
  } else if (lastGeneratedAt && now - lastGeneratedAt > 15_000) rate = 0;
  const scanComplete = total > 0 && processed >= total;
  const eta = scanComplete && !driveBlocked && workerActive > 0 && generated >= 8 && rate > 0
    ? formatEta(remaining / rate)
    : '';

  if (!phase) {
    if (!previous) return null;
    total = previous.total;
    processed = previous.processed;
    ready = previous.ready;
    const done = previous.done;
    return {
      key, phase:'', total, processed, failed:previous.failed || 0, deferred:previous.deferred || 0, generated:previous.generated || 0,
      text:done ? 'Ready' : mode === 'off' ? 'Paused' : waiting ? 'Waiting for idle' : driveBlocked ? 'Next' : 'Working',
      percent:previous.percent || '', ratio:previous.ratio || 0, indeterminate:false,
      done, waiting, driveBlocked, driveOwner, state:waiting ? 'waiting' : 'queued', working:!done && mode !== 'off' && !waiting && !driveBlocked
    };
  }

  const done = phase === 'done';
  let ratio = total ? Math.min(1, complete / total) : 0;
  let percent = total ? `${Math.floor(ratio * 100)}%` : '';
  let text = '';
  let indeterminate = false;
  let state = 'checking';

  if (done) {
    ratio = 1;
    percent = total ? '100%' : '';
    text = 'Ready';
    state = 'done';
  } else if (mode === 'off') {
    text = 'Paused';
    state = 'paused';
  } else if (waiting) {
    text = 'Waiting for idle';
    state = 'waiting';
  } else if (driveBlocked) {
    text = 'Next';
    state = 'queued';
  } else if (workerActive > 0) {
    text = eta ? `Generating · ${eta}` : 'Generating';
    state = 'active';
    indeterminate = !total;
  } else if (phase === 'checking') {
    text = 'Checking';
    state = 'checking';
    indeterminate = !total;
  } else if (workerQueued > 0 || phase === 'generating') {
    text = 'Starting';
    state = 'queued';
    indeterminate = !total;
  } else {
    text = 'Working';
    state = 'checking';
    indeterminate = !total;
  }

  const info = {
    key, phase, total, processed, ready, failed, deferred, generated, text, percent, ratio, indeterminate, done, waiting,
    driveBlocked, driveOwner, state, working: Boolean(folder.previewWarming && mode !== 'off' && !waiting && !driveBlocked)
  };
  previewMemory.set(key, {
    total, processed, ready, failed, deferred, generated, done, percent, ratio,
    rate, sampleAt:now, lastGeneratedAt
  });
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
  syncPreviewDriveOwners(stats);
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
    if (!info || info.done) {
      row.querySelector('[data-preview-progress]')?.remove();
      continue;
    }
    warming ||= Boolean(info.working);
    const node = previewNode(row);
    node.classList.toggle('preview-indeterminate', info.indeterminate);
    for (const state of ['active','queued','checking','waiting','paused']) node.classList.toggle(`preview-${state}`, info.state === state);
    node.querySelector('[data-preview-progress-text]').textContent = info.text;
    node.querySelector('[data-preview-percent]').textContent = info.percent;
    node.style.setProperty('--preview-progress', String(info.ratio));
    node.title = info.driveBlocked ? `Next after ${folderName(info.driveOwner)} on this drive`
      : info.state === 'active' ? 'Generating thumbnails now'
        : info.state === 'queued' ? 'Starting thumbnail workers'
          : info.state === 'checking' ? 'Checking the thumbnail cache'
            : info.state === 'waiting' ? 'Waiting until this computer is idle'
              : 'Background thumbnails paused';
  }
  return warming;
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
  if (progressBusy) return schedulePreviewProgress(350);
  progressBusy = true;
  let warming = false;
  try {
    const stats = (await request('/api/folder-stats')).folders || [];
    warming = renderPreviewProgress(stats);
  } catch {}
  finally {
    progressBusy = false;
    schedulePreviewProgress(warming ? 650 : 7000);
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
