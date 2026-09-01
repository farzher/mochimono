const CLIENT = document.documentElement.classList.contains('client-library');
const SNAPSHOT_KEY = 'mochimono-fast-local-v1';
const SNAPSHOT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const READY_LIMIT = 16000;
const cached = new Map();
const readyThumbs = new Set();
window.mochimonoReadyThumbs = readyThumbs;
let stopped = false;
let saveTimer = 0;
let warmTimer = 0;

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

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const ready = [...readyThumbs];
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        savedAt: Date.now(),
        files: [...cached.values()].slice(0, 720),
        ready: ready.slice(Math.max(0, ready.length - READY_LIMIT))
      }));
    } catch {}
  }, 120);
}

function publishReady() {
  window.mochimonoReadyThumbs = readyThumbs;
  window.dispatchEvent(new CustomEvent('mochimono:ready-thumbs', { detail: { hashes: [...readyThumbs] } }));
  scheduleSave();
}

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
    if (!cached.has(hash)) fresh.push(file);
    else cached.set(hash, { ...cached.get(hash), ...file });
    if (!cached.has(hash)) cached.set(hash, file);
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
  let changed = false;
  for (let offset = 0; offset < media.length; offset += 500) {
    try {
      const response = await fetch('/api/thumbs/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashes: media.slice(offset, offset + 500).map(file => file.hash) })
      });
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of data.thumbnails || []) {
        const hash = String(item.hash || '');
        // Local originals are reported as immediately displayable with 0x0
        // dimensions. Positive dimensions mean a real cached preview exists.
        if (!hash || !(Number(item.width) > 0 && Number(item.height) > 0) || readyThumbs.has(hash)) continue;
        readyThumbs.add(hash);
        changed = true;
      }
    } catch {}
  }
  if (changed) publishReady();
}

function scheduleWarm(delay) {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => refreshReadyThumbs().catch(() => {}), delay);
}

async function readFastCatalog() {
  if (!CLIENT || stopped || document.hidden) return;
  try {
    const response = await fetch('/api/client/local-catalog?limit=720', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    const files = Array.isArray(data.files) ? data.files : [];
    applyFiles(files);
    refreshReadyThumbs(files).catch(() => {});
  } catch {}
}

async function fastLocalStart() {
  if (!CLIENT) return;
  const files = document.querySelector('#files');
  if (files) new MutationObserver(restoreNow).observe(files, { childList: true, subtree: false });

  restoreSnapshot();
  if (readyThumbs.size) publishReady();

  readFastCatalog();
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
