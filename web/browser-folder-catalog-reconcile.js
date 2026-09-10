const DB_NAME = 'mochimono-browser-folders';
const DB_VERSION = 1;
const FILES = 'files';
const SHA256 = /^[a-f0-9]{64}$/;

function readAllManifests() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onerror = () => reject(open.error || new Error('Browser folder database is unavailable'));
    open.onsuccess = () => {
      const db = open.result;
      let request;
      try { request = db.transaction(FILES, 'readonly').objectStore(FILES).getAll(); }
      catch (error) { db.close(); reject(error); return; }
      request.onerror = () => { db.close(); reject(request.error || new Error('Could not read browser folders')); };
      request.onsuccess = () => {
        const manifests = new Map();
        for (const row of request.result || []) {
          const key = String(row?.key || '');
          const split = key.indexOf('\u0000');
          if (split <= 0) continue;
          const id = key.slice(0, split);
          const path = String(row?.path || key.slice(split + 1));
          const hash = String(row?.hash || '');
          let manifest = manifests.get(id);
          if (!manifest) manifests.set(id, manifest = new Map());
          manifest.set(path, hash);
        }
        db.close();
        resolve(manifests);
      };
    };
  });
}

function browserHashes(manifests) {
  const hashes = new Set();
  for (const manifest of manifests.values()) {
    for (const hash of manifest.values()) if (SHA256.test(hash)) hashes.add(hash);
  }
  return hashes;
}

async function ownedOutsideBrowser(hash) {
  try {
    const response = await fetch(`/api/provenance/${hash}`, { cache:'no-store' });
    // 404 means the Agent/Cloud provider catalog has no other ownership for this
    // content hash. Any other response is treated conservatively as "keep it".
    return response.status !== 404;
  } catch {
    return true;
  }
}

let known = await readAllManifests().catch(() => new Map());
let generation = 0;

async function reconcileSource(id) {
  const mine = ++generation;
  const before = known.get(id) || new Map();
  const current = await readAllManifests().catch(() => null);
  if (!current || mine !== generation) return;
  known = current;
  if (!before.size) return;

  // The IndexedDB manifest is authoritative by source + path. If a path was
  // replaced, renamed, or removed, its previous content hash must not linger in
  // the in-memory Library merely because the Library itself is keyed by hash.
  const liveBrowserHashes = browserHashes(current);
  const stale = [...new Set([...before.values()])]
    .filter(hash => SHA256.test(hash) && !liveBrowserHashes.has(hash));
  if (!stale.length) return;

  const removable = [];
  let cursor = 0;
  const workers = Array.from({ length:Math.min(6, stale.length) }, async () => {
    while (cursor < stale.length) {
      const hash = stale[cursor++];
      if (!await ownedOutsideBrowser(hash)) removable.push(hash);
    }
  });
  await Promise.all(workers);
  if (mine !== generation || !removable.length) return;
  window.mochimonoLibrary?.remove?.(removable);
}

window.addEventListener('mochimono:browser-folder-sync', event => {
  const detail = event.detail || {};
  if (detail.state !== 'done') return;
  const id = String(detail.id || '');
  if (id) void reconcileSource(id);
});
