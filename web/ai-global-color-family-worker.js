const VIS_DB = 'mochimono-visual-similarity';
const VIS_VERSION = 1;
const VIS_STORE = 'fingerprints';
const AI_DB = 'mochimono-ai';
const AI_VERSION = 2;
const EMBEDDINGS = 'embeddings';
const DINO_VERSION = 'dinov3-vitb16-v2';
const EMBED_SCHEMA = 3;
const THUMB_VERSION = 3;
const TEMPLATE_VERSION = 'template12-v1';
const TEMPLATE_N = 12;
const TEMPLATE_DIM = 216;
const PROJ_DIM = 32;
const BATCH = 24;
const HASH_RE = /^[a-f0-9]{64}$/;
const ROBUST_RE = /^[a-f0-9]{64}$/;

let canceled = false;
const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const progress = (done, total, detail, stage = 'families') => post('progress', { done, total, detail, stage });
const abort = () => { if (canceled) throw new DOMException('Aborted', 'AbortError'); };

function openDb(name, version) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function normalize(data, offset = 0, dim = data.length) {
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += data[offset + i] * data[offset + i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) data[offset + i] /= norm;
  return data;
}

function aspect(media, index) {
  const width = Number(media[index]?.width) || 0;
  const height = Number(media[index]?.height) || 0;
  return width > 0 && height > 0 ? width / height : 1;
}

function aspectDistance(media, left, right) {
  return Math.abs(Math.log2(aspect(media, left) / aspect(media, right)));
}

class UnionFind {
  constructor(count) {
    this.parent = Int32Array.from({ length:count }, (_, index) => index);
    this.rank = new Uint8Array(count);
  }
  find(value) {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = root;
      value = next;
    }
    return root;
  }
  join(left, right) {
    left = this.find(left);
    right = this.find(right);
    if (left === right) return;
    if (this.rank[left] < this.rank[right]) [left, right] = [right, left];
    this.parent[right] = left;
    if (this.rank[left] === this.rank[right]) this.rank[left]++;
  }
}

async function loadVisualRows() {
  const db = await openDb(VIS_DB, VIS_VERSION);
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(VIS_STORE, 'readonly').objectStore(VIS_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function saveVisualRows(rows) {
  if (!rows.length) return;
  const db = await openDb(VIS_DB, VIS_VERSION);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(VIS_STORE, 'readwrite');
    const store = tx.objectStore(VIS_STORE);
    for (const row of rows) store.put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Could not cache visual template signatures'));
  }).finally(() => db.close());
}

async function templateFor(hash) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache' });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(TEMPLATE_N, TEMPLATE_N);
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(bitmap, 0, 0, TEMPLATE_N, TEMPLATE_N);
    const pixels = context.getImageData(0, 0, TEMPLATE_N, TEMPLATE_N).data;
    const value = new Uint8Array(TEMPLATE_DIM);
    let mean = 0;

    for (let index = 0, pixel = 0; index < TEMPLATE_N * TEMPLATE_N; index++, pixel += 4) {
      const luma = Math.round(pixels[pixel] * .299 + pixels[pixel + 1] * .587 + pixels[pixel + 2] * .114);
      value[index] = luma;
      mean += luma;
    }
    mean /= TEMPLATE_N * TEMPLATE_N;

    let cursor = 144;
    for (let blockY = 0; blockY < 6; blockY++) for (let blockX = 0; blockX < 6; blockX++) {
      let redGreen = 0;
      let blueGreen = 0;
      let count = 0;
      for (let y = blockY * 2; y < blockY * 2 + 2; y++) for (let x = blockX * 2; x < blockX * 2 + 2; x++) {
        const pixel = (y * TEMPLATE_N + x) * 4;
        const red = pixels[pixel];
        const green = pixels[pixel + 1];
        const blue = pixels[pixel + 2];
        redGreen += red - green;
        blueGreen += blue - green;
        count++;
      }
      value[cursor++] = Math.max(0, Math.min(255, Math.round(127 + redGreen / count / 2)));
      value[cursor++] = Math.max(0, Math.min(255, Math.round(127 + blueGreen / count / 2)));
    }
    return { value, mean };
  } finally {
    bitmap.close?.();
  }
}

function validTemplate(row) {
  return row?.experimentalTemplateVersion === TEMPLATE_VERSION && row.experimentalTemplate?.length === TEMPLATE_DIM;
}

async function ensureTemplates(media) {
  const rows = await loadVisualRows();
  const byHash = new Map(rows.map(row => [String(row.hash || ''), row]));
  const templates = new Array(media.length);
  const means = new Float32Array(media.length);
  const missing = [];

  for (let index = 0; index < media.length; index++) {
    const row = byHash.get(media[index].hash);
    if (validTemplate(row)) {
      templates[index] = new Uint8Array(row.experimentalTemplate);
      let sum = 0;
      for (let pixel = 0; pixel < 144; pixel++) sum += templates[index][pixel];
      means[index] = sum / 144;
    } else {
      missing.push(index);
    }
  }

  let done = media.length - missing.length;
  progress(done, media.length, `Preparing color-family templates · ${done.toLocaleString()} / ${media.length.toLocaleString()}`, 'templates');

  for (let offset = 0; offset < missing.length; offset += BATCH) {
    abort();
    const indexes = missing.slice(offset, offset + BATCH);
    const computed = await Promise.all(indexes.map(async index => {
      try { return [index, await templateFor(media[index].hash)]; }
      catch { return [index, null]; }
    }));
    const writes = [];
    for (const [index, result] of computed) {
      if (!result) continue;
      templates[index] = result.value;
      means[index] = result.mean;
      const previous = byHash.get(media[index].hash) || {};
      const row = {
        ...previous,
        hash:media[index].hash,
        experimentalTemplate:result.value,
        experimentalTemplateVersion:TEMPLATE_VERSION,
        updatedAt:Date.now()
      };
      byHash.set(media[index].hash, row);
      writes.push(row);
    }
    try { await saveVisualRows(writes); } catch {}
    done += indexes.length;
    progress(Math.min(done, media.length), media.length, `Preparing color-family templates · ${Math.min(done, media.length).toLocaleString()} / ${media.length.toLocaleString()}`, 'templates');
  }

  return { templates, means, rows:byHash };
}

const projectionMaps = new Map();
function projectionMap(length) {
  if (projectionMaps.has(length)) return projectionMaps.get(length);
  const first = new Uint8Array(length);
  const second = new Uint8Array(length);
  const sign = new Int8Array(length * 2);
  for (let index = 0; index < length; index++) {
    const a = Math.imul(index + 1, 0x9e3779b1) >>> 0;
    const b = Math.imul(index + 17, 0x85ebca6b) >>> 0;
    first[index] = a % PROJ_DIM;
    second[index] = b % PROJ_DIM;
    sign[index * 2] = a & 0x80000000 ? -1 : 1;
    sign[index * 2 + 1] = b & 0x40000000 ? -1 : 1;
  }
  const map = { first, second, sign };
  projectionMaps.set(length, map);
  return map;
}

function projectVector(source, target, offset, center = 0, scale = 1) {
  const map = projectionMap(source.length);
  for (let index = 0; index < source.length; index++) {
    const value = ((Number(source[index]) || 0) - center) * scale;
    target[offset + map.first[index]] += value * map.sign[index * 2];
    target[offset + map.second[index]] += value * map.sign[index * 2 + 1];
  }
  normalize(target, offset, PROJ_DIM);
}

function templateProjection(templates, means) {
  const data = new Float32Array(templates.length * PROJ_DIM);
  const available = new Uint8Array(templates.length);
  for (let index = 0; index < templates.length; index++) {
    const template = templates[index];
    if (!template) continue;
    const source = new Float32Array(TEMPLATE_DIM);
    for (let pixel = 0; pixel < 144; pixel++) source[pixel] = (template[pixel] - means[index]) / 255;
    for (let pixel = 144; pixel < TEMPLATE_DIM; pixel++) source[pixel] = (template[pixel] - 127) / 128;
    projectVector(source, data, index * PROJ_DIM);
    available[index] = 1;
  }
  return { data, available, dim:PROJ_DIM };
}

async function loadDino(media, byHash) {
  const out = {
    data:new Float32Array(media.length * PROJ_DIM),
    available:new Uint8Array(media.length),
    dim:PROJ_DIM,
    loaded:0
  };
  const db = await openDb(AI_DB, AI_VERSION);
  try {
    const request = db.transaction(EMBEDDINGS, 'readonly').objectStore(EMBEDDINGS).index('model').openCursor(IDBKeyRange.only(DINO_VERSION));
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        abort();
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value || {};
        const index = byHash.get(String(row.hash || ''));
        if (index != null && Number(row.schema) === EMBED_SCHEMA && row.vector?.length) {
          projectVector(row.vector, out.data, index * PROJ_DIM);
          out.available[index] = 1;
          out.loaded++;
        }
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
  return out;
}

function cosineDistance(space, left, right) {
  if (!space?.available[left] || !space?.available[right]) return 1;
  let dot = 0;
  const leftOffset = left * space.dim;
  const rightOffset = right * space.dim;
  for (let dim = 0; dim < space.dim; dim++) dot += space.data[leftOffset + dim] * space.data[rightOffset + dim];
  return Math.max(0, 1 - dot);
}

function templateDistance(state, left, right) {
  const a = state.templates[left];
  const b = state.templates[right];
  if (!a || !b) return 1;
  let luma = 0;
  let chroma = 0;
  const meanA = state.means[left];
  const meanB = state.means[right];
  for (let pixel = 0; pixel < 144; pixel++) {
    const delta = ((a[pixel] - meanA) - (b[pixel] - meanB)) / 255;
    luma += delta * delta;
  }
  for (let pixel = 144; pixel < TEMPLATE_DIM; pixel++) {
    const delta = (a[pixel] - b[pixel]) / 255;
    chroma += delta * delta;
  }
  luma = Math.sqrt(luma / 144);
  chroma = Math.sqrt(chroma / (TEMPLATE_DIM - 144));
  const mean = Math.abs(meanA - meanB) / 255;
  return luma * .65 + chroma * .25 + mean * .10;
}

const POPCOUNT16 = new Uint8Array(1 << 16);
for (let value = 1; value < POPCOUNT16.length; value++) POPCOUNT16[value] = POPCOUNT16[value >> 1] + (value & 1);

function robustWords(row) {
  const value = String(row?.robust || '').toLowerCase();
  if (!ROBUST_RE.test(value)) return null;
  const words = new Uint16Array(16);
  for (let index = 0; index < 16; index++) words[index] = parseInt(value.slice(index * 4, index * 4 + 4), 16);
  return words;
}

function robustDistance(left, right) {
  if (!left || !right) return 256;
  let distance = 0;
  for (let index = 0; index < 16; index++) distance += POPCOUNT16[left[index] ^ right[index]];
  return distance;
}

function projectionWeights(seed) {
  const weights = new Int8Array(PROJ_DIM);
  let state = Math.imul(seed, 0x9e3779b1) >>> 0;
  for (let dim = 0; dim < PROJ_DIM; dim++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    weights[dim] = state & 1 ? 1 : -1;
  }
  return weights;
}

function scalar(space, index, weights) {
  let total = 0;
  const offset = index * space.dim;
  for (let dim = 0; dim < space.dim; dim++) total += space.data[offset + dim] * weights[dim];
  return total;
}

function familyPair(media, state, dino, robust, left, right) {
  if (aspectDistance(media, left, right) > .38) return false;
  const template = templateDistance(state, left, right);
  const semantic = cosineDistance(dino, left, right);
  const perceptual = robustDistance(robust[left], robust[right]);
  if (template <= .028) return true;
  if (template <= .058) return true;
  if (template <= .075 && semantic <= .08) return true;
  if (template <= .095 && semantic <= .035) return true;
  if (perceptual <= 36 && template <= .10) return true;
  if (perceptual <= 72 && template <= .072) return true;
  return false;
}

function addProjectionCandidates(space, indexes, seeds, radius, visit) {
  for (const seed of seeds) {
    abort();
    const weights = projectionWeights(seed);
    const order = indexes.slice().sort((left, right) => scalar(space, left, weights) - scalar(space, right, weights));
    for (let position = 0; position < order.length; position++) {
      const end = Math.min(order.length, position + radius + 1);
      for (let cursor = position + 1; cursor < end; cursor++) visit(order[position], order[cursor]);
    }
  }
}

function buildFamilies(media, state, dino, baseOrder) {
  const count = media.length;
  const union = new UnionFind(count);
  const robust = media.map(item => robustWords(state.rows.get(item.hash)));
  const compared = new Set();
  const tryPair = (left, right) => {
    if (left === right) return;
    const low = Math.min(left, right);
    const high = Math.max(left, right);
    const key = low * count + high;
    if (Number.isSafeInteger(key)) {
      if (compared.has(key)) return;
      compared.add(key);
    }
    if (familyPair(media, state, dino, robust, low, high)) union.join(low, high);
  };

  progress(0, count, 'Finding canonical color families…', 'families');

  // Color ordering itself is useful candidate information. It catches the exact
  // failure mode where a few unrelated cards have been inserted into an
  // otherwise obvious run of nearly identical media.
  for (let position = 0; position < baseOrder.length; position++) {
    const left = baseOrder[position];
    for (let cursor = position + 1; cursor < Math.min(baseOrder.length, position + 11); cursor++) tryPair(left, baseOrder[cursor]);
  }

  const projectedTemplates = templateProjection(state.templates, state.means);
  const templateIndexes = [];
  for (let index = 0; index < count; index++) if (projectedTemplates.available[index]) templateIndexes.push(index);
  addProjectionCandidates(projectedTemplates, templateIndexes, [3, 11, 29, 61], 9, tryPair);

  if (dino.loaded) {
    const indexes = [];
    for (let index = 0; index < count; index++) if (dino.available[index]) indexes.push(index);
    addProjectionCandidates(dino, indexes, [5, 17, 41], 8, tryPair);
  }

  const buckets = new Map();
  for (let index = 0; index < count; index++) {
    const words = robust[index];
    if (!words) continue;
    for (let block = 0; block < 16; block++) {
      const key = `${block}:${words[block]}`;
      for (const other of buckets.get(key) || []) tryPair(index, other);
      let list = buckets.get(key);
      if (!list) buckets.set(key, list = []);
      if (list.length < 192) list.push(index);
    }
  }

  const grouped = new Map();
  for (let index = 0; index < count; index++) {
    const root = union.find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(index);
  }
  const groups = [...grouped.values()];
  const multi = groups.filter(group => group.length > 1);
  const locked = multi.reduce((sum, group) => sum + group.length, 0);
  progress(count, count, `Canonical color families · ${multi.length.toLocaleString()} groups · ${locked.toLocaleString()} media locked`, 'families');
  return { groups, multi:multi.length, locked };
}

function consolidate(result, media, families) {
  const byHash = new Map(media.map((item, index) => [item.hash, index]));
  const hashes = Array.from(result?.order || [], String);
  const baseOrder = hashes.map(hash => byHash.get(hash)).filter(Number.isInteger);
  if (baseOrder.length !== media.length) throw new Error(`Color family pass received ${baseOrder.length.toLocaleString()} / ${media.length.toLocaleString()} ordered media`);

  const position = new Int32Array(media.length);
  for (let index = 0; index < baseOrder.length; index++) position[baseOrder[index]] = index;
  const groupOf = new Int32Array(media.length);
  groupOf.fill(-1);
  families.groups.forEach((group, id) => group.forEach(index => { groupOf[index] = id; }));

  const emitted = new Uint8Array(families.groups.length);
  const nextIndexes = [];
  for (const index of baseOrder) {
    const id = groupOf[index];
    if (id < 0) {
      nextIndexes.push(index);
      continue;
    }
    if (emitted[id]) continue;
    emitted[id] = 1;
    const members = families.groups[id].slice().sort((left, right) => position[left] - position[right]);
    nextIndexes.push(...members);
  }

  if (nextIndexes.length !== media.length) throw new Error('Color family consolidation lost media');
  const order = nextIndexes.map(index => media[index].hash);
  const newPosition = new Map(order.map((hash, index) => [hash, index]));
  const rail = Array.isArray(result.rail) ? result.rail.map(entry => {
    const oldIndex = Math.max(0, Math.min(hashes.length - 1, Number(entry.index) || 0));
    const hash = hashes[oldIndex];
    return { ...entry, index:newPosition.get(hash) ?? oldIndex };
  }).sort((left, right) => left.index - right.index) : [];

  return {
    ...result,
    order,
    rail,
    families:families.multi || Number(result.families) || 0,
    canonicalFamilies:families.multi,
    familyMedia:families.locked
  };
}

async function run(payload) {
  const media = Array.isArray(payload?.media) ? payload.media.filter(item => HASH_RE.test(String(item?.hash || ''))) : [];
  const result = payload?.result || {};
  if (!media.length) return result;
  const byHash = new Map(media.map((item, index) => [String(item.hash), index]));
  const hashes = Array.from(result.order || [], String);
  const baseOrder = hashes.map(hash => byHash.get(hash)).filter(Number.isInteger);
  if (baseOrder.length !== media.length) throw new Error('AI color order is incomplete before family consolidation');

  const templateState = await ensureTemplates(media);
  abort();
  progress(0, media.length, 'Reading DINO family verification…', 'embeddings');
  const dino = await loadDino(media, byHash);
  abort();
  const families = buildFamilies(media, templateState, dino, baseOrder);
  abort();
  return consolidate(result, media, families);
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.action === 'cancel') {
    canceled = true;
    return;
  }
  if (data.action !== 'consolidate') return;
  canceled = false;
  try {
    const result = await run(data.payload || {});
    abort();
    post('result', { result });
  } catch (error) {
    post('error', { error:error?.name === 'AbortError' ? 'Canceled' : String(error?.message || error), aborted:error?.name === 'AbortError' });
  }
};
