self.postMessage({ type:'progress', done:0, total:1, detail:'Starting neighborhood AI sorter…', stage:'startup' });

await new Promise((resolve, reject) => {
  const request = indexedDB.open('mochimono-visual-similarity', 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('fingerprints')) request.result.createObjectStore('fingerprints', { keyPath:'hash' });
  };
  request.onsuccess = () => { request.result.close(); resolve(); };
  request.onerror = () => reject(request.error);
});

const run = new URL(self.location.href).searchParams.get('run') || Date.now().toString(36);
const url = new URL('./ai-global-sort-worker-v6.js', import.meta.url);
url.searchParams.set('run', run);
await import(url.href);
