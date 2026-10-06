import './thumbnail-failures.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const activityCard = $('#activityCard');
const connectionDialog = $('#connectionDialog');
const deviceDialog = $('#deviceDialog');
const backupDialog = $('#backupDialog');
const restoreDialog = $('#restoreDialog');
const VERIFY_STALE_MS = 180 * 24 * 60 * 60 * 1000;
const ACTIVE_STATE_POLL_MS = 1_000;
const IDLE_STATE_POLL_MS = 30_000;

let backupPath = '';
let backupEditing = false;
let restorePath = '';
let lastFinished = '';
let defaultDevice = '';
let uploadWorkers = 2;
let foldersRenderKey = '';
let backupsRenderKey = '';
let backupLocations = [];
let backupLoading = false;
let lastBackupRefresh = 0;
let currentJob = null;
let protectionSummary = null;
const folderActivity = new Map();
const folderActivities = new Map();
const folderStatsByPath = new Map();
let stateTimer = null;
let statePolling = false;

const progressStyle = document.createElement('style');
progressStyle.textContent = `
  .source-task-progress + .source-task-progress{margin-top:10px;padding-top:9px;border-top:1px solid #262326}
  .source-task-progress .inline-progress-meta span:only-child{max-width:100%;text-align:left;white-space:normal;line-height:1.5}
`;
document.head.append(progressStyle);

async function req(path, options = {}) {
  const response = await fetch(path, { headers:{ 'content-type':'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

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
    year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit'
  });
}

function ageLabel(value) {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${Math.max(1, months)}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function setRelativeTime(node, value, fallback = '') {
  if (!node) return;
  if (!value || !ageLabel(value)) {
    delete node.dataset.relativeTime;
    delete node.dataset.relativePrefix;
    delete node.dataset.relativeSuffix;
    node.removeAttribute('datetime');
    node.removeAttribute('title');
    if (node.textContent !== fallback) node.textContent = fallback;
    return;
  }
  node.dataset.relativeTime = String(value);
  node.dateTime = String(value);
  node.title = exactDate(value);
  const text = ageLabel(value);
  if (node.textContent !== text) node.textContent = text;
}

function refreshRelativeTimes() {
  if (document.hidden) return;
  for (const node of document.querySelectorAll('[data-relative-time]')) {
    const text = ageLabel(node.dataset.relativeTime);
    if (!text) continue;
    const next = `${node.dataset.relativePrefix || ''}${text}${node.dataset.relativeSuffix || ''}`;
    if (node.textContent !== next) node.textContent = next;
  }
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
  return `<article class="storage-item folder-item" data-folder-path="${esc(folder.path)}" data-folder-protected="${folder.protected!==false?'1':'0'}">
    <div class="storage-copy">
      <div class="storage-title"><strong title="${esc(folder.path)}">${esc(folder.path)}</strong><time class="item-state" data-folder-status>—</time></div>
      <div class="storage-meta"><span data-folder-files>— indexed files</span><span>·</span><span data-folder-size>—</span><span>·</span><span data-folder-free>— free</span></div>
      <div class="storage-meter"><i data-folder-meter></i></div>
      <div class="item-progress" data-item-progress hidden></div>
      <button class="action-link" data-preview-failures="${esc(folder.path)}" hidden></button>
    </div>
    <div class="item-actions"><button class="action-link" data-sync-folder="${esc(folder.path)}">Sync</button><button class="icon tiny" data-remove-folder="${esc(folder.path)}" aria-label="Stop syncing" title="Stop syncing">×</button></div>
  </article>`;
}

function jobOperation(job) {
  const label = String(job?.label || '');
  if (job?.type === 'hash' || job?.kind === 'Hash' || /^Hash\b/i.test(label)) return 'Hash';
  if (job?.type === 'thumbnail' || job?.kind === 'Thumbnail') return 'Thumbnails';
  if (job?.kind === 'Index') return 'Index';
  if (job?.type === 'sync') return /^(?:Check|Update) /.test(label) || /^(?:Finding files|Checking files|Finalizing index)$/.test(job.progress?.phase || '') ? 'Index' : 'Sync';
  if (job?.type === 'verify') return 'Verify';
  if (job?.type === 'restore') return 'Restore';
  return '';
}

function progressData(job) {
  if (!job || !['running','queued','blocked'].includes(job.status)) return null;
  const p = job.progress || {};
  const totalBytes = Number(p.totalBytes) || 0;
  const doneBytes = Math.min(totalBytes, Number(p.doneBytes) || Number(p.copiedBytes) || 0);
  const total = Number(p.total) || 0;
  const checked = Math.min(total || Infinity, Number(p.checked ?? (job.type === 'hash' ? p.hashed : p.scanned) ?? p.hashed ?? p.processed) || 0);
  const directPercent = job.percent == null ? null : Math.max(0, Math.min(100, Number(job.percent) || 0));
  const percent = totalBytes
    ? Math.max(0, Math.min(100, doneBytes / totalBytes * 100))
    : total
      ? Math.max(0, Math.min(100, checked / total * 100))
      : directPercent;
  const indeterminate = Boolean(p.indeterminate) || percent == null;
  const operation = jobOperation(job);
  const meta = [];
  if (totalBytes) meta.push(`${bytes(doneBytes)} / ${bytes(totalBytes)}`);
  else if (total) {
    const unit = operation === 'Thumbnails' && p.unit ? String(p.unit) : 'files';
    meta.push(`${checked.toLocaleString()} / ${total.toLocaleString()} ${unit}`);
  } else if (p.scanned != null) {
    const unit = p.phase === 'Checking files' ? 'checked' : 'found';
    meta.push(`${Number(p.scanned).toLocaleString()} ${unit}`);
    if (p.reused > 0) meta.push(`${Number(p.reused).toLocaleString()} unchanged`);
    if (p.added > 0) meta.push(`${Number(p.added).toLocaleString()} new or changed`);
  } else if (job.remaining != null) meta.push(`${Number(job.remaining).toLocaleString()} hashes remaining`);
  else if (job.detail) {
    const phase = p.phase || job.phase;
    meta.push(phase ? String(job.detail).replace(`${phase} · `, '') : String(job.detail));
  }
  if (p.copied != null) meta.push(`${Number(p.copied).toLocaleString()} copied`);
  if (p.restored != null) meta.push(`${Number(p.restored).toLocaleString()} restored`);
  if (p.repaired) meta.push(`${Number(p.repaired).toLocaleString()} backup repaired`);
  if (p.primaryRepaired) meta.push(`${Number(p.primaryRepaired).toLocaleString()} Mochimono repaired`);
  if (p.catalogRepaired) meta.push('backup catalog repaired');
  if (p.catalogHealthy === false) meta.push('backup catalog damaged');
  if (p.bad) meta.push(`${Number(p.bad).toLocaleString()} still damaged`);
  if (p.speedBps > 0) meta.push(`${bytes(p.speedBps)}/s`);
  const staleScan = p.scanned != null && p.updatedAt && Date.now() - p.updatedAt > 5000 && job.status === 'running';
  if (staleScan) meta.push(`Last scan update ${duration((Date.now() - p.updatedAt) / 1000)} ago`);
  else if (p.filesPerSecond > 0) meta.push(`${Number(p.filesPerSecond).toLocaleString()} files/s`);
  if (p.elapsedSeconds > 0) meta.push(duration(p.elapsedSeconds));
  if (p.etaSeconds > 0) meta.push(`${duration(p.etaSeconds)} left`);
  const phase = job.cancelRequested ? 'Canceling…' : p.phase || job.phase || (job.status === 'blocked' ? 'Paused' : job.status === 'queued' ? 'Waiting' : 'Working…');
  const title = operation ? `${operation} · ${phase}` : phase;
  const cancel = job.cancelable === false || job.status !== 'running' ? '' : `<button class="action-link" data-cancel-job ${job.cancelRequested ? 'disabled' : ''}>Cancel</button>`;
  const side = cancel || (!indeterminate ? `<span class="inline-progress-percent">${Math.floor(percent)}%</span>` : '');
  return {
    key:JSON.stringify([title, meta, p.current || '', percent, indeterminate, job.cancelRequested, job.cancelable, job.status]),
    title, side, meta:meta.join(' · '), current:p.current || '', percent, indeterminate,
    running:job.status === 'running'
  };
}

function renderItemProgress(row, job, container = row?.querySelector('[data-item-progress]')) {
  if (!container) return;
  const data = progressData(job);
  if (!data) {
    container.hidden = true;
    container.replaceChildren();
    delete container.dataset.key;
    return;
  }
  container.hidden = false;
  if (container.dataset.key === data.key) return;
  container.dataset.key = data.key;
  if (!container.querySelector('.inline-progress-head')) container.innerHTML = '<div class="inline-progress-head"><strong></strong><span data-progress-side></span></div><div class="progress-bar"><i></i></div><div class="inline-progress-meta"><span></span></div><span class="inline-progress-current"></span>';
  container.querySelector('.inline-progress-head strong').textContent = data.title;
  const side = container.querySelector('[data-progress-side]');
  if (side.dataset.html !== data.side) { side.innerHTML = data.side; side.dataset.html = data.side; }
  const bar = container.querySelector('.progress-bar');
  bar.hidden = !data.running && data.indeterminate;
  bar.classList.toggle('indeterminate', data.running && data.indeterminate);
  bar.querySelector('i').style.width = data.indeterminate ? '32%' : `${Math.max(1,data.percent)}%`;
  container.querySelector('.inline-progress-meta span').textContent = data.meta;
  const current = container.querySelector('.inline-progress-current');
  current.hidden = !data.current;
  current.textContent = current.title = data.current;
}

function renderFolderProgress(row, job) {
  const container = row.querySelector('[data-item-progress]');
  if (!container) return;
  const key = String(row.dataset.folderPath || '').replace(/[\\/]+$/, '').toLowerCase();
  const items = [...(folderActivities.get(key) || [])];
  if (job && !items.some(item => jobOperation(item) === jobOperation(job))) items.unshift(job);
  const tasks = new Map(items.map(item => [jobOperation(item), item]));
  if (!tasks.size) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.hidden = false;
  const existing = new Map([...container.children].map(node => [node.dataset.sourceTask, node]));
  let previous = null;
  for (const [kind, item] of tasks) {
    let node = existing.get(kind);
    if (!node) {
      node = document.createElement('div');
      node.className = 'source-task-progress';
      node.dataset.sourceTask = kind;
    }
    existing.delete(kind);
    const at = previous ? previous.nextElementSibling : container.firstElementChild;
    if (at !== node) container.insertBefore(node, at);
    renderItemProgress(row, item, node);
    previous = node;
  }
  for (const node of existing.values()) node.remove();
}

function sourceStatus(row, folder) {
  if (folder?.protected !== false) return;
  const activity = folderActivity.get(String(folder.path || '').replace(/[\\/]+$/, '').toLowerCase());
  const status = row.querySelector('[data-folder-status]');
  const offline = folder.available === false;
  const indexing = folder.pending || (folder.diagnostics?.running && !folder.hashing) || ['Index','Sync'].includes(activity?.kind);
  const previews = folder.previewWarming || folder.previewQueueActive || folder.previewQueueBackground;
  const hashing = folder.hashing || folder.hashPending > 0;
  const failures = row.querySelector('[data-preview-failures]');
  const count = (Number(folder.previewFailed) || 0) + (Number(folder.previewDeferred) || 0);
  if (failures) {
    failures.hidden = !count;
    failures.textContent = `${count.toLocaleString()} thumbnail ${folder.previewWarming ? 'failures' : 'unavailable'}`;
  }
  status.textContent = offline ? 'Offline' : indexing ? (folder.progress?.phase === 'Checking files' ? 'Checking files' : 'Finding files') : previews ? 'Preparing thumbnails' : hashing ? (folder.hashing ? 'Hashing content' : 'Hashes pending') : folder.lastIndexed ? (folder.files ? 'Ready' : 'Empty') : 'Checking…';
  status.className = `item-state ${offline ? 'warning' : indexing || previews || hashing || !folder.lastIndexed ? 'working' : 'good'}`;
  status.title = offline ? 'Source unavailable' : previews ? 'Thumbnail work is unfinished' : hashing ? folder.hashWaitReason || 'Content hashes are unfinished' : folder.lastIndexed ? `Last indexed ${new Date(folder.lastIndexed).toLocaleString()}` : '';
}

function folderJob(folder, job) {
  if (!job || !['sync','hash'].includes(job.type) || job.status !== 'running') return null;
  if (job.progress?.path && samePath(job.progress.path, folder.path)) return job;
  const name = pathName(folder.path) || folder.path;
  return [`Sync ${name}`, `Check ${name}`, `Update ${name}`, `Hash ${name}`].includes(job.label) ? job : null;
}

function backupJob(location, job) {
  if (!job || job.status !== 'running') return null;
  return [`Verify ${location.path}`, `Restore ${location.path}`].includes(job.label) ? job : null;
}

function renderFolders(folders, job) {
  const key = JSON.stringify(folders.map(folder => [folder.path, folder.importId, folder.protected !== false]));
  if (key !== foldersRenderKey) {
    foldersRenderKey = key;
    $('#folders').innerHTML = folders.length ? folders.map(folderRow).join('') : '<div class="empty-state">No folders</div>';
  }
  for (const row of $('#folders').querySelectorAll('[data-folder-path]')) {
    const folder = folders.find(item => samePath(item.path, row.dataset.folderPath));
    if (!folder) continue;
    if(folder.protected===false){
      sourceStatus(row, folderStatsByPath.get(String(folder.path || '').replace(/[\\/]+$/, '').toLowerCase()) || folder);
    }
    else{
      const status=row.querySelector('[data-folder-status]');
      status.textContent='Checking backup…';
      status.className='item-state';
    }
    renderFolderProgress(row, folderJob(folder, job));
  }
  renderFolderProtection(protectionSummary);
}

function renderFolderProtection(summary) {
  protectionSummary=summary||protectionSummary;
  if(!protectionSummary)return;
  const sources=Array.isArray(protectionSummary.sources)?protectionSummary.sources:[];
  for(const row of $('#folders').querySelectorAll('[data-folder-path][data-folder-protected="1"]')){
    const source=sources.find(item=>samePath(item.rootPath,row.dataset.folderPath));
    const status=row.querySelector('[data-folder-status]');
    if(!status)continue;
    status.className='item-state';
    if(!source){
      status.textContent='Preparing…';
      status.classList.add('working');
      continue;
    }
    const files=Number(source.files)||0;
    const protectedFiles=Number(source.protectedFiles)||0;
    const preparing=Number(source.preparingFiles)||0;
    const needs=Number(source.needsProtection)||0;
    const remaining=Math.max(0,files-protectedFiles);
    if(!files){
      status.textContent='No files';
    }else if(preparing||Number(source.pendingFiles)||folderActivity.get(String(row.dataset.folderPath||'').replace(/[\\/]+$/,'').toLowerCase())){
      status.textContent='Backing up';
      status.classList.add('working');
    }else if(needs||remaining){
      status.textContent='Needs backup';
      status.classList.add('warning');
    }else{
      status.textContent='Protected';
      status.classList.add('good');
    }
    status.title=`${protectedFiles.toLocaleString()} of ${files.toLocaleString()} protected`;
  }
}

async function refreshFolderStats() {
  if ($('#storagePane')?.hidden) return;
  try {
    const folders = (await req('/api/folder-stats')).folders || [];
    for (const item of folders) {
      folderStatsByPath.set(String(item.path || '').replace(/[\\/]+$/, '').toLowerCase(), item);
      const row = [...$('#folders').querySelectorAll('[data-folder-path]')].find(node => samePath(node.dataset.folderPath, item.path));
      if (!row) continue;
      row.querySelector('[data-folder-files]').textContent = `${Number(item.files).toLocaleString()} indexed files`;
      row.querySelector('[data-folder-size]').textContent = bytes(item.bytes);
      row.querySelector('[data-folder-free]').textContent = `${bytes(item.freeBytes)} free`;
      if (item.protected === false) {
        sourceStatus(row, item);
      }
      const diagnosticJob = item.progress ? {
        type:item.hashing?'hash':'sync', kind:item.hashing?'Hash':'Index',
        label:`${item.hashing?'Hash':'Index'} ${pathName(item.path) || item.path}`,
        status:'running', cancelable:false, startedAt:item.startedAt, progress:item.progress
      } : null;
      renderFolderProgress(row, diagnosticJob || folderJob(item, currentJob));
      const ratio = item.capacityBytes ? Math.min(100, Number(item.bytes) / Number(item.capacityBytes) * 100) : 0;
      const meter = row.querySelector('[data-folder-meter]');
      meter.style.width = item.bytes ? `max(2px, ${ratio}%)` : '0';
      meter.parentElement.title = `${bytes(item.bytes)} of ${bytes(item.capacityBytes)}`;
    }
    renderFolderProtection(protectionSummary);
  } catch {}
}

function backgroundActivity(_job, previews = {}) {
  const active = Number(previews.active) || 0;
  const queued = (Number(previews.urgent) || 0) + (Number(previews.priority) || 0) + (Number(previews.queued) || 0);
  if (!active && !queued) return void (activityCard.hidden = true);
  activityCard.hidden = false;
  const key = `${active}:${queued}`;
  if ($('#activity').dataset.key === key) return;
  $('#activity').dataset.key = key;
  $('#activity').innerHTML = `<span><strong>Thumbnails</strong>${active ? ` · ${active} generating` : ''}${queued ? ` · ${queued.toLocaleString()} queued` : ''}</span><div class="progress-bar indeterminate"><i style="width:32%"></i></div>`;
}

async function refreshLibrary() {
  const frame = $('#filesFrame')?.contentWindow;
  try {
    await frame?.mochimonoLibrary?.refresh?.();
    await frame?.mochimonoLocations?.refresh?.();
  } catch { if (frame) frame.location.reload(); }
}

function finishedToast(job) {
  if (job.status === 'canceled') return 'Canceled';
  if (job.status !== 'done') return job.error;
  if (job.type === 'sync') return /^(?:Check|Update) /.test(String(job.label || '')) ? 'Indexed' : 'Synced';
  if (job.type === 'restore') return 'Restored';
  if (job.type === 'verify') {
    const result = job.result || {};
    const parts = ['Verified'];
    if (result.repaired) parts.push(`${Number(result.repaired).toLocaleString()} backup repaired`);
    if (result.primaryRepaired) parts.push(`${Number(result.primaryRepaired).toLocaleString()} Mochimono repaired`);
    if (result.catalogRepaired) parts.push('backup catalog repaired');
    if (result.catalogHealthy === false) parts.push('backup catalog still damaged');
    if (result.bad) parts.push(`${Number(result.bad).toLocaleString()} still damaged`);
    return parts.join(' · ');
  }
  return 'Done';
}

async function state() {
  try {
    const current = await req('/api/state');
    currentJob = current.job;
    if (!connectionDialog.open) $('#serverUrl').value = current.settings.server;
    defaultDevice = current.settings.device || defaultDevice;
    uploadWorkers = [1, 2, 4].includes(Number(current.settings.uploadWorkers)) ? Number(current.settings.uploadWorkers) : 2;
    $('#deviceLabel').textContent = defaultDevice;
    renderFolders(current.settings.folders || [], current.job);
    renderBackupProgress(current.job);
    backgroundActivity(current.job, current.previews);

    if (current.job && current.job.status !== 'running' && lastFinished !== current.job.id) {
      lastFinished = current.job.id;
      const success = current.job.status === 'done';
      toast(finishedToast(current.job));
      if (success && ['sync', 'verify', 'restore'].includes(current.job.type)) refreshLibrary();
      if (!$('#storagePane')?.hidden) {
        backups(true);
        refreshFolderStats();
      }
    }
    if (!$('#storagePane')?.hidden && Date.now() - lastBackupRefresh > 60_000) backups();
    return current;
  } catch (error) { toast(error.message); return null; }
}

function backupVerification(location) {
  const count = Number(location.local?.count) || 0;
  if (!count) return { label:'No files to verify', stale:false, catalogBad:false };
  const value = location.meta?.lastVerifiedAt || location.local?.oldestVerification || null;
  const time = value ? new Date(value).getTime() : NaN;
  const stale = !Number.isFinite(time) || Date.now() - time > VERIFY_STALE_MS;
  const bad = Number(location.meta?.lastVerifyBad) || 0;
  const repaired = Number(location.meta?.lastVerifyRepaired) || 0;
  const primaryRepaired = Number(location.meta?.lastVerifyPrimaryRepaired) || 0;
  const catalogBad = location.meta?.lastVerifyCatalogHealthy === false;
  const catalogRepaired = Boolean(location.meta?.lastVerifyCatalogRepaired);
  const extras = [
    repaired ? `${repaired} backup repaired` : '',
    primaryRepaired ? `${primaryRepaired} Mochimono repaired` : '',
    catalogRepaired ? 'catalog repaired' : '',
    catalogBad ? 'catalog damaged' : ''
  ].filter(Boolean);
  if (!value) return { label:`Never fully verified${extras.length ? ` · ${extras.join(' · ')}` : ''}`, stale:true, bad, catalogBad, value:null };
  const prefix = stale ? 'Verify recommended · last checked ' : 'Verified ';
  const suffix = extras.length ? ` · ${extras.join(' · ')}` : '';
  return { label:`${prefix}${ageLabel(value)}${suffix}`, stale, bad, catalogBad, value, prefix, suffix };
}

function backupState(location) {
  const count = Number(location.local?.count) || 0;
  const verification = backupVerification(location);
  if (verification.catalogBad) return { label:'Backup catalog damaged', className:'warning' };
  if (verification.bad) return { label:`${verification.bad.toLocaleString()} damaged`, className:'warning' };
  if (verification.stale && count) return { label:'Verify recommended', className:'warning' };
  if (!location.remote) return { label:count ? 'Stored locally' : 'Server unavailable', className:count ? 'good' : '' };
  return { label:count ? 'Stored' : 'Empty', className:count ? 'good' : '' };
}

function backupCard(location, index) {
  const localCount = Number(location.local?.count) || 0;
  const localBytes = Number(location.local?.bytes) || 0;
  const totalBytes = Number(location.totalBytes) || 0;
  const quotaBytes = Math.max(0, Number(location.meta?.quotaBytes) || 0);
  const capacityBytes = quotaBytes || totalBytes;
  const freeBytes = quotaBytes ? Math.min(Number(location.freeBytes) || 0, Math.max(0, quotaBytes - localBytes)) : Number(location.freeBytes) || 0;
  const ratio = capacityBytes ? Math.min(100, localBytes / capacityBytes * 100) : 0;
  const state = backupState(location);
  const verification = backupVerification(location);
  const verificationTitle = verification.catalogBad && location.meta?.lastVerifyCatalogError
    ? `Backup catalog problem: ${location.meta.lastVerifyCatalogError}`
    : verification.value ? `Last full SHA-256 verification: ${exactDate(verification.value)}` : 'This backup has not had a complete SHA-256 verification yet';
  const verificationTime = verification.value
    ? ` data-relative-time="${esc(verification.value)}" data-relative-prefix="${esc(verification.prefix || '')}" data-relative-suffix="${esc(verification.suffix || '')}"`
    : '';

  return `<article class="storage-item backup-item" data-backup-index="${index}">
    <div class="storage-copy">
      <div class="storage-title"><strong>${esc(location.meta?.name || pathName(location.path))}</strong><span class="item-state ${state.className}">${esc(state.label)}</span></div>
      <div class="storage-path" title="${esc(location.path)}">${esc(location.path)}</div>
      <div class="storage-meta"><span>${localCount.toLocaleString()} files</span><span>·</span><span>${bytes(localBytes)}</span><span>·</span><span>${bytes(freeBytes)} free</span><span>·</span><span title="${esc(verificationTitle)}"${verificationTime}>${esc(verification.label)}</span></div>
      <div class="storage-meter backup-meter" title="${bytes(localBytes)} stored · ${quotaBytes ? `${bytes(quotaBytes)} limit` : `${bytes(totalBytes)} drive`}"><i style="width:${localBytes ? `max(2px, ${ratio}%)` : '0'}"></i></div>
      <div class="item-progress" data-item-progress hidden></div>
    </div>
    <div class="item-actions backup-actions">
      <button class="action-link" data-restore="${index}" ${localCount ? '' : 'disabled'}>Restore</button>
      <button class="action-link ${(verification.stale || verification.catalogBad) && localCount ? 'primary-action' : ''}" data-verify="${index}" ${localCount ? `title="${verification.catalogBad ? 'Recheck and repair backup metadata' : verification.stale ? 'Full SHA-256 verification recommended' : 'Recheck every file with SHA-256'}"` : 'disabled'}>Verify</button>
      <button class="action-link" data-configure="${index}">Edit</button>
    </div>
  </article>`;
}

function wireBackupActions() {
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
  if (backupLoading || (!force && Date.now() - lastBackupRefresh < 60_000)) return;
  backupLoading = true;
  try {
    backupLocations = (await req('/api/backups')).backups || [];
    lastBackupRefresh = Date.now();
    const key = JSON.stringify(backupLocations.map(location => [
      location.path, location.meta?.name, location.meta?.lastVerifiedAt,
      location.meta?.lastVerifyBad, location.meta?.lastVerifyRepaired,
      location.meta?.lastVerifyPrimaryRepaired, location.meta?.lastVerifyCatalogHealthy,
      location.meta?.lastVerifyCatalogRepaired, location.meta?.lastVerifyCatalogError,
      location.meta?.quotaBytes, location.local, location.totalBytes, location.freeBytes, location.remote
    ]));
    if (key !== backupsRenderKey) {
      backupsRenderKey = key;
      $('#backups').innerHTML = backupLocations.length ? backupLocations.map(backupCard).join('') : '<div class="empty-state">No backups</div>';
      wireBackupActions();
    }
    renderBackupProgress(currentJob);
    refreshRelativeTimes();
  } catch (error) { $('#backups').innerHTML = `<div class="error">${esc(error.message)}</div>`; }
  finally { backupLoading = false; }
}

function openBackupDialog(path, meta = null) {
  backupPath = path;
  backupEditing = Boolean(meta);
  $('#backupPathLabel').textContent = path;
  $('#backupName').value = meta?.name || pathName(path) || '';
  $('#backupQuota').value = Number(meta?.quotaBytes) > 0 ? String(Number(meta.quotaBytes) / 1_000_000_000) : '';
  $('#removeBackup').hidden = !backupEditing;
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
  try { await req(`/api/backup/${action}`, { method:'POST', body:JSON.stringify({ path }) }); wakeState(); }
  catch (error) { toast(error.message); }
}

$('#deviceButton').onclick = () => {
  $('#deviceName').value = defaultDevice;
  $('#uploadWorkers').value = String(uploadWorkers);
  deviceDialog.showModal();
};
$('#showFolderAdd').onclick = () => toggleInline($('#folderAdd'), $('#showFolderAdd'));
$('#showBackupAdd').onclick = () => toggleInline($('#backupAdd'), $('#showBackupAdd'));
$('#chooseImport').onclick = () => chooseFolder($('#importPath'));
$('#chooseBackup').onclick = () => chooseFolder($('#backupLocation'));
$('#refreshBackups').onclick = () => backups(true);
$$('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());

document.addEventListener('click', async event => {
  if (!event.target.closest('[data-cancel-job]')) return;
  try { await req('/api/job/cancel', { method:'POST' }); wakeState(); }
  catch (error) { toast(error.message); }
});

$('#folders').addEventListener('click', async event => {
  const sync = event.target.closest('[data-sync-folder]');
  const remove = event.target.closest('[data-remove-folder]');
  try {
    if (sync) await req('/api/folders/sync', { method:'POST', body:JSON.stringify({ path:sync.dataset.syncFolder }) });
    if (remove) {
      const path=remove.dataset.removeFolder;
      const source=(protectionSummary?.sources||[]).find(item=>samePath(item.rootPath,path));
      const files=Number(source?.files)||0;
      const message=files
        ? `Stop backing up this folder?\n\n${files.toLocaleString()} files will stop being current backup items. Existing Mochimono copies are not deleted; source-less stored files will appear in Review.`
        : 'Stop backing up this folder?\n\nExisting Mochimono copies are not deleted.';
      if(!confirm(message))return;
      await req('/api/folders/remove', { method:'POST', body:JSON.stringify({ path }) });
    }
    await wakeState();
    refreshFolderStats();
  } catch (error) { toast(error.message); }
});

$('#startImport').onclick = async () => {
  const path = $('#importPath').value.trim();
  if (!path) return toast('Choose a folder.');
  try {
    await req('/api/folders', { method:'POST', body:JSON.stringify({ path }) });
    $('#importPath').value = '';
    $('#folderAdd').hidden = true;
    $('#showFolderAdd').classList.remove('active');
    await wakeState();
    refreshFolderStats();
  } catch (error) { toast(error.message); }
};

$('#saveDevice').onclick = async () => {
  const device = $('#deviceName').value.trim();
  const workers = Number($('#uploadWorkers').value);
  if (!device || ![1, 2, 4].includes(workers)) return;
  try {
    await req('/api/settings', { method:'POST', body:JSON.stringify({ device, uploadWorkers:workers }) });
    deviceDialog.close();
    wakeState();
  } catch (error) { toast(error.message); }
};

$('#addBackup').onclick = async () => {
  const path = $('#backupLocation').value.trim();
  if (!path) return toast('Choose a folder.');
  let meta = backupLocations.find(item => samePath(item.path, path))?.meta || null;
  if (!meta) { try { meta = (await req(`/api/backup/status?path=${encodeURIComponent(path)}`)).meta; } catch {} }
  openBackupDialog(path, meta);
};

$('#initializeBackup').onclick = async () => {
  const path = backupPath;
  const quotaGb = Math.max(0, Number($('#backupQuota').value) || 0);
  try {
    const result = await req('/api/backup/init', {
      method:'POST',
      body:JSON.stringify({
        path,
        name:$('#backupName').value.trim(),
        configure:backupEditing,
        quotaBytes:Math.round(quotaGb * 1_000_000_000)
      })
    });
    backupDialog.close();
    $('#backupLocation').value = '';
    $('#backupAdd').hidden = true;
    $('#showBackupAdd').classList.remove('active');
    backupsRenderKey = '';
    await backups(true);
    window.dispatchEvent(new CustomEvent('mochimono:storage-changed'));
    if (!backupEditing && !result.existing) {
      await req('/api/client/protection/run', { method:'POST', body:'{}' }).catch(() => {});
      toast('Added');
    } else toast('Saved');
  } catch (error) { toast(error.message); }
};

$('#removeBackup').onclick = async () => {
  if (!backupPath || !backupEditing) return;
  const name = $('#backupName').value.trim() || pathName(backupPath) || 'this backup';
  const button = $('#removeBackup');
  button.disabled = true;
  try {
    const backup=backupLocations.find(item=>samePath(item.path,backupPath));
    const id=String(backup?.meta?.id||'');
    const impact=id?await req(`/api/protection/locations/${encodeURIComponent(id)}/impact`).catch(()=>null):null;
    const affected=Number(impact?.newlyUnderProtected)||0;
    const copies=Number(impact?.files)||0;
    const consequence=affected
      ? `\n\n${affected.toLocaleString()} managed ${affected===1?'file will':'files will'} fall below the requested protection level.`
      : copies ? `\n\n${copies.toLocaleString()} managed ${copies===1?'file has':'files have'} a copy there, but required protection remains satisfied without it.` : '';
    if (!confirm(`Disconnect ${name}?${consequence}\n\nBackup files on the drive will be kept.`)) return;
    await req('/api/backup/disconnect', { method:'POST', body:JSON.stringify({ path:backupPath }) });
    backupDialog.close();
    backupEditing = false;
    backupsRenderKey = '';
    await backups(true);
    window.dispatchEvent(new CustomEvent('mochimono:storage-changed'));
    wakeState();
    toast('Disconnected');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
};

$('#startRestore').onclick = async () => {
  if (!restorePath) return;
  $('#startRestore').disabled = true;
  try {
    await req('/api/backup/restore', { method:'POST', body:JSON.stringify({ path:restorePath, destination:'Mochimono' }) });
    restoreDialog.close();
    wakeState();
  } catch (error) {
    $('#startRestore').disabled = false;
    toast(error.message);
  }
};

function scheduleState(delay) {
  clearTimeout(stateTimer);
  stateTimer = null;
  if (document.hidden) return;
  stateTimer = setTimeout(() => void pollState(), Math.max(0, delay));
}

async function pollState() {
  if (statePolling || document.hidden) return;
  statePolling = true;
  const current = await state();
  statePolling = false;
  scheduleState(current?.job?.status === 'running' ? ACTIVE_STATE_POLL_MS : IDLE_STATE_POLL_MS);
}

async function wakeState() {
  clearTimeout(stateTimer);
  stateTimer = null;
  if (document.hidden) return null;
  if (statePolling) {
    scheduleState(ACTIVE_STATE_POLL_MS);
    return null;
  }
  statePolling = true;
  const current = await state();
  statePolling = false;
  scheduleState(current?.job?.status === 'running' ? ACTIVE_STATE_POLL_MS : IDLE_STATE_POLL_MS);
  return current;
}

const storagePane = $('#storagePane');
if (storagePane) {
  new MutationObserver(() => {
    if (storagePane.hidden) return;
    refreshFolderStats();
    backups();
  }).observe(storagePane, { attributes:true, attributeFilter:['hidden'] });
}

window.addEventListener('mochimono:protection-summary',event=>renderFolderProtection(event.detail||{}));

window.addEventListener('mochimono:activity-model', event => {
  folderActivity.clear();
  folderActivities.clear();
  const priority = { Thumbnail:1, Sync:2, Index:3, Hash:4 };
  for (const folder of event.detail?.folders || []) folderStatsByPath.set(String(folder.path || '').replace(/[\\/]+$/, '').toLowerCase(), folder);
  for (const item of [...(event.detail?.active || []), ...(event.detail?.queued || []), ...(event.detail?.blocked || [])]) {
    const path = String(item?.path || item?.progress?.path || '').replace(/[\\/]+$/, '');
    const kind = String(item.kind || '');
    if (!path || !priority[kind]) continue;
    const key = path.toLowerCase();
    if (!folderActivities.has(key)) folderActivities.set(key, []);
    folderActivities.get(key).push(item);
    const previous = folderActivity.get(key);
    const rank = value => (value.status === 'running' ? 10 : 0) + priority[String(value.kind || '')];
    if (!previous || rank(item) > rank(previous)) folderActivity.set(key, item);
  }
  for (const row of $('#folders').querySelectorAll('[data-folder-path]')) {
    const path = String(row.dataset.folderPath || '').replace(/[\\/]+$/, '').toLowerCase();
    renderFolderProgress(row, folderJob({ path:row.dataset.folderPath }, currentJob));
    const stats = folderStatsByPath.get(path);
    if (stats) {
      sourceStatus(row, stats);
      row.querySelector('[data-folder-files]').textContent = `${Number(stats.files || 0).toLocaleString()} indexed files`;
      row.querySelector('[data-folder-size]').textContent = bytes(stats.bytes);
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(stateTimer);
    stateTimer = null;
    return;
  }
  wakeState();
  if (!storagePane?.hidden) {
    refreshFolderStats();
    backups();
  }
  refreshRelativeTimes();
});

wakeState();
if (!storagePane?.hidden) {
  refreshFolderStats();
  backups(true);
}
refreshRelativeTimes();
const relativeTimer = setInterval(refreshRelativeTimes, 60_000);
addEventListener('beforeunload', () => {
  clearTimeout(stateTimer);
  clearInterval(relativeTimer);
}, { once:true });
