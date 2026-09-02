const $ = selector => document.querySelector(selector);
const tabs = [...document.querySelectorAll('[data-client-tab]')];
const filesPane = $('#filesPane');
const storagePane = $('#storagePane');
const frame = $('#filesFrame');
const connection = $('#connectionDialog');
const connectButton = $('#saveSettings');
const connectMenuButton = $('#clientConnect');
const logoutButton = $('#clientLogout');
const serverStorage = $('#serverStorage');
const serverStorageText = $('#serverStorageText');
const serverStorageBar = $('#serverStorageBar');
const header = document.querySelector('.client-header');
const brand = document.querySelector('.app-brand');
const manageButton = tabs.find(button => button.dataset.clientTab === 'storage');
const clientMenu = document.querySelector('.client-menu');
let libraryScrollY = 0;

const fileHash = value => /^[a-f0-9]{64}$/.test(String(value || '')) ? String(value) : '';
function shellFileHash() {
  return fileHash(new URL(location.href).searchParams.get('file'));
}
function syncShellFileUrl(hash = '') {
  const url = new URL(location.href);
  const next = fileHash(hash);
  if (next) url.searchParams.set('file', next);
  else url.searchParams.delete('file');
  if (url.href !== location.href) history.replaceState(history.state, '', url);
}

const initialFileHash = shellFileHash();
if (initialFileHash && frame) frame.src = `/files/?file=${encodeURIComponent(initialFileHash)}`;

if (brand && manageButton) {
  manageButton.textContent = 'Storage';
  manageButton.title = 'Storage and protection';
  manageButton.setAttribute('aria-label', 'Storage and protection');
  brand.tabIndex = 0;
  brand.setAttribute('role', 'button');
  brand.title = 'Library';
}

function syncHeaderScroll() {
  const height = header?.offsetHeight || 64;
  const offset = filesPane.hidden ? 0 : Math.min(height, Math.max(0, libraryScrollY));
  document.documentElement.style.setProperty('--client-header-scroll', `${offset}px`);
}

function showTab(name) {
  const files = name !== 'storage';
  filesPane.hidden = !files;
  storagePane.hidden = files;
  document.body.classList.toggle('client-library-active', files);
  if (manageButton) {
    manageButton.classList.toggle('active', !files);
    manageButton.textContent = files ? 'Storage' : 'Library';
    manageButton.title = files ? 'Storage and protection' : 'Back to library';
    manageButton.setAttribute('aria-label', manageButton.title);
  }
  clientMenu?.removeAttribute('open');
  syncHeaderScroll();
}

manageButton?.addEventListener('click', () => showTab(storagePane.hidden ? 'storage' : 'files'));
brand?.addEventListener('click', () => showTab('files'));
brand?.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.code !== 'Space') return;
  event.preventDefault();
  showTab('files');
});
clientMenu?.addEventListener('click', event => {
  if (event.target.closest('button') && !event.target.closest('[data-client-tab]')) queueMicrotask(() => clientMenu.removeAttribute('open'));
});
showTab('files');
addEventListener('resize', syncHeaderScroll, { passive: true });

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

function unauthorized(state) {
  return /(?:^|\b)(?:401|unauthorized)(?:\b|$)/i.test(String(state?.server?.error || ''));
}

function renderServerStorage(state) {
  const hasToken = Boolean(state?.settings?.hasToken);
  const stats = state?.server?.online ? state.server.stats : null;
  connectMenuButton.hidden = hasToken;
  logoutButton.hidden = !hasToken;
  if (!stats) {
    serverStorage.hidden = true;
    return;
  }
  const used = Number(stats.bytes) || 0;
  const capacity = Number(stats.capacityBytes) || 0;
  const percent = capacity ? Math.min(100, used / capacity * 100) : 0;
  serverStorageText.textContent = `${bytes(used)} / ${bytes(capacity)}`;
  serverStorageBar.style.width = used ? `max(2px, ${percent}%)` : '0';
  serverStorage.title = `${bytes(used)} of ${bytes(capacity)} used`;
  serverStorage.hidden = false;
}

async function hasOfflineLibrary(state) {
  if (state?.settings?.folders?.length) return true;
  try { return Boolean((await json('/api/backups')).backups?.length); }
  catch { return false; }
}

async function refreshShellState(showLogin = false) {
  try {
    const state = await json('/api/state');
    renderServerStorage(state);
    const noServer = !state.settings?.hasToken || unauthorized(state);
    const canBrowseOffline = noServer && await hasOfflineLibrary(state);
    if (noServer && !canBrowseOffline && showLogin && !connection.open) connection.showModal();
    return state;
  } catch {
    serverStorage.hidden = true;
    return null;
  }
}

function openConnection() {
  if (!connection.open) connection.showModal();
}
connectMenuButton?.addEventListener('click', openConnection);

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
    await json('/api/settings', { method: 'POST', body: { server, token: login.token } });
    $('#serverPassword').value = '';
    $('#serverToken').value = '';
    connection.close();
    libraryScrollY = 0;
    syncShellFileUrl('');
    frame.src = `/files/?connected=${Date.now()}`;
    showTab('files');
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
  try { await json('/api/auth/revoke-self', { method: 'POST' }); } catch {}
  libraryScrollY = 0;
  syncHeaderScroll();
  serverStorage.hidden = true;
  logoutButton.hidden = true;
  connectMenuButton.hidden = false;
  logoutButton.disabled = false;
  syncShellFileUrl('');
  frame.src = `/files/?offline=${Date.now()}`;
  openConnection();
  notify('Logged out');
});

function refreshLibraryFrame() {
  frame.contentWindow?.mochimonoLibrary?.refresh?.().catch?.(() => {});
  frame.contentWindow?.mochimonoLocations?.refresh?.().catch?.(() => {});
}

function droppedFolderName(value) {
  return String(value || '').trim().split(/[\\/]/).filter(Boolean).at(-1) || '';
}

async function chooseLocalFolder(mode, hint = '') {
  const normalized = mode === 'browse' ? 'browse' : 'protect';
  const name = droppedFolderName(hint);
  const action = normalized === 'browse' ? 'browse locally' : 'protect';
  notify(name ? `Select “${name}” once to ${action}` : `Select the folder to ${action}`);
  try {
    const title = name
      ? `Select “${name}” to ${normalized === 'browse' ? 'browse in Mochimono' : 'protect with Mochimono'}`
      : normalized === 'browse' ? 'Select the folder to browse in Mochimono' : 'Select the folder to protect with Mochimono';
    const picked = await json(`/api/pick-folder?title=${encodeURIComponent(title)}`);
    const path = String(picked.path || '').trim();
    if (!path) return;

    if (normalized === 'browse') {
      await json('/api/browse-folders', { method: 'POST', body: { path } });
    } else {
      await json('/api/folders', { method: 'POST', body: { path } });
    }

    showTab('files');
    await refreshShellState();
    refreshLibraryFrame();
    setTimeout(refreshLibraryFrame, 500);
    notify(normalized === 'browse' ? 'Browsing local folder' : 'Protecting local folder');
  } catch (error) {
    notify(error.message);
  }
}

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type === 'mochimono-auth-required') {
    refreshShellState(true);
    return;
  }
  if (event.data?.type === 'mochimono-folder-intent') {
    chooseLocalFolder(event.data.mode, event.data.hint);
    return;
  }
  if (event.data?.type === 'mochimono-viewer-state') {
    document.body.classList.toggle('library-viewer-open', Boolean(event.data.open));
    if (!event.data.pending) syncShellFileUrl(event.data.open ? event.data.hash : '');
    return;
  }
  if (event.data?.type === 'mochimono-library-scroll') {
    libraryScrollY = Number(event.data.y) || 0;
    syncHeaderScroll();
  }
});

refreshShellState(true);
setInterval(refreshShellState, 5000);
