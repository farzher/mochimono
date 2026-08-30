const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const login = $('#login');
const app = $('#app');
const logout = $('#logout');
const PAGE = 200;

let searchTimer;
let loaded = [];
let offset = 0;
let hasMore = false;
let type = '';
let view = 'grid';
let selected = null;

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
  return value === 'other' || value === 'application/octet-stream' ? 'file' : value;
}

function matchesType(file) {
  if (!type) return true;
  const value = kind(file);
  if (type === 'application') return value === 'application' || value === 'text';
  if (type === 'other') return !['image', 'video', 'audio', 'application', 'text'].includes(value);
  return value === type;
}

function preview(file, large = false) {
  const url = `/api/objects/${file.hash}`;
  if (kind(file) === 'image') {
    return `<img ${large ? '' : 'loading="lazy"'} src="${url}" alt="${escapeHtml(file.filename)}">`;
  }
  const icon = kind(file) === 'video' ? '▶' : kind(file) === 'audio' ? '♪' : typeLabel(file) === 'document' ? '▤' : '·';
  return `<div class="file-icon ${escapeHtml(kind(file))}">${icon}</div>`;
}

async function loadStats() {
  const s = await request('/api/stats');
  $('#stats').innerHTML = `
    <article><strong>${s.objects.toLocaleString()}</strong><span>unique files</span></article>
    <article><strong>${formatBytes(s.bytes)}</strong><span>cloud library</span></article>
    <article><strong>${s.sources.toLocaleString()}</strong><span>known locations</span></article>
    <article><strong>${s.ignored.toLocaleString()}</strong><span>ignored hashes</span></article>`;
}

function renderFiles() {
  const files = loaded.filter(matchesType);
  const element = $('#files');
  element.className = `files ${view}`;

  if (!files.length) {
    element.innerHTML = `<div class="empty">${loaded.length && type ? 'No loaded files match this filter. Load more to search farther back.' : 'No files found.'}</div>`;
  } else if (view === 'grid') {
    element.innerHTML = files.map(file => `
      <button class="file-card" data-hash="${file.hash}">
        <div class="thumb">${preview(file)}</div>
        <div class="card-copy">
          <strong title="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</strong>
          <span>${formatBytes(file.size)}${file.referencesCount > 1 ? ` · ${file.referencesCount} locations` : ''}</span>
        </div>
      </button>`).join('');
  } else {
    element.innerHTML = files.map(file => `
      <button class="file-row" data-hash="${file.hash}">
        <span class="type">${escapeHtml(typeLabel(file))}</span>
        <div class="file-main">
          <strong>${escapeHtml(file.filename)}</strong>
          <span>${escapeHtml(file.originalPath || '')}</span>
        </div>
        <span class="refs">${file.referencesCount > 1 ? `${file.referencesCount} locations` : ''}</span>
        <span class="size">${formatBytes(file.size)}</span>
      </button>`).join('');
  }

  $('#more').hidden = !hasMore;
}

async function loadFiles(reset = true) {
  if (reset) {
    loaded = [];
    offset = 0;
  }
  const q = $('#search').value.trim();
  const data = await request(`/api/files?limit=${PAGE}&offset=${offset}&q=${encodeURIComponent(q)}`);
  loaded.push(...data.files);
  offset += data.files.length;
  hasMore = data.files.length === PAGE;
  renderFiles();
}

async function openDetails(hash) {
  selected = loaded.find(file => file.hash === hash);
  if (!selected) return;

  $('#detail-name').textContent = selected.filename;
  $('#detail-meta').textContent = `${typeLabel(selected)} · ${formatBytes(selected.size)} · ${selected.hash.slice(0, 12)}…`;
  $('#detail-open').href = `/api/objects/${selected.hash}`;
  $('#detail-preview').innerHTML = preview(selected, true);
  $('#detail-sources').innerHTML = '<div class="empty small-empty">Loading locations…</div>';
  $('#details').showModal();

  try {
    const data = await request(`/api/files/${selected.hash}/sources`);
    $('#detail-sources').innerHTML = data.sources.length ? data.sources.map(source => `
      <article>
        <strong>${escapeHtml(source.sourceName)}</strong>
        <span>${escapeHtml(source.path)}</span>
        <small>${source.mtime ? `Modified ${new Date(source.mtime).toLocaleString()}` : ''}</small>
      </article>`).join('') : '<div class="empty small-empty">No source locations recorded.</div>';
  } catch (error) {
    $('#detail-sources').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
  }
}

async function removeSelected(ignore) {
  if (!selected) return;
  const text = ignore
    ? 'Delete this exact content from the live library and remember its hash so future imports keep ignoring it? Offline backup copies are not erased.'
    : 'Delete this content from the live library? It can return if encountered in a future import. Offline backup copies are not erased.';
  if (!confirm(text)) return;
  await request(`/api/objects/${selected.hash}/delete`, { method: 'POST', body: { ignore } });
  $('#details').close();
  selected = null;
  await Promise.all([loadStats(), loadFiles(true), loadDrives()]);
}

async function loadDrives() {
  const data = await request('/api/drives');
  if (!data.drives.length) {
    $('#drives').innerHTML = '<div class="empty">No backups yet. Create one with the local Mochimono Agent.</div>';
    return;
  }
  $('#drives').innerHTML = data.drives.map(drive => {
    const ratio = drive.desiredBytes ? Math.min(100, (drive.protectedBytes / drive.desiredBytes) * 100) : 100;
    const missing = Math.max(0, drive.desiredBytes - drive.protectedBytes);
    return `
      <article class="drive">
        <div class="drive-head"><strong>${escapeHtml(drive.name)}</strong><span>${ratio.toFixed(1)}%</span></div>
        <div class="meter"><i style="width:${ratio}%"></i></div>
        <p>${formatBytes(drive.protectedBytes)} protected of ${formatBytes(drive.desiredBytes)}${missing ? ` · ${formatBytes(missing)} missing` : ' · complete'}</p>
        <p>${drive.protectedCount.toLocaleString()} / ${drive.desiredCount.toLocaleString()} objects · ${drive.policy.all ? 'Everything' : drive.policy.types.map(escapeHtml).join(', ')} · Last seen ${new Date(drive.lastSeen).toLocaleString()}</p>
      </article>`;
  }).join('');
}

async function boot() {
  try {
    await request('/api/health');
    login.hidden = true;
    app.hidden = false;
    logout.hidden = false;
    await Promise.all([loadStats(), loadFiles(true), loadDrives()]);
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

$('#filters').addEventListener('click', event => {
  const button = event.target.closest('[data-type]');
  if (!button) return;
  type = button.dataset.type;
  $$('#filters button').forEach(item => item.classList.toggle('active', item === button));
  renderFiles();
});

$('#views').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  view = button.dataset.view;
  $$('#views button').forEach(item => item.classList.toggle('active', item === button));
  renderFiles();
});

$('#files').addEventListener('click', event => {
  const item = event.target.closest('[data-hash]');
  if (item) openDetails(item.dataset.hash).catch(console.error);
});

$('#more').onclick = () => loadFiles(false).catch(console.error);
$('#close-details').onclick = () => $('#details').close();
$('#delete').onclick = () => removeSelected(false).catch(console.error);
$('#delete-ignore').onclick = () => removeSelected(true).catch(console.error);

boot().catch(error => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${escapeHtml(error.stack || error.message)}</pre>`);
});
