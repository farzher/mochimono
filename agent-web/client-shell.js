const $ = selector => document.querySelector(selector);
const tabs = [...document.querySelectorAll('[data-client-tab]')];
const filesPane = $('#filesPane');
const storagePane = $('#storagePane');
const frame = $('#filesFrame');
const connection = $('#connectionDialog');
const connectButton = $('#saveSettings');
const logoutButton = $('#clientLogout');
const serverStorage = $('#serverStorage');
const serverStorageText = $('#serverStorageText');
const serverStorageBar = $('#serverStorageBar');

function showTab(name) {
  const files = name !== 'storage';
  filesPane.hidden = !files;
  storagePane.hidden = files;
  for (const button of tabs) button.classList.toggle('active', button.dataset.clientTab === (files ? 'files' : 'storage'));
  localStorage.setItem('mochimono-client-tab', files ? 'files' : 'storage');
}

for (const button of tabs) button.addEventListener('click', () => showTab(button.dataset.clientTab));
showTab(localStorage.getItem('mochimono-client-tab') || 'files');

async function json(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function notify(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function bytes(number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(number) || 0;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function renderServerStorage(state) {
  const stats = state?.server?.online ? state.server.stats : null;
  if (!stats) {
    serverStorage.hidden = true;
    logoutButton.hidden = !state?.settings?.hasToken;
    return;
  }
  const used = Number(stats.bytes) || 0;
  const capacity = Number(stats.capacityBytes) || 0;
  const percent = capacity ? Math.min(100, used / capacity * 100) : 0;
  serverStorageText.innerHTML = `${bytes(used)} <small>of ${bytes(capacity)}</small>`;
  serverStorageBar.style.width = used ? `max(2px, ${percent}%)` : '0';
  serverStorage.hidden = false;
  logoutButton.hidden = false;
}

async function refreshShellState(showLogin = false) {
  try {
    const state = await json('/api/state');
    renderServerStorage(state);
    if ((!state.settings?.hasToken || !state.server?.online) && (showLogin || !connection.open)) {
      if (!connection.open) connection.showModal();
    }
    return state;
  } catch {
    serverStorage.hidden = true;
    return null;
  }
}

connectButton.addEventListener('click', async event => {
  event.preventDefault();
  event.stopImmediatePropagation();
  const server = $('#serverUrl').value.trim();
  const username = $('#serverUsername').value.trim();
  const password = $('#serverPassword').value;
  if (!server || !username || !password) return notify('Server, username, and password are required.');

  connectButton.disabled = true;
  try {
    const state = await json('/api/state').catch(() => ({ settings: {} }));
    const login = await json('/api/client/login', {
      method: 'POST',
      body: { server, username, password, device: state.settings?.device || 'Mochimono' }
    });
    await json('/api/settings', {
      method: 'POST',
      body: { server, token: login.token }
    });
    $('#serverPassword').value = '';
    $('#serverToken').value = '';
    connection.close();
    frame.src = `/files/?connected=${Date.now()}`;
    await refreshShellState();
    notify('Connected');
  } catch (error) {
    notify(error.message);
  } finally {
    connectButton.disabled = false;
  }
}, { capture: true });

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await json('/api/auth/revoke-self', { method: 'POST' });
  } catch {}
  frame.src = 'about:blank';
  serverStorage.hidden = true;
  logoutButton.hidden = true;
  logoutButton.disabled = false;
  if (!connection.open) connection.showModal();
  notify('Logged out');
});

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type === 'mochimono-auth-required') {
    if (!connection.open) connection.showModal();
    return;
  }
  if (event.data?.type === 'mochimono-viewer-state') {
    document.body.classList.toggle('library-viewer-open', Boolean(event.data.open));
  }
});

refreshShellState(true);
setInterval(refreshShellState, 5000);