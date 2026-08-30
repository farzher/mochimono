const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const login = $('#login');
const app = $('#app');
const logout = $('#logout');
const PAGE = 120;

let searchTimer;
let loaded = [];
let imports = [];
let offset = 0;
let hasMore = false;
let type = '';
let importId = '';
let inboxOnly = false;
let noBackupOnly = false;
let view = 'grid';
let selected = null;
let folderImportId = '';
let folderPath = '';
let folderData = null;

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  if (response.status === 401) throw Object.assign(new Error('Unauthorized'), { unauthorized: true });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(bytes || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function kind(file) {
  return file.mime?.split('/')[0] || 'other';
}

function typeLabel(file) {
  const value = kind(file);
  if (value === 'application' || value === 'text') return 'document';
  return value === 'other' ? 'file' : value;
}

function preview(file, large = false) {
  const url = `/api/objects/${file.hash}`;
  if (kind(file) === 'image') return `<img ${large ? '' : 'loading="lazy"'} src="${url}" alt="${escapeHtml(file.filename)}">`;
  const icon = kind(file) === 'video' ? '▶' : kind(file) === 'audio' ? '♪' : typeLabel(file) === 'document' ? '▤' : '·';
  return `<div class="file-icon ${escapeHtml(kind(file))}">${icon}</div>`;
}

async function loadStats() {
  const s = await request('/api/stats');
  $('#stats').innerHTML = `
    <article><strong>${s.objects.toLocaleString()}</strong><span>files</span></article>
    <article><strong>${formatBytes(s.bytes)}</strong><span>stored</span></article>
    <article><strong>${s.sources.toLocaleString()}</strong><span>locations</span></article>
    <article><strong>${s.unreviewed.toLocaleString()}</strong><span>inbox</span></article>`;
  $('#inbox').textContent = s.unreviewed ? `Inbox · ${s.unreviewed.toLocaleString()}` : 'Inbox';
  $('#unbacked').textContent = s.unbacked ? `Unbacked · ${s.unbacked.toLocaleString()}` : 'Unbacked';
}

async function loadImports() {
  const data = await request('/api/imports');
  imports = data.imports;
  const source = $('#source');
  source.innerHTML = '<option value="">All sources</option>' + imports.map(item => {
    const date = new Date(item.createdAt).toLocaleDateString();
    return `<option value="${item.id}">${escapeHtml(item.sourceName)} · ${item.files.toLocaleString()} · ${escapeHtml(date)}</option>`;
  }).join('');
  source.value = importId;
  if (view === 'folders' && !folderImportId) renderFolder();
}

function renderFiles() {
  if (view === 'folders') return renderFolder();
  const element = $('#files');
  element.className = `files ${view}`;
  $('#folderbar').hidden = true;
  $('#more').hidden = !hasMore;

  if (!loaded.length) {
    const message = inboxOnly ? 'Inbox empty.' : noBackupOnly ? 'All backed up.' : 'No files.';
    element.innerHTML = `<div class="empty">${message}</div>`;
  } else if (view === 'grid') {
    element.innerHTML = loaded.map(file => `
      <button class="file-card" data-hash="${file.hash}">
        <div class="thumb">${preview(file)}${file.reviewed ? '' : '<span class="inbox-badge">Inbox</span>'}</div>
        <div class="card-copy">
          <strong title="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</strong>
          <span>${formatBytes(file.size)}${file.backupCount ? ` · ${file.backupCount} backup${file.backupCount === 1 ? '' : 's'}` : ' · unbacked'}</span>
        </div>
      </button>`).join('');
  } else {
    element.innerHTML = loaded.map(file => `
      <button class="file-row" data-hash="${file.hash}">
        <span class="type ${file.reviewed ? '' : 'inbox-type'}">${file.reviewed ? escapeHtml(typeLabel(file)) : 'inbox'}</span>
        <div class="file-main">
          <strong>${escapeHtml(file.filename)}</strong>
          <span>${escapeHtml(file.originalPath || '')}</span>
        </div>
        <span class="refs">${file.backupCount ? `${file.backupCount} backup${file.backupCount === 1 ? '' : 's'}` : 'unbacked'}</span>
        <span class="size">${formatBytes(file.size)}</span>
      </button>`).join('');
  }
}

async function loadFiles(reset = true) {
  if (view === 'folders') return loadFolder();
  if (reset) {
    loaded = [];
    offset = 0;
  }
  const q = $('#search').value.trim();
  const review = inboxOnly ? 'unreviewed' : '';
  const backup = noBackupOnly ? 'missing' : '';
  const data = await request(`/api/files?limit=${PAGE}&offset=${offset}&type=${encodeURIComponent(type)}&review=${review}&backup=${backup}&import=${encodeURIComponent(importId)}&q=${encodeURIComponent(q)}`);
  loaded.push(...data.files);
  offset += data.files.length;
  hasMore = data.hasMore;
  renderFiles();
}

function currentFolderSource() {
  return imports.find(item => String(item.id) === String(folderImportId));
}

function folderBreadcrumb() {
  const bar = $('#folderbar');
  bar.hidden = false;
  const source = currentFolderSource();
  const parts = folderPath ? folderPath.split('/') : [];
  const crumbs = [`<button data-folder-home>Sources</button>`];
  if (source) {
    crumbs.push(`<span>›</span><button data-folder-depth="0">${escapeHtml(source.sourceName)}</button>`);
    parts.forEach((part, index) => crumbs.push(`<span>›</span><button data-folder-depth="${index + 1}">${escapeHtml(part)}</button>`));
  }
  bar.innerHTML = `<div class="breadcrumbs">${crumbs.join('')}</div>`;
}

function renderFolder() {
  const element = $('#files');
  element.className = 'files folders';
  $('#more').hidden = true;
  folderBreadcrumb();

  if (!folderImportId) {
    element.innerHTML = imports.length ? `
      <div class="folder-list-head"><span>Name</span><span>Files</span><span>Imported</span></div>
      ${imports.map(item => `
        <button class="folder-row source-row" data-folder-source="${item.id}">
          <span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(item.sourceName)}</strong></span>
          <span>${item.files.toLocaleString()} · ${formatBytes(item.referencedBytes)}</span>
          <span>${escapeHtml(new Date(item.createdAt).toLocaleDateString())}</span>
        </button>`).join('')}` : '<div class="empty">No sources.</div>';
    return;
  }

  if (!folderData) {
    element.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }

  const rows = [];
  for (const folder of folderData.folders) {
    rows.push(`
      <button class="folder-row" data-folder-name="${escapeHtml(folder.name)}">
        <span class="folder-name"><i class="folder-icon"></i><strong>${escapeHtml(folder.name)}</strong></span>
        <span>${folder.files.toLocaleString()}</span>
        <span>Folder</span>
      </button>`);
  }
  for (const file of folderData.files) {
    rows.push(`
      <button class="folder-row file-folder-row" data-hash="${file.hash}">
        <span class="folder-name"><i class="document-icon"></i><strong>${escapeHtml(file.filename)}</strong>${file.reviewed ? '' : '<em>Inbox</em>'}</span>
        <span>${formatBytes(file.size)} · ${file.backupCount ? `${file.backupCount} backup${file.backupCount === 1 ? '' : 's'}` : 'unbacked'}</span>
        <span>${escapeHtml(typeLabel(file))}</span>
      </button>`);
  }
  element.innerHTML = rows.length
    ? `<div class="folder-list-head"><span>Name</span><span>Details</span><span>Type</span></div>${rows.join('')}`
    : '<div class="empty">Empty.</div>';
}

async function loadFolder() {
  folderData = null;
  renderFolder();
  if (!folderImportId) return;
  folderData = await request(`/api/folders?import=${encodeURIComponent(folderImportId)}&path=${encodeURIComponent(folderPath)}`);
  renderFolder();
}

function setView(next) {
  view = next;
  $('#library-card').classList.toggle('folder-mode', view === 'folders');
  $$('#views button').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  if (view === 'folders') {
    folderImportId = importId;
    folderPath = '';
    loadFolder().catch(console.error);
  } else {
    $('#folderbar').hidden = true;
    loadFiles(true).catch(console.error);
  }
}

function renderReviewState() {
  const reviewed = Boolean(selected?.reviewed);
  $('#review-status').textContent = reviewed ? 'Kept' : 'Inbox';
  $('#review-toggle').textContent = reviewed ? 'Inbox' : 'Keep';
  $('#review-toggle').className = reviewed ? 'quiet' : '';
}

async function openDetails(hash, fallback = null) {
  selected = loaded.find(file => file.hash === hash) || folderData?.files?.find(file => file.hash === hash) || fallback;
  if (!selected) return;

  $('#detail-name').textContent = selected.filename;
  $('#detail-meta').textContent = `${typeLabel(selected)} · ${formatBytes(selected.size)} · ${selected.hash.slice(0, 12)}…`;
  $('#detail-open').href = `/api/objects/${selected.hash}`;
  $('#detail-preview').innerHTML = preview(selected, true);
  $('#detail-sources').innerHTML = '<div class="empty small-empty">Loading…</div>';
  $('#detail-backups').innerHTML = '<div class="empty small-empty">Loading…</div>';
  renderReviewState();
  $('#details').showModal();

  try {
    const data = await request(`/api/files/${selected.hash}/details`);
    selected.reviewed = Boolean(data.object.reviewed);
    renderReviewState();
    $('#detail-sources').innerHTML = data.sources.length ? data.sources.map(source => `
      <article>
        <strong>${escapeHtml(source.sourceName)}</strong>
        <span>${escapeHtml(source.path)}</span>
        <small>${source.mtime ? new Date(source.mtime).toLocaleString() : ''}</small>
      </article>`).join('') : '<div class="empty small-empty">None.</div>';

    $('#detail-backups').innerHTML = data.backups.length ? data.backups.map(backup => `
      <article>
        <strong>${escapeHtml(backup.name)}</strong>
        <small>${backup.verifiedAt ? new Date(backup.verifiedAt).toLocaleString() : new Date(backup.lastSeen).toLocaleString()}</small>
      </article>`).join('') : '<div class="empty small-empty warning">None.</div>';
  } catch (error) {
    const html = `<div class="error">${escapeHtml(error.message)}</div>`;
    $('#detail-sources').innerHTML = html;
    $('#detail-backups').innerHTML = html;
  }
}

async function refreshLibrary() {
  await loadStats();
  if (view === 'folders') await loadFolder();
  else await loadFiles(true);
}

async function toggleReviewed() {
  if (!selected) return;
  const reviewed = !Boolean(selected.reviewed);
  await request(`/api/objects/${selected.hash}/review`, { method: 'POST', body: { reviewed } });
  $('#details').close();
  selected = null;
  await refreshLibrary();
}

async function removeSelected(ignore) {
  if (!selected) return;
  const text = ignore ? 'Delete + ignore on future imports?' : 'Delete this file?';
  if (!confirm(text)) return;
  await request(`/api/objects/${selected.hash}/delete`, { method: 'POST', body: { ignore } });
  $('#details').close();
  selected = null;
  await Promise.all([loadStats(), loadImports(), loadDrives()]);
  if (view === 'folders') await loadFolder();
  else await loadFiles(true);
}

async function loadDrives() {
  const data = await request('/api/drives');
  if (!data.drives.length) {
    $('#drives').innerHTML = '<div class="empty">No backups.</div>';
    return;
  }
  $('#drives').innerHTML = data.drives.map(drive => {
    const ratio = drive.desiredBytes ? Math.min(100, (drive.protectedBytes / drive.desiredBytes) * 100) : 100;
    const missing = Math.max(0, drive.desiredBytes - drive.protectedBytes);
    return `
      <article class="drive">
        <div class="drive-head"><strong>${escapeHtml(drive.name)}</strong><span>${ratio.toFixed(1)}%</span></div>
        <div class="meter"><i style="width:${ratio}%"></i></div>
        <p>${formatBytes(drive.protectedBytes)} / ${formatBytes(drive.desiredBytes)}${missing ? ` · ${formatBytes(missing)} missing` : ''}</p>
        <p>${drive.protectedCount.toLocaleString()} / ${drive.desiredCount.toLocaleString()} files · ${drive.policy.all ? 'Everything' : drive.policy.types.map(escapeHtml).join(', ')} · ${new Date(drive.lastSeen).toLocaleString()}</p>
      </article>`;
  }).join('');
}

async function boot() {
  try {
    await request('/api/health');
    login.hidden = true;
    app.hidden = false;
    logout.hidden = false;
    await Promise.all([loadStats(), loadImports(), loadFiles(true), loadDrives()]);
  } catch (error) {
    if (error.unauthorized) {
      login.hidden = false;
      app.hidden = true;
      logout.hidden = true;
    } else throw error;
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await request('/api/login', { method: 'POST', body: { token: $('#token').value } });
    $('#token').value = '';
    await boot();
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});

logout.addEventListener('click', async () => {
  await request('/api/logout', { method: 'POST' }).catch(() => {});
  await boot();
});

$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadFiles(true).catch(console.error), 200);
});

$('#source').addEventListener('change', event => {
  importId = event.target.value;
  if (view === 'folders') {
    folderImportId = importId;
    folderPath = '';
    loadFolder().catch(console.error);
  } else loadFiles(true).catch(console.error);
});

$('#inbox').addEventListener('click', () => {
  inboxOnly = !inboxOnly;
  $('#inbox').classList.toggle('active', inboxOnly);
  loadFiles(true).catch(console.error);
});

$('#unbacked').addEventListener('click', () => {
  noBackupOnly = !noBackupOnly;
  $('#unbacked').classList.toggle('active', noBackupOnly);
  loadFiles(true).catch(console.error);
});

$('#filters').addEventListener('click', event => {
  const button = event.target.closest('[data-type]');
  if (!button) return;
  type = button.dataset.type;
  $$('#filters button').forEach(item => item.classList.toggle('active', item === button));
  loadFiles(true).catch(console.error);
});

$('#views').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});

$('#folderbar').addEventListener('click', event => {
  if (event.target.closest('[data-folder-home]')) {
    folderImportId = '';
    folderPath = '';
    importId = '';
    $('#source').value = '';
    loadFolder().catch(console.error);
    return;
  }
  const crumb = event.target.closest('[data-folder-depth]');
  if (!crumb) return;
  const depth = Number(crumb.dataset.folderDepth);
  folderPath = depth ? folderPath.split('/').slice(0, depth).join('/') : '';
  loadFolder().catch(console.error);
});

$('#files').addEventListener('click', event => {
  const sourceRow = event.target.closest('[data-folder-source]');
  if (sourceRow) {
    folderImportId = sourceRow.dataset.folderSource;
    importId = folderImportId;
    $('#source').value = importId;
    folderPath = '';
    loadFolder().catch(console.error);
    return;
  }
  const folderRow = event.target.closest('[data-folder-name]');
  if (folderRow) {
    folderPath = folderPath ? `${folderPath}/${folderRow.dataset.folderName}` : folderRow.dataset.folderName;
    loadFolder().catch(console.error);
    return;
  }
  const item = event.target.closest('[data-hash]');
  if (item) openDetails(item.dataset.hash).catch(console.error);
});

$('#more').onclick = () => loadFiles(false).catch(console.error);
$('#close-details').onclick = () => $('#details').close();
$('#review-toggle').onclick = () => toggleReviewed().catch(console.error);
$('#delete').onclick = () => removeSelected(false).catch(console.error);
$('#delete-ignore').onclick = () => removeSelected(true).catch(console.error);

boot().catch(error => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${escapeHtml(error.stack || error.message)}</pre>`);
});
