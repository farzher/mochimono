self.postMessage({ type:'progress', done:0, total:1, detail:'Starting AI sort worker…', stage:'startup' });

let child = null;
let canceled = false;

const stopChild = () => {
  if (!child) return;
  try { child.postMessage({ action:'cancel' }); } catch {}
  try { child.terminate(); } catch {}
  child = null;
};

function runWorker(url, message, onMessage) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(url, import.meta.url), { type:'module' });
    child = worker;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (child === worker) child = null;
      try { worker.terminate(); } catch {}
      fn(value);
    };
    worker.onerror = event => finish(reject, new Error(event.message || 'AI sort child worker failed'));
    worker.onmessageerror = () => finish(reject, new Error('AI sort child worker returned unreadable data'));
    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'progress') {
        self.postMessage(data);
        return;
      }
      if (data.type === 'error') {
        const error = new Error(data.error || 'AI sort child worker failed');
        if (data.aborted) error.name = 'AbortError';
        finish(reject, error);
        return;
      }
      if (data.type === 'result') finish(resolve, onMessage ? onMessage(data.result || {}) : (data.result || {}));
    };
    worker.postMessage(message);
  });
}

async function sort(payload) {
  const mode = String(payload?.mode || 'flow');
  const base = await runWorker(
    './ai-global-sort-worker-core-v5.js?v=20260911-3',
    { action:'sort', payload },
    result => result
  );
  if (canceled || mode !== 'color') return base;

  self.postMessage({
    type:'progress',
    done:0,
    total:Array.isArray(payload?.media) ? payload.media.length : 1,
    detail:'Locking canonical visual families into Color order…',
    stage:'families'
  });

  return runWorker(
    './ai-global-color-family-worker.js?v=20260911-1',
    { action:'consolidate', payload:{ media:payload.media, result:base } },
    result => result
  );
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.action === 'cancel') {
    canceled = true;
    stopChild();
    return;
  }
  if (data.action !== 'sort') return;

  canceled = false;
  stopChild();
  try {
    const result = await sort(data.payload || {});
    if (canceled) return;
    self.postMessage({ type:'result', result });
  } catch (error) {
    if (canceled || error?.name === 'AbortError') {
      self.postMessage({ type:'error', error:'Canceled', aborted:true });
      return;
    }
    self.postMessage({ type:'error', error:String(error?.message || error) });
  }
};
