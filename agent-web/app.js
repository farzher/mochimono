const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const activityCard = $('#activityCard');
const protection = $('#protection');
const connectionDialog = $('#connectionDialog');

let backupPath;
let backupEditing = false;
let restorePath;
let lastFinished;
let defaultDevice = '';

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
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(number) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function duration(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function toast(text) {
  const element = $('#toast');
  element.textContent = text;
  element.classList.add('show');
  clearTimeout(element.timer);
  element.timer = setTimeout(() => element.classList.remove('show'), 3000);
}

async function chooseFolder(target) {
  try {
    const result = await req('/api/pick-folder');
    if (result.path) target.value = result.path;
  } catch (error) {
    toast(error.message);
  }
}

function renderFolders(folders, job) {
  const element = $('#folders');
  if (!folders.length) {
    element.innerHTML = '<div class="muted">No folders.</div>';
    return;
  }
  element.innerHTML = folders.map(folder => {
    const syncing = job?.status === 'running' && job.type === 'sync' && job.progress?.path === folder.path;
    const status = syncing ? 'Syncing…' : folder.lastSynced ? 'Synced' : 'Pending';
    return `
      <div class="sync-folder">
        <div class="sync-folder-copy">
          <strong>${esc(folder.path)}</strong>
          <span>${esc(folder.device)} · ${status}</span>
        </div>
        <div class="sync-folder-actions">
          <button class="secondary small" data-sync-folder="${esc(folder.path)}">Sync</button>
          <button class="icon tiny" data-remove-folder="${esc(folder.path)}" aria-label="Remove" title="Stop syncing">×</button>
        </div>
      </div>`;
  }).join('');
}

async function state() {
  try {
    const current = await req('/api/state');
    if (!connectionDialog.open) $('#serverUrl').value = current.settings.server;
    defaultDevice = current.settings.device || defaultDevice;
    if (!$('#deviceName').value) $('#deviceName').value = defaultDevice;

    const status = $('#serverStatus');
    status.className = `status ${current.server.online ? 'online' : 'offline'}`;
    status.textContent = current.server.online ? 'Online' : 'Connect';
    status.title = current.server.online ? `${current.server.stats.objects.toLocaleString()} files` : current.server.error || 'Connect';

    renderFolders(current.settings.folders || [], current.job);
    activity(current.job);
    if (current.job && current.job.status !== 'running' && lastFinished !== current.job.id) {
      lastFinished = current.job.id;
      toast(current.job.status === 'done' ? 'Synced' : current.job.status === 'canceled' ? 'Canceled' : current.job.error);
      if (protection.open) backups();
    }
  } catch (error) {
    toast(error.message);
  }
}

function activity(job) {
  if (!job || job.status !== 'running') {
    activityCard.hidden = true;
    return;
  }

  activityCard.hidden = false;
  const p = job.progress || {};
  const total = Number(p.totalBytes) || 0;
  const done = Math.min(total, Number(p.doneBytes) || 0);
  const percent = total ? Math.max(0, Math.min(100, done / total * 100)) : 0;
  const meta = [];

  if (total) meta.push(`${bytes(done)} / ${bytes(total)}`);
  else if (p.scanned != null) meta.push(`${Number(p.scanned).toLocaleString()} files`);
  if (p.speedBps > 0) meta.push(`${bytes(p.speedBps)}/s`);
  if (p.etaSeconds != null && p.etaSeconds > 0) meta.push(`${duration(p.etaSeconds)} left`);

  $('#activity').innerHTML = `
    <div class="progress-head">
      <strong>${esc(job.cancelRequested ? 'Canceling…' : p.phase || 'Working…')}</strong>
      <button class="secondary small" data-cancel-job ${job.cancelRequested ? 'disabled' : ''}>Cancel</button>
    </div>
    <div class="progress-bar ${p.indeterminate ? 'indeterminate' : ''}"><i style="width:${p.indeterminate ? '32%' : `${percent}%`}"></i></div>
    <div class="progress-foot">
      <span>${esc(meta.join(' · '))}</span>
      <span title="${esc(p.current || '')}">${esc(p.current || '')}</span>
    </div>`;
}

async function backups() {
  const element = $('#backups');
  element.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const { backups: locations } = await req('/api/backups');
    element.innerHTML = locations.map((location, index) => {
      const policy = location.meta.policy?.all ? 'Everything' : (location.meta.policy?.types || []).join(', ');
      const remote = location.remote;
      const ratio = remote?.desiredBytes ? Math.min(100, remote.protectedBytes / remote.desiredBytes * 100) : remote ? 100 : 0;
      const missing = remote ? Math.max(0, remote.desiredBytes - remote.protectedBytes) : null;
      const coverage = remote ? `
        <div class="coverage"><div class="coverage-bar"><i style="width:${ratio}%"></i></div>
        <div class="coverage-copy"><span>${bytes(remote.protectedBytes)} / ${bytes(remote.desiredBytes)}</span><b>${missing ? `${bytes(missing)} missing` : 'Complete'}</b></div></div>` :
        '<div class="coverage-copy offline-copy"><span>Offline</span><b>Local only</b></div>';
      return `
        <div class="drive">
          <div class="drive-name">${esc(location.meta.name)}</div>
          <div class="drive-path">${esc(location.path)}</div>
          ${coverage}
          <div class="drive-meta">${location.local.count.toLocaleString()} files · ${bytes(location.local.bytes)} · ${bytes(location.freeBytes)} free · ${esc(policy)}</div>
          <div class="drive-actions">
            <button class="primary small" data-update="${index}">Update</button>
            <button class="secondary small" data-configure="${index}">Edit</button>
            <button class="secondary small" data-restore="${index}">Restore</button>
            <button class="secondary small" data-verify="${index}">Verify</button>
          </div>
        </div>`;
    }).join('') || '<div class="muted">None.</div>';

    $$('[data-update]').forEach(button => button.onclick = () => runBackup(locations[Number(button.dataset.update)].path, 'update'));
    $$('[data-verify]').forEach(button => button.onclick = () => runBackup(locations[Number(button.dataset.verify)].path, 'verify'));
    $$('[data-restore]').forEach(button => button.onclick = () => openRestoreDialog(locations[Number(button.dataset.restore)].path));
    $$('[data-configure]').forEach(button => button.onclick = () => {
      const location = locations[Number(button.dataset.configure)];
      openBackupDialog(location.path, location.meta);
    });
  } catch (error) {
    element.innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

async function runBackup(path, action) {
  try {
    await req(`/api/backup/${action}`, { method: 'POST', body: JSON.stringify({ path }) });
    state();
  } catch (error) {
    toast(error.message);
  }
}

function openBackupDialog(path, meta = null) {
  backupPath = path;
  backupEditing = Boolean(meta);
  $('#backupPathLabel').textContent = path;
  $('#backupName').value = meta?.name || '';
  const everything = meta?.policy?.all !== false;
  $('#backupEverything').checked = everything;
  $('#backupTypes').classList.toggle('disabled', everything);
  const selected = new Set(meta?.policy?.types || []);
  $$('#backupTypes input').forEach(input => { input.checked = selected.has(input.value); });
  $('#backupDialog').showModal();
}

function openRestoreDialog(path) {
  restorePath = path;
  $('#restoreBackupLabel').textContent = path;
  $('#restoreDestination').value = '';
  $('#restoreDialog').showModal();
}

$('#serverStatus').onclick = () => connectionDialog.showModal();
$('#chooseImport').onclick = () => chooseFolder($('#importPath'));
$('#chooseBackup').onclick = () => chooseFolder($('#backupLocation'));
$('#chooseRestore').onclick = () => chooseFolder($('#restoreDestination'));
$('#refreshBackups').onclick = backups;
protection.addEventListener('toggle', () => { if (protection.open) backups(); });
$$('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#backupEverything').onchange = event => $('#backupTypes').classList.toggle('disabled', event.target.checked);

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
    state();
  } catch (error) {
    toast(error.message);
  }
});

$('#startImport').onclick = async () => {
  const path = $('#importPath').value.trim();
  const device = $('#deviceName').value.trim() || defaultDevice;
  if (!path) return toast('Choose a folder.');
  try {
    await req('/api/folders', { method: 'POST', body: JSON.stringify({ path, device }) });
    $('#importPath').value = '';
    state();
  } catch (error) {
    toast(error.message);
  }
};

$('#addBackup').onclick = () => {
  const path = $('#backupLocation').value.trim();
  if (!path) return toast('Choose a folder.');
  openBackupDialog(path);
};

$('#initializeBackup').onclick = async () => {
  const types = $('#backupEverything').checked ? [] : $$('#backupTypes input:checked').map(input => input.value);
  try {
    const result = await req('/api/backup/init', {
      method: 'POST',
      body: JSON.stringify({ path: backupPath, name: $('#backupName').value.trim(), types, configure: backupEditing })
    });
    $('#backupDialog').close();
    $('#backupLocation').value = '';
    toast(backupEditing ? 'Saved' : result.existing ? 'Added' : 'Created');
    if (protection.open) backups();
  } catch (error) {
    toast(error.message);
  }
};

$('#startRestore').onclick = async () => {
  const destination = $('#restoreDestination').value.trim();
  if (!destination) return toast('Choose a destination.');
  try {
    await req('/api/backup/restore', { method: 'POST', body: JSON.stringify({ path: restorePath, destination }) });
    $('#restoreDialog').close();
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
    state();
  } catch (error) {
    toast(error.message);
  }
};

state();
setInterval(state, 900);
