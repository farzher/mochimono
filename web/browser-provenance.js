const DB_NAME = 'mochimono-browser-folders';
const DB_VERSION = 1;
const SOURCES = 'sources';
const FILES = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES, { keyPath:'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath:'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function all(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function browserSourcesForHash(hash) {
  if (!/^[a-f0-9]{64}$/.test(String(hash || ''))) return [];
  let db;
  try {
    db = await openDb();
    const tx = db.transaction([SOURCES, FILES], 'readonly');
    const [sources, files] = await Promise.all([all(tx.objectStore(SOURCES)), all(tx.objectStore(FILES))]);
    const byId = new Map(sources.map(source => [String(source.id || ''), source]));
    const result = [];
    for (const row of files) {
      if (String(row.hash || '') !== String(hash)) continue;
      const separator = String(row.key || '').indexOf('\u0000');
      const id = separator >= 0 ? String(row.key).slice(0, separator) : '';
      const source = byId.get(id);
      if (!source) continue;
      result.push({
        browser:true,
        browserSourceId:id,
        sourceName:source.name || 'Browser folder',
        deviceName:`Browser · ${source.name || 'Folder'}`,
        rootPath:source.rootPath || source.name || '',
        path:row.path || '',
        filename:String(row.path || '').split('/').at(-1) || row.path || '',
        mtime:Number(row.lastModified) || 0,
        importedAt:source.createdAt || '',
        cloud:Boolean(source.cloud && row.cloudSynced)
      });
    }
    return result;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
