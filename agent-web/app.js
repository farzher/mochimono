const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let backupPath;
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
  element.timer = setTimeout(() => element.classList.remove('show'), 2500);
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
    status.textContent = current.server.online
      ? `Server online · ${current.server.stats.objects} objects`
      : `Server offline · ${current.server.error || 'not configured'}`;

    activity(current.job);
    if (current.job && current.job.status !== 'running' && lastFinished !== current.job.id) {
      lastFinished = current.job.id;
      toast(current.job.status === 'done' ? 'Operation complete' : current.job.error);
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
    element.textContent = 'Nothing running.';
    return;
  }

  const progress = job.progress || {};
  const metrics = [];
  for (const [key, label] of [
    ['scanned', 'scanned'], ['new', 'new'], ['duplicates', 'duplicates'], ['ignored', 'ignored'],
    ['copied', 'copied'], ['already', 'already there'], ['checked', 'checked'], ['total', 'total'], ['bad', 'bad']
  ]) {
    if (progress[key] != null) metrics.push(`<span class="metric"><b>${esc(progress[key])}</b> ${label}</span>`);
  }
  if (progress.uploaded) metrics.push(`<span class="metric"><b>${esc(progress.uploaded)}</b> uploaded</span>`);
  if (progress.copiedSize) metrics.push(`<span class="metric"><b>${esc(progress.copiedSize)}</b> copied</span>`);

  element.className = 'activity';
  element.innerHTML = `
    <div class="activity-top">
      <div>
        <div class="activity-title">${esc(job.label)}</div>
        <div class="activity-phase ${job.status}">${esc(job.status === 'running' ? progress.phase || 'Working…' : job.status === 'done' ? 'Done' : job.error)}</div>
      </div>
      <span class="badge">${job.status}</span>
    </div>
    ${progress.current ? `<div class="drive-path">${esc(progress.current)}</div>` : ''}
    <div class="metrics">${metrics.join('')}</div>`;
}

async function backups() {
  const element = $('#backups');
  element.innerHTML = '<div class="muted">Looking for backups…</div>';
  try {
    const { backups: locations } = await req('/api/backups');
    element.innerHTML = locations.map((location, index) => `
      <div class="drive">
        <div class="drive-head">
          <div>
            <div class="drive-name">${esc(location.meta.name)}</div>
            <div class="drive-path">${esc(location.path)}</div>
          </div>
          <span class="badge managed">Mochimono backup</span>
        </div>
        <div class="drive-meta">${bytes(location.freeBytes)} free of ${bytes(location.totalBytes)}</div>
        <div class="drive-actions">
          <button class="primary small" data-update="${index}">Update</button>
          <button class="secondary small" data-status="${index}">Status</button>
          <button class="secondary small" data-verify="${index}">Verify</button>
        </div>
      </div>`).join('') || '<div class="muted">No backup locations yet. Choose any folder above to create one.</div>';

    $$('[data-update]').forEach(button => button.onclick = () => runBackup(locations[Number(button.dataset.update)].path, 'update'));
    $$('[data-verify]').forEach(button => button.onclick = () => runBackup(locations[Number(button.dataset.verify)].path, 'verify'));
    $$('[data-status]').forEach(button => button.onclick = async () => {
      try {
        const location = locations[Number(button.dataset.status)];
        const status = await req(`/api/backup/status?path=${encodeURIComponent(location.path)}`);
        toast(`${status.meta.name}: ${status.remote.protectedCount}/${status.remote.desiredCount} protected`);
      } catch (error) {
        toast(error.message);
      }
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

function openBackupDialog(path) {
  backupPath = path;
  $('#backupPathLabel').textContent = path;
  $('#backupName').value = '';
  $('#backupEverything').checked = true;
  $('#backupTypes').classList.add('disabled');
  $$('#backupTypes input').forEach(input => { input.checked = false; });
  $('#backupDialog').showModal();
}

$('#chooseImport').onclick = () => chooseFolder($('#importPath'));
$('#chooseBackup').onclick = () => chooseFolder($('#backupLocation'));
$('#refreshBackups').onclick = backups;
$$('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
$('#backupEverything').onchange = event => $('#backupTypes').classList.toggle('disabled', event.target.checked);

$('#startImport').onclick = async () => {
  const path = $('#importPath').value.trim();
  if (!path) return toast('Paste a path or choose a folder first');
  try {
    await req('/api/import', { method: 'POST', body: JSON.stringify({ path, source: $('#sourceName').value.trim() }) });
    state();
  } catch (error) {
    toast(error.message);
  }
};

$('#addBackup').onclick = () => {
  const path = $('#backupLocation').value.trim();
  if (!path) return toast('Paste a path or choose a backup folder first');
  openBackupDialog(path);
};

$('#initializeBackup').onclick = async () => {
  const types = $('#backupEverything').checked ? [] : $$('#backupTypes input:checked').map(input => input.value);
  try {
    const result = await req('/api/backup/init', {
      method: 'POST',
      body: JSON.stringify({ path: backupPath, name: $('#backupName').value.trim(), types })
    });
    $('#backupDialog').close();
    $('#backupLocation').value = '';
    toast(result.existing ? 'Existing backup added' : 'Backup folder initialized');
    backups();
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
    toast('Settings saved');
    state();
  } catch (error) {
    toast(error.message);
  }
};

state();
backups();
setInterval(state, 900);