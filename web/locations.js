import { normalizeText } from './search-query.js';

const select = document.querySelector('#locationFilter');
const library = () => window.mochimonoLibrary;
let definitions = [];
let drives = [];
let copies = new Map();
let driveHashes = new Map();
let serverHashes = new Set();
let lastRefresh = 0;

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const words = value => normalizeText(value).split(' ').filter(Boolean);
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

function renderOptions() {
  const current = select.value;
  const local = definitions.filter(location => location.kind === 'local');
  select.innerHTML = `
    <option value="">All locations</option>
    <option value="server">Mochimono Server</option>
    ${local.length ? '<option value="local">All local folders</option>' : ''}
    <option value="backup">Backups</option>
    <option value="unbacked">Not backed up</option>
    ${local.length ? `<optgroup label="On this device">${local.map(location => `<option value="folder:${location.id}">${escapeHtml(location.name)}${location.protected === false ? ' · Browse' : ''}${location.available === false ? ' · Offline' : ''}</option>`).join('')}</optgroup>` : ''}
    ${drives.length ? `<optgroup label="Backup drives">${drives.map(drive => `<option value="drive:${encodeURIComponent(drive.id)}">${escapeHtml(drive.name)}</option>`).join('')}</optgroup>` : ''}`;
  select.value = [...select.options].some(option => option.value === current) ? current : '';
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

async function applySelection() {
  const value = select.value;
  select.title = value === 'local'
    ? 'Files in local folders Mochimono is browsing or protecting on this device'
    : 'Storage location';
  if (!value || value === 'backup' || value === 'unbacked') {
    library()?.setLocationFilter?.(value);
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
  const search = new Map([...copies].map(([hash, locations]) => [hash, locationTokens(locations)]));
  library()?.setLocationSearch?.(search);
  renderOptions();
  await applySelection();
  window.dispatchEvent(new CustomEvent('mochimono:locations-updated'));
}

function refreshIfStale() {
  if (Date.now() - lastRefresh > 30_000) refreshLocations();
}

window.mochimonoLocations = {
  forHash(hash) { return copies.get(String(hash)) || []; },
  isServerStored(hash) { return serverHashes.has(String(hash)); },
  allServerStored(hashes) { return [...hashes || []].every(hash => serverHashes.has(String(hash))); },
  definitions() { return [...definitions, ...drives.map(drive => ({ id: drive.id, kind: 'backup', name: drive.name, available: null, lastSeen: drive.lastSeen }))]; },
  refresh: refreshLocations
};

select.addEventListener('change', () => applySelection().catch(console.error));
refreshLocations().catch(console.error);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
window.addEventListener('focus', refreshIfStale, { passive: true });
