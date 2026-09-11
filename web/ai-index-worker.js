const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const DB_NAME = 'mochimono-ai';
const DB_VERSION = 2;
const EMBEDDINGS = 'embeddings';
const METADATA = 'metadata';
const THUMB_VERSION = 3;
const EMBEDDING_SCHEMA = 3;
const PREFETCH_AHEAD = 32;
const MAX_WRITE_BACKLOG = 3;

const MODELS = {
  siglip2:{ id:'onnx-community/siglip2-base-patch16-224-ONNX', label:'SigLIP 2 Base', indexVersion:'siglip2-base-224-v2' },
  dinov3:{ id:'onnx-community/dinov3-vitb16-pretrain-lvd1689m-ONNX', label:'DINOv3 ViT-B', indexVersion:'dinov3-vitb16-v2' }
};

const GROUP_PROMPTS = [
  ['People','a photo of people, portraits, selfies, friends or family'],
  ['Pets','a photo of a pet, dog, cat or other companion animal'],
  ['Food','a photo of food, a meal, cooking or a restaurant dish'],
  ['Screenshots','a computer or phone screenshot, software interface or app UI'],
  ['Documents','a document, receipt, form, page of text, scan or paperwork'],
  ['Nature','a photo of nature, plants, forests, mountains, water or landscapes'],
  ['Travel','a travel photo, vacation, landmark, hotel, airport or sightseeing'],
  ['Games','a video game screenshot, game UI or gameplay'],
  ['Artwork','an illustration, drawing, painting, digital art or graphic design'],
  ['Memes','a meme, reaction image, joke image or image macro']
];

const running = new Map();
let dbPromise = null;
let hfPromise = null;
let siglipPromise = null;
let dinoPromise = null;
let siglipAnchorImageInputs = null;

const absoluteUrl = path => new URL(path, self.location.origin).href;
const thumbUrl = hash => absoluteUrl(`/api/thumbs/${hash}?v=${THUMB_VERSION}`);
const now = () => performance.now();

function post(id, type, payload = {}) { self.postMessage({ id, type, ...payload }); }
function progress(id, stage, done = 0, total = 0, detail = '', metrics = null) {
  post(id, 'progress', { stage, done, total, detail, ...(metrics ? { metrics } : {}) });
}
function aborted(id) { if (running.get(id)?.aborted) throw new DOMException('Aborted', 'AbortError'); }
function sleepTurn() { return new Promise(resolve => setTimeout(resolve, 0)); }

function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

function quantize(vector) {
  const source = vector instanceof Float32Array ? vector : Float32Array.from(vector || []);
  let maxAbs = 0;
  for (const value of source) maxAbs = Math.max(maxAbs, Math.abs(Number(value) || 0));
  const multiplier = maxAbs > 0 ? 127 / maxAbs : 1;
  const data = new Int8Array(source.length);
  let normSq = 0;
  for (let index = 0; index < source.length; index++) {
    const value = Math.max(-127, Math.min(127, Math.round((Number(source[index]) || 0) * multiplier)));
    data[index] = value;
    normSq += value * value;
  }
  return { data, normSq:Math.max(1, normSq), scale:maxAbs > 0 ? maxAbs / 127 : 1 };
}

function vectorRecord(value) {
  if (!value) return null;
  if (value.data && Number(value.normSq) > 0) {
    return {
      data:value.data instanceof Int8Array ? value.data : Int8Array.from(value.data),
      normSq:Number(value.normSq),
      scale:Number(value.scale) || 1
    };
  }
  if (!value.vector) return null;
  return vectorRecord({ data:value.vector, normSq:value.normSq, scale:value.scale });
}

function dot(left, right) {
  const a = vectorRecord(left);
  const b = vectorRecord(right);
  if (!a || !b) return -1;
  const length = Math.min(a.data.length, b.data.length);
  let total = 0;
  for (let index = 0; index < length; index++) total += a.data[index] * b.data[index];
  return total / Math.sqrt(a.normSq * b.normSq);
}

function scoreFor(similarity) { return Math.round(Math.max(0, Math.min(1, Number(similarity) || 0)) * 100); }

function oneTensorVector(tensor, strategy = 'auto') {
  if (!tensor) throw new Error('Model returned no embedding');
  const data = tensor.data || tensor.cpuData;
  const dims = Array.isArray(tensor.dims) ? tensor.dims.map(Number) : [];
  if (!data?.length) throw new Error('Model returned an unreadable embedding');
  if (dims.length >= 2) {
    const dim = dims.at(-1);
    const tokens = Math.floor(data.length / dim);
    const out = new Float32Array(dim);
    if (strategy === 'cls') {
      for (let j = 0; j < dim; j++) out[j] = Number(data[j]) || 0;
    } else {
      for (let token = 0; token < tokens; token++) {
        const offset = token * dim;
        for (let j = 0; j < dim; j++) out[j] += Number(data[offset + j]) || 0;
      }
      const scale = 1 / Math.max(1, tokens);
      for (let j = 0; j < dim; j++) out[j] *= scale;
    }
    return normalize(out);
  }
  return normalize(Float32Array.from(data, value => Number(value) || 0));
}

function tensorBatchVectors(tensor, expectedBatch, strategy = 'auto') {
  if (Array.isArray(tensor)) {
    if (tensor.length !== expectedBatch) throw new Error(`Model returned ${tensor.length} embeddings for ${expectedBatch} images`);
    return tensor.map(item => oneTensorVector(item, strategy));
  }
  if (!tensor) throw new Error('Model returned no embeddings');
  const data = tensor.data || tensor.cpuData;
  const dims = Array.isArray(tensor.dims) ? tensor.dims.map(Number) : [];
  if (!data?.length) throw new Error('Model returned unreadable embeddings');
  if (expectedBatch === 1) return [oneTensorVector(tensor, strategy)];
  if (!dims.length || dims[0] !== expectedBatch) throw new Error(`Model output batch does not match input batch (${dims[0] || '?'} != ${expectedBatch})`);

  const stride = Math.floor(data.length / expectedBatch);
  const vectors = [];
  for (let batch = 0; batch < expectedBatch; batch++) {
    const slice = data.subarray ? data.subarray(batch * stride, (batch + 1) * stride) : data.slice(batch * stride, (batch + 1) * stride);
    vectors.push(oneTensorVector({ data:slice, dims:dims.slice(1) }, strategy));
  }
  return vectors;
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EMBEDDINGS)) {
        const store = db.createObjectStore(EMBEDDINGS, { keyPath:'id' });
        store.createIndex('model', 'model', { unique:false });
        store.createIndex('hash', 'hash', { unique:false });
      }
      if (!db.objectStoreNames.contains(METADATA)) {
        const store = db.createObjectStore(METADATA, { keyPath:'id' });
        store.createIndex('kind', 'kind', { unique:false });
        store.createIndex('hash', 'hash', { unique:false });
      }
      if (event.oldVersion < 2 && db.objectStoreNames.contains(EMBEDDINGS)) request.transaction.objectStore(EMBEDDINGS).clear();
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
  transaction.onabort = () => reject(transaction.error || new Error('AI database transaction aborted'));
});

function modelIndexVersion(model) { return MODELS[model]?.indexVersion || model; }
function embeddingId(model, hash) { return `${modelIndexVersion(model)}:${hash}`; }

async function hashesForModel(model) {
  const version = modelIndexVersion(model);
  const prefix = `${version}:`;
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const index = tx.objectStore(EMBEDDINGS).index('model');
  const keys = await requestResult(index.getAllKeys(IDBKeyRange.only(version)));
  await transactionDone(tx).catch(() => {});
  const hashes = new Set();
  for (const key of keys || []) {
    const value = String(key || '');
    if (value.startsWith(prefix)) hashes.add(value.slice(prefix.length));
  }
  return hashes;
}

async function countForModel(model) {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const count = await requestResult(tx.objectStore(EMBEDDINGS).index('model').count(IDBKeyRange.only(modelIndexVersion(model))));
  await transactionDone(tx).catch(() => {});
  return Number(count) || 0;
}

async function getEmbedding(model, hash) {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const row = await requestResult(tx.objectStore(EMBEDDINGS).get(embeddingId(model, hash)));
  await transactionDone(tx).catch(() => {});
  return row?.vector && Number(row.schema) === EMBEDDING_SCHEMA
    ? vectorRecord({ data:row.vector, normSq:row.normSq, scale:row.scale })
    : null;
}

async function putEmbeddingBatch(model, entries) {
  if (!entries.length) return;
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS, 'readwrite');
  const store = tx.objectStore(EMBEDDINGS);
  const version = modelIndexVersion(model);
  const stamp = Date.now();
  for (const entry of entries) {
    const packed = quantize(entry.vector);
    store.put({
      id:`${version}:${entry.hash}`, model:version, modelKey:model, hash:entry.hash,
      schema:EMBEDDING_SCHEMA, dimension:packed.data.length, vector:packed.data,
      normSq:packed.normSq, scale:packed.scale, updatedAt:stamp
    });
  }
  await transactionDone(tx);
}

async function clearAiData() {
  const db = await openDb();
  const tx = db.transaction([EMBEDDINGS, METADATA], 'readwrite');
  tx.objectStore(EMBEDDINGS).clear();
  tx.objectStore(METADATA).clear();
  await transactionDone(tx);
}

async function forEachModelRow(model, callback) {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const request = tx.objectStore(EMBEDDINGS).index('model').openCursor(IDBKeyRange.only(modelIndexVersion(model)));
  await new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      callback(cursor.value);
      cursor.continue();
    };
  });
  await transactionDone(tx).catch(() => {});
}

async function hf() { hfPromise ||= import(TRANSFORMERS_URL); return hfPromise; }

async function runtimeOptions(id, label) {
  const module = await hf();
  const canWebGpu = Boolean(self.navigator?.gpu);
  return { module, options:{
    device:canWebGpu ? 'webgpu' : 'wasm',
    dtype:canWebGpu ? 'fp16' : 'q8',
    progress_callback:data => {
      const loaded = Number(data?.loaded) || 0;
      const total = Number(data?.total) || 0;
      const file = String(data?.file || data?.name || '');
      if (total > 0) progress(id, 'model', loaded, total, `${label}${file ? ` · ${file}` : ''}`);
      else if (data?.status) progress(id, 'model', 0, 0, `${label} · ${data.status}`);
    }
  }};
}

async function loadSiglip(id) {
  if (siglipPromise) return siglipPromise;
  siglipPromise = (async () => {
    const { module, options } = await runtimeOptions(id, 'Loading SigLIP 2');
    const { AutoTokenizer, AutoProcessor, SiglipModel, RawImage } = module;
    progress(id, 'model', 0, 0, 'Loading SigLIP 2…');
    const load = async (device, dtype) => {
      const common = { ...options, device, dtype };
      const [tokenizer, processor, model] = await Promise.all([
        AutoTokenizer.from_pretrained(MODELS.siglip2.id, common),
        AutoProcessor.from_pretrained(MODELS.siglip2.id, common),
        SiglipModel.from_pretrained(MODELS.siglip2.id, common)
      ]);
      const dummyText = tokenizer(['a photo'], { padding:'max_length', truncation:true, max_length:64 });
      return { tokenizer, processor, model, RawImage, dummyText, backend:device };
    };
    try { return await load(options.device, options.dtype); }
    catch (error) {
      if (options.device !== 'webgpu') throw error;
      progress(id, 'model', 0, 0, 'WebGPU SigLIP load failed · using WASM CPU fallback');
      return load('wasm', 'q8');
    }
  })().catch(error => { siglipPromise = null; throw error; });
  return siglipPromise;
}

async function loadDino(id) {
  if (dinoPromise) return dinoPromise;
  dinoPromise = (async () => {
    const { module, options } = await runtimeOptions(id, 'Loading DINOv3');
    const preferred = { ...options, dtype:options.device === 'webgpu' ? 'fp32' : 'q8' };
    progress(id, 'model', 0, 0, 'Loading DINOv3…');
    try {
      const extractor = await module.pipeline('image-feature-extraction', MODELS.dinov3.id, preferred);
      return { extractor, RawImage:module.RawImage, backend:preferred.device };
    } catch (error) {
      if (preferred.device !== 'webgpu') throw error;
      progress(id, 'model', 0, 0, 'WebGPU DINOv3 load failed · using WASM CPU fallback');
      const extractor = await module.pipeline('image-feature-extraction', MODELS.dinov3.id, { ...preferred, device:'wasm', dtype:'q8' });
      return { extractor, RawImage:module.RawImage, backend:'wasm' };
    }
  })().catch(error => { dinoPromise = null; throw error; });
  return dinoPromise;
}

async function loadRuntime(id, model) { return model === 'dinov3' ? loadDino(id) : loadSiglip(id); }

async function siglipBatchVectors(id, runtime, images) {
  aborted(id);
  const inputs = await runtime.processor(images.length === 1 ? images[0] : images);
  aborted(id);
  const output = await runtime.model({ ...runtime.dummyText, ...inputs });
  return tensorBatchVectors(output.image_embeds || output.vision_model_output?.pooler_output || output.pooler_output, images.length);
}

async function dinoBatchVectors(id, runtime, images) {
  aborted(id);
  let output;
  try { output = await runtime.extractor(images, { pool:true }); }
  catch (error) {
    if (images.length > 1) throw error;
    output = await runtime.extractor(images[0]);
  }
  return tensorBatchVectors(output, images.length, 'cls');
}

async function inferBatch(id, model, runtime, images) {
  return model === 'dinov3' ? dinoBatchVectors(id, runtime, images) : siglipBatchVectors(id, runtime, images);
}

class BatchTuner {
  constructor(backend) {
    this.candidates = backend === 'webgpu' ? [4, 8, 16, 32] : [1, 2, 4];
    this.trial = 0;
    this.scores = [];
    this.fixed = 0;
  }
  size(remaining) {
    const wanted = this.fixed || this.candidates[Math.min(this.trial, this.candidates.length - 1)];
    return Math.max(1, Math.min(remaining, wanted));
  }
  success(size, items, milliseconds) {
    if (this.fixed) return;
    if (items > 0 && milliseconds > 0) this.scores.push({ size, rate:items * 1000 / milliseconds });
    if (this.trial < this.candidates.length - 1) this.trial++;
    else this.fixed = this.scores.reduce((best, item) => !best || item.rate > best.rate ? item : best, null)?.size || size;
  }
  failure(size) {
    const smaller = this.candidates.filter(value => value < size).at(-1) || 1;
    this.fixed = smaller;
  }
  current() { return this.fixed || this.candidates[Math.min(this.trial, this.candidates.length - 1)]; }
}

class ImagePrefetcher {
  constructor(RawImage, files) { this.RawImage = RawImage; this.files = files; this.promises = new Map(); }
  fill(start) {
    const end = Math.min(this.files.length, start + PREFETCH_AHEAD);
    for (let index = start; index < end; index++) {
      const file = this.files[index];
      if (this.promises.has(file.hash)) continue;
      this.promises.set(file.hash, this.RawImage.read(thumbUrl(file.hash)));
    }
  }
  async take(files) {
    const settled = await Promise.allSettled(files.map(file => this.promises.get(file.hash) || this.RawImage.read(thumbUrl(file.hash))));
    const loaded = [];
    const failed = [];
    settled.forEach((result, index) => {
      const file = files[index];
      this.promises.delete(file.hash);
      if (result.status === 'fulfilled') loaded.push({ file, image:result.value });
      else failed.push({ file, error:result.reason });
    });
    return { loaded, failed };
  }
}

async function inferWithSplitting(id, model, runtime, loaded, tuner, stats) {
  if (!loaded.length) return [];
  const images = loaded.map(item => item.image);
  const started = now();
  try {
    const vectors = await inferBatch(id, model, runtime, images);
    const elapsed = Math.max(.01, now() - started);
    if (vectors.length !== loaded.length) throw new Error(`Expected ${loaded.length} vectors, got ${vectors.length}`);
    tuner.success(loaded.length, loaded.length, elapsed);
    stats.inferenceMs += elapsed;
    return loaded.map((item, index) => ({ hash:item.file.hash, vector:vectors[index] }));
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (loaded.length === 1) throw error;
    tuner.failure(loaded.length);
    const middle = Math.ceil(loaded.length / 2);
    const left = await inferWithSplitting(id, model, runtime, loaded.slice(0, middle), tuner, stats);
    const right = await inferWithSplitting(id, model, runtime, loaded.slice(middle), tuner, stats);
    return left.concat(right);
  }
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds - hours * 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function runtimeMetrics(runtime, tuner, stats, completed, total, started) {
  const elapsedMs = Math.max(1, now() - started);
  const newlyProcessed = Math.max(0, stats.indexed + stats.unavailable);
  const rate = newlyProcessed * 1000 / elapsedMs;
  const remaining = Math.max(0, total - completed);
  return {
    backend:runtime?.backend || (self.navigator?.gpu ? 'webgpu' : 'wasm'),
    batch:tuner?.current?.() || 1,
    rate:Number.isFinite(rate) ? rate : 0,
    etaSeconds:rate > 0 ? remaining / rate : null,
    inferenceMs:stats.inferenceMs,
    resumed:stats.resumed,
    newlyIndexed:stats.indexed,
    unavailable:stats.unavailable
  };
}

function progressIndex(id, model, runtime, tuner, stats, completed, total, started, prefix = '') {
  const metrics = runtimeMetrics(runtime, tuner, stats, completed, total, started);
  const backend = metrics.backend === 'webgpu' ? 'WebGPU' : 'WASM CPU';
  const rate = metrics.rate > 0 ? ` · ${metrics.rate.toFixed(1)} img/s` : '';
  const eta = metrics.etaSeconds != null && completed < total ? ` · ETA ${formatEta(metrics.etaSeconds)}` : '';
  const resumed = stats.resumed ? ` · resumed ${stats.resumed.toLocaleString()}` : '';
  progress(id, 'index', completed, total,
    `${prefix || MODELS[model].label} · ${completed.toLocaleString()} / ${total.toLocaleString()}${rate}${eta} · ${backend} · batch ${metrics.batch}${resumed}`,
    metrics);
}

async function ensureEmbeddings(id, model, media) {
  const unique = [];
  const seen = new Set();
  for (const file of media) {
    const hash = String(file?.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash) || seen.has(hash)) continue;
    seen.add(hash);
    unique.push({ ...file, hash });
  }
  const total = unique.length;
  const scanStarted = now();
  progress(id, 'resume', 0, total, `Checking saved ${MODELS[model].label} index…`);
  const existing = await hashesForModel(model);
  aborted(id);
  const missing = [];
  let resumed = 0;
  for (const file of unique) {
    if (existing.has(file.hash)) resumed++;
    else missing.push(file);
  }
  if (!missing.length) {
    const metrics = { backend:'cached', batch:0, rate:0, etaSeconds:0, resumed, newlyIndexed:0, unavailable:0, scanMs:now() - scanStarted };
    progress(id, 'index', total, total, `${MODELS[model].label} · ${total.toLocaleString()} / ${total.toLocaleString()} · already indexed`, metrics);
    return { indexed:total, newlyIndexed:0, resumed, unavailable:0, runtime:metrics };
  }

  progress(id, 'model', resumed, total, `${MODELS[model].label} · ${missing.length.toLocaleString()} remaining · loading model…`, { resumed });
  const runtime = await loadRuntime(id, model);
  aborted(id);
  const tuner = new BatchTuner(runtime.backend);
  const prefetcher = new ImagePrefetcher(runtime.RawImage, missing);
  const stats = { resumed, indexed:0, unavailable:0, inferenceMs:0 };
  const started = now();
  let cursor = 0;
  let writeChain = Promise.resolve();
  let writeBacklog = 0;
  let writeError = null;
  prefetcher.fill(0);
  progressIndex(id, model, runtime, tuner, stats, resumed, total, started);

  while (cursor < missing.length) {
    aborted(id);
    const batchSize = tuner.size(missing.length - cursor);
    const files = missing.slice(cursor, cursor + batchSize);
    const loadedBatch = await prefetcher.take(files);
    cursor += files.length;
    prefetcher.fill(cursor);
    stats.unavailable += loadedBatch.failed.length;

    if (loadedBatch.loaded.length) {
      const entries = await inferWithSplitting(id, model, runtime, loadedBatch.loaded, tuner, stats);
      stats.indexed += entries.length;
      writeChain = writeChain.then(() => putEmbeddingBatch(model, entries)).catch(error => { writeError ||= error; });
      writeBacklog++;
      if (writeBacklog >= MAX_WRITE_BACKLOG) {
        await writeChain;
        if (writeError) throw writeError;
        writeBacklog = 0;
      }
    }

    const completed = resumed + stats.indexed + stats.unavailable;
    progressIndex(id, model, runtime, tuner, stats, completed, total, started);
    if ((stats.indexed + stats.unavailable) % 256 < batchSize) await sleepTurn();
  }

  await writeChain;
  if (writeError) throw writeError;
  aborted(id);
  const completed = resumed + stats.indexed + stats.unavailable;
  const metrics = runtimeMetrics(runtime, tuner, stats, completed, total, started);
  progressIndex(id, model, runtime, tuner, stats, completed, total, started);
  return {
    indexed:resumed + stats.indexed,
    newlyIndexed:stats.indexed,
    resumed,
    unavailable:stats.unavailable,
    runtime:metrics
  };
}

async function siglipTextVectors(id, texts, anchorHash) {
  const runtime = await loadSiglip(id);
  aborted(id);
  if (!siglipAnchorImageInputs || siglipAnchorImageInputs.hash !== anchorHash) {
    const image = await runtime.RawImage.read(thumbUrl(anchorHash));
    siglipAnchorImageInputs = { hash:anchorHash, inputs:await runtime.processor(image) };
  }
  const textInputs = runtime.tokenizer(texts.map(String), { padding:'max_length', truncation:true, max_length:64 });
  aborted(id);
  const output = await runtime.model({ ...textInputs, ...siglipAnchorImageInputs.inputs });
  return { vectors:tensorBatchVectors(output.text_embeds || output.text_model_output?.pooler_output, texts.length), backend:runtime.backend };
}

function isWorse(left, right) {
  return left.similarity < right.similarity || (left.similarity === right.similarity && left.hash > right.hash);
}
function isBetter(left, right) { return isWorse(right, left); }

class TopK {
  constructor(limit) { this.limit = Math.max(1, Number(limit) || 1); this.heap = []; }
  push(item) {
    if (this.heap.length < this.limit) {
      this.heap.push(item);
      this.#up(this.heap.length - 1);
      return;
    }
    if (!isBetter(item, this.heap[0])) return;
    this.heap[0] = item;
    this.#down(0);
  }
  #up(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!isWorse(this.heap[index], this.heap[parent])) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }
  #down(index) {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < this.heap.length && isWorse(this.heap[left], this.heap[worst])) worst = left;
      if (right < this.heap.length && isWorse(this.heap[right], this.heap[worst])) worst = right;
      if (worst === index) break;
      [this.heap[index], this.heap[worst]] = [this.heap[worst], this.heap[index]];
      index = worst;
    }
  }
  values() { return this.heap.sort((a, b) => b.similarity - a.similarity || a.hash.localeCompare(b.hash)); }
}

async function rankSimilar(id, model, media, targetHash, limit = 40) {
  const indexResult = await ensureEmbeddings(id, model, media);
  aborted(id);
  const target = await getEmbedding(model, targetHash);
  if (!target) throw new Error('The selected file could not be indexed by this AI model.');
  const allowed = new Set(media.map(file => String(file.hash || '')));
  const best = new TopK(Math.max(1, Math.min(200, Number(limit) || 40)));
  let scanned = 0;
  await forEachModelRow(model, row => {
    if (!allowed.has(row.hash) || row.hash === targetHash || !row.vector || Number(row.schema) !== EMBEDDING_SCHEMA) return;
    const similarity = dot(target, row);
    best.push({ hash:row.hash, similarity, score:scoreFor(similarity) });
    scanned++;
  });
  progress(id, 'rank', scanned, scanned, `${MODELS[model].label} · ranked ${scanned.toLocaleString()} indexed media`, indexResult.runtime);
  return best.values();
}

async function semanticSearch(id, media, query, limit = 80) {
  const text = String(query || '').trim();
  if (!text) return [];
  const indexResult = await ensureEmbeddings(id, 'siglip2', media);
  aborted(id);
  const anchor = media.find(file => /^[a-f0-9]{64}$/.test(String(file?.hash || '')));
  if (!anchor) return [];
  progress(id, 'query', 0, 1, 'Encoding semantic search…', indexResult.runtime);
  const queryEncoding = await siglipTextVectors(id, [text], anchor.hash);
  const [queryVectorFloat] = queryEncoding.vectors;
  const queryVector = quantize(queryVectorFloat);
  const queryRuntime = { ...indexResult.runtime, backend:queryEncoding.backend };
  progress(id, 'query', 1, 1, `Semantic query ready · ${queryEncoding.backend === 'webgpu' ? 'WebGPU' : 'WASM CPU'}`, queryRuntime);
  const allowed = new Set(media.map(file => String(file.hash || '')));
  const best = new TopK(Math.max(1, Math.min(500, Number(limit) || 80)));
  let scanned = 0;
  await forEachModelRow('siglip2', row => {
    if (!allowed.has(row.hash) || !row.vector || Number(row.schema) !== EMBEDDING_SCHEMA) return;
    const similarity = dot(queryVector, row);
    best.push({ hash:row.hash, similarity, score:scoreFor(similarity) });
    scanned++;
  });
  progress(id, 'rank', scanned, scanned, `Semantic search · ranked ${scanned.toLocaleString()} media`, queryRuntime);
  return best.values();
}

async function autoGroups(id, media, limitPerGroup = 120) {
  const indexResult = await ensureEmbeddings(id, 'siglip2', media);
  aborted(id);
  const anchor = media.find(file => /^[a-f0-9]{64}$/.test(String(file?.hash || '')));
  if (!anchor) return [];
  progress(id, 'groups', 0, GROUP_PROMPTS.length, 'Encoding group concepts…', indexResult.runtime);
  const groupEncoding = await siglipTextVectors(id, GROUP_PROMPTS.map(item => item[1]), anchor.hash);
  const textVectors = groupEncoding.vectors.map(quantize);
  const groupRuntime = { ...indexResult.runtime, backend:groupEncoding.backend };
  progress(id, 'groups', 1, GROUP_PROMPTS.length, `Group concepts ready · ${groupEncoding.backend === 'webgpu' ? 'WebGPU' : 'WASM CPU'}`, groupRuntime);
  const allowed = new Set(media.map(file => String(file.hash || '')));
  const limit = Math.max(12, Math.min(500, Number(limitPerGroup) || 120));
  const groups = GROUP_PROMPTS.map(([name]) => ({ name, best:new TopK(limit) }));
  let scanned = 0;
  await forEachModelRow('siglip2', row => {
    if (!allowed.has(row.hash) || !row.vector || Number(row.schema) !== EMBEDDING_SCHEMA) return;
    let bestIndex = 0;
    let bestSimilarity = -Infinity;
    for (let index = 0; index < textVectors.length; index++) {
      const similarity = dot(textVectors[index], row);
      if (similarity > bestSimilarity) { bestSimilarity = similarity; bestIndex = index; }
    }
    groups[bestIndex].best.push({ hash:row.hash, similarity:bestSimilarity, score:scoreFor(bestSimilarity) });
    scanned++;
  });
  progress(id, 'groups', GROUP_PROMPTS.length, GROUP_PROMPTS.length, `AI groups · classified ${scanned.toLocaleString()} media`, groupRuntime);
  return groups.map(group => ({ name:group.name, matches:group.best.values() }));
}

async function status() {
  const [siglip2, dinov3] = await Promise.all([countForModel('siglip2'), countForModel('dinov3')]);
  return {
    webgpu:Boolean(self.navigator?.gpu),
    models:MODELS,
    embeddingSchema:EMBEDDING_SCHEMA,
    indexed:{ siglip2, dinov3 }
  };
}

async function handle(id, action, payload) {
  if (action === 'status') return status();
  if (action === 'clear') { await clearAiData(); return status(); }
  const media = Array.isArray(payload?.media)
    ? payload.media.filter(file => /^[a-f0-9]{64}$/.test(String(file?.hash || '')))
    : [];
  if (action === 'index') return ensureEmbeddings(id, payload.model === 'dinov3' ? 'dinov3' : 'siglip2', media);
  if (action === 'similar') return rankSimilar(id, payload.model === 'dinov3' ? 'dinov3' : 'siglip2', media, String(payload.targetHash || ''), payload.limit);
  if (action === 'search') return semanticSearch(id, media, payload.query, payload.limit);
  if (action === 'groups') return autoGroups(id, media, payload.limitPerGroup);
  throw new Error(`Unknown AI index action: ${action}`);
}

self.onmessage = async event => {
  const data = event.data || {};
  const id = String(data.id || '');
  if (!id) return;
  if (data.action === 'cancel') {
    const job = running.get(String(data.cancelId || id));
    if (job) job.aborted = true;
    return;
  }
  running.set(id, { aborted:false });
  try {
    const result = await handle(id, data.action, data.payload || {});
    aborted(id);
    post(id, 'result', { result });
  } catch (error) {
    post(id, 'error', {
      error:error?.name === 'AbortError' ? 'Canceled' : (error?.message || String(error)),
      aborted:error?.name === 'AbortError'
    });
  } finally {
    running.delete(id);
  }
};
