const params = new URL(location.href).searchParams;
const addedMode = params.get('sort') === 'added';
const batchId = Math.max(0, Number(params.get('batch') || 0) || 0);
const modeKey = `${addedMode ? 'added' : 'file'}:${batchId || ''}`;
const CACHE_MODE_KEY = 'mochimono-catalog-view-mode';
const PENDING_SORT_KEY = 'mochimono-pending-sort';

async function clearCatalogCache() {
  if (!('indexedDB' in window)) return;
  await new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const request = indexedDB.deleteDatabase('mochimono-catalog');
    request.onsuccess = done;
    request.onerror = done;
    request.onblocked = () => setTimeout(done, 80);
    setTimeout(done, 300);
  });
}

if (localStorage.getItem(CACHE_MODE_KEY) !== modeKey) {
  await clearCatalogCache();
  localStorage.setItem(CACHE_MODE_KEY, modeKey);
}

function ids(value) {
  return String(value || '').split(',').map(Number).filter(Boolean);
}

const nativeFetch = window.fetch.bind(window);
window.fetch = async function(input, init) {
  const response = await nativeFetch(input, init);
  try {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname !== '/api/catalog' || !response.ok) return response;
    const data = await response.clone().json();
    if (!Array.isArray(data.files)) return response;
    let files = data.files;
    if (batchId) files = files.filter(file => ids(file.exactImportIds).includes(batchId));
    if (addedMode) files = files.map(file => ({ ...file, fileDate: file.addedAt || file.createdAt }));
    const body = JSON.stringify({ ...data, files });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: { ...Object.fromEntries(response.headers.entries()), 'content-type': 'application/json; charset=utf-8' }
    });
  } catch {
    return response;
  }
};

const sort = document.querySelector('#sort');
if (addedMode && sort) sort.value = 'date-added';

sort?.addEventListener('change', event => {
  const value = event.target.value;
  if (value === 'date-added' && !addedMode) {
    event.stopImmediatePropagation();
    const url = new URL(location.href);
    url.searchParams.set('sort', 'added');
    location.replace(url);
    return;
  }
  if (addedMode && value !== 'date-added') {
    event.stopImmediatePropagation();
    sessionStorage.setItem(PENDING_SORT_KEY, value);
    const url = new URL(location.href);
    url.searchParams.delete('sort');
    location.replace(url);
  }
}, true);

if (!addedMode) {
  const pending = sessionStorage.getItem(PENDING_SORT_KEY);
  if (pending) {
    sessionStorage.removeItem(PENDING_SORT_KEY);
    addEventListener('load', () => {
      if (!sort) return;
      sort.value = pending;
      sort.dispatchEvent(new Event('change', { bubbles: true }));
    }, { once: true });
  }
}

if (batchId) {
  const style = document.createElement('style');
  style.textContent = `
    .added-batch-filter{height:30px;padding:0 9px;border:1px solid #3b3539;border-radius:7px;background:#1a171a;color:#ded7d4;font:650 11px Inter,system-ui,sans-serif;white-space:nowrap;cursor:pointer}
    .added-batch-filter:hover{border-color:#6c5f62;color:#fff}
  `;
  document.head.append(style);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'added-batch-filter';
  button.textContent = 'Added batch ×';
  button.title = 'Show all files';
  button.addEventListener('click', () => {
    const url = new URL(location.href);
    url.searchParams.delete('batch');
    location.replace(url);
  });
  document.querySelector('.commandbar')?.append(button);
}
