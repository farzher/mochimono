import { normalizeText } from './search-query.js';

const CLIENT = document.documentElement.classList.contains('client-library');
const locationFilter = document.querySelector('#locationFilter');
const search = document.querySelector('#search');
const BACKGROUND_HYDRATE_DELAY = 10000;
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

function scheduleBackgroundHydrate() {
  if (!CLIENT || locationData || loading || hydrateTimer) return;
  hydrateTimer = setTimeout(() => {
    hydrateTimer = 0;
    if (window.mochimonoGridInteraction?.active?.()) {
      scheduleBackgroundHydrate();
      return;
    }
    loadLocations().catch(() => {});
  }, BACKGROUND_HYDRATE_DELAY);
}

if (CLIENT) {
  // This payload can be tens of MB. requestIdleCallback is not a startup barrier:
  // Chrome can call it almost immediately while network/catalog work is still on
  // the critical path. Load locations immediately only when the user actually
  // asks for location-aware filtering/search. Otherwise wait until the complete
  // catalog has landed, then give the grid a long quiet window first.
  search?.addEventListener('input', () => {
    if (String(search.value || '').trim()) loadLocations().catch(() => {});
  }, { passive:true });

  window.addEventListener('mochimono:catalog-cache-restored', scheduleBackgroundHydrate, { once:true });
  window.addEventListener('mochimono:catalog-updated', scheduleBackgroundHydrate, { once:true });
}

addEventListener('beforeunload', () => {
  if (hydrateTimer) clearTimeout(hydrateTimer);
}, { once:true });