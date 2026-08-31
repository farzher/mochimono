import { normalizeText } from './search-query.js';

const select = document.querySelector('#locationFilter');
const source = document.querySelector('#source');
const collection = document.querySelector('#collectionFilter');
const folderbar = document.querySelector('#folderbar');
const library = () => window.mochimonoLibrary;
let definitions = [];
let drives = [];
let copies = new Map();
let driveHashes = new Map();
let serverHashes = new Set();
let protection = {
  backed: new Set(), safeLocal: new Set(), needs: new Set(), onlyLocal: new Set(), notLocal: new Set()
};
let lastRefresh = 0;

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const words = value => normalizeText(value).split(' ').filter(Boolean);
const count = set => Number(set?.size || 0).toLocaleString();
const union = (...sets) => new Set(sets.flatMap(set => [...(set || [])]));
const locationTokens = locations => {
  const parts = ['__location__local'];
  for (const location of locations) {
    const text = `${location.name || ''} ${location.deviceName || ''} ${location.rootPath || ''}`;
    parts.push(...words(text).map(word => `__location__${word}`));
    parts.push(normalizeText(text));
  }
  return [...new Set(parts.filter(Boolean))].join(' ');
};

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
  if (source?.options[0] && !source.value) source.options[0].textContent = 'Origin';
  collection?.setAttribute('aria-label', 'Tags and groups');
  if (collection?.options[0] && !collection.value) collection.options[0].textContent = 'Groups';
  const home = folderbar?.querySelector('[data-folder-home]');
  if (home?.textContent === 'Sources') home.textContent = 'Origins';
}

function renderOptions() {
  const current = select.value;
  const local = definitions.filter(location => location.kind === 'local');
  const protectionOptions = `
    <optgroup label="Protection">
      <option value="safe-local">Safe to free from this PC · ${count(protection.safeLocal)}</option>
      <option value="needs-protection">Needs protection · ${count(protection.needs)}</option>
      <option value="only-local">Only on this PC · ${count(protection.onlyLocal)}</option>
      <option value="not-local">Not on this PC · ${count(protection.notLocal)}</option>
    </optgroup>`;
  select.innerHTML = `
    <option value="">Everywhere</option>
    <option value="local">This PC · ${count(new Set(copies.keys()))}</option>
    <option value="server">Mochimono · ${count(serverHashes)}</option>
    <option value="backup">Backups · ${count(protection.backed)}</option>
    ${protectionOptions}
    ${local.length ? `<optgroup label="Folders on this PC">${local.map(location => `<option value="folder:${location.id}">${escapeHtml(location.name)}${location.protected === false ? ' · Browse only' : ''}${location.available === false ? ' · Offline' : ''}</option>`).join('')}</optgroup>` : ''}
    ${drives.length ? `<optgroup label="Backup drives">${drives.map(drive => `<option value="drive:${encodeURIComponent(drive.id)}">${escapeHtml(drive.name)}</option>`).join('')}</optgroup>` : ''}`;
  select.value = [...select.options].some(option => option.value === current) ? current : '';
  select.setAttribute('aria-label', 'Where files are stored');
  syncOrganizationLabels();
}

async function backupFiles(id) {
  if (driveHashes.has(id)) return driveHashes.get(id);
  const hashes = new Set();
  let after = '';
  do {
    const response = await fetch(`/api/drives/${encodeURIComponent(id)}/files?limit=5000&after=${encodeURIComponent(after)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read backup location (${response.status})`);
    const page = await response.json();
    for (const file of page.files || []) hashes.add(file.hash);
    after = page.nextAfter || '';
  } while (after);
  driveHashes.set(id, hashes);
  return hashes;
}

async function rebuildProtection() {
  const backed = new Set();
  await Promise.all(drives.map(async drive => {
    try { for (const hash of await backupFiles(String(drive.id))) backed.add(hash); }
    catch {}
  }));
  const local = new Set(copies.keys());
  const known = union(local, serverHashes, backed);
  protection = {
    backed,
    safeLocal: new Set([...local].filter(hash => serverHashes.has(hash) && backed.has(hash))),
    needs: new Set([...known].filter(hash => !serverHashes.has(hash) || !backed.has(hash))),
    onlyLocal: new Set([...local].filter(hash => !serverHashes.has(hash) && !backed.has(hash))),
    notLocal: new Set([...known].filter(hash => !local.has(hash)))
  };
}

async function applySelection() {
  const value = select.value;
  const titles = {
    'safe-local': 'Files on this PC that also exist in Mochimono and on a backup',
    'needs-protection': 'Files missing either the Mochimono copy or an independent backup copy',
    'only-local': 'Files whose only known copy is on this PC',
    'not-local': 'Files with no indexed copy on this PC',
    local: 'Files in folders Mochimono is browsing or protecting on this PC',
    server: 'Files stored in Mochimono',
    backup: 'Files present on at least one backup'
  };
  select.title = titles[value] || 'Where files are stored';
  if (!value) {
    library()?.setLocationFilter?.('');
    return;
  }
  if (value === 'server') {
    library()?.setLocationFilter?.('server-only', serverHashes);
    return;
  }
  if (value === 'local') {
    library()?.setLocationFilter?.('local', new Set(copies.keys()));
    return;
  }
  if (value === 'backup') {
    library()?.setLocationFilter?.('backup-known', protection.backed);
    return;
  }
  if (value === 'safe-local') return library()?.setLocationFilter?.(value, protection.safeLocal);
  if (value === 'needs-protection') return library()?.setLocationFilter?.(value, protection.needs);
  if (value === 'only-local') return library()?.setLocationFilter?.(value, protection.onlyLocal);
  if (value === 'not-local') return library()?.setLocationFilter?.(value, protection.notLocal);
  if (value.startsWith('folder:')) {
    const id = value.slice(7);
    const hashes = new Set([...copies].filter(([, locations]) => locations.some(location => location.id === id)).map(([hash]) => hash));
    library()?.setLocationFilter?.(value, hashes);
    return;
  }
  if (value.startsWith('drive:')) {
    const id = decodeURIComponent(value.slice(6));
    library()?.setLocationFilter?.(value, await backupFiles(id));
  }
}

export async function refreshLocations() {
  lastRefresh = Date.now();
  let localData = { locations: [], files: [] };
  let driveData = { drives: [] };
  let serverData = { hashes: [] };
  await Promise.all([
    fetch('/api/client/locations', { cache: 'no-store' }).then(async response => { if (response.ok) localData = await response.json(); }).catch(() => {}),
    fetch('/api/drives', { cache: 'no-store' }).then(async response => { if (response.ok) driveData = await response.json(); }).catch(() => {}),
    fetch('/api/client/server-hashes', { cache: 'no-store' }).then(async response => { if (response.ok) serverData = await response.json(); }).catch(() => {})
  ]);

  definitions = localData.locations || [];
  drives = driveData.drives || [];
  serverHashes = new Set(serverData.hashes || []);
  copies = locationCopies(localData);
  driveHashes = new Map();
  await rebuildProtection();
  const search = new Map([...copies].map(([hash, locations]) => [hash, locationTokens(locations)]));
  library()?.setLocationSearch?.(search);
  renderOptions();
  await applySelection();
  window.dispatchEvent(new CustomEvent('mochimono:locations-updated', { detail: {
    local: new Set(copies.keys()), server: new Set(serverHashes), ...protection
  } }));
}

function refreshIfStale() {
  if (Date.now() - lastRefresh > 30_000) refreshLocations();
}

window.mochimonoLocations = {
  forHash(hash) { return copies.get(String(hash)) || []; },
  isServerStored(hash) { return serverHashes.has(String(hash)); },
  isBackedUp(hash) { return protection.backed.has(String(hash)); },
  isSafeToFree(hash) { return protection.safeLocal.has(String(hash)); },
  allServerStored(hashes) { return [...hashes || []].every(hash => serverHashes.has(String(hash))); },
  definitions() { return [...definitions, ...drives.map(drive => ({ id: drive.id, kind: 'backup', name: drive.name, available: null, lastSeen: drive.lastSeen }))]; },
  refresh: refreshLocations
};

select.addEventListener('change', () => applySelection().catch(console.error));
new MutationObserver(syncOrganizationLabels).observe(source, { childList: true });
new MutationObserver(syncOrganizationLabels).observe(collection, { childList: true });
new MutationObserver(syncOrganizationLabels).observe(folderbar, { childList: true, subtree: true });
syncOrganizationLabels();
refreshLocations().catch(console.error);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
window.addEventListener('focus', refreshIfStale, { passive: true });
