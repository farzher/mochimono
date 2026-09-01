const CLIENT = document.documentElement.classList.contains('client-library');
const SNAPSHOT_KEY = 'mochimono-fast-local-v1';
const SNAPSHOT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const READY_LIMIT = 24000;
const FAST_LIMIT = 2000;
const FULL_PAGE_LIMIT = 3000;
const SNAPSHOT_LIMIT = 1200;
const cached = new Map();
const readyThumbs = new Set();
window.mochimonoReadyThumbs = readyThumbs;
let stopped = false;
let saveTimer = 0;
let warmTimer = 0;
let fullCatalogStarted = false;

function needsRestore() {
  const files = document.querySelector('#files');
  if (!files || !cached.size) return false;
  return !files.querySelector('[data-hash]') && /loading|no files/i.test(files.textContent || '');
}

function paint(items) {
  const library = window.mochimonoLibrary;
  if (!library?.upsertMany || !items.length) return false;
  library.upsertMany(items);
  window.mochimonoFastLocalHashes = new Set(cached.keys());
  window.dispatchEvent(new CustomEvent('mochimono:fast-local', { detail: { count: items.length } }));
  return true;
}

function snapshotFiles() {
  const time = file => new Date(file?.fileDate || file?.createdAt || 0).getTime() || 0;
  return [...cached.values()].sort((a, b) => time(b) - time(a)).slice(0, SNAPSHOT_LIMIT);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const ready = [...readyThumbs];
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        savedAt: Date.now(),
        files: snapshotFiles(),
        ready: ready.slice(Math.max(0, ready.length - READY_LIMIT))
      }));
    } catch {}
  }, 120);
}

function publishReady(hashes = readyThumbs) {
  window.mochimonoReadyThumbs = readyThumbs;
  window.dispatchEvent(new CustomEvent('mochimono:ready-thumbs', { detail: { hashes: [...hashes] } }));
  scheduleSave();
}

window.mochimonoRememberReadyThumbs = hashes => {
  const added = [];
  for (const value of hashes || []) {
    const hash = String(value || '');
    if (!/^[a-f0-9]{64}$/.test(hash) || readyThumbs.has(hash)) continue;
    readyThumbs.add(hash);
    added.push(hash);
  }
  if (added.length) publishReady(added);
};

window.addEventListener('mochimono:ready-thumb-missed', event => {
  const hash = String(event.detail?.hash || '');
  if (hash && readyThumbs.delete(hash)) scheduleSave();
});

function restoreSnapshot() {
  if (!CLIENT) return;
  try {
    const snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');
    if (!snapshot || Date.now() - Number(snapshot.savedAt || 0) > SNAPSHOT_MAX_AGE) return;
    for (const hash of snapshot.ready || []) {
      if (/^[a-f0-9]{64}$/.test(String(hash))) readyThumbs.add(String(hash));
    }
    const files = Array.isArray(snapshot.files) ? snapshot.files : [];
    if (files.length) applyFiles(files, false);
  } catch {}
}

function applyFiles(files, persist = true) {
  const fresh = [];
  for (const file of files) {
    const hash = String(file?.hash || '');
    if (!hash) continue;
    const previous = cached.get(hash);
    if (!previous) fresh.push(file);
    cached.set(hash, previous ? { ...previous, ...file } : file);
  }
  const painted = fresh.length ? paint(fresh) : needsRestore() ? paint([...cached.values()]) : false;
  if (persist && files.length) scheduleSave();
  return painted;
}

function restoreNow() {
  if (needsRestore()) paint([...cached.values()]);
}

function mediaFiles(items) {
  return items.filter(file => /^(image|video)\//.test(String(file?.mime || '')));
}

async function refreshReadyThumbs(items = [...cached.values()]) {
  if (!CLIENT || stopped || document.hidden) return;
  const media = mediaFiles(items);
  if (!media.length) return;
  const discovered = [];
  for (let offset = 0; offset < media.length; offset += 500) {
    try {
      const response = await fetch('/api/thumbs/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ background: true, hashes: media.slice(offset, offset + 500).map(file => file.hash) })
      });
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of data.thumbnails || []) {
        const hash = String(item.hash || '');
        // Local originals are reported as immediately displayable with 0x0
        // dimensions. Positive dimensions mean a real cached preview exists.
        if (!hash || !(Number(item.width) > 0 && Number(item.height) > 0) || readyThumbs.has(hash)) continue;
        readyThumbs.add(hash);
        discovered.push(hash);
      }
    } catch {}
  }
  if (discovered.length) publishReady(discovered);
}

function scheduleWarm(delay) {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => refreshReadyThumbs().catch(() => {}), delay);
}

async function readFastCatalog() {
  if (!CLIENT || stopped || document.hidden) return;
  try {
    const response = await fetch(`/api/client/local-catalog?limit=${FAST_LIMIT}`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    const files = Array.isArray(data.files) ? data.files : [];
    applyFiles(files);
    // Do not bulk-check/generate every preview here. thumbs.js checks the actual
    // visible cards immediately after they render, so those previews get the
    // thumbnail queue first. Background warming starts only after first paint.
  } catch {}
}

async function readCompleteLocalCatalog() {
  if (!CLIENT || stopped || document.hidden || fullCatalogStarted) return;
  fullCatalogStarted = true;
  let offset = 0;
  try {
    while (!stopped && !document.hidden) {
      const response = await fetch(`/api/client/local-catalog?limit=${FULL_PAGE_LIMIT}&offset=${offset}`, { cache: 'no-store' });
      if (!response.ok) break;
      const data = await response.json();
      const files = Array.isArray(data.files) ? data.files : [];
      if (files.length) applyFiles(files);
      if (data.nextOffset == null) break;
      offset = Number(data.nextOffset) || 0;
      // Yield between SQLite/JSON pages so first-paint interaction always wins.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    window.dispatchEvent(new CustomEvent('mochimono:local-catalog-ready', { detail: { count: cached.size } }));
  } catch {}
}

async function fastLocalStart() {
  if (!CLIENT) return;
  const files = document.querySelector('#files');
  if (files) new MutationObserver(restoreNow).observe(files, { childList: true, subtree: false });

  restoreSnapshot();
  if (readyThumbs.size) publishReady();

  readFastCatalog();
  // Let the snapshot/first 2k paint first, then fill the complete indexed local
  // timeline from SQLite instead of waiting for the cloud/provider merge.
  setTimeout(() => readCompleteLocalCatalog().catch(() => {}), 120);
  scheduleWarm(3500);
  setTimeout(() => refreshReadyThumbs().catch(() => {}), 12_000);
  setTimeout(() => refreshReadyThumbs().catch(() => {}), 30_000);

  const started = Date.now();
  const timer = setInterval(() => {
    if (stopped || Date.now() - started > 90_000) {
      stopped = true;
      clearInterval(timer);
      return;
    }
    readFastCatalog();
  }, 1500);
  window.addEventListener('beforeunload', () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(saveTimer);
    clearTimeout(warmTimer);
  }, { once: true });
}

fastLocalStart();
