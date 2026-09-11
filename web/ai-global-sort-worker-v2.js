self.postMessage({ type:'progress', done:0, total:1, detail:'Starting AI sort worker…', stage:'startup' });

let child = null;
let canceled = false;
const RUN_REVISION = new URL(self.location.href).searchParams.get('run') || `${Date.now()}`;

const childUrl = path => {
  const url = new URL(path, import.meta.url);
  url.searchParams.set('run', RUN_REVISION);
  return url;
};

const stopChild = () => {
  if (!child) return;
  try { child.postMessage({ action:'cancel' }); } catch {}
  try { child.terminate(); } catch {}
  child = null;
};

function runWorker(path, message, onMessage) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(childUrl(path), { type:'module' });
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
    './ai-global-sort-worker-core-v5.js',
    { action:'sort', payload },
    result => result
  );
  if (canceled || mode !== 'color') return base;

  // Color is the invariant of this mode. Keep the base palette flow, then do
  // only palette-local family healing. The older global family/gap passes could
  // move visually similar but differently colored media across the spectrum.
  try {
    const guarded = await runWorker(
      './ai-global-color-palette-guard-worker.js',
      { action:'guard', payload:{ media:payload.media, result:base } },
      result => result
    );
    self.postMessage({
      type:'progress',
      done:Array.isArray(payload?.media) ? payload.media.length : 1,
      total:Array.isArray(payload?.media) ? payload.media.length : 1,
      detail:`Color palette final · ${(Number(guarded.paletteGuardRuns)||0).toLocaleString()} local runs · ${(Number(guarded.paletteGuardMoved)||0).toLocaleString()} positions stabilized`,
      stage:'palette-guard'
    });
    return guarded;
  } catch (error) {
    if (canceled || error?.name === 'AbortError') throw error;
    self.postMessage({ type:'progress', done:1, total:1, detail:`Color palette guard skipped · ${error.message || error}`, stage:'palette-guard' });
    return base;
  }
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