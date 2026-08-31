const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const activityCard = $('#activityCard');
const connectionDialog = $('#connectionDialog');
const deviceDialog = $('#deviceDialog');
const backupDialog = $('#backupDialog');
const restoreDialog = $('#restoreDialog');

let backupPath = '';
let backupEditing = false;
let restorePath = '';
let lastFinished = '';
let defaultDevice = '';
let foldersRenderKey = '';
let backupsRenderKey = '';
let backupLocations = [];
let smartCollections = [];
let backupLoading = false;
let lastBackupRefresh = 0;
let currentJob = null;

async function req(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function bytes(number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(number) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function duration(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function exactDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit'
  });
}

function pathName(path) {
  const clean = String(path || '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || clean;
}

function samePath(a, b) {
  const clean = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
  return clean(a) === clean(b);
}

function toast(text) {
  const element = $('#toast');
  element.textContent = text;
  element.classList.add('show');
  clearTimeout(element.timer);
  element.timer = setTimeout(() => element.classList.remove('show'), 2800);
}

async function chooseFolder(target) {
  try {
    const result = await req('/api/pick-folder');
    if (result.path) target.value = result.path;
  } catch (error) {
    toast(error.message);
  }
}

function toggleInline(element, button) {
  element.hidden = !element.hidden;
  button.classList.toggle('active', !element.hidden);
  if (!element.hidden) element.querySelector('input')?.focus();
}

function folderRow(folder) {
  return `
    <article class="storage-item folder-item" data-folder-path="${esc(folder.path)}">
      <div class="storage-copy">
        <div class="storage-title">
          <strong title="${esc(folder.path)}">${esc(folder.path)}</strong>
          <time class="item-state" data-folder-status>—</time>
        </div>
        <div class="storage-meta"><span data-folder-files>— files</span><span>·</span><span data-folder-size>—</span><span>·</span><span data-folder-free>— free</span></div>
        <div class="storage-meter" title=""><i data-folder-meter></i></div>
        <div class="item-progress" data-item-progress hidden></div>
      </div>
      <div class="item-actions">
        <button class="action-link" data-sync-folder="${esc(folder.path)}">Sync</button>
        <button class="icon tiny" data-remove-folder="${esc(folder.path)}" aria-label="Stop syncing" title="Stop syncing">×</button>
      </div>
    </article>`;
}

function progressData(job) {
  if (!job || job.status !== 'running') return null;
  const p = job.progress || {};
  const total = Number(p.totalBytes) || 0;
  const done = Math.min(total, Number(p.doneBytes) || 0);
  const percent = total ? Math.max(0, Math.min(100, done / total * 100)) : 0;
  const meta = [];
  if (total) meta.push(`${bytes(done)} / ${bytes(total)}`);
  else if (p.scanned != null) meta.push(`${Number(p.scanned).toLocaleString()} files`);
  else if (p.total != null) meta.push(`${Number(p.checked || 0).toLocaleString()} / ${Number(p.total).toLocaleString()}`);
  if (p.copied != null) meta.push(`${Number(p.copied).toLocaleString()} copied`);
  if (p.speedBps > 0) meta.push(`${bytes(p.speedBps)}/s`);
  if (p.etaSeconds > 0) meta.push(`${duration(p.etaSeconds)} left`);
  const phase = job.cancelRequested ? 'Canceling…' : p.phase || 'Working…';
  return {
    key: JSON.stringify([phase, meta, p.current || '', percent, Boolean(p.indeterminate), job.cancelRequested]),
    html: `
      <div class="inline-progress-head"><strong>${esc(phase)}</strong><button class="action-link" data-cancel-job ${job.cancelRequested ? 'disabled' : ''}>Cancel</button></div>
      <div class="progress-bar ${p.indeterminate || !total ? 'indeterminate' : ''}"><i style="width:${p.indeterminate || !total ? '32%' : `${percent}%`}"></i></div>
      <div class="inline-progress-meta"><span>${esc(meta.join(' · '))}</span><span title="${esc(p.current || '')}">${esc(p.current || '')}</span></div>`
  };
}

function renderItemProgress(row, job) {
  const element = row?.querySelector('[data-item-progress]');
  if (!element) return;
  const progress = progressData(job);
  if (!progress) {
    element.hidden = true;
    element.dataset.progressKey = '';
    return;
  }
  element.hidden = false;
  if (element.dataset.progressKey === progress.key) return;
  element.dataset.progressKey = progress.key;
  element.innerHTML = progress.html;
}

function folderJob(path, job) {
  if (job?.status !== 'running' || job.type !== 'sync') return null;
  return samePath(job.progress?.path, path) ? job : null;
}

function backupJobPath(job) {
  const label = String(job?.label || '');
  for (const prefix of ['Update ', 'Verify ', 'Restore ']) {
    if (label.startsWith(prefix)) return label.slice(prefix.length);
  }
  return '';
}

function backupJob(location, job) {
  if (job?.status !== 'running' || !['backup', 'verify', 'restore'].includes(job.type)) return null;
  return samePath(backupJobPath(job), location.path) ? job : null;
}

function renderFolders(folders, job) {
  const element = $('#folders');
  const renderKey = JSON.stringify(folders.map(folder => folder.path));
  if (renderKey !== foldersRenderKey) {
    foldersRenderKey = renderKey;
    element.innerHTML = folders.length ? folders.map(folderRow).join('') : '<div class="empty-state">No folders</div>';
  }

  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  for (const row of element.querySelectorAll('[data-folder-path]')) {
    const folder = byPath.get(row.dataset.folderPath);
    if (!folder) continue;
    const active = folderJob(folder.path, job);
    const label = row.querySelector('[data-folder-status]');
    const status = active ? 'Syncing' : exactDate(folder.lastSynced) || '—';
    if (label.textContent !== status) label.textContent = status;
    label.className = `item-state ${active ? 'working' : folder.lastSynced ? 'good' : ''}`;
    row.classList.toggle('working', Boolean(active));
    renderItemProgress(row, active);
  }
}

async function refreshFolderStats() {
  try {
    const { folders = [] } = await req('/api/folder-stats');
    for (const item of folders) {
      const row = [...$('#folders').querySelectorAll('[data-folder-path]')].find(node => samePath(node.dataset.folderPath, item.path));
      if (!row) continue;
      row.querySelector('[data-folder-files]').textContent = `${Number(item.files).toLocaleString()} files`;
      row.querySelector('[data-folder-size]').textContent = bytes(item.bytes);
      row.querySelector('[data-folder-free]').textContent = `${bytes(item.freeBytes)} free`;
      const ratio = item.capacityBytes ? Math.min(100, Number(item.bytes) / Number(item.capacityBytes) * 100) : 0;
      const meter = row.querySelector('[data-folder-meter]');
      meter.style.width = item.bytes ? `max(2px, ${ratio}%)` : '0';
      meter.parentElement.title = `${bytes(item.bytes)} of ${bytes(item.capacityBytes)}`;
    }
  } catch {}
}

function backgroundActivity(job, previews = {}) {
  const previewActive = Number(previews.active) || 0;
  const previewQueued = (Number(previews.urgent) || 0) + (Number(previews.priority) || 0) + (Number(previews.queued) || 0);
  if (job?.status === 'running' || (!previewActive && !previewQueued)) {
    activityCard.hidden = true;
    return;
  }
  activityCard.hidden = false;
  const key = `${previewActive}:${previewQueued}`;
  if ($('#activity').dataset.key === key) return;
  $('#activity').dataset.key = key;
  $('#activity').innerHTML = `<span><strong>Previews</strong>${previewActive ? ` · ${previewActive} working` : ''}${previewQueued ? ` · ${previewQueued.toLocaleString()} queued` : ''}</span><div class="progress-bar indeterminate"><i style="width:32%"></i></div>`;
}

async function recordFinishedBackup(job) {
  if (job?.status !== 'done') return;
  const path = backupJobPath(job);
  if (!path) return;
  const action = job.type === 'backup' ? 'update' : job.type;
  if (!['update', 'verify', 'restore'].includes(action)) return;
  try {
    await req('/api/backup/history', { method: 'POST', body: JSON.stringify({ path, action }) });
    backupsRenderKey = '';
  } catch {}
}

async function state() {
  try {
    const current = await req('/api/state');
    currentJob = current.job;
    if (!connectionDialog.open) $('#serverUrl').value = current.settings.server;
    defaultDevice = current.settings.device || defaultDevice;
    $('#deviceLabel').textContent = defaultDevice;

    const status = $('#serverStatus');
    status.className = `status ${current.server.online ? 'online' : 'offline'}`;
    status.textContent = current.server.online ? 'Online' : 'Connect';
    status.title = current.server.online ? `${current.server.stats.objects.toLocaleString()} files` : current.server.error || 'Connect';

    renderFolders(current.settings.folders || [], current.job);
    renderBackupProgress(current.job);
    backgroundActivity(current.job, current.previews);

    if (current.job && current.job.status !== 'running' && lastFinished !== current.job.id) {
      lastFinished = current.job.id;
      await recordFinishedBackup(current.job);
      toast(current.job.status === 'done' ? (current.job.type === 'sync' ? 'Synced' : 'Done') : current.job.status === 'canceled' ? 'Canceled' : current.job.error);
      backups(true);
      refreshFolderStats();
    }

    if (Date.now() - lastBackupRefresh > 12_000) backups();
  } catch (error) {
    toast(error.message);
  }
}

function backupScope(location) {
  const policy = location.remote?.policy || location.meta?.policy || {};
  if (policy.all !== false) return 'Everything';
  return `${policy.collectionName ? '✦ ' : ''}${policy.collectionName || `Collection ${policy.collectionId || ''}`.trim()}`;
}

function backupState(location) {
  const remote = location.remote;
  if (!remote) return { label: 'Offline', className: '' };
  if (remote.policy?.missing) return { label: 'Collection missing', className: 'bad' };
  const missing = Math.max(0, Number(remote.desiredBytes) - Number(remote.protectedBytes));
  if (missing) return { label: `${bytes(missing)} left`, className: 'warning' };
  const when = exactDate(location.meta?.lastBackupAt || location.local?.oldestVerification);
  return { label: when || 'Ready', className: 'good' };
}

function backupCard(location, index) {
  const remote = location.remote;
  const protectedBytes = Number(remote?.protectedBytes) || 0;
  const desiredBytes = Number(remote?.desiredBytes) || 0;
  const ratio = desiredBytes ? Math.min(100, protectedBytes / desiredBytes * 100) : remote ? 100 : 0;
  const state = backupState(location);
  const scope = backupScope(location);
  const localBytes = Number(location.local?.bytes) || 0;
  const shownBytes = remote ? protectedBytes : localBytes;

  return `
    <article class="storage-item backup-item" data-backup-index="${index}">
      <div class="storage-copy">
        <div class="storage-title"><strong>${esc(location.meta.name)}</strong><time class="item-state ${state.className}">${esc(state.label)}</time></div>
        <div class="storage-path" title="${esc(location.path)}">${esc(location.path)}</div>
        <div class="storage-meta"><span>${esc(scope)}</span><span>·</span><span>${bytes(shownBytes)}</span><span>·</span><span>${bytes(location.freeBytes)} free</span></div>
        <div class="storage-meter backup-meter" title="${remote ? `${bytes(protectedBytes)} of ${bytes(desiredBytes)} backed up` : `${bytes(localBytes)} stored`}"><i style="width:${remote && protectedBytes ? `max(2px, ${ratio}%)` : '0'}"></i></div>
        <div class="item-progress" data-item-progress hidden></div>
      </div>
      <div class="item-actions backup-actions">
        <button class="action-link primary-action" data-update="${index}">Update</button>
        <button class="action-link" data-restore="${index}">Restore</button>
        <button class="action-link" data-verify="${index}">Verify</button>
        <button class="action-link" data-configure="${index}">Edit</button>
      </div>
    </article>`;
}

function wireBackupActions() {
  $$('[data-update]').forEach(button => button.onclick = () => runBackup(backupLocations[Number(button.dataset.update)].path, 'update'));
  $$('[data-verify]').forEach(button => button.onclick = () => runBackup(backupLocations[Number(button.dataset.verify)].path, 'verify'));
  $$('[data-restore]').forEach(button => button.onclick = () => openRestoreDialog(backupLocations[Number(button.dataset.restore)].path));
  $$('[data-configure]').forEach(button => button.onclick = () => {
    const location = backupLocations[Number(button.dataset.configure)];
    openBackupDialog(location.path, location.meta);
  });
}

function renderBackupProgress(job) {
  for (const row of $('#backups').querySelectorAll('[data-backup-index]')) {
    const location = backupLocations[Number(row.dataset.backupIndex)];
    if (location) renderItemProgress(row, backupJob(location, job));
  }
}

async function backups(force = false) {
  if (backupLoading || (!force && Date.now() - lastBackupRefresh < 5000)) return;
  backupLoading = true;
  try {
    const { backups: locations } = await req('/api/backups');
    backupLocations = locations || [];
    lastBackupRefresh = Date.now();
    const key = JSON.stringify(backupLocations.map(location => [
      location.path,
      location.meta?.name,
      location.meta?.policy,
      location.meta?.lastBackupAt,
      location.meta?.lastVerifiedAt,
      location.local?.count,
      location.local?.bytes,
      location.local?.oldestVerification,
      location.freeBytes,
      location.remote?.protectedBytes,
      location.remote?.desiredBytes,
      location.remote?.policy
    ]));
    if (key !== backupsRenderKey) {
      backupsRenderKey = key;
      $('#backups').innerHTML = backupLocations.length ? backupLocations.map(backupCard).join('') : '<div class="empty-state">No backups</div>';
      wireBackupActions();
    }
    renderBackupProgress(currentJob);
  } catch (error) {
    $('#backups').innerHTML = `<div class="error">${esc(error.message)}</div>`;
  } finally {
    backupLoading = false;
  }
}

async function loadSmartCollections() {
  try {
    smartCollections = (await req('/api/backup-collections')).collections || [];
  } catch {
    smartCollections = [];
  }
}

function renderBackupScopes(meta = null) {
  const select = $('#backupScope');
  const current = meta?.policy?.all === false ? Number(meta.policy.collectionId) || 0 : 0;
  const options = ['<option value="">Everything</option>'];
  if (smartCollections.length) options.push(`<optgroup label="Smart Collections">${smartCollections.map(item => `<option value="${Number(item.id)}">✦ ${esc(item.name)}</option>`).join('')}</optgroup>`);
  if (current && !smartCollections.some(item => Number(item.id) === current)) options.push(`<option value="${current}">✦ ${esc(meta.policy.collectionName || `Collection ${current}`)}</option>`);
  select.innerHTML = options.join('');
  select.value = current ? String(current) : '';
}

async function openBackupDialog(path, meta = null) {
  backupPath = path;
  backupEditing = Boolean(meta);
  $('#backupPathLabel').textContent = path;
  $('#backupName').value = meta?.name || pathName(path) || '';
  await loadSmartCollections();
  renderBackupScopes(meta);
  backupDialog.showModal();
}

function openRestoreDialog(path) {
  restorePath = path;
  $('#restoreBackupLabel').textContent = path;
  $('#restoreDestination').value = '';
  restoreDialog.showModal();
}

async function runBackup(path, action) {
  try {
    await req(`/api/backup/${action}`, { method: 'POST', body: JSON.stringify({ path }) });
    state();
  } catch (error) {
    toast(error.message);
  }
}

$('#serverStatus').onclick = () => connectionDialog.showModal();
$('#deviceButton').onclick = () => {
  $('#deviceName').value = defaultDevice;
  deviceDialog.showModal();
};
$('#showFolderAdd').onclick = () => toggleInline($('#folderAdd'), $('#showFolderAdd'));
$('#showBackupAdd').onclick = () => toggleInline($('#backupAdd'), $('#showBackupAdd'));
$('#chooseImport').onclick = () => chooseFolder($('#importPath'));
$('#chooseBackup').onclick = () => chooseFolder($('#backupLocation'));
$('#chooseRestore').onclick = () => chooseFolder($('#restoreDestination'));
$('#refreshBackups').onclick = () => backups(true);
$$('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());

document.addEventListener('click', async event => {
  if (!event.target.closest('[data-cancel-job]')) return;
  try {
    await req('/api/job/cancel', { method: 'POST' });
    state();
  } catch (error) {
    toast(error.message);
  }
});

$('#folders').addEventListener('click', async event => {
  const sync = event.target.closest('[data-sync-folder]');
  const remove = event.target.closest('[data-remove-folder]');
  try {
    if (sync) await req('/api/folders/sync', { method: 'POST', body: JSON.stringify({ path: sync.dataset.syncFolder }) });
    if (remove) await req('/api/folders/remove', { method: 'POST', body: JSON.stringify({ path: remove.dataset.removeFolder }) });
    await state();
    refreshFolderStats();
  } catch (error) {
    toast(error.message);
  }
});

$('#startImport').onclick = async () => {
  const path = $('#importPath').value.trim();
  if (!path) return toast('Choose a folder.');
  try {
    await req('/api/folders', { method: 'POST', body: JSON.stringify({ path }) });
    $('#importPath').value = '';
    $('#folderAdd').hidden = true;
    $('#showFolderAdd').classList.remove('active');
    await state();
    refreshFolderStats();
  } catch (error) {
    toast(error.message);
  }
};

$('#saveDevice').onclick = async () => {
  const device = $('#deviceName').value.trim();
  if (!device) return;
  try {
    await req('/api/settings', { method: 'POST', body: JSON.stringify({ device }) });
    deviceDialog.close();
    state();
  } catch (error) {
    toast(error.message);
  }
};

$('#addBackup').onclick = async () => {
  const path = $('#backupLocation').value.trim();
  if (!path) return toast('Choose a folder.');
  let meta = backupLocations.find(item => samePath(item.path, path))?.meta || null;
  if (!meta) {
    try { meta = (await req(`/api/backup/status?path=${encodeURIComponent(path)}`)).meta; } catch {}
  }
  openBackupDialog(path, meta);
};

$('#initializeBackup').onclick = async () => {
  const collectionId = Number($('#backupScope').value) || 0;
  const collection = smartCollections.find(item => Number(item.id) === collectionId);
  const collectionName = collection?.name || (collectionId ? $('#backupScope').selectedOptions[0]?.textContent?.replace(/^✦\s*/, '') || '' : '');
  const path = backupPath;
  try {
    const result = await req('/api/backup/init', {
      method: 'POST',
      body: JSON.stringify({ path, name: $('#backupName').value.trim(), types: [], configure: backupEditing })
    });
    await req('/api/backup/policy', {
      method: 'POST',
      body: JSON.stringify({ path, collectionId: collectionId || null, collectionName })
    });
    backupDialog.close();
    $('#backupLocation').value = '';
    $('#backupAdd').hidden = true;
    $('#showBackupAdd').classList.remove('active');
    backupsRenderKey = '';
    await backups(true);
    if (!backupEditing && !result.existing) await runBackup(path, 'update');
    else toast(backupEditing ? 'Saved' : 'Added');
  } catch (error) {
    toast(error.message);
  }
};

$('#startRestore').onclick = async () => {
  const destination = $('#restoreDestination').value.trim();
  if (!destination) return toast('Choose a destination.');
  try {
    await req('/api/backup/restore', { method: 'POST', body: JSON.stringify({ path: restorePath, destination }) });
    restoreDialog.close();
    state();
  } catch (error) {
    toast(error.message);
  }
};

$('#saveSettings').onclick = async () => {
  try {
    await req('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ server: $('#serverUrl').value.trim(), token: $('#serverToken').value })
    });
    $('#serverToken').value = '';
    connectionDialog.close();
    backupsRenderKey = '';
    state();
    backups(true);
  } catch (error) {
    toast(error.message);
  }
};

state();
refreshFolderStats();
backups(true);
setInterval(state, 900);
setInterval(refreshFolderStats, 2500);