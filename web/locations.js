import { normalizeText } from './search-query.js';

const CLIENT = document.documentElement.classList.contains('client-library');
const locationFilter = document.querySelector('#locationFilter');
const search = document.querySelector('#search');
const DUPLICATE_CACHE_MS = 30_000;
let locationData = null;
let loading = null;
let duplicateHashes = null;
let duplicateLoadedAt = 0;
let duplicateLoading = null;

const library = () => window.mochimonoLibrary;

if (CLIENT && locationFilter && !locationFilter.querySelector('option[value="duplicates"]')) {
  const option = document.createElement('option');
  option.value = 'duplicates';
  option.textContent = 'Duplicates';
  locationFilter.append(option);
}

function locationText(location) {
  return normalizeText(`${location.kind || ''} ${location.name || ''} ${location.deviceName || ''} ${location.rootPath || ''}`);
}

function buildSearch(files = [], locations = []) {
  const byId = new Map(locations.map(item => [item.id, item]));
  const result = new Map();
  for (const item of files) {
    const [hash, locationId, path] = item;
    const location = byId.get(locationId);
    if (!hash || !location) continue;
    const text = normalizeText(`${path || ''} ${location.name || ''} ${location.deviceName || ''} ${location.rootPath || ''}`);
    if (!text) continue;
    result.set(hash, `${result.get(hash) || ''} ${text}`.trim());
  }
  return result;
}

function applyLocations(data) {
  locationData = data;
  library()?.setLocationSearch?.(buildSearch(data.files || [], data.locations || []));
}

async function loadLocations() {
  if (locationData) return locationData;
  if (loading) return loading;
  loading = fetch('/api/client/locations', { cache:'no-store' })
    .then(response => {
      if (!response.ok) throw new Error(`Locations failed (${response.status})`);
      return response.json();
    })
    .then(data => {
      applyLocations(data || {});
      return locationData;
    })
    .finally(() => { loading = null; });
  return loading;
}

async function loadDuplicateHashes(force = false) {
  if (!force && duplicateHashes && Date.now() - duplicateLoadedAt < DUPLICATE_CACHE_MS) return duplicateHashes;
  if (duplicateLoading) return duplicateLoading;
  duplicateLoading = fetch('/api/client/duplicate-stats', { cache:'no-store' })
    .then(response => {
      if (!response.ok) throw new Error(`Duplicate scan failed (${response.status})`);
      return response.json();
    })
    .then(data => {
      duplicateHashes = new Set((data?.hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)));
      duplicateLoadedAt = Date.now();
      return duplicateHashes;
    })
    .finally(() => { duplicateLoading = null; });
  return duplicateLoading;
}

async function applyFilter() {
  if (!locationFilter) return;
  const mode = String(locationFilter.value || '');
  if (!mode) {
    library()?.setLocationFilter?.('', null);
    return;
  }

  if (mode === 'duplicates') {
    const hashes = await loadDuplicateHashes().catch(() => null);
    if (!hashes || String(locationFilter.value || '') !== mode) return;
    library()?.setLocationFilter?.(mode, hashes);
    return;
  }

  const data = await loadLocations().catch(() => null);
  if (!data || String(locationFilter.value || '') !== mode) return;
  const locations = new Map((data.locations || []).map(item => [item.id, item]));
  const hashes = new Set();
  for (const [hash, locationId] of data.files || []) {
    const location = locations.get(locationId);
    if (!location) continue;
    const local = location.kind === 'local';
    const backup = location.kind === 'backup';
    if ((mode === 'local' && local) || (mode === 'backup' && backup) || (mode === 'server' && location.kind === 'server')) hashes.add(hash);
  }
  library()?.setLocationFilter?.(mode, hashes);
}

locationFilter?.addEventListener('change', () => applyFilter().catch(() => {}));

if (CLIENT) {
  // Location provenance can be a large payload, so never hydrate it merely
  // because the Library is open. Load it only when search or a location filter
  // actually needs it.
  search?.addEventListener('input', () => {
    if (String(search.value || '').trim()) loadLocations().catch(() => {});
  }, { passive:true });

  window.addEventListener('mochimono:catalog-updated', () => {
    duplicateHashes = null;
    duplicateLoadedAt = 0;
    if (locationFilter?.value === 'duplicates') applyFilter().catch(() => {});
  });
}
