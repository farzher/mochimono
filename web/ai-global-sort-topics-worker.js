const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const MODEL_ID = 'onnx-community/siglip2-base-patch16-224-ONNX';
const AI_DB = 'mochimono-ai';
const AI_DB_VERSION = 2;
const EMBEDDINGS = 'embeddings';
const EMBEDDING_SCHEMA = 3;
const SIGLIP_VERSION = 'siglip2-base-224-v2';
const DINO_VERSION = 'dinov3-vitb16-v2';
const THUMB_VERSION = 3;
const DIMS = 64;
const HASH_RE = /^[a-f0-9]{64}$/;

const TOPICS = [
  ['People', 'a photo of a person, portrait, face or people'],
  ['Selfies', 'a selfie or close personal portrait taken with a phone'],
  ['Family & groups', 'a group photo of family, friends, children or people together'],
  ['Pets', 'a photo of a pet, dog, cat or companion animal'],
  ['Wildlife', 'a photo of wild animals, birds, insects or wildlife'],
  ['Food', 'a photo of food, meals, drinks, cooking or restaurant dishes'],
  ['Screenshots', 'a phone or computer screenshot, app interface or website'],
  ['Code & software', 'a programming, code editor, terminal, developer tool or software interface screenshot'],
  ['Video games', 'a video game screenshot, gameplay, game character or game interface'],
  ['Documents', 'a document, receipt, form, page, scan, paperwork or mostly text'],
  ['Memes & text', 'a meme, reaction image, joke, quote card or image dominated by text'],
  ['Art', 'an illustration, drawing, painting, digital artwork, graphic design or anime art'],
  ['Objects', 'a product, gadget, device, tool or individual object photographed up close'],
  ['Fashion', 'clothing, fashion, outfit, shoes, accessories or apparel'],
  ['Interiors', 'an indoor room, home interior, furniture, office or indoor space'],
  ['Architecture', 'a building, house, architecture, monument or exterior structure'],
  ['Cities & streets', 'a city, street, road, urban scene, neighborhood or downtown'],
  ['Travel', 'a travel photo, vacation, landmark, sightseeing, hotel, airport or tourist destination'],
  ['Nature', 'a natural landscape, mountain, forest, field, countryside or scenic outdoor view'],
  ['Plants & flowers', 'plants, flowers, trees, garden, leaves or vegetation as the main subject'],
  ['Water & beaches', 'ocean, beach, lake, river, pool, coast or water scene'],
  ['Sky & sunsets', 'sky, clouds, sunset, sunrise, moon, stars or dramatic weather'],
  ['Vehicles', 'a car, truck, motorcycle, train, airplane, boat or other vehicle'],
  ['Events & activities', 'a party, event, concert, sport, exercise, hobby or people doing an activity']
];

let canceled = false;
const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const progress = (done, total, detail, stage = 'topics') => post('progress', { done, total, detail, stage });
const abortIfNeeded = () => { if (canceled) throw new DOMException('Aborted', 'AbortError'); };
const thumbUrl = hash => new URL(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, self.location.origin).href;

function normalize(data) {
  let norm = 0;
  for (const value of data) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < data.length; i++) data[i] /= norm;
  return data;
}

function oneTensorVector(tensor) {
  const data = tensor?.data || tensor?.cpuData;
  const dims = Array.isArray(tensor?.dims) ? tensor.dims.map(Number) : [];
  if (!data?.length) throw new Error('SigLIP returned no text embedding');
  if (dims.length >= 2) {
    const dim = dims.at(-1);
    const tokens = Math.max(1, Math.floor(data.length / dim));
    const out = new Float32Array(dim);
    for (let token = 0; token < tokens; token++) {
      const offset = token * dim;
      for (let d = 0; d < dim; d++) out[d] += Number(data[offset + d]) || 0;
    }
    for (let d = 0; d < dim; d++) out[d] /= tokens;
    return normalize(out);
  }
  return normalize(Float32Array.from(data, value => Number(value) || 0));
}

function tensorBatchVectors(tensor, batch) {
  if (Array.isArray(tensor)) return tensor.map(oneTensorVector);
  const data = tensor?.data || tensor?.cpuData;
  const dims = Array.isArray(tensor?.dims) ? tensor.dims.map(Number) : [];
  if (!data?.length || dims[0] !== batch) throw new Error('SigLIP text batch shape was unexpected');
  const stride = Math.floor(data.length / batch);
  return Array.from({ length:batch }, (_, index) => {
    const slice = data.subarray ? data.subarray(index * stride, (index + 1) * stride) : data.slice(index * stride, (index + 1) * stride);
    return oneTensorVector({ data:slice, dims:dims.slice(1) });
  });
}

const maps = new Map();
function projectionMap(length) {
  if (maps.has(length)) return maps.get(length);
  const first = new Uint16Array(length);
  const second = new Uint16Array(length);
  const signs = new Int8Array(length * 2);
  for (let j = 0; j < length; j++) {
    const h1 = Math.imul(j + 1, 0x9e3779b1) >>> 0;
    const h2 = Math.imul(j + 17, 0x85ebca6b) >>> 0;
    first[j] = h1 % DIMS;
    second[j] = h2 % DIMS;
    signs[j * 2] = h1 & 0x80000000 ? -1 : 1;
    signs[j * 2 + 1] = h2 & 0x40000000 ? -1 : 1;
  }
  const result = { first, second, signs };
  maps.set(length, result);
  return result;
}

function project(source) {
  const out = new Float32Array(DIMS);
  const map = projectionMap(source.length);
  for (let j = 0; j < source.length; j++) {
    const value = Number(source[j]) || 0;
    out[map.first[j]] += value * map.signs[j * 2];
    out[map.second[j]] += value * map.signs[j * 2 + 1];
  }
  return normalize(out);
}

function openAiDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AI_DB, AI_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EMBEDDINGS)) {
        const store = db.createObjectStore(EMBEDDINGS, { keyPath:'id' });
        store.createIndex('model', 'model', { unique:false });
        store.createIndex('hash', 'hash', { unique:false });
      }
      if (!db.objectStoreNames.contains('metadata')) {
        const store = db.createObjectStore('metadata', { keyPath:'id' });
        store.createIndex('kind', 'kind', { unique:false });
        store.createIndex('hash', 'hash', { unique:false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createSpace(count) {
  return { count, dim:DIMS, data:new Float32Array(count * DIMS), available:new Uint8Array(count), loaded:0 };
}

async function loadSpace(version, name, media, indexByHash) {
  const space = createSpace(media.length);
  const db = await openAiDb();
  progress(0, media.length, `Reading saved ${name} embeddings…`, 'embeddings');
  try {
    const tx = db.transaction(EMBEDDINGS, 'readonly');
    const request = tx.objectStore(EMBEDDINGS).index('model').openCursor(IDBKeyRange.only(version));
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (canceled) return reject(new DOMException('Aborted', 'AbortError'));
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value || {};
        const index = indexByHash.get(String(row.hash || ''));
        if (index != null && Number(row.schema) === EMBEDDING_SCHEMA && row.vector?.length) {
          space.data.set(project(row.vector), index * DIMS);
          space.available[index] = 1;
          space.loaded++;
          if (space.loaded % 3000 === 0) progress(space.loaded, media.length, `Reading saved ${name} embeddings · ${space.loaded.toLocaleString()} matched…`, 'embeddings');
        }
        cursor.continue();
      };
    });
  } finally { db.close(); }
  return space;
}

async function loadTopicVectors(anchorHash) {
  progress(0, TOPICS.length, 'Loading semantic concept encoder…', 'concepts');
  const hf = await import(TRANSFORMERS_URL);
  const { AutoTokenizer, AutoProcessor, SiglipModel, RawImage } = hf;
  const canWebGpu = Boolean(self.navigator?.gpu);
  const load = async (device, dtype) => {
    const options = {
      device,
      dtype,
      progress_callback:data => {
        const loaded = Number(data?.loaded) || 0;
        const total = Number(data?.total) || 0;
        const file = String(data?.file || data?.name || '');
        if (total > 0) progress(loaded, total, `Loading semantic concepts${file ? ` · ${file}` : ''}`, 'model');
      }
    };
    const [tokenizer, processor, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID, options),
      AutoProcessor.from_pretrained(MODEL_ID, options),
      SiglipModel.from_pretrained(MODEL_ID, options)
    ]);
    return { tokenizer, processor, model, RawImage, backend:device };
  };

  let runtime;
  try { runtime = await load(canWebGpu ? 'webgpu' : 'wasm', canWebGpu ? 'fp16' : 'q8'); }
  catch (error) {
    if (!canWebGpu) throw error;
    progress(0, TOPICS.length, 'WebGPU concept encoder failed · using CPU fallback', 'model');
    runtime = await load('wasm', 'q8');
  }
  abortIfNeeded();
  const image = await runtime.RawImage.read(thumbUrl(anchorHash));
  const imageInputs = await runtime.processor(image);
  const textInputs = runtime.tokenizer(TOPICS.map(topic => topic[1]), { padding:'max_length', truncation:true, max_length:64 });
  const output = await runtime.model({ ...textInputs, ...imageInputs });
  const vectors = tensorBatchVectors(output.text_embeds || output.text_model_output?.pooler_output, TOPICS.length).map(project);
  progress(TOPICS.length, TOPICS.length, `Semantic concepts ready · ${runtime.backend === 'webgpu' ? 'WebGPU' : 'CPU'}`, 'concepts');
  return vectors;
}

function dot(space, index, vector) {
  const offset = index * DIMS;
  let total = 0;
  for (let d = 0; d < DIMS; d++) total += space.data[offset + d] * vector[d];
  return total;
}

function distance(space, left, right) {
  const a = left * DIMS;
  const b = right * DIMS;
  let total = 0;
  for (let d = 0; d < DIMS; d++) total += space.data[a + d] * space.data[b + d];
  return 1 - total;
}

function projection(space, index, axis) {
  const offset = index * DIMS;
  let total = 0;
  for (let d = 0; d < DIMS; d++) total += space.data[offset + d] * axis[d];
  return total;
}

function split(indexes, space, scratch) {
  if (indexes.length < 2) return [indexes, []];
  const sampleCount = Math.min(24, indexes.length);
  const sample = Array.from({ length:sampleCount }, (_, i) => indexes[Math.min(indexes.length - 1, Math.floor((i + .5) * indexes.length / sampleCount))]);
  const farthest = source => {
    let best = source, bestDistance = -Infinity;
    for (const index of sample) {
      const value = distance(space, source, index);
      if (value > bestDistance) { best = index; bestDistance = value; }
    }
    return best;
  };
  const first = farthest(sample[0]);
  const second = farthest(first);
  const axis = new Float32Array(DIMS);
  let norm = 0;
  for (let d = 0; d < DIMS; d++) {
    axis[d] = space.data[second * DIMS + d] - space.data[first * DIMS + d];
    norm += axis[d] * axis[d];
  }
  if (norm < 1e-9) axis[0] = 1;
  for (const index of indexes) scratch[index] = projection(space, index, axis);
  indexes.sort((a, b) => scratch[a] - scratch[b] || a - b);
  const middle = Math.ceil(indexes.length / 2);
  return [indexes.slice(0, middle), indexes.slice(middle)];
}

function greedy(indexes, space) {
  if (indexes.length < 3) return indexes.slice();
  const remaining = indexes.slice();
  const result = [remaining.shift()];
  while (remaining.length) {
    const current = result.at(-1);
    let best = 0, score = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const value = distance(space, current, remaining[i]);
      if (value < score) { score = value; best = i; }
    }
    result.push(remaining.splice(best, 1)[0]);
  }
  return result;
}

function route(indexes, space, scratch = new Float32Array(space.count)) {
  abortIfNeeded();
  if (indexes.length <= 30) return greedy(indexes, space);
  const [left, right] = split(indexes.slice(), space, scratch);
  const a = route(left, space, scratch);
  const b = route(right, space, scratch);
  if (!a.length) return b;
  if (!b.length) return a;
  const choices = [
    [distance(space, a.at(-1), b[0]), false, false],
    [distance(space, a.at(-1), b.at(-1)), false, true],
    [distance(space, a[0], b[0]), true, false],
    [distance(space, a[0], b.at(-1)), true, true]
  ].sort((x, y) => x[0] - y[0]);
  if (choices[0][1]) a.reverse();
  if (choices[0][2]) b.reverse();
  return a.concat(b);
}

async function buildTopics(payload) {
  const media = Array.isArray(payload?.media) ? payload.media.filter(item => HASH_RE.test(String(item?.hash || ''))) : [];
  if (!media.length) return { order:[], indexed:0, unavailable:0, families:0, rail:[] };
  const indexByHash = new Map(media.map((item, index) => [String(item.hash), index]));
  const siglip = await loadSpace(SIGLIP_VERSION, 'semantic', media, indexByHash);
  abortIfNeeded();
  if (!siglip.loaded) throw new Error('Semantic AI index is empty for this view.');
  const dino = await loadSpace(DINO_VERSION, 'visual', media, indexByHash);
  abortIfNeeded();
  const anchor = media.find((_, index) => siglip.available[index]);
  if (!anchor) throw new Error('No semantic anchor image is available.');
  const topicVectors = await loadTopicVectors(anchor.hash);
  abortIfNeeded();

  const groups = Array.from({ length:TOPICS.length }, () => []);
  const missing = [];
  let classified = 0;
  for (let index = 0; index < media.length; index++) {
    if (!siglip.available[index]) { missing.push(index); continue; }
    let best = 0;
    let bestScore = -Infinity;
    for (let topic = 0; topic < topicVectors.length; topic++) {
      const score = dot(siglip, index, topicVectors[topic]);
      if (score > bestScore) { bestScore = score; best = topic; }
    }
    groups[best].push(index);
    classified++;
    if (classified % 2000 === 0) progress(classified, siglip.loaded, `Classifying library by meaning · ${classified.toLocaleString()} / ${siglip.loaded.toLocaleString()}…`, 'classify');
  }

  const result = [];
  const rail = [];
  let families = 0;
  for (let topic = 0; topic < groups.length; topic++) {
    const group = groups[topic];
    if (!group.length) continue;
    rail.push({ index:result.length, label:TOPICS[topic][0] });
    families++;
    const visual = group.filter(index => dino.available[index]);
    const semanticOnly = group.filter(index => !dino.available[index]);
    if (visual.length) result.push(...route(visual, dino));
    if (semanticOnly.length) result.push(...route(semanticOnly, siglip));
  }
  result.push(...missing);
  progress(result.length, media.length, `Named semantic topics ready · ${families} topics`, 'topics');
  return {
    order:result.map(index => media[index].hash),
    indexed:classified,
    unavailable:missing.length,
    families,
    rail,
    dinoIndexed:dino.loaded,
    semanticIndexed:siglip.loaded
  };
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.action === 'cancel') { canceled = true; return; }
  canceled = false;
  try {
    const result = await buildTopics(data.payload || {});
    abortIfNeeded();
    post('result', { result });
  } catch (error) {
    post('error', { error:error?.name === 'AbortError' ? 'Canceled' : (error?.message || String(error)), aborted:error?.name === 'AbortError' });
  }
};
