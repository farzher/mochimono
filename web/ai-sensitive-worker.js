const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const MODEL_ID = 'onnx-community/nsfw_image_detection-ONNX';
const MODEL_VERSION = 'falconsai-nsfw-v1';
const THUMB_VERSION = 3;
const DB_NAME = 'mochimono-sensitive-ai';
const DB_VERSION = 1;
const STORE = 'scores';
const BATCH_SIZE = 8;
const DEFAULT_THRESHOLD = .65;

let pipelinePromise = null;
let dbPromise = null;
const running = new Map();

const absoluteUrl = path => new URL(path, self.location.origin).href;
const thumbUrl = hash => absoluteUrl(`/api/thumbs/${hash}?v=${THUMB_VERSION}`);
const post = (id, type, payload = {}) => self.postMessage({ id, type, ...payload });
const progress = (id, stage, done = 0, total = 0, detail = '', metrics = null) => post(id, 'progress', { stage, done, total, detail, ...(metrics ? { metrics } : {}) });

function aborted(id) {
  if (running.get(id)?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath:'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('Sensitive score cache transaction aborted'));
});

async function cachedScores() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const rows = await requestResult(tx.objectStore(STORE).getAll());
  await transactionDone(tx).catch(() => {});
  const result = new Map();
  for (const row of rows || []) {
    if (row?.model !== MODEL_VERSION || !row?.hash) continue;
    const score = Number(row.score);
    if (Number.isFinite(score)) result.set(String(row.hash), score);
  }
  return result;
}

async function cacheBatch(items) {
  if (!items.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const item of items) {
    store.put({
      id:`${MODEL_VERSION}:${item.hash}`,
      model:MODEL_VERSION,
      hash:item.hash,
      score:item.score,
      updatedAt:Date.now()
    });
  }
  await transactionDone(tx);
}

async function loadClassifier(id) {
  if (pipelinePromise) return pipelinePromise;
  pipelinePromise = (async () => {
    const module = await import(TRANSFORMERS_URL);
    const canWebGpu = Boolean(self.navigator?.gpu);
    const create = async (device, dtype) => {
      progress(id, 'model', 0, 0, `Loading sensitive-content model · ${device === 'webgpu' ? 'GPU' : 'CPU'}…`, { backend:device });
      const pipe = await module.pipeline('image-classification', MODEL_ID, {
        device,
        dtype,
        progress_callback:data => {
          const loaded = Number(data?.loaded) || 0;
          const total = Number(data?.total) || 0;
          const file = String(data?.file || data?.name || '');
          if (total > 0) progress(id, 'model', loaded, total, `Sensitive model${file ? ` · ${file}` : ''}`, { backend:device });
          else if (data?.status) progress(id, 'model', 0, 0, `Sensitive model · ${data.status}`, { backend:device });
        }
      });
      return { pipe, backend:device, dtype };
    };

    if (canWebGpu) {
      try { return await create('webgpu', 'q4'); }
      catch (error) {
        progress(id, 'model', 0, 0, 'GPU model load failed · using CPU fallback');
      }
    }
    return create('wasm', 'q8');
  })().catch(error => { pipelinePromise = null; throw error; });
  return pipelinePromise;
}

function nsfwScore(output) {
  const rows = Array.isArray(output) ? output : [];
  const hit = rows.find(item => String(item?.label || '').trim().toLowerCase() === 'nsfw');
  if (hit && Number.isFinite(Number(hit.score))) return Number(hit.score);
  const normal = rows.find(item => String(item?.label || '').trim().toLowerCase() === 'normal');
  if (normal && Number.isFinite(Number(normal.score))) return 1 - Number(normal.score);
  return 0;
}

async function classifyBatch(pipe, items) {
  const urls = items.map(item => thumbUrl(item.hash));
  const output = await pipe(urls.length === 1 ? urls[0] : urls, { top_k:2 });
  const grouped = urls.length === 1 ? [output] : output;
  return items.map((item, index) => ({ hash:item.hash, score:nsfwScore(grouped?.[index]) }));
}

async function scan(id, payload) {
  const media = [...new Map((payload?.media || [])
    .filter(item => /^[a-f0-9]{64}$/.test(String(item?.hash || '')))
    .map(item => [String(item.hash), { hash:String(item.hash), type:String(item.type || '') }])).values()];
  const threshold = Math.max(.5, Math.min(.95, Number(payload?.threshold) || DEFAULT_THRESHOLD));
  const cache = await cachedScores();
  const scores = new Map();
  const pending = [];

  for (const item of media) {
    const cached = cache.get(item.hash);
    if (Number.isFinite(cached)) scores.set(item.hash, cached);
    else pending.push(item);
  }

  let backend = 'cache';
  let failed = 0;
  if (pending.length) {
    const runtime = await loadClassifier(id);
    backend = runtime.backend;
    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      aborted(id);
      const batch = pending.slice(offset, offset + BATCH_SIZE);
      let classified = [];
      try {
        classified = await classifyBatch(runtime.pipe, batch);
      } catch {
        // A corrupt or unsupported thumbnail should not fail the whole library scan.
        for (const item of batch) {
          aborted(id);
          try { classified.push(...await classifyBatch(runtime.pipe, [item])); }
          catch { failed++; }
        }
      }
      for (const item of classified) scores.set(item.hash, item.score);
      await cacheBatch(classified);
      const done = Math.min(offset + batch.length, pending.length);
      progress(
        id,
        'scan',
        done,
        pending.length,
        `Sensitive scan · ${done.toLocaleString()} / ${pending.length.toLocaleString()} new · ${cache.size.toLocaleString()} cached`,
        { backend }
      );
    }
  } else {
    progress(id, 'scan', media.length, media.length, `Sensitive scan · all ${media.length.toLocaleString()} scores cached`, { backend });
  }

  aborted(id);
  const matches = [];
  for (const item of media) {
    const score = scores.get(item.hash);
    if (!Number.isFinite(score) || score < threshold) continue;
    matches.push({ hash:item.hash, confidence:score, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return {
    matches,
    stats:{
      total:media.length,
      classified:pending.length - failed,
      cached:media.length - pending.length,
      failed,
      threshold,
      model:MODEL_ID
    },
    runtime:{ backend }
  };
}

self.onmessage = async event => {
  const { id, action, payload } = event.data || {};
  if (action === 'cancel') {
    const job = running.get(String(event.data?.cancelId || ''));
    if (job) job.aborted = true;
    return;
  }
  if (!id || action !== 'sensitive') return;
  running.set(String(id), { aborted:false });
  try {
    post(id, 'result', { result:await scan(String(id), payload || {}) });
  } catch (error) {
    post(id, 'error', {
      error:error?.message || String(error),
      aborted:error?.name === 'AbortError'
    });
  } finally {
    running.delete(String(id));
  }
};