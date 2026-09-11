const DB_NAME = 'mochimono-ai';
const DB_VERSION = 2;
const STORE = 'embeddings';
const EMBEDDING_SCHEMA = 3;
const VERSIONS = {
  dinov3:'dinov3-vitb16-v2',
  siglip2:'siglip2-base-224-v2'
};

function recognized(row, key = '') {
  const id = String(row?.id || key || '');
  const model = String(row?.model || '');
  const modelKey = String(row?.modelKey || '');
  if (modelKey === 'dinov3' || model === VERSIONS.dinov3 || id.startsWith(`${VERSIONS.dinov3}:`)) return ['dinov3', VERSIONS.dinov3];
  if (modelKey === 'siglip2' || model === VERSIONS.siglip2 || id.startsWith(`${VERSIONS.siglip2}:`)) return ['siglip2', VERSIONS.siglip2];
  return null;
}

function hashFor(row, key = '', version = '') {
  const direct = String(row?.hash || '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(direct)) return direct;
  const id = String(row?.id || key || '');
  const prefix = `${version}:`;
  const fromId = id.startsWith(prefix) ? id.slice(prefix.length).toLowerCase() : '';
  return /^[a-f0-9]{64}$/.test(fromId) ? fromId : '';
}

async function normalizeIndexRows() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath:'id' });
        store.createIndex('model', 'model', { unique:false });
        store.createIndex('hash', 'hash', { unique:false });
      }
      if (!database.objectStoreNames.contains('metadata')) {
        const metadata = database.createObjectStore('metadata', { keyPath:'id' });
        metadata.createIndex('kind', 'kind', { unique:false });
        metadata.createIndex('hash', 'hash', { unique:false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const stats = { dinov3:0, siglip2:0, repaired:0, incompatible:0 };
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const row = cursor.value || {};
        const match = recognized(row, cursor.primaryKey);
        if (match) {
          const [modelKey, version] = match;
          const hash = hashFor(row, cursor.primaryKey, version);
          const validVector = Boolean(row.vector?.length) && Number(row.schema) === EMBEDDING_SCHEMA;
          if (hash && validVector) {
            stats[modelKey]++;
            const wantedId = `${version}:${hash}`;
            if (row.id !== wantedId || row.model !== version || row.modelKey !== modelKey || row.hash !== hash) {
              store.put({ ...row, id:wantedId, model:version, modelKey, hash });
              if (cursor.primaryKey !== wantedId) store.delete(cursor.primaryKey);
              stats.repaired++;
            }
          } else stats.incompatible++;
        }
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('AI index compatibility check aborted'));
    });
  } finally { db.close(); }
  window.mochimonoAIIndexCompatibility = stats;
  window.dispatchEvent(new CustomEvent('mochimono:ai-index-compatible', { detail:stats }));
  return stats;
}

normalizeIndexRows().catch(error => console.warn('Could not normalize Mochimono AI index metadata.', error));
