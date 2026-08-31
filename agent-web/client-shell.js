const $ = selector => document.querySelector(selector);
const tabs = [...document.querySelectorAll('[data-client-tab]')];
const filesPane = $('#filesPane');
const storagePane = $('#storagePane');
const frame = $('#filesFrame');
const connection = $('#connectionDialog');
const connectButton = $('#saveSettings');

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
      body: { server, username, password, device: state.settings?.device || 'Mochimono Client' }
    });
    await json('/api/settings', {
      method: 'POST',
      body: { server, token: login.token }
    });
    $('#serverPassword').value = '';
    $('#serverToken').value = '';
    connection.close();
    frame.src = `/files/?connected=${Date.now()}`;
    notify('Connected');
  } catch (error) {
    notify(error.message);
  } finally {
    connectButton.disabled = false;
  }
}, { capture: true });

async function ensureConnected() {
  try {
    const state = await json('/api/state');
    if ((!state.settings?.hasToken || !state.server?.online) && !connection.open) connection.showModal();
  } catch {}
}

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

ensureConnected();