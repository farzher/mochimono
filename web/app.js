const $ = selector => document.querySelector(selector);
const login = $('#login');
const app = $('#app');
const logout = $('#logout');
let searchTimer;

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
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function typeLabel(mime) {
  return mime?.split('/')[0] || 'file';
}

async function loadStats() {
  const s = await request('/api/stats');
  $('#stats').innerHTML = `
    <article><strong>${s.objects.toLocaleString()}</strong><span>unique files</span></article>
    <article><strong>${formatBytes(s.bytes)}</strong><span>cloud library</span></article>
    <article><strong>${s.sources.toLocaleString()}</strong><span>known locations</span></article>
    <article><strong>${s.ignored.toLocaleString()}</strong><span>ignored hashes</span></article>`;
}

async function loadFiles() {
  const q = $('#search').value.trim();
  const data = await request(`/api/files?limit=200&q=${encodeURIComponent(q)}`);
  if (!data.files.length) {
    $('#files').innerHTML = '<div class="empty">No files found.</div>';
    return;
  }
  $('#files').innerHTML = data.files.map(file => `
    <div class="file-row" data-hash="${file.hash}">
      <span class="type">${escapeHtml(typeLabel(file.mime))}</span>
      <div class="file-main">
        <a href="/api/objects/${file.hash}" target="_blank">${escapeHtml(file.filename)}</a>
        <span>${escapeHtml(file.originalPath || '')}</span>
      </div>
      <span class="refs">${file.referencesCount > 1 ? `${file.referencesCount} locations` : ''}</span>
      <span class="size">${formatBytes(file.size)}</span>
      <button class="delete quiet" title="Delete">Delete</button>
    </div>`).join('');
}

async function loadDrives() {
  const data = await request('/api/drives');
  if (!data.drives.length) {
    $('#drives').innerHTML = '<div class="empty">No backup drives yet. Initialize one with the Mochimono agent.</div>';
    return;
  }
  $('#drives').innerHTML = data.drives.map(drive => {
    const ratio = drive.desiredBytes ? Math.min(100, (drive.protectedBytes / drive.desiredBytes) * 100) : 100;
    return `
      <article class="drive">
        <div class="drive-head"><strong>${escapeHtml(drive.name)}</strong><span>${ratio.toFixed(1)}%</span></div>
        <div class="meter"><i style="width:${ratio}%"></i></div>
        <p>${formatBytes(drive.protectedBytes)} of ${formatBytes(drive.desiredBytes)} · ${drive.protectedCount.toLocaleString()} / ${drive.desiredCount.toLocaleString()} objects</p>
        <p>Policy: ${drive.policy.all ? 'Everything' : drive.policy.types.map(escapeHtml).join(', ')} · Last seen ${new Date(drive.lastSeen).toLocaleString()}</p>
      </article>`;
  }).join('');
}

async function boot() {
  try {
    await request('/api/health');
    login.hidden = true;
    app.hidden = false;
    logout.hidden = false;
    await Promise.all([loadStats(), loadFiles(), loadDrives()]);
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
  searchTimer = setTimeout(() => loadFiles().catch(console.error), 200);
});

$('#files').addEventListener('click', async event => {
  const button = event.target.closest('.delete');
  if (!button) return;
  const row = button.closest('.file-row');
  if (!confirm('Delete this exact content from the live library and remember it so it stays ignored on future imports?')) return;
  if (!confirm('This removes the primary cloud copy. Offline backup copies are not automatically erased. Continue?')) return;
  await request(`/api/objects/${row.dataset.hash}/delete`, { method: 'POST', body: { ignore: true } });
  await Promise.all([loadStats(), loadFiles(), loadDrives()]);
});

boot().catch(error => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${escapeHtml(error.stack || error.message)}</pre>`);
});
