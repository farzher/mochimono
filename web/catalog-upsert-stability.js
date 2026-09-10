let wrappedLibrary = null;
const signatures = new Map();
const lastSearchText = new Map();
const metrics = { accepted:0, skipped:0, resets:0 };

function normalizedIds(value) {
  return Array.isArray(value) ? [...new Set(value.map(Number).filter(Number.isFinite))].sort((a, b) => a - b).join(',') : '';
}

function signature(file) {
  return JSON.stringify([
    String(file?.hash || ''),
    String(file?.filename || ''),
    Number(file?.size) || 0,
    String(file?.mime || ''),
    Number(file?.width) || 0,
    Number(file?.height) || 0,
    Number(file?.duration) || 0,
    String(file?.rootPath || ''),
    String(file?.originalPath || ''),
    String(file?.fileDate || ''),
    String(file?.createdAt || ''),
    String(file?.addedAt || ''),
    Boolean(file?.localAvailable),
    Boolean(file?.localManaged),
    Boolean(file?.cloudBacked),
    normalizedIds(file?.importIds),
    normalizedIds(file?.exactImportIds),
    String(file?.searchText || '')
  ]);
}

function reset() {
  signatures.clear();
  lastSearchText.clear();
  metrics.resets++;
}

function install() {
  const library = window.mochimonoLibrary;
  if (!library) {
    requestAnimationFrame(install);
    return;
  }
  if (wrappedLibrary === library || typeof library.upsertMany !== 'function') return;
  wrappedLibrary = library;

  const originalUpsertMany = library.upsertMany.bind(library);
  const originalRemove = typeof library.remove === 'function' ? library.remove.bind(library) : null;

  library.upsertMany = items => {
    if (!items?.length) return;
    const accepted = [];
    for (const raw of items) {
      const hash = String(raw?.hash || '');
      if (!hash) continue;
      const nextSignature = signature(raw);
      if (signatures.get(hash) === nextSignature) {
        metrics.skipped++;
        continue;
      }

      const searchText = String(raw?.searchText || '');
      const repeatedSearch = lastSearchText.has(hash) && lastSearchText.get(hash) === searchText;
      signatures.set(hash, nextSignature);
      lastSearchText.set(hash, searchText);
      metrics.accepted++;

      // library-app merges incoming searchText into the current record. When an
      // update only changes availability/metadata, do not append the exact same
      // search corpus again and let it grow forever.
      accepted.push(repeatedSearch && searchText ? { ...raw, searchText:'' } : raw);
    }
    if (accepted.length) return originalUpsertMany(accepted);
  };

  if (originalRemove) {
    library.remove = hashes => {
      for (const hash of hashes || []) {
        signatures.delete(String(hash));
        lastSearchText.delete(String(hash));
      }
      return originalRemove(hashes);
    };
  }
}

window.addEventListener('mochimono:catalog-updated', reset);
window.addEventListener('pageshow', event => { if (event.persisted) reset(); });
window.mochimonoCatalogUpsertStability = {
  stats:() => ({ ...metrics, tracked:signatures.size }),
  reset
};

install();
