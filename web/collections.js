const app = document.querySelector('#app');
const source = document.querySelector('#source');
const filter = document.querySelector('#collectionFilter');
const search = document.querySelector('#search');
const typeFilter = document.querySelector('#typeFilter');
const sort = document.querySelector('#sort');
const views = document.querySelector('#views');
const strip = document.querySelector('#collectionStrip');
const viewer = document.querySelector('#viewer');
const viewerOpen = document.querySelector('#viewer-open');
const viewerCollections = document.querySelector('#viewerCollections');
const viewerClose = document.querySelector('#viewer-close');
const RECENT_KEY = 'mochimono-recent-collections';

let collections = [];
let smartCollections = [];
let activeKey = '';
let activeHashes = null;
let loaded = false;
let applyingSmart = false;
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

const smartKey = id => `s${id}`;
const isSmartKey = key => /^s\d+$/.test(String(key || ''));
const smartId = key => Number(String(key).slice(1));

function itemForKey(key) {
  if (isSmartKey(key)) return smartCollections.find(item => Number(item.id) === smartId(key));
  return collections.find(item => String(item.id) === String(key));
}

function currentHash() {
  const match = viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/);
  return match?.[1] || '';
}

function currentView() {
  return views.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function rawSearch() {
  return window.mochimonoSearch?.raw?.() ?? search.value;
}

function selectedSourceName() {
  return source.value ? source.selectedOptions[0]?.textContent?.trim() || '' : '';
}

function currentSpec() {
  return {
    query: rawSearch().trim(),
    type: typeFilter.value,
    sourceName: selectedSourceName(),
    sort: sort.value
  };
}

function saveableView() {
  if (currentView() === 'folders' || activeKey) return false;
  const spec = currentSpec();
  return Boolean(spec.query || spec.type || spec.sourceName);
}

function readRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function rememberRecent(key) {
  if (!key || !itemForKey(key)) return;
  const next = [String(key), ...readRecent().filter(item => item !== String(key))].slice(0, 5);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  renderStrip();
}

function renderStrip() {
  if (!strip) return;
  const recent = readRecent().map(key => [key, itemForKey(key)]).filter(([, item]) => item).slice(0, 5);
  const buttons = recent.map(([key, item]) =>
    `<button type="button" data-recent-collection="${escapeHtml(key)}" class="${String(activeKey) === String(key) ? 'active' : ''} ${isSmartKey(key) ? 'smart' : ''}">${isSmartKey(key) ? '<span>✦</span>' : ''}${escapeHtml(item.name)}</button>`
  );
  if (saveableView()) buttons.push('<button type="button" class="save-view" data-save-view>Save view</button>');
  strip.innerHTML = buttons.join('');
  strip.hidden = !buttons.length;
}

function renderFilter() {
  const manual = collections.length
    ? `<optgroup label="Collections">${collections.map(item => `<option value="${item.id}">${escapeHtml(item.name)}${item.count ? ` · ${Number(item.count).toLocaleString()}` : ''}</option>`).join('')}</optgroup>`
    : '';
  const smart = smartCollections.length
    ? `<optgroup label="Smart">${smartCollections.map(item => `<option value="${smartKey(item.id)}">${escapeHtml(item.name)}</option>`).join('')}</optgroup>`
    : '';
  filter.innerHTML = `<option value="">Collections</option>${manual}${smart}`;
  filter.value = itemForKey(activeKey) ? String(activeKey) : '';
  renderStrip();
}

async function refreshCollections() {
  const [manual, smart] = await Promise.all([
    json('/api/collections'),
    json('/api/smart-collections')
  ]);
  collections = manual.collections || [];
  smartCollections = smart.collections || [];
  if (activeKey && !itemForKey(activeKey)) activeKey = '';
  renderFilter();
  renderPickerOptions();
}

function updateCollectionUrl(key) {
  const url = new URL(location.href);
  if (key) {
    url.searchParams.set('collection', key);
    url.searchParams.delete('source');
    url.searchParams.delete('path');
  } else {
    url.searchParams.delete('collection');
  }
  history.replaceState(history.state, '', url);
}

function clearSmartControls() {
  applyingSmart = true;
  source.value = '';
  source.dispatchEvent(new Event('change', { bubbles: true }));
  typeFilter.value = '';
  typeFilter.dispatchEvent(new Event('change', { bubbles: true }));
  sort.value = 'date-desc';
  sort.dispatchEvent(new Event('change', { bubbles: true }));
  window.mochimonoSearch?.setRaw?.('', true);
  applyingSmart = false;
}

function applySmartSpec(spec = {}) {
  applyingSmart = true;
  window.mochimonoSetCollectionHashes?.(null);
  if (currentView() === 'folders') views.querySelector('[data-view="grid"]')?.click();

  const normalize = window.mochimonoSearch?.normalize || (value => String(value || '').toLowerCase().trim());
  const wantedSource = normalize(spec.sourceName || '');
  const sourceOption = wantedSource
    ? [...source.options].find(option => option.value && normalize(option.textContent) === wantedSource)
    : null;
  source.value = sourceOption?.value || '';
  source.dispatchEvent(new Event('change', { bubbles: true }));

  typeFilter.value = ['', 'media', 'image', 'video', 'audio', 'application', 'other'].includes(spec.type) ? spec.type : '';
  typeFilter.dispatchEvent(new Event('change', { bubbles: true }));
  sort.value = ['date-desc', 'date-asc', 'size-desc'].includes(spec.sort) ? spec.sort : 'date-desc';
  sort.dispatchEvent(new Event('change', { bubbles: true }));
  window.mochimonoSearch?.setRaw?.(spec.query || '', true);
  applyingSmart = false;
}

function clearActiveIndicator(updateUrl = true) {
  activeKey = '';
  activeHashes = null;
  filter.value = '';
  window.mochimonoSetCollectionHashes?.(null);
  if (updateUrl) updateCollectionUrl('');
  renderStrip();
}

async function setActiveCollection(key, updateUrl = true) {
  const next = String(key || '');
  const previousWasSmart = isSmartKey(activeKey);

  if (!next) {
    if (previousWasSmart) clearSmartControls();
    clearActiveIndicator(updateUrl);
    return;
  }

  const item = itemForKey(next);
  if (!item) return;

  if (isSmartKey(next)) {
    activeKey = next;
    activeHashes = null;
    filter.value = next;
    applySmartSpec(item.spec || {});
  } else {
    if (previousWasSmart) clearSmartControls();
    activeKey = next;
    filter.value = next;
    const data = await json(`/api/collections/${encodeURIComponent(next)}/hashes`);
    if (activeKey !== next) return;
    activeHashes = new Set(data.hashes || []);
    window.mochimonoSetCollectionHashes?.(activeHashes);
  }

  rememberRecent(next);
  if (updateUrl) updateCollectionUrl(next);
  renderStrip();
}

async function switchFromViewer(key) {
  const next = String(key);
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
  if (applyingSmart) return renderStrip();
  if (activeKey) clearActiveIndicator();
  renderStrip();
});
for (const control of [typeFilter, sort]) control.addEventListener('change', () => {
  if (!applyingSmart && isSmartKey(activeKey)) clearActiveIndicator();
  renderStrip();
});
search.addEventListener('input', () => {
  if (!applyingSmart && isSmartKey(activeKey)) clearActiveIndicator();
  renderStrip();
});
views.addEventListener('click', event => {
  if (!event.target.closest('[data-view="folders"]') || !activeKey) return;
  if (isSmartKey(activeKey)) clearSmartControls();
  clearActiveIndicator();
});

async function fileCollections(hash) {
  const manual = (await json(`/api/collections/file/${hash}`)).collections || [];
  if (!smartCollections.length || !window.mochimonoSearch?.matchesSmart) return { manual, smart: [] };
  let details;
  try { details = await json(`/api/files/${hash}/details`); }
  catch { return { manual, smart: [] }; }
  const smart = smartCollections.filter(item => window.mochimonoSearch.matchesSmart(details, item.spec || {}));
  return { manual, smart };
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
    const manual = memberships.manual.map(item => `
      <span class="viewer-collection-chip">
        <button data-open-collection="${item.id}">${escapeHtml(item.name)}</button>
        <button data-remove-collection="${item.id}" aria-label="Remove from ${escapeHtml(item.name)}">×</button>
      </span>`).join('');
    const smart = memberships.smart.map(item => `
      <span class="viewer-collection-chip smart">
        <button data-open-collection="${smartKey(item.id)}"><span>✦</span>${escapeHtml(item.name)}</button>
      </span>`).join('');
    viewerCollections.innerHTML = manual + smart + '<button class="viewer-collection-add" data-add-collection>+ Collection</button>';
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
    if (String(activeKey) === String(id) && activeHashes) {
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
  if (String(activeKey) === String(id)) {
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

const saveDialog = document.createElement('dialog');
saveDialog.className = 'collection-picker save-view-dialog';
saveDialog.innerHTML = `
  <form method="dialog" class="collection-picker-card" data-save-form>
    <div class="collection-picker-head"><strong>Save view</strong><button type="button" data-save-close aria-label="Close">×</button></div>
    <input data-save-name type="text" maxlength="80" autocomplete="off" placeholder="Collection name" required>
    <div class="save-view-summary" data-save-summary></div>
    <button type="submit" class="collection-create">Save smart collection</button>
  </form>`;
document.body.append(saveDialog);
const saveName = saveDialog.querySelector('[data-save-name]');
const saveSummary = saveDialog.querySelector('[data-save-summary]');

function smartSummary(spec) {
  const parts = [];
  if (spec.query) parts.push(spec.query);
  if (spec.type) parts.push(typeFilter.querySelector(`option[value="${CSS.escape(spec.type)}"]`)?.textContent || spec.type);
  if (spec.sourceName) parts.push(spec.sourceName);
  return parts.join(' · ');
}

function suggestedSmartName(spec) {
  if (spec.query) return spec.query.replace(/\b(name|path|source|type|ext|year):/gi, '').replace(/["']/g, '').trim().slice(0, 80);
  if (spec.type) return typeFilter.querySelector(`option[value="${CSS.escape(spec.type)}"]`)?.textContent?.trim() || spec.type;
  return spec.sourceName.slice(0, 80);
}

function openSaveDialog() {
  if (!saveableView()) return;
  const spec = currentSpec();
  saveName.value = suggestedSmartName(spec);
  saveSummary.textContent = smartSummary(spec);
  saveDialog.showModal();
  requestAnimationFrame(() => {
    saveName.focus();
    saveName.select();
  });
}

saveDialog.querySelector('[data-save-close]').addEventListener('click', () => saveDialog.close());
saveDialog.addEventListener('click', event => { if (event.target === saveDialog) saveDialog.close(); });
saveDialog.querySelector('[data-save-form]').addEventListener('submit', async event => {
  event.preventDefault();
  const name = saveName.value.trim();
  if (!name) return;
  try {
    const item = await json('/api/smart-collections', { method: 'POST', body: { name, spec: currentSpec() } });
    saveDialog.close();
    await refreshCollections();
    await setActiveCollection(smartKey(item.id));
  } catch (error) {
    alert(error.message);
  }
});

strip?.addEventListener('click', event => {
  const recent = event.target.closest('[data-recent-collection]');
  if (recent) return setActiveCollection(recent.dataset.recentCollection).catch(console.error);
  if (event.target.closest('[data-save-view]')) openSaveDialog();
});

window.addEventListener('mochimono:add-to-collection', event => openPicker(event.detail?.hashes || []));

async function bootCollections() {
  if (loaded || app.hidden) return;
  try {
    await refreshCollections();
    loaded = true;
    const wanted = new URL(location.href).searchParams.get('collection');
    if (wanted && itemForKey(wanted)) await setActiveCollection(wanted, false);
    else if (wanted) updateCollectionUrl('');
    renderStrip();
  } catch (error) {
    console.warn(error);
  }
}

new MutationObserver(bootCollections).observe(app, { attributes: true, attributeFilter: ['hidden'] });
bootCollections();
