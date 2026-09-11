const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const DB_NAME = 'mochimono-ai';
const DB_VERSION = 2;
const METADATA = 'metadata';
const THUMB_VERSION = 3;

const MODELS = {
  qwen3vl:{ id:'onnx-community/Qwen3-VL-2B-Instruct-ONNX', label:'Qwen3-VL 2B' },
  sam:{ id:'onnx-community/sam-vit-base-ONNX', label:'SAM ViT-B' }
};

const running = new Map();
let dbPromise = null;
let hfPromise = null;
let qwenPromise = null;
let samPromise = null;

const absoluteUrl = path => new URL(path, self.location.origin).href;
const thumbUrl = hash => absoluteUrl(`/api/thumbs/${hash}?v=${THUMB_VERSION}`);

function post(id, type, payload = {}) { self.postMessage({ id, type, ...payload }); }
function progress(id, stage, done = 0, total = 0, detail = '') { post(id, 'progress', { stage, done, total, detail }); }
function aborted(id) { if (running.get(id)?.aborted) throw new DOMException('Aborted', 'AbortError'); }

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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
      return { processor, model, RawImage, backend:device };
    };
    try {
      if (options.device === 'webgpu') return await load('webgpu', {
        embed_tokens:'fp16', vision_encoder:'fp16', decoder_model_merged:'q4f16'
      });
      return await load('wasm', { embed_tokens:'q8', vision_encoder:'q8', decoder_model_merged:'q4' });
    } catch (error) {
      if (options.device !== 'webgpu') throw error;
      progress(id, 'model', 0, 0, 'WebGPU VLM load failed · using WASM CPU fallback');
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
      const pipe = await module.pipeline('mask-generation', MODELS.sam.id, {
        ...options, dtype:options.device === 'webgpu' ? 'q4f16' : 'q8'
      });
      return { pipe, backend:options.device };
    } catch (error) {
      if (options.device !== 'webgpu') throw error;
      progress(id, 'model', 0, 0, 'WebGPU mask model load failed · using WASM CPU fallback');
      const pipe = await module.pipeline('mask-generation', MODELS.sam.id, { ...options, device:'wasm', dtype:'q8' });
      return { pipe, backend:'wasm' };
    }
  })().catch(error => { samPromise = null; throw error; });
  return samPromise;
}

async function describeImage(id, hash, promptText = '') {
  const kind = 'qwen3vl-description-v1';
  const cached = await getMetadata(kind, hash);
  if (cached && !promptText) return cached;
  const { processor, model, RawImage, backend } = await loadQwen(id);
  aborted(id);
  const prompt = String(promptText || '').trim() ||
    'Describe this file for a personal file organizer. Include the main subjects, scene, visible text when useful, document or screenshot type if applicable, and concise searchable keywords. Do not speculate about identities.';
  progress(id, 'vlm', 0, 1, `Reading image with Qwen3-VL · ${backend === 'webgpu' ? 'WebGPU' : 'WASM CPU'}…`);
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
  progress(id, 'vlm', 1, 1, `Description ready · ${backend === 'webgpu' ? 'WebGPU' : 'WASM CPU'}`);
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
  const { pipe, backend } = await loadSam(id);
  aborted(id);
  progress(id, 'mask', 0, 1, `Finding subjects with SAM · ${backend === 'webgpu' ? 'WebGPU' : 'WASM CPU'}…`);
  const output = await pipe(thumbUrl(hash), { points_per_batch:32, pred_iou_thresh:.88 });
  const masks = serializableMask(output);
  progress(id, 'mask', 1, 1, `${masks.length ? `${masks.length} subject masks` : 'No subject masks returned'} · ${backend === 'webgpu' ? 'WebGPU' : 'WASM CPU'}`);
  return masks;
}

async function handle(id, action, payload) {
  if (action === 'describe') return describeImage(id, String(payload.hash || ''), payload.prompt);
  if (action === 'mask') return subjectMasks(id, String(payload.hash || ''));
  throw new Error(`Unknown AI detail action: ${action}`);
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
