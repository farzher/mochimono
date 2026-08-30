const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let backupPath;
let backupEditing = false;
let restorePath;
let lastFinished;

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

async function state() {
  try {
    const current = await req('/api/state');
    $('#serverUrl').value = current.settings.server;
    const status = $('#serverStatus');
    status.className = `status ${current.server.online ? 'online' : 'offline'}`;
    status.textContent = current.server.online ? `Online · ${current.server.stats.objects} files` : 'Offline';
    status.title = current.server.online ? '' : current.server.error || 'Not configured';

    activity(current.job);
    if (current.job && current.job.status !== 'running' && lastFinished !== current.job.id) {
      lastFinished = current.job.id;
      toast(current.job.status === 'done' ? 'Done' : current.job.status === 'canceled' ? 'Canceled' : current.job.error);
      backups();
    }
  } catch (error) {
    toast(error.message);
  }
}

function activity(job) {
  const element = $('#activity');
  if (!job) {
    element.className = 'empty';
    element.textContent = 'Idle';
    return;
  }

  const progress = job.progress || {};
  const metrics = [];
  for (const [key, label] of [
    ['scanned', 'scanned'], ['new', 'new'], ['duplicates', 'duplicates'], ['ignored', 'ignored'], ['errors', 'errors'],
    ['copied', 'copied'], ['already', 'existing'], ['checked', 'checked'], ['total', 'total'], ['bad', 'bad'],
    ['restored', 'restored'], ['skipped', 'skipped'], ['missing', 'missing'], ['conflicts', 'conflicts']
  ]) {
    if (progress[key] != null) metrics.push(`<span class="metric"><b>${esc(progress[key])}</b> ${label}</span>`);
  }
  if (progress.uploaded) metrics.push(`<span class="metric"><b>${esc(progress.uploaded)}</b> uploaded</span>`);
  if (progress.copiedSize) metrics.push(`<span class="metric"><b>${esc(progress.copiedSize)}</b> copied</span>`);

  const phase = job.status === 'running'
    ? (job.cancelRequested ? 'Canceling…' : progress.phase || 'Working…')
    : job.status === 'done' ? 'Done'
      : job.status === 'canceled' ? 'Canceled'
        : job.error;

  element.className = 'activity';
  element.innerHTML = `
    <div class="activity-top">
      <div>
        <div class="activity-title">${esc(job.label)}</div>
        <div class="activity-phase ${job.status}">${esc(phase)}</div>
      </div>
      <div class="activity-actions">
        ${job.status === 'running' ? `<button class="secondary small" data-cancel-job ${job.cancelRequested ? 'disabled' : ''}>${job.cancelRequested ? 'Canceling…' : 'Cancel'}</button>` : ''}
        <span class="badge">${esc(job.status)}</span>
      </div>
    </div>
    ${progress.current ? `<div class="drive-path">${esc(progress.current)}</div>` : ''}
    <div class="metrics">${metrics.join('')}</div>`;
}

async function backups() {
  const element = $('#backups');
  element.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const { backups: locations } = await req('/api/backups');
    element.innerHTML = locations.map((location, index) => {
      const policy = location.meta.policy?.all ? 'Everything' : (location.meta.policy?.types || []).join(', ');
      const remote = location.remote;
      const ratio = remote?.desiredBytes ? Math.min(100, (remote.protectedBytes / remote.desiredBytes) * 100) : remote ? 100 : null;
      const missing = remote ? Math.max(0, remote.desiredBytes - remote.protectedBytes) : null;
      const coverage = remote ? `
        <div class="coverage"><div class="coverage-bar"><i style="width:${ratio}%"></i></div>
        <div class="coverage-copy"><span>${bytes(remote.protectedBytes)} / ${bytes(remote.desiredBytes)}</span><b>${missing ? `${bytes(missing)} missing` : 'Complete'}</b></div></div>` :
        '<div class="coverage-copy offline-copy"><span>Offline</span><b>Local only</b></div>';
      return `
        <div class="drive">
          <div class="drive-head">
            <div>
              <div class="drive-name">${esc(location.meta.name)}</div>
              <div class="drive-path">${esc(location.path)}</div>
            </div>
            <span class="badge managed">Backup</span>
          </div>
          ${coverage}
          <div class="drive-meta">${location.local.count.toLocaleString()} files · ${bytes(location.local.bytes)} · ${bytes(location.freeBytes)} free · ${esc(policy)}</div>
          <div class="drive-actions">
            <button class="primary small" data-update="${index}">Update</button>
            <button class="secondary small" data-configure="${index}">Configure</button>
            <button class="secondary small" data-restore="${index}">Restore</button>
            <button class="secondary small" data-verify="${index}">Verify</button>
          </div>
        </div>`;
    }).join('') || '<div class="muted">No backups.</div>';

    $$('[data-update]').forEach(button => button.onclick = () => runBackup(locations[Number(button.dataset.update)].path, 'update'));
    $$('[data-verify]').forEach(button => button.onclick = () => runBackup(locations[Number(button.dataset.verify)].path, 'verify'));
    $$('[data-restore]').forEach(button => button.onclick = () => openRestoreDialog(locations[Number(button.dataset.restore)].path));
    $$('[data-configure]').forEach(button => {
      button.onclick = () => {
        const location = locations[Number(button.dataset.configure)];
        openBackupDialog(location.path, location.meta);
      };
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
  $('#initializeBackup').textContent = 'Save';
  $('#backupDialog').showModal();
}

function openRestoreDialog(path) {
  restorePath = path;
  $('#restoreBackupLabel').textContent = path;
  $('#restoreDestination').value = '';
  $('#restoreDialog').showModal();
}

$('#chooseImport').onclick = () => chooseFolder($('#importPath'));
$('#chooseBackup').onclick = () => chooseFolder($('#backupLocation'));
$('#chooseRestore').onclick = () => chooseFolder($('#restoreDestination'));
$('#refreshBackups').onclick = backups;
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

$('#startImport').onclick = async () => {
  const path = $('#importPath').value.trim();
  if (!path) return toast('Choose a folder.');
  try {
    await req('/api/import', { method: 'POST', body: JSON.stringify({ path, source: $('#sourceName').value.trim() }) });
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
    backups();
  } catch (error) {
    toast(error.message);
  }
};

$('#startRestore').onclick = async () => {
  const destination = $('#restoreDestination').value.trim();
  if (!destination) return toast('Choose a destination.');
  try {
    await req('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify({ path: restorePath, destination })
    });
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
    toast('Saved');
    state();
  } catch (error) {
    toast(error.message);
  }
};

state();
backups();
setInterval(state, 900);
