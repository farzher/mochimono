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

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

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
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function exactDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'
  });
}

function pathName(path) {
  const clean = String(path || '').replace(/[\\/]+$/, '');
  return clean.split(/[\\/]+/).filter(Boolean).at(-1) || clean;
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
  } catch (error) { toast(error.message); }
}

function toggleInline(element, button) {
  element.hidden = !element.hidden;
  button.classList.toggle('active', !element.hidden);
  if (!element.hidden) element.querySelector('input')?.focus();
}

function folderRow(folder) {
  return `<article class="storage-item folder-item" data-folder-path="${esc(folder.path)}">
    <div class="storage-copy">
      <div class="storage-title"><strong title="${esc(folder.path)}">${esc(folder.path)}</strong><time class="item-state" data-folder-status>—</time></div>
      <div class="storage-meta"><span data-folder-files>— files</span><span>·</span><span data-folder-size>—</span><span>·</span><span data-folder-free>— free</span></div>
      <div class="storage-meter"><i data-folder-meter></i></div>
      <div class="item-progress" data-item-progress hidden></div>
    </div>
    <div class="item-actions"><button class="action-link" data-sync-folder="${esc(folder.path)}">Sync</button><button class="icon tiny" data-remove-folder="${esc(folder.path)}" aria-label="Stop syncing" title="Stop syncing">×</button></div>
  </article>`;
}

function progressData(job) {
  if (!job || job.status !== 'running') return null;
  const p = job.progress || {};
  const totalBytes = Number(p.totalBytes) || 0;
  const doneBytes = Math.min(totalBytes, Number(p.doneBytes) || 0);
  const percent = totalBytes ? Math.max(0, Math.min(100, doneBytes / totalBytes * 100)) : 0;
  const meta = [];
  if (totalBytes) meta.push(`${bytes(doneBytes)} / ${bytes(totalBytes)}`);
  else if (p.scanned != null) meta.push(`${Number(p.scanned).toLocaleString()} files`);
  else if (p.total != null) meta.push(`${Number(p.checked || 0).toLocaleString()} / ${Number(p.total).toLocaleString()}`);
  if (p.copied != null) meta.push(`${Number(p.copied).toLocaleString()} copied`);
  if (p.restored != null) meta.push(`${Number(p.restored).toLocaleString()} restored`);
  if (p.already != null) meta.push(`${Number(p.already).toLocaleString()} already in Mochimono`);
  if (p.ignored) meta.push(`${Number(p.ignored).toLocaleString()} ignored`);
  if (p.speedBps > 0) meta.push(`${bytes(p.speedBps)}/s`);
  if (p.etaSeconds > 0) meta.push(`${duration(p.etaSeconds)} left`);
  const phase = job.cancelRequested ? 'Canceling…' : p.phase || 'Working…';
  return {
    key: JSON.stringify([phase, meta, p.current || '', percent, Boolean(p.indeterminate), job.cancelRequested]),
    html: `<div class="inline-progress-head"><strong>${esc(phase)}</strong><button class="action-link" data-cancel-job ${job.cancelRequested ? 'disabled' : ''}>Cancel</button></div>
      <div class="progress-bar ${p.indeterminate || !totalBytes ? 'indeterminate' : ''}"><i style="width:${p.indeterminate || !totalBytes ? '32%' : `${percent}%`}"></i></div>
      <div class="inline-progress-meta"><span>${esc(meta.join(' · '))}</span><span title="${esc(p.current || '')}">${esc(p.current || '')}</span></div>`
  };
}

function renderItemProgress(row, job) {
  const container = row?.querySelector('[data-item-progress]');
  if (!container) return;
  const data = progressData(job);
  if (!data) {
    container.hidden = true;
    container.replaceChildren();
    delete container.dataset.key;
    return;
  }
  container.hidden = false;
  if (container.dataset.key !== data.key) {
    container.dataset.key = data.key;
    container.innerHTML = data.html;
  }
}

function folderJob(folder, job) {
  return job?.type === 'sync' && job.status === 'running' && job.label === `Sync ${pathName(folder.path) || folder.path}` ? job : null;
}

function backupJob(location, job) {
  if (!job || job.status !== 'running') return null;
  const labels = [`Update ${location.path}`, `Verify ${location.path}`, `Restore ${location.path}`];
  return labels.includes(job.label) ? job : null;
}

function renderFolders(folders, job) {
  const key = JSON.stringify(folders.map(folder => [folder.path, folder.importId, folder.lastSynced]));
  if (key !== foldersRenderKey) {
    foldersRenderKey = key;
    $('#folders').innerHTML = folders.length ? folders.map(folderRow).join('') : '<div class="empty-state">No protected folders</div>';
  }
  for (const row of $('#folders').querySelectorAll('[data-folder-path]')) {
    const folder = folders.find(item => samePath(item.path, row.dataset.folderPath));
    if (!folder) continue;
    row.querySelector('[data-folder-status]').textContent = exactDate(folder.lastSynced) || 'Not synced yet';
    renderItemProgress(row, folderJob(folder, job));
  }
}

async function refreshFolderStats() {
  try {
    const folders = (await req('/api/folder-stats')).folders || [];
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
  const active = Number(previews.active) || 0;
  const queued = (Number(previews.urgent) || 0) + (Number(previews.priority) || 0) + (Number(previews.queued) || 0);
  if (job?.status === 'running' || (!active && !queued)) return void (activityCard.hidden = true);
  activityCard.hidden = false;
  const key = `${active}:${queued}`;
  if ($('#activity').dataset.key === key) return;
  $('#activity').dataset.key = key;
  $('#activity').innerHTML = `<span><strong>Previews</strong>${active ? ` · ${active} working` : ''}${queued ? ` · ${queued.toLocaleString()} queued` : ''}</span><div class="progress-bar indeterminate"><i style="width:32%"></i></div>`;
}

async function refreshLibrary() {
  const frame = $('#filesFrame')?.contentWindow;
  try {
    await frame?.mochimonoLibrary?.refresh?.();
    await frame?.mochimonoLocations?.refresh?.();
  } catch { if (frame) frame.location.reload(); }
}

async function state() {
  try {
    const current = await req('/api/state');
    currentJob = current.job;
    if (!connectionDialog.open) $('#serverUrl').value = current.settings.server;
    defaultDevice = current.settings.device || defaultDevice;
    $('#deviceLabel').textContent = defaultDevice;
    renderFolders(current.settings.folders || [], current.job);
    renderBackupProgress(current.job);
    backgroundActivity(current.job, current.previews);

    if (current.job && current.job.status !== 'running' && lastFinished !== current.job.id) {
      lastFinished = current.job.id;
      const success = current.job.status === 'done';
      toast(success ? (current.job.type === 'sync' ? 'Synced' : current.job.type === 'restore' ? 'Restored' : 'Done') : current.job.status === 'canceled' ? 'Canceled' : current.job.error);
      if (success && ['sync', 'backup', 'verify', 'restore'].includes(current.job.type)) refreshLibrary();
      backups(true);
      refreshFolderStats();
    }
    if (Date.now() - lastBackupRefresh > 12_000) backups();
    return current;
  } catch (error) { toast(error.message); return null; }
}

function backupScope(location) {
  const policy = location.meta?.policy || location.remote?.policy || {};
  if (policy.all !== false) return 'Everything';
  return `${policy.collectionName ? '✦ ' : ''}${policy.collectionName || `Collection ${policy.collectionId || ''}`.trim()}`;
}

function backupState(location) {
  const count = Number(location.local?.count) || 0;
  const remote = location.remote;
  if (remote?.policy?.missing) return { label: 'Scope removed', className: 'warning' };
  if (!remote) return { label: count ? 'Stored locally' : 'Server unavailable', className: count ? 'good' : '' };
  const missing = Math.max(0, Number(remote.desiredBytes) - Number(remote.protectedBytes));
  if (missing) return { label: `${bytes(missing)} left`, className: 'warning' };
  return { label: exactDate(location.meta?.lastBackupAt || location.local?.oldestVerification) || (count ? 'Stored' : 'Empty'), className: count ? 'good' : '' };
}

function backupCard(location, index) {
  const remote = location.remote;
  const localCount = Number(location.local?.count) || 0;
  const localBytes = Number(location.local?.bytes) || 0;
  const desiredBytes = Number(remote?.desiredBytes) || 0;
  const protectedBytes = Number(remote?.protectedBytes) || 0;
  const scopeMissing = Boolean(remote?.policy?.missing);
  const ratio = desiredBytes ? Math.min(100, protectedBytes / desiredBytes * 100) : 0;
  const state = backupState(location);
  const meterTitle = scopeMissing
    ? `${bytes(localBytes)} stored in this backup`
    : remote ? `${bytes(protectedBytes)} of ${bytes(desiredBytes)} backed up` : `${bytes(localBytes)} stored in this backup`;
  const meterWidth = !scopeMissing && remote && protectedBytes ? `max(2px, ${ratio}%)` : localBytes ? '100%' : '0';

  return `<article class="storage-item backup-item" data-backup-index="${index}">
    <div class="storage-copy">
      <div class="storage-title"><strong>${esc(location.meta?.name || pathName(location.path))}</strong><time class="item-state ${state.className}">${esc(state.label)}</time></div>
      <div class="storage-path" title="${esc(location.path)}">${esc(location.path)}</div>
      <div class="storage-meta"><span>${esc(backupScope(location))}</span><span>·</span><span>${localCount.toLocaleString()} files</span><span>·</span><span>${bytes(localBytes)}</span><span>·</span><span>${bytes(location.freeBytes)} free</span></div>
      <div class="storage-meter backup-meter" title="${esc(meterTitle)}"><i style="width:${meterWidth}"></i></div>
      <div class="item-progress" data-item-progress hidden></div>
    </div>
    <div class="item-actions backup-actions">
      <button class="action-link primary-action" data-update="${index}" ${scopeMissing ? 'disabled title="Choose a current scope first"' : ''}>Update</button>
      <button class="action-link" data-restore="${index}" ${localCount ? '' : 'disabled'}>Restore</button>
      <button class="action-link" data-verify="${index}" ${localCount ? '' : 'disabled'}>Verify</button>
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
    backupLocations = (await req('/api/backups')).backups || [];
    lastBackupRefresh = Date.now();
    const key = JSON.stringify(backupLocations.map(location => [
      location.path, location.meta?.name, location.meta?.policy, location.meta?.lastBackupAt,
      location.meta?.lastVerifiedAt, location.local, location.freeBytes, location.remote
    ]));
    if (key !== backupsRenderKey) {
      backupsRenderKey = key;
      $('#backups').innerHTML = backupLocations.length ? backupLocations.map(backupCard).join('') : '<div class="empty-state">No backups</div>';
      wireBackupActions();
    }
    renderBackupProgress(currentJob);
  } catch (error) { $('#backups').innerHTML = `<div class="error">${esc(error.message)}</div>`; }
  finally { backupLoading = false; }
}

async function loadSmartCollections() {
  try { smartCollections = (await req('/api/backup-collections')).collections || []; }
  catch { smartCollections = []; }
}

function renderBackupScopes(meta = null) {
  const select = $('#backupScope');
  const current = meta?.policy?.all === false ? Number(meta.policy.collectionId) || 0 : 0;
  const options = ['<option value="">Everything</option>'];
  if (smartCollections.length) options.push(`<optgroup label="Smart Collections">${smartCollections.map(item => `<option value="${Number(item.id)}">✦ ${esc(item.name)}</option>`).join('')}</optgroup>`);
  if (current && !smartCollections.some(item => Number(item.id) === current)) options.push(`<option value="${current}" disabled>✦ ${esc(meta.policy.collectionName || `Collection ${current}`)} (removed)</option>`);
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

async function openRestoreDialog(path) {
  restorePath = path;
  $('#restoreBackupLabel').textContent = path;
  $('#restoreSummary').textContent = 'Loading…';
  $('#restoreSources').replaceChildren();
  $('#restoreFiles').replaceChildren();
  $('#startRestore').disabled = true;
  restoreDialog.showModal();
  try {
    const backup = await req(`/api/backup/contents?path=${encodeURIComponent(path)}`);
    if (restorePath !== path || !restoreDialog.open) return;
    $('#restoreSummary').innerHTML = `<strong>${Number(backup.count).toLocaleString()} files</strong><span>${bytes(backup.bytes)}</span>`;
    $('#restoreSources').innerHTML = (backup.sources || []).map(source => `<span>${esc(source.sourceName)} · ${Number(source.files).toLocaleString()}</span>`).join('');
    $('#restoreFiles').innerHTML = (backup.sample || []).map(file => `<div class="restore-file"><strong>${esc(file.filename)}</strong><span>${esc(file.sourceName)} · ${esc(file.path)}</span></div>`).join('');
    $('#startRestore').disabled = !Number(backup.count);
  } catch (error) {
    $('#restoreSummary').innerHTML = `<span class="error">${esc(error.message)}</span>`;
  }
}

async function runBackup(path, action) {
  try { await req(`/api/backup/${action}`, { method: 'POST', body: JSON.stringify({ path }) }); state(); }
  catch (error) { toast(error.message); }
}

$('#deviceButton').onclick = () => { $('#deviceName').value = defaultDevice; deviceDialog.showModal(); };
$('#showFolderAdd').onclick = () => toggleInline($('#folderAdd'), $('#showFolderAdd'));
$('#showBackupAdd').onclick = () => toggleInline($('#backupAdd'), $('#showBackupAdd'));
$('#chooseImport').onclick = () => chooseFolder($('#importPath'));
$('#chooseBackup').onclick = () => chooseFolder($('#backupLocation'));
$('#refreshBackups').onclick = () => backups(true);
$$('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());

document.addEventListener('click', async event => {
  if (!event.target.closest('[data-cancel-job]')) return;
  try { await req('/api/job/cancel', { method: 'POST' }); state(); }
  catch (error) { toast(error.message); }
});

$('#folders').addEventListener('click', async event => {
  const sync = event.target.closest('[data-sync-folder]');
  const remove = event.target.closest('[data-remove-folder]');
  try {
    if (sync) await req('/api/folders/sync', { method: 'POST', body: JSON.stringify({ path: sync.dataset.syncFolder }) });
    if (remove) await req('/api/folders/remove', { method: 'POST', body: JSON.stringify({ path: remove.dataset.removeFolder }) });
    await state();
    refreshFolderStats();
  } catch (error) { toast(error.message); }
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
  } catch (error) { toast(error.message); }
};

$('#saveDevice').onclick = async () => {
  const device = $('#deviceName').value.trim();
  if (!device) return;
  try { await req('/api/settings', { method: 'POST', body: JSON.stringify({ device }) }); deviceDialog.close(); state(); }
  catch (error) { toast(error.message); }
};

$('#addBackup').onclick = async () => {
  const path = $('#backupLocation').value.trim();
  if (!path) return toast('Choose a folder.');
  let meta = backupLocations.find(item => samePath(item.path, path))?.meta || null;
  if (!meta) { try { meta = (await req(`/api/backup/status?path=${encodeURIComponent(path)}`)).meta; } catch {} }
  openBackupDialog(path, meta);
};

$('#initializeBackup').onclick = async () => {
  const collectionId = Number($('#backupScope').value) || 0;
  const collection = smartCollections.find(item => Number(item.id) === collectionId);
  if (collectionId && !collection) return toast('Choose a current backup scope.');
  const path = backupPath;
  try {
    const result = await req('/api/backup/init', {
      method: 'POST',
      body: JSON.stringify({ path, name: $('#backupName').value.trim(), types: [], configure: backupEditing })
    });
    await req('/api/backup/policy', {
      method: 'POST',
      body: JSON.stringify({ path, collectionId: collectionId || null, collectionName: collection?.name || '' })
    });
    backupDialog.close();
    $('#backupLocation').value = '';
    $('#backupAdd').hidden = true;
    $('#showBackupAdd').classList.remove('active');
    backupsRenderKey = '';
    await backups(true);
    if (!backupEditing && !result.existing) await runBackup(path, 'update');
    else toast(backupEditing ? 'Saved' : 'Added');
  } catch (error) { toast(error.message); }
};

$('#startRestore').onclick = async () => {
  if (!restorePath) return;
  $('#startRestore').disabled = true;
  try {
    await req('/api/backup/restore', { method: 'POST', body: JSON.stringify({ path: restorePath, destination: 'Mochimono' }) });
    restoreDialog.close();
    state();
  } catch (error) {
    $('#startRestore').disabled = false;
    toast(error.message);
  }
};

state();
refreshFolderStats();
backups(true);
setInterval(state, 2000);
setInterval(refreshFolderStats, 5000);