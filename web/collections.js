const app = document.querySelector('#app');
const source = document.querySelector('#source');
const filter = document.querySelector('#collectionFilter');
const views = document.querySelector('#views');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerCollections = document.querySelector('#viewerCollections');
const viewerClose = document.querySelector('#viewer-close');

let collections = [];
let activeId = '';
let activeHashes = null;
let loaded = false;
let viewerGeneration = 0;
let pickerHashes = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function json(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function currentHash() {
  const match = viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/);
  return match?.[1] || '';
}

function renderFilter() {
  const current = activeId;
  filter.innerHTML = '<option value="">Collections</option>' + collections.map(item =>
    `<option value="${item.id}">${escapeHtml(item.name)}${item.count ? ` · ${Number(item.count).toLocaleString()}` : ''}</option>`
  ).join('');
  filter.value = collections.some(item => String(item.id) === String(current)) ? String(current) : '';
}

async function refreshCollections() {
  const data = await json('/api/collections');
  collections = data.collections || [];
  renderFilter();
  renderPickerOptions();
}

function updateCollectionUrl(id) {
  const url = new URL(location.href);
  if (id) {
    url.searchParams.set('collection', id);
    url.searchParams.delete('source');
    url.searchParams.delete('path');
  } else {
    url.searchParams.delete('collection');
  }
  history.replaceState(history.state, '', url);
}

async function setActiveCollection(id, updateUrl = true) {
  const next = String(id || '');
  activeId = next;
  filter.value = next;
  if (!next) {
    activeHashes = null;
    window.mochimonoSetCollectionHashes?.(null);
    if (updateUrl) updateCollectionUrl('');
    return;
  }

  const data = await json(`/api/collections/${encodeURIComponent(next)}/hashes`);
  if (activeId !== next) return;
  activeHashes = new Set(data.hashes || []);
  window.mochimonoSetCollectionHashes?.(activeHashes);
  if (updateUrl) updateCollectionUrl(next);
}

async function switchFromViewer(id) {
  const next = String(id);
  if (!viewer.hidden && history.state?.mochimonoViewer) {
    const apply = () => setActiveCollection(next).catch(console.error);
    window.addEventListener('popstate', apply, { once: true });
    viewerClose.click();
    return;
  }
  if (!viewer.hidden) viewerClose.click();
  await setActiveCollection(next);
}

filter.addEventListener('change', () => setActiveCollection(filter.value).catch(console.error));
source.addEventListener('change', () => {
  if (!activeId) return;
  activeId = '';
  activeHashes = null;
  filter.value = '';
  window.mochimonoSetCollectionHashes?.(null);
  updateCollectionUrl('');
});
views.addEventListener('click', event => {
  if (!event.target.closest('[data-view="folders"]') || !activeId) return;
  activeId = '';
  activeHashes = null;
  filter.value = '';
  window.mochimonoSetCollectionHashes?.(null);
  updateCollectionUrl('');
});

async function fileCollections(hash) {
  return (await json(`/api/collections/file/${hash}`)).collections || [];
}

async function renderViewerMemberships() {
  const hash = currentHash();
  const generation = ++viewerGeneration;
  if (!hash || viewer.hidden) {
    viewerCollections.replaceChildren();
    return;
  }
  try {
    const memberships = await fileCollections(hash);
    if (generation !== viewerGeneration || hash !== currentHash() || viewer.hidden) return;
    viewerCollections.innerHTML = memberships.map(item => `
      <span class="viewer-collection-chip">
        <button data-open-collection="${item.id}">${escapeHtml(item.name)}</button>
        <button data-remove-collection="${item.id}" aria-label="Remove from ${escapeHtml(item.name)}">×</button>
      </span>`).join('') + '<button class="viewer-collection-add" data-add-collection>+ Collection</button>';
  } catch (error) {
    console.warn(error);
  }
}

new MutationObserver(() => renderViewerMemberships()).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
new MutationObserver(() => {
  if (viewer.hidden) {
    viewerGeneration++;
    viewerCollections.replaceChildren();
  } else renderViewerMemberships();
}).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

viewerCollections.addEventListener('click', async event => {
  const open = event.target.closest('[data-open-collection]');
  if (open) {
    await switchFromViewer(open.dataset.openCollection);
    return;
  }
  const remove = event.target.closest('[data-remove-collection]');
  if (remove) {
    const hash = currentHash();
    const id = remove.dataset.removeCollection;
    if (!hash) return;
    await json(`/api/collections/${encodeURIComponent(id)}/items/${hash}`, { method: 'DELETE' });
    if (String(activeId) === String(id) && activeHashes) {
      activeHashes.delete(hash);
      window.mochimonoSetCollectionHashes?.(activeHashes);
      viewerClose.click();
    } else {
      await renderViewerMemberships();
    }
    await refreshCollections();
    return;
  }
  if (event.target.closest('[data-add-collection]')) {
    const hash = currentHash();
    if (hash) openPicker([hash]);
  }
});

const picker = document.createElement('dialog');
picker.className = 'collection-picker';
picker.innerHTML = `
  <div class="collection-picker-card">
    <div class="collection-picker-head"><strong>Add to collection</strong><button type="button" data-picker-close aria-label="Close">×</button></div>
    <input data-picker-input type="text" maxlength="80" autocomplete="off" placeholder="Find or create a collection">
    <div class="collection-picker-options"></div>
    <button type="button" class="collection-create" data-create-collection hidden></button>
  </div>`;
document.body.append(picker);
const pickerInput = picker.querySelector('[data-picker-input]');
const pickerOptions = picker.querySelector('.collection-picker-options');
const createButton = picker.querySelector('[data-create-collection]');

function renderPickerOptions() {
  if (!pickerOptions) return;
  const query = pickerInput.value.trim().toLowerCase();
  const matches = collections.filter(item => !query || item.name.toLowerCase().includes(query));
  pickerOptions.innerHTML = matches.map(item => `<button type="button" data-pick-collection="${item.id}"><span>${escapeHtml(item.name)}</span><small>${Number(item.count || 0).toLocaleString()}</small></button>`).join('');
  const exact = query && collections.some(item => item.name.toLowerCase() === query);
  createButton.hidden = !query || exact;
  if (!createButton.hidden) createButton.textContent = `Create “${pickerInput.value.trim()}”`;
}

function openPicker(hashes) {
  pickerHashes = [...new Set(hashes)].filter(hash => /^[a-f0-9]{64}$/.test(hash));
  if (!pickerHashes.length) return;
  pickerInput.value = '';
  renderPickerOptions();
  if (!picker.open) picker.showModal();
  requestAnimationFrame(() => pickerInput.focus());
}

function closePicker() {
  pickerHashes = [];
  if (picker.open) picker.close();
}

picker.querySelector('[data-picker-close]').addEventListener('click', closePicker);
picker.addEventListener('click', event => { if (event.target === picker) closePicker(); });
pickerInput.addEventListener('input', renderPickerOptions);

async function addHashes(id, hashes) {
  for (let index = 0; index < hashes.length; index += 1000) {
    await json(`/api/collections/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      body: { hashes: hashes.slice(index, index + 1000) }
    });
  }
  if (String(activeId) === String(id)) {
    if (!activeHashes) activeHashes = new Set();
    hashes.forEach(hash => activeHashes.add(hash));
    window.mochimonoSetCollectionHashes?.(activeHashes);
  }
}

async function chooseCollection(id) {
  const hashes = [...pickerHashes];
  if (!hashes.length) return;
  await addHashes(id, hashes);
  closePicker();
  await refreshCollections();
  if (!viewer.hidden && hashes.includes(currentHash())) await renderViewerMemberships();
}

pickerOptions.addEventListener('click', event => {
  const button = event.target.closest('[data-pick-collection]');
  if (button) chooseCollection(button.dataset.pickCollection).catch(error => alert(error.message));
});

async function createAndChoose() {
  const name = pickerInput.value.trim();
  if (!name) return;
  const item = await json('/api/collections', { method: 'POST', body: { name } });
  await chooseCollection(item.id);
}

createButton.addEventListener('click', () => createAndChoose().catch(error => alert(error.message)));
pickerInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const query = pickerInput.value.trim().toLowerCase();
  const exact = collections.find(item => item.name.toLowerCase() === query);
  (exact ? chooseCollection(exact.id) : createAndChoose()).catch(error => alert(error.message));
});

window.addEventListener('mochimono:add-to-collection', event => openPicker(event.detail?.hashes || []));

async function bootCollections() {
  if (loaded || app.hidden) return;
  try {
    await refreshCollections();
    loaded = true;
    const wanted = new URL(location.href).searchParams.get('collection');
    if (wanted && collections.some(item => String(item.id) === wanted)) await setActiveCollection(wanted, false);
    else if (wanted) updateCollectionUrl('');
  } catch (error) {
    console.warn(error);
  }
}

new MutationObserver(bootCollections).observe(app, { attributes: true, attributeFilter: ['hidden'] });
bootCollections();
