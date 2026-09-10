const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const DB_NAME = 'mochimono-ai';
const DB_VERSION = 1;
const EMBEDDINGS = 'embeddings';
const METADATA = 'metadata';
const THUMB_VERSION = 3;
const EMBEDDING_SCHEMA = 2;

const MODELS = {
  siglip2:{ id:'onnx-community/siglip2-base-patch16-224-ONNX', label:'SigLIP 2 Base', kind:'semantic', indexVersion:'siglip2-base-224-v1' },
  dinov3:{ id:'onnx-community/dinov3-vitb16-pretrain-lvd1689m-ONNX', label:'DINOv3 ViT-B', kind:'visual', indexVersion:'dinov3-vitb16-v1' },
  qwen3vl:{ id:'onnx-community/Qwen3-VL-2B-Instruct-ONNX', label:'Qwen3-VL 2B', kind:'vlm' },
  sam:{ id:'onnx-community/sam-vit-base-ONNX', label:'SAM ViT-B', kind:'mask' }
};

const running = new Map();
let dbPromise = null;
let hfPromise = null;
let siglipPromise = null;
let dinoPromise = null;
let qwenPromise = null;
let samPromise = null;
let siglipDummyText = null;
let siglipAnchorImageInputs = null;

const absoluteUrl = path => new URL(path, self.location.origin).href;
const thumbUrl = hash => absoluteUrl(`/api/thumbs/${hash}?v=${THUMB_VERSION}`);

function post(id, type, payload = {}) { self.postMessage({ id, type, ...payload }); }
function progress(id, stage, done = 0, total = 0, detail = '') { post(id, 'progress', { stage, done, total, detail }); }
function aborted(id) { if (running.get(id)?.aborted) throw new DOMException('Aborted', 'AbortError'); }

function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

function tensorVector(tensor, strategy = 'auto') {
  if (!tensor) throw new Error('Model returned no embedding');
  const data = tensor.data || tensor.cpuData;
  const dims = Array.isArray(tensor.dims) ? tensor.dims.map(Number) : [];
  if (data?.length) {
    if (dims.length >= 3) {
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
  const nested = typeof tensor.tolist === 'function' ? tensor.tolist() : tensor;
  const flat = [];
  (function visit(value) {
    if (Array.isArray(value)) for (const item of value) visit(item);
    else if (Number.isFinite(Number(value))) flat.push(Number(value));
  })(nested);
  if (!flat.length) throw new Error('Model returned an unreadable embedding');
  return normalize(Float32Array.from(flat));
}

function quantize(vector) {
  const data = new Int8Array(vector.length);
  let normSq = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = Math.max(-127, Math.min(127, Math.round(vector[index] * 127)));
    data[index] = value;
    normSq += value * value;
  }
  return { data, normSq:Math.max(1, normSq) };
}

function vectorRecord(value) {
  if (!value) return null;
  if (value.data && Number(value.normSq) > 0) {
    const data = value.data instanceof Int8Array ? value.data : Int8Array.from(value.data);
    return { data, normSq:Number(value.normSq) };
  }
  const source = value instanceof Float32Array || value instanceof Int8Array
    ? value
    : value.vector instanceof Float32Array || value.vector instanceof Int8Array
      ? value.vector
      : value.vector ? new Float32Array(value.vector) : null;
  if (!source?.length) return null;
  if (source instanceof Int8Array) {
    let normSq = 0;
    for (const item of source) normSq += item * item;
    return { data:source, normSq:Math.max(1, normSq) };
  }
  return quantize(normalize(Float32Array.from(source)));
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

function scoreFor(similarity) { return Math.round(Math.max(0, Math.min(100, (similarity + 1) * 50))); }

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
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

async function getEmbedding(model, hash) {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const row = await requestResult(tx.objectStore(EMBEDDINGS).get(embeddingId(model, hash)));
  await transactionDone(tx).catch(() => {});
  return row?.vector ? vectorRecord({ data:row.vector, normSq:row.normSq }) : null;
}

async function putEmbedding(model, hash, vector) {
  const packed = quantize(vector);
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS, 'readwrite');
  tx.objectStore(EMBEDDINGS).put({
    id:embeddingId(model, hash), model:modelIndexVersion(model), modelKey:model, hash,
    schema:EMBEDDING_SCHEMA, dimension:packed.data.length, vector:packed.data,
    normSq:packed.normSq, updatedAt:Date.now()
  });
  await transactionDone(tx);
  return packed;
}

async function rowsForModel(model) {
  const db = await openDb();
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const index = tx.objectStore(EMBEDDINGS).index('model');
  const rows = await requestResult(index.getAll(IDBKeyRange.only(modelIndexVersion(model))));
  await transactionDone(tx).catch(() => {});
  return rows || [];
}

async function putMetadata(kind, hash, value) {
  const db = await openDb();
  const tx = db.transaction(METADATA, 'readwrite');
  tx.objectStore(METADATA).put({ id:`${kind}:${hash}`, kind, hash, value, updatedAt:Date.now() });
  await transactionDone(tx);
}

async function getMetadata(kind, hash) {
  const db = await openDb();
  const tx = db.transaction(METADATA, 'readonly');
  const value = await requestResult(tx.objectStore(METADATA).get(`${kind}:${hash}`));
  await transactionDone(tx).catch(() => {});
  return value?.value ?? null;
}

async function clearAiData() {
  const db = await openDb();
  const tx = db.transaction([EMBEDDINGS, METADATA], 'readwrite');
  tx.objectStore(EMBEDDINGS).clear();
  tx.objectStore(METADATA).clear();
  await transactionDone(tx);
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
    let tokenizer, processor, model;
    try {
      [tokenizer, processor, model] = await Promise.all([
        AutoTokenizer.from_pretrained(MODELS.siglip2.id, options),
        AutoProcessor.from_pretrained(MODELS.siglip2.id, options),
        SiglipModel.from_pretrained(MODELS.siglip2.id, options)
      ]);
    } catch (error) {
      if (options.device !== 'webgpu') throw error;
      progress(id, 'model', 0, 0, 'WebGPU model load failed · retrying with WASM');
      const fallback = { ...options, device:'wasm', dtype:'q8' };
      [tokenizer, processor, model] = await Promise.all([
        AutoTokenizer.from_pretrained(MODELS.siglip2.id, fallback),
        AutoProcessor.from_pretrained(MODELS.siglip2.id, fallback),
        SiglipModel.from_pretrained(MODELS.siglip2.id, fallback)
      ]);
    }
    siglipDummyText = tokenizer(['a photo'], { padding:'max_length', truncation:true, max_length:64 });
    return { tokenizer, processor, model, RawImage };
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
      return await module.pipeline('image-feature-extraction', MODELS.dinov3.id, preferred);
    } catch (error) {
      if (preferred.device !== 'webgpu') throw error;
      progress(id, 'model', 0, 0, 'WebGPU model load failed · retrying with WASM');
      return module.pipeline('image-feature-extraction', MODELS.dinov3.id, { ...preferred, device:'wasm', dtype:'q8' });
    }
  })().catch(error => { dinoPromise = null; throw error; });
  return dinoPromise;
}

async function loadQwen(id) {
  if (qwenPromise) return qwenPromise;
  qwenPromise = (async () => {
    const { module, options } = await runtimeOptions(id, 'Loading Qwen3-VL');
    const { AutoProcessor, Qwen3VLForConditionalGeneration, RawImage } = module;
    if (!Qwen3VLForConditionalGeneration) throw new Error('This Transformers.js build does not include Qwen3-VL support.');
    progress(id, 'model', 0, 0, 'Loading Qwen3-VL 2B…');
    const load = async (device, dtype) => {
      const common = { ...options, device, dtype };
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(MODELS.qwen3vl.id, common),
        Qwen3VLForConditionalGeneration.from_pretrained(MODELS.qwen3vl.id, common)
      ]);
      return { processor, model, RawImage };
    };
    try {
      if (options.device === 'webgpu') return await load('webgpu', {
        embed_tokens:'fp16', vision_encoder:'fp16', decoder_model_merged:'q4f16'
      });
      return await load('wasm', { embed_tokens:'q8', vision_encoder:'q8', decoder_model_merged:'q4' });
    } catch (error) {
      if (options.device !== 'webgpu') throw error;
      progress(id, 'model', 0, 0, 'WebGPU VLM load failed · retrying with WASM');
      return load('wasm', { embed_tokens:'q8', vision_encoder:'q8', decoder_model_merged:'q4' });
    }
  })().catch(error => { qwenPromise = null; throw error; });
  return qwenPromise;
}

async function loadSam(id) {
  if (samPromise) return samPromise;
  samPromise = (async () => {
    const { module, options } = await runtimeOptions(id, 'Loading SAM');
    progress(id, 'model', 0, 0, 'Loading SAM…');
    try {
      return await module.pipeline('mask-generation', MODELS.sam.id, {
        ...options, dtype:options.device === 'webgpu' ? 'q4f16' : 'q8'
      });
    } catch (error) {
      if (options.device !== 'webgpu') throw error;
      progress(id, 'model', 0, 0, 'WebGPU mask model load failed · retrying with WASM');
      return module.pipeline('mask-generation', MODELS.sam.id, { ...options, device:'wasm', dtype:'q8' });
    }
  })().catch(error => { samPromise = null; throw error; });
  return samPromise;
}

async function siglipImageVector(id, hash, skipCache = false) {
  if (!skipCache) {
    const cached = await getEmbedding('siglip2', hash);
    if (cached) return cached;
  }
  const { processor, model, RawImage } = await loadSiglip(id);
  aborted(id);
  const image = await RawImage.read(thumbUrl(hash));
  const imageInputs = await processor(image);
  aborted(id);
  const output = await model({ ...siglipDummyText, ...imageInputs });
  const vector = tensorVector(output.image_embeds || output.vision_model_output?.pooler_output || output.pooler_output);
  await putEmbedding('siglip2', hash, vector);
  return vector;
}

async function siglipTextVector(id, text, anchorHash) {
  const { tokenizer, processor, model, RawImage } = await loadSiglip(id);
  aborted(id);
  if (!siglipAnchorImageInputs || siglipAnchorImageInputs.hash !== anchorHash) {
    const image = await RawImage.read(thumbUrl(anchorHash));
    siglipAnchorImageInputs = { hash:anchorHash, inputs:await processor(image) };
  }
  const textInputs = tokenizer([String(text || '')], { padding:'max_length', truncation:true, max_length:64 });
  aborted(id);
  const output = await model({ ...textInputs, ...siglipAnchorImageInputs.inputs });
  return tensorVector(output.text_embeds || output.text_model_output?.pooler_output);
}

async function dinoImageVector(id, hash, skipCache = false) {
  if (!skipCache) {
    const cached = await getEmbedding('dinov3', hash);
    if (cached) return cached;
  }
  const extractor = await loadDino(id);
  aborted(id);
  let output;
  try { output = await extractor(thumbUrl(hash), { pool:true }); }
  catch { output = await extractor(thumbUrl(hash)); }
  const vector = tensorVector(output, 'cls');
  await putEmbedding('dinov3', hash, vector);
  return vector;
}

async function imageVector(id, model, hash, skipCache = false) {
  return model === 'dinov3' ? dinoImageVector(id, hash, skipCache) : siglipImageVector(id, hash, skipCache);
}

async function ensureEmbeddings(id, model, media) {
  let ready = 0;
  let unavailable = 0;
  const total = media.length;
  progress(id, 'index', 0, total, `Checking ${MODELS[model]?.label || model} index…`);
  const existingRows = await rowsForModel(model);
  const existing = new Set(existingRows.map(row => String(row.hash || '')));
  for (const file of media) {
    aborted(id);
    if (!existing.has(file.hash)) {
      try {
        await imageVector(id, model, file.hash, true);
        existing.add(file.hash);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        unavailable++;
      }
    }
    ready++;
    progress(id, 'index', ready, total, `${MODELS[model]?.label || model} · ${ready.toLocaleString()} / ${total.toLocaleString()}`);
    if (ready % 6 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { indexed:total - unavailable, unavailable };
}

async function rankSimilar(id, model, media, targetHash, limit = 40) {
  await ensureEmbeddings(id, model, media);
  aborted(id);
  const target = await getEmbedding(model, targetHash);
  if (!target) throw new Error('The selected file could not be indexed by this AI model.');
  const rows = await rowsForModel(model);
  const allowed = new Set(media.map(file => file.hash));
  const ranked = [];
  for (const row of rows) {
    if (!allowed.has(row.hash) || row.hash === targetHash || !row.vector) continue;
    const similarity = dot(target, { data:row.vector, normSq:row.normSq });
    ranked.push({ hash:row.hash, similarity, score:scoreFor(similarity) });
  }
  ranked.sort((a, b) => b.similarity - a.similarity || a.hash.localeCompare(b.hash));
  return ranked.slice(0, Math.max(1, Math.min(200, Number(limit) || 40)));
}

async function semanticSearch(id, media, query, limit = 80) {
  if (!String(query || '').trim()) return [];
  await ensureEmbeddings(id, 'siglip2', media);
  aborted(id);
  const anchor = media.find(file => file.hash && /^[a-f0-9]{64}$/.test(file.hash));
  if (!anchor) return [];
  const queryVector = quantize(await siglipTextVector(id, query, anchor.hash));
  const rows = await rowsForModel('siglip2');
  const allowed = new Set(media.map(file => file.hash));
  const ranked = [];
  for (const row of rows) {
    if (!allowed.has(row.hash) || !row.vector) continue;
    const similarity = dot(queryVector, { data:row.vector, normSq:row.normSq });
    ranked.push({ hash:row.hash, similarity, score:scoreFor(similarity) });
  }
  ranked.sort((a, b) => b.similarity - a.similarity || a.hash.localeCompare(b.hash));
  return ranked.slice(0, Math.max(1, Math.min(500, Number(limit) || 80)));
}

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

async function autoGroups(id, media, limitPerGroup = 120) {
  await ensureEmbeddings(id, 'siglip2', media);
  aborted(id);
  const anchor = media.find(file => file.hash);
  if (!anchor) return [];
  const textVectors = [];
  for (let index = 0; index < GROUP_PROMPTS.length; index++) {
    aborted(id);
    progress(id, 'groups', index, GROUP_PROMPTS.length, `Understanding ${GROUP_PROMPTS[index][0]}…`);
    textVectors.push(quantize(await siglipTextVector(id, GROUP_PROMPTS[index][1], anchor.hash)));
  }
  const rows = await rowsForModel('siglip2');
  const allowed = new Set(media.map(file => file.hash));
  const groups = GROUP_PROMPTS.map(([name]) => ({ name, matches:[] }));
  for (const row of rows) {
    if (!allowed.has(row.hash) || !row.vector) continue;
    const vector = { data:row.vector, normSq:row.normSq };
    for (let index = 0; index < groups.length; index++) {
      const similarity = dot(textVectors[index], vector);
      groups[index].matches.push({ hash:row.hash, similarity, score:scoreFor(similarity) });
    }
  }
  for (const group of groups) {
    group.matches.sort((a, b) => b.similarity - a.similarity || a.hash.localeCompare(b.hash));
    group.matches = group.matches.slice(0, Math.max(12, Math.min(500, Number(limitPerGroup) || 120)));
  }
  progress(id, 'groups', GROUP_PROMPTS.length, GROUP_PROMPTS.length, 'AI groups ready');
  return groups;
}

async function describeImage(id, hash, promptText = '') {
  const kind = 'qwen3vl-description-v1';
  const cached = await getMetadata(kind, hash);
  if (cached && !promptText) return cached;
  const { processor, model, RawImage } = await loadQwen(id);
  aborted(id);
  const prompt = String(promptText || '').trim() ||
    'Describe this file for a personal file organizer. Include the main subjects, scene, visible text when useful, document or screenshot type if applicable, and concise searchable keywords. Do not speculate about identities.';
  progress(id, 'vlm', 0, 1, 'Reading image with Qwen3-VL…');
  let image = await RawImage.read(thumbUrl(hash));
  if (typeof image.resize === 'function') image = await image.resize(448, 448);
  const conversation = [{ role:'user', content:[{ type:'image' }, { type:'text', text:prompt }] }];
  const text = processor.apply_chat_template(conversation, { add_generation_prompt:true });
  const inputs = await processor(text, image);
  aborted(id);
  const outputs = await model.generate({ ...inputs, max_new_tokens:192 });
  const inputLength = Number(inputs.input_ids?.dims?.at?.(-1)) || 0;
  const generated = inputLength && typeof outputs.slice === 'function' ? outputs.slice(null, [inputLength, null]) : outputs;
  const decoded = processor.batch_decode(generated, { skip_special_tokens:true });
  const result = String(Array.isArray(decoded) ? decoded[0] : decoded || '').trim();
  if (!result) throw new Error('Qwen3-VL returned no description.');
  if (!promptText) await putMetadata(kind, hash, result);
  progress(id, 'vlm', 1, 1, 'Description ready');
  return result;
}

function serializableMask(output) {
  const masks = output?.masks || output?.mask || (Array.isArray(output) ? output.map(item => item?.mask).filter(Boolean) : []);
  const list = Array.isArray(masks) ? masks : [masks];
  const result = [];
  for (const mask of list.slice(0, 8)) {
    const tensor = mask?.data ? mask : mask?.mask?.data ? mask.mask : null;
    if (tensor?.data && Array.isArray(tensor.dims)) {
      result.push({ dims:tensor.dims.map(Number), data:Uint8Array.from(tensor.data, value => Number(value) > 0 ? 255 : 0) });
      continue;
    }
    if (mask?.data && Number(mask.width) && Number(mask.height)) {
      result.push({ dims:[Number(mask.height), Number(mask.width)], data:Uint8Array.from(mask.data, value => Number(value) > 0 ? 255 : 0) });
    }
  }
  return result;
}

async function subjectMasks(id, hash) {
  const pipe = await loadSam(id);
  aborted(id);
  progress(id, 'mask', 0, 1, 'Finding subjects with SAM…');
  const output = await pipe(thumbUrl(hash), { points_per_batch:32, pred_iou_thresh:.88 });
  const masks = serializableMask(output);
  progress(id, 'mask', 1, 1, masks.length ? `${masks.length} subject masks` : 'No subject masks returned');
  return masks;
}

async function status() {
  const [siglipRows, dinoRows] = await Promise.all([rowsForModel('siglip2'), rowsForModel('dinov3')]);
  return { webgpu:Boolean(self.navigator?.gpu), models:MODELS, indexed:{ siglip2:siglipRows.length, dinov3:dinoRows.length } };
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
  if (action === 'describe') return describeImage(id, String(payload.hash || ''), payload.prompt);
  if (action === 'mask') return subjectMasks(id, String(payload.hash || ''));
  throw new Error(`Unknown AI action: ${action}`);
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
    post(id, 'error', { error:error?.name === 'AbortError' ? 'Canceled' : (error?.message || String(error)), aborted:error?.name === 'AbortError' });
  } finally {
    running.delete(id);
  }
};
