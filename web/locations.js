import { normalizeText } from './search-query.js';

const CLIENT = document.documentElement.classList.contains('client-library');
const locationFilter = document.querySelector('#locationFilter');
let locationData = null;
let loading = null;
let hydrateTimer = 0;

const library = () => window.mochimonoLibrary;

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

async function applyFilter() {
  if (!locationFilter) return;
  const mode = String(locationFilter.value || '');
  if (!mode) {
    library()?.setLocationFilter?.('', null);
    return;
  }
  const data = await loadLocations().catch(() => null);
  if (!data) return;
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
  // /api/client/locations can be tens of MB for a large library. It is useful for
  // location search/filtering but not needed to paint or navigate the initial
  // grid, so hydrate it after startup instead of competing with the catalog.
  const hydrate = () => loadLocations().catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(hydrate, { timeout: 5000 });
  else hydrateTimer = setTimeout(hydrate, 2200);
}

addEventListener('beforeunload', () => {
  if (hydrateTimer) clearTimeout(hydrateTimer);
}, { once:true });
