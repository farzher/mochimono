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

function pathParts(path) {
  const raw = String(path || '');
  const clean = raw.replace(/[\\/]+$/, '') || raw;
  const index = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return {
    name: index >= 0 ? clean.slice(index + 1) || clean : clean,
    parent: index >= 0 ? clean.slice(0, index) : ''
  };
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
  const path = pathParts(folder.path);
  return `
    <article class="storage-item folder-item" data-folder-path="${esc(folder.path)}">
      <span class="folder-glyph" aria-hidden="true"></span>
      <div class="storage-copy">
        <div class="storage-title"><strong>${esc(path.name || folder.path)}</strong><span class="item-state" data-folder-status>Pending</span></div>
        ${path.parent ? `<div class="storage-path" title="${esc(folder.path)}">${esc(path.parent)}</div>` : ''}
        <div class="storage-meta">
          <span data-folder-files>— files</span><span>·</span><span data-folder-size>—</span><span>·</span><span data-folder-free>— free</span>
        </div>
        <div class="storage-meter" title="Folder size relative to drive capacity"><i data-folder-meter></i></div>
      </div>
      <div class="item-actions">
        <button class="action-link" data-sync-folder="${esc(folder.path)}">Sync</button>
        <button class="icon tiny" data-remove-folder="${esc(folder.path)}" aria-label="Stop syncing" title="Stop syncing">×</button>
      </div>
    </article>`;
}

function renderFolders(folders, job) {
  const element = $('#folders');
  const renderKey = JSON.stringify(folders.map(folder => folder.path));
  if (renderKey !== foldersRenderKey) {
    foldersRenderKey = renderKey;
    element.innerHTML = folders.length ? folders.map(folderRow).join('') : '<div class="empty-state">No folders yet</div>';
  }

  const syncingPath = job?.status === 'running' && job.type === 'sync' ? String(job.progress?.path || '') : '';
  const byPath = new Map(folders.map(folder => [folder.path, folder]));
  for (const row of element.querySelectorAll('[data-folder-path]')) {
    const folder = byPath.get(row.dataset.folderPath);
    if (!folder) continue;
    const syncing = syncingPath === folder.path;
    const state = syncing ? 'Syncing' : folder.lastSynced ? 'Synced' : 'Pending';
    const label = row.querySelector('[data-folder-status]');
    if (label.textContent !== state) label.textContent = state;
    label.className = `item-state ${syncing ? 'working' : folder.lastSynced ? 'good' : 'idle'}`;
    label.title = folder.lastSynced ? new Date(folder.lastSynced).toLocaleString() : '';
    row.classList.toggle('working', syncing);
  }
  $('#folderSummary').textContent = folders.length ? `${folders.length} ${folders.length === 1 ? 'folder' : 'folders'}` : '';
}

async function refreshFolderStats() {
  try {
    const data = await req('/api/folder-stats');
    const stats = data.folders || [];
    let totalBytes = 0;
    let totalFiles = 0;
    for (const item of stats) {
      const row = [...$('#folders').querySelectorAll('[data-folder-path]')].find(node => node.dataset.folderPath === item.path);
      if (!row) continue;
      totalBytes += Number(item.bytes) || 0;
      totalFiles += Number(item.files) || 0;
      row.querySelector('[data-folder-files]').textContent = `${Number(item.files).toLocaleString()} files`;
      row.querySelector('[data-folder-size]').textContent = bytes(item.bytes);
      row.querySelector('[data-folder-free]').textContent = `${bytes(item.freeBytes)} free`;
      const ratio = item.capacityBytes ? Math.min(100, Number(item.bytes) / Number(item.capacityBytes) * 100) : 0;
      const meter = row.querySelector('[data-folder-meter]');
      meter.style.width = item.bytes ? `max(2px, ${ratio}%)` : '0';
      meter.parentElement.title = `${bytes(item.bytes)} of ${bytes(item.capacityBytes)}`;
    }
    const count = stats.length;
    $('#folderSummary').textContent = count ? `${totalFiles.toLocaleString()} files · ${bytes(totalBytes)}` : '';
  } catch {}
}

function activity(job, previews = {}) {
  const previewActive = Number(previews.active) || 0;
  const previewQueued = (Number(previews.urgent) || 0) + (Number(previews.priority) || 0) + (Number(previews.queued) || 0);
  const working = job?.status === 'running';
  if (!working && !previewActive && !previewQueued) {
    activityCard.hidden = true;
    return;
  }

  activityCard.hidden = false;
  if (!working) {
    $('#activity').innerHTML = `
      <div class="activity-head"><div><span class="pulse"></span><strong>Previews</strong></div><span>${previewActive ? `${previewActive} working` : ''}${previewActive && previewQueued ? ' · ' : ''}${previewQueued ? `${previewQueued.toLocaleString()} queued` : ''}</span></div>
      <div class="progress-bar indeterminate"><i style="width:32%"></i></div>`;
    return;
  }

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
  if (previewActive || previewQueued) meta.push(`${previewActive} previews · ${previewQueued.toLocaleString()} queued`);

  const phase = job.cancelRequested ? 'Canceling…' : p.phase || job.label || 'Working…';
  $('#activity').innerHTML = `
    <div class="activity-head">
      <div><span class="pulse"></span><strong>${esc(phase)}</strong><span class="activity-label">${esc(job.label || '')}</span></div>
      <button class="action-link" data-cancel-job ${job.cancelRequested ? 'disabled' : ''}>Cancel</button>
    </div>
    <div class="progress-bar ${p.indeterminate || !total ? 'indeterminate' : ''}"><i style="width:${p.indeterminate || !total ? '32%' : `${percent}%`}"></i></div>
    <div class="activity-foot"><span>${esc(meta.join(' · '))}</span><span title="${esc(p.current || '')}">${esc(p.current || '')}</span></div>`;
}

async function state() {
  try {
    const current = await req('/api/state');
    if (!connectionDialog.open) $('#serverUrl').value = current.settings.server;
    defaultDevice = current.settings.device || defaultDevice;
    $('#deviceLabel').textContent = defaultDevice;

    const status = $('#serverStatus');
    status.className = `status ${current.server.online ? 'online' : 'offline'}`;
    status.textContent = current.server.online ? 'Online' : 'Connect';
    status.title = current.server.online ? `${current.server.stats.objects.toLocaleString()} files` : current.server.error || 'Connect';

    renderFolders(current.settings.folders || [], current.job);
    activity(current.job, current.previews);

    if (current.job && current.job.status !== 'running' && lastFinished !== current.job.id) {
      lastFinished = current.job.id;
      const done = current.job.type === 'sync' ? 'Synced' : 'Done';
      toast(current.job.status === 'done' ? done : current.job.status === 'canceled' ? 'Canceled' : current.job.error);
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
  if (policy.all !== false) return { label: 'Everything', smart: false };
  return {
    label: policy.collectionName || `Collection ${policy.collectionId || ''}`.trim(),
    smart: true,
    missing: Boolean(policy.missing)
  };
}

function backupState(location) {
  const remote = location.remote;
  if (!remote) return { label: 'Offline', className: 'idle' };
  if (remote.policy?.missing) return { label: 'Collection missing', className: 'bad' };
  const missing = Math.max(0, Number(remote.desiredBytes) - Number(remote.protectedBytes));
  if (!missing) return { label: 'Complete', className: 'good' };
  return { label: `${bytes(missing)} missing`, className: 'warning' };
}

function backupCard(location, index) {
  const remote = location.remote;
  const protectedBytes = Number(remote?.protectedBytes) || 0;
  const desiredBytes = Number(remote?.desiredBytes) || 0;
  const ratio = desiredBytes ? Math.min(100, protectedBytes / desiredBytes * 100) : remote ? 100 : 0;
  const scope = backupScope(location);
  const state = backupState(location);
  const totalBytes = Number(location.totalBytes) || 0;
  const freeBytes = Number(location.freeBytes) || 0;
  const driveUsed = Math.max(0, totalBytes - freeBytes);
  const capacityRatio = totalBytes ? Math.min(100, driveUsed / totalBytes * 100) : 0;

  return `
    <article class="storage-item backup-item" data-backup-index="${index}">
      <span class="drive-glyph" aria-hidden="true"></span>
      <div class="storage-copy">
        <div class="storage-title"><strong>${esc(location.meta.name)}</strong><span class="item-state ${state.className}">${esc(state.label)}</span></div>
        <div class="storage-path" title="${esc(location.path)}">${esc(location.path)}</div>
        <div class="backup-scope ${scope.missing ? 'missing' : ''}">${scope.smart ? '<span>✦</span>' : ''}${esc(scope.label)}</div>
        <div class="backup-coverage">
          <div class="storage-meter coverage-meter"><i style="width:${protectedBytes ? `max(2px, ${ratio}%)` : '0'}"></i></div>
          <div class="coverage-values"><span>${remote ? `${bytes(protectedBytes)} / ${bytes(desiredBytes)}` : `${Number(location.local.count).toLocaleString()} files · ${bytes(location.local.bytes)}`}</span><span>${bytes(freeBytes)} free</span></div>
        </div>
        <div class="capacity-line" title="${bytes(driveUsed)} used of ${bytes(totalBytes)}"><i style="width:${capacityRatio}%"></i></div>
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
      location.local?.count,
      location.local?.bytes,
      location.freeBytes,
      location.totalBytes,
      location.remote?.protectedBytes,
      location.remote?.desiredBytes,
      location.remote?.policy
    ]));
    if (key !== backupsRenderKey) {
      backupsRenderKey = key;
      $('#backups').innerHTML = backupLocations.length ? backupLocations.map(backupCard).join('') : '<div class="empty-state">No backups yet</div>';
      wireBackupActions();
    }
    const protectedBytes = backupLocations.reduce((sum, location) => sum + (Number(location.remote?.protectedBytes) || Number(location.local?.bytes) || 0), 0);
    $('#backupSummary').textContent = backupLocations.length ? `${backupLocations.length} ${backupLocations.length === 1 ? 'drive' : 'drives'} · ${bytes(protectedBytes)}` : '';
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
  if (smartCollections.length) {
    options.push(`<optgroup label="Smart Collections">${smartCollections.map(item => `<option value="${Number(item.id)}">✦ ${esc(item.name)}</option>`).join('')}</optgroup>`);
  }
  if (current && !smartCollections.some(item => Number(item.id) === current)) {
    options.push(`<option value="${current}">✦ ${esc(meta.policy.collectionName || `Collection ${current}`)}</option>`);
  }
  select.innerHTML = options.join('');
  select.value = current ? String(current) : '';
}

async function openBackupDialog(path, meta = null) {
  backupPath = path;
  backupEditing = Boolean(meta);
  $('#backupPathLabel').textContent = path;
  $('#backupName').value = meta?.name || pathParts(path).name || '';
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

$('#activity').addEventListener('click', async event => {
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
  let meta = backupLocations.find(item => item.path.toLowerCase() === path.toLowerCase())?.meta || null;
  if (!meta) {
    try { meta = (await req(`/api/backup/status?path=${encodeURIComponent(path)}`)).meta; } catch {}
  }
  openBackupDialog(path, meta);
};

$('#initializeBackup').onclick = async () => {
  const collectionId = Number($('#backupScope').value) || 0;
  const collection = smartCollections.find(item => Number(item.id) === collectionId);
  const collectionName = collection?.name || (collectionId ? $('#backupScope').selectedOptions[0]?.textContent?.replace(/^✦\s*/, '') || '' : '');
  try {
    const result = await req('/api/backup/init', {
      method: 'POST',
      body: JSON.stringify({ path: backupPath, name: $('#backupName').value.trim(), types: [], configure: backupEditing })
    });
    await req('/api/backup/policy', {
      method: 'POST',
      body: JSON.stringify({ path: backupPath, collectionId: collectionId || null, collectionName })
    });
    backupDialog.close();
    $('#backupLocation').value = '';
    $('#backupAdd').hidden = true;
    $('#showBackupAdd').classList.remove('active');
    toast(backupEditing ? 'Saved' : result.existing ? 'Added' : 'Created');
    backupsRenderKey = '';
    backups(true);
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