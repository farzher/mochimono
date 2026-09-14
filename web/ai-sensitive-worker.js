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
const originalUrl = hash => absoluteUrl(`/api/objects/${hash}`);
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

function cacheId(hash) {
  return `${MODEL_VERSION}:${hash}`;
}

async function cachedScore(hash) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const row = await requestResult(tx.objectStore(STORE).get(cacheId(hash)));
  await transactionDone(tx).catch(() => {});
  if (row?.model !== MODEL_VERSION || row?.hash !== hash || !Number.isFinite(Number(row.score))) return null;
  return row;
}

async function cachedScores() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const rows = await requestResult(tx.objectStore(STORE).getAll());
  await transactionDone(tx).catch(() => {});
  const result = new Map();
  for (const row of rows || []) {
    if (row?.model !== MODEL_VERSION || !row?.hash || !Number.isFinite(Number(row.score))) continue;
    result.set(String(row.hash), row);
  }
  return result;
}

async function cacheBatch(items, runtime = null) {
  if (!items.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const item of items) {
    store.put({
      id:cacheId(item.hash),
      model:MODEL_VERSION,
      hash:item.hash,
      score:item.score,
      labels:Array.isArray(item.labels) ? item.labels : undefined,
      backend:runtime?.backend || item.backend || '',
      dtype:runtime?.dtype || item.dtype || '',
      thumbVersion:THUMB_VERSION,
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
      catch {
        progress(id, 'model', 0, 0, 'GPU model load failed · using CPU fallback');
      }
    }
    return create('wasm', 'q8');
  })().catch(error => { pipelinePromise = null; throw error; });
  return pipelinePromise;
}

function normalizeLabels(output) {
  if (!Array.isArray(output)) return [];
  return output.map(item => ({
    label:String(item?.label || '').trim(),
    score:Number(item?.score)
  })).filter(item => item.label && Number.isFinite(item.score));
}

function labelScore(labels, wanted) {
  const row = labels.find(item => item.label.toLowerCase() === wanted);
  return row && Number.isFinite(row.score) ? row.score : null;
}

function nsfwScore(labels) {
  const nsfw = labelScore(labels, 'nsfw');
  if (nsfw != null) return nsfw;
  const normal = labelScore(labels, 'normal');
  if (normal != null) return 1 - normal;
  return 0;
}

function diagnosticResult(hash, labels, score, source, input, runtime = null, cached = null, threshold = DEFAULT_THRESHOLD) {
  const normal = labelScore(labels, 'normal');
  return {
    hash,
    input,
    source,
    score,
    nsfw:score,
    normal:normal == null ? Math.max(0, Math.min(1, 1 - score)) : normal,
    labels,
    threshold,
    model:MODEL_ID,
    modelVersion:MODEL_VERSION,
    thumbVersion:THUMB_VERSION,
    updatedAt:Number(cached?.updatedAt) || Date.now(),
    runtime:{
      backend:runtime?.backend || cached?.backend || (source === 'cache' ? 'cache' : ''),
      dtype:runtime?.dtype || cached?.dtype || ''
    }
  };
}

async function classifyBatch(pipe, items) {
  const urls = items.map(item => thumbUrl(item.hash));
  const output = await pipe(urls.length === 1 ? urls[0] : urls, { top_k:2 });
  const grouped = urls.length === 1 ? [output] : output;
  return items.map((item, index) => {
    const labels = normalizeLabels(grouped?.[index]);
    return { hash:item.hash, score:nsfwScore(labels), labels };
  });
}

async function inspect(id, payload) {
  const hash = String(payload?.hash || '');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid file hash');
  const threshold = Math.max(.5, Math.min(.95, Number(payload?.threshold) || DEFAULT_THRESHOLD));
  const input = payload?.input === 'original' ? 'original' : 'thumbnail';
  const fresh = Boolean(payload?.fresh) || input === 'original';

  if (!fresh && input === 'thumbnail') {
    const cached = await cachedScore(hash);
    if (cached) {
      const labels = Array.isArray(cached.labels) ? normalizeLabels(cached.labels) : [];
      return diagnosticResult(hash, labels, Number(cached.score), 'cache', input, null, cached, threshold);
    }
  }

  aborted(id);
  const runtime = await loadClassifier(id);
  aborted(id);
  const url = input === 'original' ? originalUrl(hash) : thumbUrl(hash);
  progress(id, 'inspect', 0, 1, `Inspecting ${input === 'original' ? 'original image' : 'scan thumbnail'}…`, { backend:runtime.backend });
  const output = await runtime.pipe(url, { top_k:2 });
  const labels = normalizeLabels(output);
  const score = nsfwScore(labels);
  const result = diagnosticResult(hash, labels, score, 'fresh', input, runtime, null, threshold);
  if (input === 'thumbnail') await cacheBatch([{ hash, score, labels }], runtime);
  progress(id, 'inspect', 1, 1, 'Sensitive score ready', { backend:runtime.backend });
  return result;
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
    const score = Number(cached?.score);
    if (Number.isFinite(score)) scores.set(item.hash, score);
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
        for (const item of batch) {
          aborted(id);
          try { classified.push(...await classifyBatch(runtime.pipe, [item])); }
          catch { failed++; }
        }
      }
      for (const item of classified) scores.set(item.hash, item.score);
      await cacheBatch(classified, runtime);
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
  if (!id || !['sensitive','inspect-sensitive'].includes(action)) return;
  running.set(String(id), { aborted:false });
  try {
    const result = action === 'inspect-sensitive'
      ? await inspect(String(id), payload || {})
      : await scan(String(id), payload || {});
    post(id, 'result', { result });
  } catch (error) {
    post(id, 'error', {
      error:error?.message || String(error),
      aborted:error?.name === 'AbortError'
    });
  } finally {
    running.delete(String(id));
  }
};