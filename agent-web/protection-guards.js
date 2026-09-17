const CONTROL = 'http://127.0.0.1:8645';

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers:{ 'content-type':'application/json', ...(options.headers || {}) },
    body:options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

const server = (path, options) => request('', path, options);
const control = (path, options) => request(CONTROL, path, options);
const pathKey = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();

function toast(text) {
  const node = document.querySelector('#toast');
  if (!node) return;
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove('show'), 2800);
}

function bytes(number) {
  const units = ['B','KB','MB','GB','TB','PB'];
  let value = Math.max(0, Number(number) || 0), unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 && unit ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

async function removeFolder(path) {
  const state = await server('/api/state');
  const folder = (state.settings?.folders || []).find(item => pathKey(item.path) === pathKey(path));
  const importId = Number(folder?.importId) || 0;

  if (folder?.protected !== false && importId) {
    const cleanup = await server(`/api/protection/imports/${importId}/cleanup`);
    if (!confirm(`Stop protecting ${path}?\n\nThe original folder will not be deleted.`)) return;
    let trashExclusive = false;
    if (cleanup.exclusiveFiles) {
      trashExclusive = confirm(`${Number(cleanup.exclusiveFiles).toLocaleString()} files (${bytes(cleanup.exclusiveBytes)}) are stored by Mochimono only because of this folder.\n\nMove those extra Mochimono copies to Trash?`);
    }
    await server(`/api/protection/imports/${importId}/cleanup`, { method:'POST', body:{ trashExclusive } });
  }

  await server('/api/folders/remove', { method:'POST', body:{ path } });
  location.reload();
}

document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-remove-folder]');
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  removeFolder(button.dataset.removeFolder).catch(error => toast(error.message));
}, true);

document.addEventListener('click', event => {
  const button = event.target.closest?.('#startImport');
  if (!button) return;
  if (button.dataset.protectionApproved === '1') {
    delete button.dataset.protectionApproved;
    return;
  }
  const path = document.querySelector('#importPath')?.value.trim();
  if (!path) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = 'Checking…';

  control('/api/client/protection/estimate-folder', { method:'POST', body:{ path } })
    .then(estimate => {
      const large = estimate.truncated || estimate.bytes >= 100e9 || estimate.files >= 100000;
      if (large && !confirm(`Protect ${estimate.truncated ? 'at least ' : ''}${Number(estimate.files).toLocaleString()} files (${bytes(estimate.bytes)})?`)) return;
      button.dataset.protectionApproved = '1';
      button.disabled = false;
      button.textContent = previous;
      button.click();
    })
    .catch(error => toast(error.message))
    .finally(() => {
      button.disabled = false;
      button.textContent = previous;
    });
}, true);
