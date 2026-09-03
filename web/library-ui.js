const UI_KEY = 'mochimono-library-ui';
const files = document.querySelector('#files');
const folderbar = document.querySelector('#folderbar');
const source = document.querySelector('#source');
const collectionFilter = document.querySelector('#collectionFilter');
const search = document.querySelector('#search');
const typeFilter = document.querySelector('#typeFilter');
const sort = document.querySelector('#sort');
const selectToggle = document.querySelector('#selectFiles');
const selectionBar = document.querySelector('#selectionBar');
const selectionCount = document.querySelector('#selectionCount');
const selectAll = document.querySelector('#selectAll');
const selectionCollection = document.querySelector('#selectionCollection');
const selectionDelete = document.querySelector('#selectionDelete');
const selectionIgnore = document.querySelector('#selectionIgnore');
const selectionClear = document.querySelector('#selectionClear');

let selectionMode = false;
let anchorHash = '';
let selected = new Set();
let timelineFrame = 0;
let timelineMembership = null;
let mutationUiPending = false;

const currentView = () => document.querySelector('#views [data-view].active')?.dataset.view || 'grid';
const allServerStored = hashes => window.mochimonoLocations?.allServerStored?.(hashes) ?? true;
const gridMoving = () => Boolean(window.mochimonoGridInteraction?.active?.());

function saveUi() {
  localStorage.setItem(UI_KEY, JSON.stringify({ view: currentView(), sort: sort.value, type: typeFilter.value }));
}

function restoreUi() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch {}
  if (['date-desc','date-added','date-asc','size-desc'].includes(saved.sort)) {
    sort.value = saved.sort;
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (['','media','image','video','audio','application','other'].includes(saved.type)) {
    typeFilter.value = saved.type;
    typeFilter.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (['grid','list','folders'].includes(saved.view)) document.querySelector(`#views [data-view="${saved.view}"]`)?.click();
}

function syncSelectedClasses() {
  if (!selected.size) {
    for (const item of files.querySelectorAll('.selected[data-hash]')) item.classList.remove('selected');
    return;
  }
  files.querySelectorAll('[data-hash]').forEach(item => item.classList.toggle('selected', selected.has(item.dataset.hash)));
}

function groupState(hashes) {
  if (!hashes?.length) return 'none';
  let count = 0;
  for (const hash of hashes) if (selected.has(hash)) count++;
  return count === 0 ? 'none' : count === hashes.length ? 'all' : 'partial';
}

function periodKey(hash, period) {
  const dates = window.mochimonoFileDates?.get(hash);
  const value = sort.value === 'date-added' ? dates?.addedAt || dates?.fileDate : dates?.fileDate;
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear());
  if (period === 'year') return year;
  const month = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  if (period === 'month') return month;
  return `${month}-${String(date.getDate()).padStart(2, '0')}`;
}

function invalidateTimelineMembership() {
  timelineMembership = null;
}

function ensureTimelineMembership() {
  if (timelineMembership) return timelineMembership;
  const membership = new Map();
  const hashes = window.mochimonoLibrary?.filteredHashes?.() || renderedHashes();
  for (const hash of hashes) {
    for (const period of ['year','month','day']) {
      const key = periodKey(hash, period);
      if (!key) continue;
      const id = `${period}:${key}`;
      let group = membership.get(id);
      if (!group) membership.set(id, group = []);
      group.push(hash);
    }
  }
  timelineMembership = membership;
  return membership;
}

function syncTimelineSelection() {
  const buttons = files.querySelectorAll('[data-select-period]');
  if (!selected.size) {
    for (const button of buttons) {
      button.classList.remove('selected','partial');
      button.setAttribute('aria-pressed','false');
      const label = button.dataset.periodLabel || button.textContent.trim();
      button.title = `Select ${label}`;
    }
    return;
  }

  const membership = ensureTimelineMembership();
  for (const button of buttons) {
    const hashes = membership.get(`${button.dataset.selectPeriod}:${button.dataset.periodKey}`) || [];
    const state = groupState(hashes);
    button.classList.toggle('selected', state === 'all');
    button.classList.toggle('partial', state === 'partial');
    button.setAttribute('aria-pressed', state === 'all' ? 'true' : 'false');
    const label = button.dataset.periodLabel || button.textContent.trim();
    button.title = state === 'all' ? `Deselect ${label}` : `Select ${label}`;
  }
}

function syncSelectionUi() {
  const count = selected.size;
  const active = selectionMode || count > 0;
  const mutable = count > 0 && allServerStored(selected);
  selectionBar.hidden = !active;
  document.documentElement.classList.toggle('selection-active', active);
  selectToggle.classList.toggle('active', selectionMode);
  selectionCount.textContent = count ? `${count.toLocaleString()} selected` : 'Select files';
  selectionCollection.disabled = selectionDelete.disabled = selectionIgnore.disabled = !mutable;
  const title = count && !mutable ? 'This action requires every selected file to be stored on the Mochimono Server.' : '';
  selectionCollection.title = selectionDelete.title = selectionIgnore.title = title;
  syncSelectedClasses();
  syncTimelineSelection();
}

function clearSelection(exit = true) {
  selected.clear();
  anchorHash = '';
  if (exit) selectionMode = false;
  syncSelectionUi();
}

function renderedHashes() {
  return [...files.querySelectorAll('[data-hash]')].map(item => item.dataset.hash);
}

function toggleHash(hash, extend) {
  if (extend && anchorHash) {
    const hashes = renderedHashes();
    const a = hashes.indexOf(anchorHash);
    const b = hashes.indexOf(hash);
    if (a >= 0 && b >= 0) {
      for (const item of hashes.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(item);
      anchorHash = hash;
      return;
    }
  }
  selected.has(hash) ? selected.delete(hash) : selected.add(hash);
  anchorHash = hash;
}

function toggleGroup(hashes) {
  const unique = [...new Set(hashes || [])];
  if (!unique.length) return;
  const remove = unique.every(hash => selected.has(hash));
  for (const hash of unique) remove ? selected.delete(hash) : selected.add(hash);
  anchorHash = '';
  selectionMode = selected.size > 0;
  syncSelectionUi();
}

function groupButton(period, key, label, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `timeline-group-select ${className}`.trim();
  button.dataset.selectPeriod = period;
  button.dataset.periodKey = key;
  button.dataset.periodLabel = label;
  button.setAttribute('aria-label', `Select ${label}`);
  button.innerHTML = `<span class="timeline-check" aria-hidden="true"></span><span>${label}</span>`;
  return button;
}

function decorateTimeline() {
  timelineFrame = 0;
  if (currentView() !== 'grid' || !sort.value.startsWith('date-')) return;
  for (const section of files.querySelectorAll('.date-group[data-date-group]')) {
    const monthKey = section.dataset.dateGroup;
    const year = monthKey.slice(0, 4);
    const yearHeading = section.querySelector(':scope > .year-heading');
    if (yearHeading && !yearHeading.querySelector('[data-select-period]')) {
      const label = yearHeading.textContent.trim();
      yearHeading.replaceChildren(groupButton('year', year, label));
    }
    const monthHeading = section.querySelector(':scope > .date-heading');
    if (monthHeading && !monthHeading.querySelector('[data-select-period]')) {
      const label = monthHeading.textContent.trim();
      monthHeading.replaceChildren(groupButton('month', monthKey, label));
    }
  }
  syncTimelineSelection();
}

function scheduleTimeline() {
  invalidateTimelineMembership();
  if (timelineFrame) return;
  timelineFrame = requestAnimationFrame(decorateTimeline);
}

function syncMutationUi() {
  invalidateTimelineMembership();
  if (gridMoving()) {
    mutationUiPending = true;
    return;
  }
  syncSelectedClasses();
  scheduleTimeline();
}

function flushMutationUi() {
  if (!mutationUiPending) return;
  mutationUiPending = false;
  syncSelectedClasses();
  scheduleTimeline();
}

function breadcrumbPath() {
  return [...folderbar.querySelectorAll('[data-folder-depth]')]
    .filter(button => Number(button.dataset.folderDepth) > 0)
    .map(button => button.textContent.trim()).join('/');
}

async function selectionUniverse() {
  const sourceId = Number(source.value) || 0;
  if (currentView() === 'folders' && sourceId) {
    const response = await fetch(`/api/folders?import=${encodeURIComponent(sourceId)}&path=${encodeURIComponent(breadcrumbPath())}`);
    if (!response.ok) throw new Error('Could not read this folder.');
    return (await response.json()).files.map(file => file.hash);
  }
  return window.mochimonoLibrary?.filteredHashes?.() || renderedHashes();
}

async function deleteSelected(ignore) {
  const hashes = [...selected];
  if (!hashes.length || !allServerStored(hashes)) return;
  const label = ignore ? 'Delete + Ignore' : 'Delete';
  if (!confirm(`${label} ${hashes.length.toLocaleString()} file${hashes.length === 1 ? '' : 's'}?`)) return;

  selectionDelete.disabled = selectionIgnore.disabled = selectAll.disabled = true;
  let next = 0;
  let done = 0;
  const failed = [];
  const succeeded = [];
  await Promise.all(Array.from({ length: Math.min(8, hashes.length) }, async () => {
    while (next < hashes.length) {
      const hash = hashes[next++];
      try {
        const response = await fetch(`/api/objects/${hash}/delete`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ignore })
        });
        if (!response.ok) throw new Error(String(response.status));
        succeeded.push(hash);
      } catch { failed.push(hash); }
      selectionCount.textContent = `Deleting ${++done} / ${hashes.length}`;
    }
  }));

  window.mochimonoLibrary?.remove?.(succeeded);
  clearSelection(true);
  selectAll.disabled = false;
  if (failed.length) alert(`${failed.length.toLocaleString()} file${failed.length === 1 ? '' : 's'} could not be deleted.`);
}

selectToggle.addEventListener('click', () => {
  if (selectionMode || selected.size) clearSelection(true);
  else { selectionMode = true; syncSelectionUi(); }
});
selectionClear.addEventListener('click', () => clearSelection(true));
selectAll.addEventListener('click', async () => {
  selectionMode = true;
  selectAll.disabled = true;
  selectionCount.textContent = 'Selecting…';
  try { selected = new Set(await selectionUniverse()); }
  catch (error) { alert(error.message); }
  finally { anchorHash = ''; selectAll.disabled = false; syncSelectionUi(); }
});
selectionCollection.addEventListener('click', () => {
  if (selected.size && allServerStored(selected)) window.dispatchEvent(new CustomEvent('mochimono:add-to-collection', { detail: { hashes: [...selected] } }));
});
selectionDelete.addEventListener('click', () => deleteSelected(false));
selectionIgnore.addEventListener('click', () => deleteSelected(true));

files.addEventListener('click', event => {
  const group = event.target.closest('[data-select-period]');
  if (group) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const membership = ensureTimelineMembership();
    toggleGroup(membership.get(`${group.dataset.selectPeriod}:${group.dataset.periodKey}`));
    return;
  }
  const item = event.target.closest('[data-hash]');
  if (!item || (!selectionMode && !event.ctrlKey && !event.metaKey && !event.shiftKey)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  selectionMode = true;
  toggleHash(item.dataset.hash, event.shiftKey);
  syncSelectionUi();
}, true);

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.querySelector('#viewer').hidden && (selectionMode || selected.size)) clearSelection(true);
});
for (const control of [sort, typeFilter]) control.addEventListener('change', () => { saveUi(); scheduleTimeline(); });
document.querySelector('#views').addEventListener('click', event => {
  if (!event.target.closest('[data-view]')) return;
  clearSelection(true);
  setTimeout(() => { saveUi(); scheduleTimeline(); });
});
for (const control of [source, collectionFilter]) control.addEventListener('change', () => { invalidateTimelineMembership(); clearSelection(true); });
search.addEventListener('input', () => { invalidateTimelineMembership(); if (selected.size) clearSelection(true); });
document.querySelector('#mediaSize')?.addEventListener('input', scheduleTimeline);
window.addEventListener('resize', scheduleTimeline, { passive: true });
window.addEventListener('mochimono:locations-updated', () => { syncSelectionUi(); });
window.addEventListener('mochimono:grid-interaction-end', flushMutationUi);
new MutationObserver(syncMutationUi).observe(files, { childList: true });

window.mochimonoSelection = {
  hashes: () => [...selected],
  clear: () => clearSelection(true),
  count: () => selected.size
};

restoreUi();
syncSelectionUi();
scheduleTimeline();
