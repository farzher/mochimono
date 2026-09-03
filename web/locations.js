import { normalizeText } from './search-query.js';
import './protection-indicators.js';

const select = document.querySelector('#locationFilter');
const source = document.querySelector('#source');
const collection = document.querySelector('#collectionFilter');
const folderbar = document.querySelector('#folderbar');
const searchInput = document.querySelector('#search');
const library = () => window.mochimonoLibrary;
let definitions = [];
let drives = [];
let copies = new Map();
let driveHashes = new Map();
let serverHashes = new Set();
let damagedServer = new Set();
let backed = new Set();
let verifiedBacked = new Set();
let locationSearch = new Map();
let locationSearchGeneration = 0;
let appliedLocationSearchGeneration = 0;
let lastRefresh = 0;
let lastVersion = '';

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]);
const words = value => normalizeText(value).split(' ').filter(Boolean);
const count = set => Number(set?.size || 0).toLocaleString();

function locationTokens(locations) {
  const parts = ['__location__local'];
  for (const location of locations) {
    const text = `${location.name || ''} ${location.deviceName || ''} ${location.rootPath || ''}`;
    parts.push(...words(text).map(word => `__location__${word}`));
    parts.push(normalizeText(text));
  }
  return [...new Set(parts.filter(Boolean))].join(' ');
}

function locationCopies(data) {
  const byId = new Map((data.locations || []).map(location => [location.id, location]));
  const result = new Map();
  for (const [hash, id, path] of data.files || []) {
    const location = byId.get(id);
    if (!location) continue;
    if (!result.has(hash)) result.set(hash, []);
    result.get(hash).push({ ...location, relativePath: path });
  }
  return result;
}

function syncOrganizationLabels() {
  source?.setAttribute('aria-label', 'Origin');
  if (source?.options[0]) source.options[0].textContent = 'Origin';
  collection?.setAttribute('aria-label', 'Tags and groups');
  if (collection?.options[0]) collection.options[0].textContent = 'Groups';
  const home = folderbar?.querySelector('[data-folder-home]');
  if (home?.textContent === 'Sources') home.textContent = 'Origins';
}

function renderOptions() {
  const current = select.value;
  const local = definitions.filter(location => location.kind === 'local');
  select.innerHTML = `
    <option value="">Everywhere</option>
    <option value="local">On this PC · ${count(new Set(copies.keys()))}</option>
    <option value="server">Mochimono · ${count(serverHashes)}</option>
    <option value="backup">Backup copies · ${count(backed)}</option>
    ${local.length ? `<optgroup label="Folders on this PC">${local.map(location => `<option value="folder:${location.id}">${escapeHtml(location.name)}${location.protected === false ? ' · Browse only' : ''}${location.available === false ? ' · Offline' : ''}</option>`).join('')}</optgroup>` : ''}
    ${drives.length ? `<optgroup label="Backup locations">${drives.map(drive => `<option value="drive:${encodeURIComponent(drive.id)}">${escapeHtml(drive.name)}</option>`).join('')}</optgroup>` : ''}`;
  select.value = [...select.options].some(option => option.value === current) ? current : '';
  select.setAttribute('aria-label', 'Where files are stored');
  select.title = 'Where files are stored';
  syncOrganizationLabels();
}

async function backupFiles(id) {
  if (driveHashes.has(id)) return driveHashes.get(id);
  const hashes = new Set();
  const verified = new Set();
  let after = '';
  do {
    const response = await fetch(`/api/drives/${encodeURIComponent(id)}/files?limit=5000&after=${encodeURIComponent(after)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read backup location (${response.status})`);
    const page = await response.json();
    for (const file of page.files || []) {
      hashes.add(file.hash);
      if (file.verifiedAt) verified.add(file.hash);
    }
    after = page.nextAfter || '';
  } while (after);
  const result = { hashes, verified };
  driveHashes.set(id, result);
  return result;
}

async function damagedPrimaryHashes() {
  const hashes = new Set();
  let after = '';
  try {
    do {
      const response = await fetch(`/api/integrity/bad?limit=5000&after=${encodeURIComponent(after)}`, { cache: 'no-store' });
      if (!response.ok) return hashes;
      const page = await response.json();
      for (const object of page.objects || []) hashes.add(object.hash);
      after = page.nextAfter || '';
    } while (after);
  } catch {}
  return hashes;
}

async function providerVersion() {
  try {
    const response = await fetch('/api/catalog/version', { cache: 'no-store' });
    if (!response.ok) return '';
    return String((await response.json()).version || '');
  } catch { return ''; }
}

async function rebuildBackupSets() {
  backed = new Set();
  verifiedBacked = new Set();
  await Promise.all(drives.map(async drive => {
    try {
      const backup = await backupFiles(String(drive.id));
      for (const hash of backup.hashes) backed.add(hash);
      for (const hash of backup.verified) verifiedBacked.add(hash);
    } catch {}
  }));
}

async function applySelection() {
  const value = select.value;
  if (!value) return library()?.setLocationFilter?.('');
  if (value === 'server') return library()?.setLocationFilter?.('server-only', serverHashes);
  if (value === 'local') return library()?.setLocationFilter?.('local', new Set(copies.keys()));
  if (value === 'backup') return library()?.setLocationFilter?.('backup-known', backed);
  if (value.startsWith('folder:')) {
    const id = value.slice(7);
    const hashes = new Set([...copies].filter(([, locations]) => locations.some(location => location.id === id)).map(([hash]) => hash));
    return library()?.setLocationFilter?.(value, hashes);
  }
  if (value.startsWith('drive:')) {
    const id = decodeURIComponent(value.slice(6));
    return library()?.setLocationFilter?.(value, (await backupFiles(id)).hashes);
  }
}

function installLocationSearch() {
  if (appliedLocationSearchGeneration === locationSearchGeneration) return;
  const target = library();
  if (!target?.setLocationSearch) return;
  target.setLocationSearch(locationSearch);
  appliedLocationSearchGeneration = locationSearchGeneration;
}

export async function refreshLocations(force = false) {
  if (!force && Date.now() - lastRefresh < 30_000) return;
  const version = await providerVersion();
  if (!force && lastVersion && version && version === lastVersion) {
    lastRefresh = Date.now();
    return;
  }

  lastRefresh = Date.now();
  let localData = { locations: [], files: [] };
  let driveData = { drives: [] };
  let serverData = { hashes: [] };
  let bad = new Set();
  await Promise.all([
    fetch('/api/client/locations', { cache: 'no-store' }).then(async response => { if (response.ok) localData = await response.json(); }).catch(() => {}),
    fetch('/api/drives', { cache: 'no-store' }).then(async response => { if (response.ok) driveData = await response.json(); }).catch(() => {}),
    fetch('/api/client/server-hashes', { cache: 'no-store' }).then(async response => { if (response.ok) serverData = await response.json(); }).catch(() => {}),
    damagedPrimaryHashes().then(value => { bad = value; })
  ]);

  definitions = localData.locations || [];
  drives = driveData.drives || [];
  damagedServer = bad;
  serverHashes = new Set((serverData.hashes || []).filter(hash => !damagedServer.has(hash)));
  copies = locationCopies(localData);
  driveHashes = new Map();
  await rebuildBackupSets();
  lastVersion = version || lastVersion;

  locationSearch = new Map([...copies].map(([hash, locations]) => [hash, locationTokens(locations)]));
  locationSearchGeneration++;
  if (String(window.mochimonoSearch?.raw?.() || '').trim()) installLocationSearch();

  renderOptions();
  // Refreshing location metadata must not rebuild an unfiltered grid. Applying an
  // empty location filter used to destroy/recreate every visible card on startup,
  // which made already-cached thumbnails visibly repaint.
  if (select.value) await applySelection();
  window.dispatchEvent(new CustomEvent('mochimono:locations-updated', { detail: {
    local: new Set(copies.keys()),
    server: new Set(serverHashes),
    damagedServer: new Set(damagedServer),
    backed: new Set(backed),
    verifiedBacked: new Set(verifiedBacked)
  } }));
}

function refreshIfStale() {
  refreshLocations(false).catch(console.error);
}

window.mochimonoLocations = {
  forHash(hash) { return copies.get(String(hash)) || []; },
  isServerStored(hash) { return serverHashes.has(String(hash)); },
  isServerDamaged(hash) { return damagedServer.has(String(hash)); },
  isBackedUp(hash) { return backed.has(String(hash)); },
  isVerifiedBackup(hash) { return verifiedBacked.has(String(hash)); },
  isSafeToFree() { return false; },
  allServerStored(hashes) { return [...hashes || []].every(hash => serverHashes.has(String(hash))); },
  definitions() {
    return [...definitions, ...drives.map(drive => ({ id: drive.id, kind: 'backup', name: drive.name, available: null, lastSeen: drive.lastSeen }))];
  },
  async select(value) {
    const wanted = String(value || '');
    if (![...select.options].some(option => option.value === wanted)) return false;
    select.value = wanted;
    await applySelection();
    select.dispatchEvent(new CustomEvent('mochimono:where-selected', { bubbles: true, detail: { value: wanted } }));
    return true;
  },
  refresh: () => refreshLocations(true)
};

select.addEventListener('change', () => applySelection().catch(console.error));
searchInput?.addEventListener('pointerdown', installLocationSearch, { passive: true });
searchInput?.addEventListener('focus', installLocationSearch, { passive: true });
searchInput?.addEventListener('input', installLocationSearch, { capture: true });
window.addEventListener('mochimono:catalog-cache-restored', syncOrganizationLabels);
window.addEventListener('mochimono:catalog-updated', syncOrganizationLabels);
window.addEventListener('mochimono:folder-changed', syncOrganizationLabels);
syncOrganizationLabels();
refreshLocations(true).catch(console.error);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
window.addEventListener('focus', refreshIfStale, { passive: true });
