const run = new URL(self.location.href).searchParams.get('run') || Date.now().toString(36);
const children = new Map();
let active = null;

function childUrl(path) {
  const url = new URL(path, import.meta.url);
  url.searchParams.set('run', run);
  return url;
}

function workerFor(mode) {
  const path = mode === 'families' ? './ai-global-sort-families-worker.js' : './ai-global-sort-worker-v6.js';
  if (children.has(path)) return children.get(path);
  const worker = new Worker(childUrl(path), { type:'module' });
  worker.onmessage = event => {
    if (worker !== active) return;
    self.postMessage(event.data);
  };
  worker.onerror = event => {
    if (worker !== active) return;
    self.postMessage({ type:'error', error:event.message || 'AI sort child worker failed' });
  };
  worker.onmessageerror = () => {
    if (worker !== active) return;
    self.postMessage({ type:'error', error:'AI sort child worker returned unreadable data' });
  };
  children.set(path, worker);
  return worker;
}

function stopAll() {
  for (const worker of children.values()) {
    try { worker.postMessage({ action:'cancel' }); } catch {}
    try { worker.terminate(); } catch {}
  }
  children.clear();
  active = null;
}

self.onmessage = event => {
  const data = event.data || {};
  if (data.action === 'cancel') {
    stopAll();
    return;
  }
  if (data.action !== 'sort') return;
  const mode = String(data.payload?.mode || 'flow');
  active = workerFor(mode);
  active.postMessage(data);
};

self.postMessage({ type:'progress', done:0, total:1, detail:'Neighborhood AI sorter ready…', stage:'startup' });
