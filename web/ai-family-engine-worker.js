let canceled = false;
let child = null;
let cache = null;

const VIS_DB = 'mochimono-visual-similarity';
const VIS_VERSION = 1;
const VIS_STORE = 'fingerprints';
const HASH_RE = /^[a-f0-9]{64}$/;
const ROBUST_VERSION = 'phash32-dct16-v1';
const TEMPLATE_VERSION = 'template12-v1';
const TEMPLATE_DIM = 216;
const FEATURE_VERSION = 'layout-edge-palette-v3';
const MULTIMODAL_WORKER_REV = 'shared-family-v1';

const DUP_BANDS = 16;
const DUP_STRONG_PHASH = 7;
const DUP_MAX_PHASH = 15;
const DUP_STRONG_TEMPLATE = .082;
const DUP_MAX_TEMPLATE = .052;

const SERIES_PROJECTIONS = 4;
const SERIES_WINDOW = 9;
const SERIES_STRONG = .082;
const SERIES_MAX = .125;
const SERIES_TEMPLATE_MAX = .155;
const SERIES_ASPECT_MAX = .22;
const SERIES_HUE_MAX = .11;
const SERIES_LIGHT_MAX = .11;
const SERIES_PHASH_MAX = 88;
const SERIES_VECTOR_DIM = 39;

const POPCOUNT16 = new Uint8Array(1 << 16);
for (let value = 1; value < POPCOUNT16.length; value++) POPCOUNT16[value] = POPCOUNT16[value >> 1] + (value & 1);

const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const abort = () => { if (canceled) throw new DOMException('Aborted', 'AbortError'); };
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const hueDelta = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));

function datasetKey(media) {
  let hash = 2166136261 >>> 0;
  for (const item of media) {
    const value = `${item.hash}:${Number(item.width) || 0}x${Number(item.height) || 0}`;
    for (let index = 0; index < value.length; index += 4) {
      hash ^= value.charCodeAt(index) || 0;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return `${media.length}:${hash.toString(36)}`;
}

function openVisualDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VIS_DB, VIS_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function rowColor(row) {
  const sorted = row?.aiSortColorVersion === 'ai-sort-color-v1' ? row.aiSortColor : null;
  if (sorted && Number.isFinite(Number(sorted.l))) {
    return { h:((Number(sorted.h) || 0) % 1 + 1) % 1, l:clamp(Number(sorted.l) || 0), c:Math.max(0, Number(sorted.c) || 0), f:clamp(Number(sorted.f) || 0) };
  }
  const flow = row?.aiColorFlow;
  if (flow && Number.isFinite(Number(flow.l))) {
    return { h:((Number(flow.h) || 0) % 1 + 1) % 1, l:clamp(Number(flow.l) || 0), c:Math.max(0, Number(flow.c) || 0), f:clamp(Number(flow.f) || 0) };
  }
  const color = row?.visualColor;
  const feature = row?.visualFeature;
  if (!color && !feature) return null;
  return {
    h:((Number(color?.dominantHue) || 0) % 1 + 1) % 1,
    l:clamp((Number(feature?.meanLuma) || 127) / 255),
    c:Math.max(0, Number(color?.meanChroma) || 0),
    f:clamp(Number(color?.colorFraction) || 0)
  };
}

function validFeature(feature) {
  return feature?.version === FEATURE_VERSION && feature.layout?.length === 48 && feature.edges?.length === 64 && feature.energy?.length === 16 && feature.hues?.length === 24;
}

async function loadVisual(media) {
  const byHash = new Map(media.map((item, index) => [String(item.hash), index]));
  const colors = Array(media.length).fill(null);
  const robust = Array(media.length).fill('');
  const templates = Array(media.length).fill(null);
  const features = Array(media.length).fill(null);
  let db;
  try {
    db = await openVisualDb();
    if (!db.objectStoreNames.contains(VIS_STORE)) return { colors, robust, templates, features };
    post('progress', { done:0, total:media.length, detail:'Reading shared visual family descriptors…', stage:'hard-families' });
    const request = db.transaction(VIS_STORE, 'readonly').objectStore(VIS_STORE).openCursor();
    let found = 0;
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        abort();
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value || {};
        const index = byHash.get(String(row.hash || ''));
        if (index != null) {
          const color = rowColor(row);
          if (color) colors[index] = color;
          if (row.robustVersion === ROBUST_VERSION && HASH_RE.test(String(row.robust || ''))) robust[index] = String(row.robust);
          if (row.experimentalTemplateVersion === TEMPLATE_VERSION && row.experimentalTemplate?.length === TEMPLATE_DIM) templates[index] = row.experimentalTemplate;
          if (row.visualFeatureVersion === FEATURE_VERSION && validFeature(row.visualFeature)) features[index] = row.visualFeature;
          found++;
        }
        if (found && found % 5000 === 0) post('progress', { done:found, total:media.length, detail:`Reading shared visual families · ${found.toLocaleString()} matched…`, stage:'hard-families' });
        cursor.continue();
      };
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  } finally {
    db?.close?.();
  }
  return { colors, robust, templates, features };
}

function hammingHex(left, right) {
  if (!HASH_RE.test(left) || !HASH_RE.test(right)) return 256;
  let total = 0;
  for (let index = 0; index < 16; index++) total += POPCOUNT16[parseInt(left.slice(index * 4, index * 4 + 4), 16) ^ parseInt(right.slice(index * 4, index * 4 + 4), 16)];
  return total;
}

function templateDistance(left, right) {
  if (!left?.length || !right?.length || left.length !== TEMPLATE_DIM || right.length !== TEMPLATE_DIM) return null;
  let meanLeft = 0, meanRight = 0;
  for (let index = 0; index < 144; index++) { meanLeft += left[index]; meanRight += right[index]; }
  meanLeft /= 144; meanRight /= 144;
  let luma = 0, chroma = 0;
  for (let index = 0; index < 144; index++) {
    const delta = ((left[index] - meanLeft) - (right[index] - meanRight)) / 255;
    luma += delta * delta;
  }
  for (let index = 144; index < TEMPLATE_DIM; index++) {
    const delta = (left[index] - right[index]) / 255;
    chroma += delta * delta;
  }
  return Math.sqrt(luma / 144) * .65 + Math.sqrt(chroma / (TEMPLATE_DIM - 144)) * .25 + Math.abs(meanLeft - meanRight) / 255 * .10;
}

function colorClose(left, right, light = .065, hue = .055) {
  return Boolean(left && right) && Math.abs(left.l - right.l) <= light && (hueDelta(left.h, right.h) <= hue || left.c < .025 || right.c < .025);
}

function nearDuplicate(a, b, visual) {
  const distance = hammingHex(visual.robust[a], visual.robust[b]);
  if (distance > DUP_MAX_PHASH) return false;
  const template = templateDistance(visual.templates[a], visual.templates[b]);
  if (template != null) return distance <= DUP_STRONG_PHASH ? template <= DUP_STRONG_TEMPLATE : template <= DUP_MAX_TEMPLATE;
  return distance <= 4 && colorClose(visual.colors[a], visual.colors[b]);
}

function makeUnion(count) {
  const parent = new Int32Array(count);
  const size = new Int32Array(count);
  for (let index = 0; index < count; index++) { parent[index] = index; size[index] = 1; }
  const find = index => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) { const next = parent[index]; parent[index] = root; index = next; }
    return root;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a === b) return a;
    if (size[a] < size[b]) [a, b] = [b, a];
    parent[b] = a; size[a] += size[b];
    return a;
  };
  return { parent, size, find, union };
}

function addDuplicateEdges(union, visual) {
  const count = visual.robust.length;
  const stamp = new Int32Array(count);
  const heads = new Int32Array(DUP_BANDS * (1 << 16));
  const next = new Int32Array(DUP_BANDS * count);
  heads.fill(-1); next.fill(-1);
  const exact = new Map();
  let generation = 1, comparisons = 0;
  for (let index = 0; index < count; index++) {
    abort();
    const hash = visual.robust[index];
    if (!HASH_RE.test(hash)) continue;
    let matchedExact = false;
    let reps = exact.get(hash);
    if (reps) {
      for (const candidate of reps) if (nearDuplicate(index, candidate, visual)) { union.union(index, candidate); matchedExact = true; break; }
    }
    if (!matchedExact) { if (reps) reps.push(index); else exact.set(hash, reps = [index]); }
    if (++generation === 2147483647) { stamp.fill(0); generation = 1; }
    for (let band = 0; band < DUP_BANDS; band++) {
      const key = parseInt(hash.slice(band * 4, band * 4 + 4), 16);
      const head = band * (1 << 16) + key;
      for (let candidate = heads[head]; candidate >= 0; candidate = next[band * count + candidate]) {
        if (stamp[candidate] === generation) continue;
        stamp[candidate] = generation;
        if (visual.robust[candidate] === hash) continue;
        if (nearDuplicate(index, candidate, visual)) union.union(index, candidate);
        if (++comparisons % 250000 === 0) abort();
      }
    }
    for (let band = 0; band < DUP_BANDS; band++) {
      const key = parseInt(hash.slice(band * 4, band * 4 + 4), 16);
      const head = band * (1 << 16) + key;
      const nextIndex = band * count + index;
      next[nextIndex] = heads[head];
      heads[head] = index;
    }
  }
}

function mediaRatio(item) {
  return Math.max(1, Number(item?.width) || 1) / Math.max(1, Number(item?.height) || 1);
}
function aspectDistance(left, right) { return Math.abs(Math.log2(Math.max(1e-6, left) / Math.max(1e-6, right))); }

function seriesVector(feature, target, offset) {
  let mean = 0;
  for (let cell = 0; cell < 16; cell++) mean += (Number(feature.layout[cell * 3]) || 0) / 255;
  mean /= 16;
  let cursor = offset;
  for (let cell = 0; cell < 16; cell++) target[cursor++] = (Number(feature.layout[cell * 3]) || 0) / 255 - mean;
  for (let cell = 0; cell < 16; cell++) target[cursor++] = (Number(feature.energy[cell]) || 0) / 255;
  for (let orientation = 0; orientation < 4; orientation++) {
    let sum = 0;
    for (let cell = 0; cell < 16; cell++) sum += (Number(feature.edges[cell * 4 + orientation]) || 0) / 255;
    target[cursor++] = sum / 16;
  }
  target[cursor++] = (Number(feature.contrast) || 0) / 255;
  target[cursor++] = (Number(feature.edgeDensity) || 0) / 255;
  target[cursor++] = (Number(feature.colorfulness) || 0) / 255;
}

function seriesProjectionWeights(seed) {
  const output = new Float32Array(SERIES_VECTOR_DIM);
  let state = Math.imul(seed + 1, 0x9e3779b1) >>> 0;
  for (let index = 0; index < output.length; index++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    output[index] = state & 1 ? 1 : -1;
  }
  return output;
}

function seriesDistance(vectors, a, b) {
  const ao = a * SERIES_VECTOR_DIM, bo = b * SERIES_VECTOR_DIM;
  let luma = 0, energy = 0, edges = 0;
  for (let index = 0; index < 16; index++) luma += Math.abs(vectors[ao + index] - vectors[bo + index]);
  for (let index = 16; index < 32; index++) energy += Math.abs(vectors[ao + index] - vectors[bo + index]);
  for (let index = 32; index < 36; index++) edges += Math.abs(vectors[ao + index] - vectors[bo + index]);
  const stats = (Math.abs(vectors[ao + 36] - vectors[bo + 36]) + Math.abs(vectors[ao + 37] - vectors[bo + 37]) + Math.abs(vectors[ao + 38] - vectors[bo + 38])) / 3;
  return (luma / 16) * .42 + (energy / 16) * .30 + (edges / 4) * .18 + stats * .10;
}

function seriesSimilar(a, b, media, visual, vectors) {
  if (!visual.features[a] || !visual.features[b]) return false;
  const aspect = aspectDistance(mediaRatio(media[a]), mediaRatio(media[b]));
  if (aspect > SERIES_ASPECT_MAX) return false;
  const left = visual.colors[a], right = visual.colors[b];
  if (left && right) {
    if (Math.abs(left.l - right.l) > SERIES_LIGHT_MAX) return false;
    if (left.c > .025 && right.c > .025 && hueDelta(left.h, right.h) > SERIES_HUE_MAX) return false;
  }
  const structure = seriesDistance(vectors, a, b);
  if (structure <= SERIES_STRONG && aspect <= .16) return true;
  if (structure > SERIES_MAX) return false;
  const template = templateDistance(visual.templates[a], visual.templates[b]);
  if (template != null && template <= SERIES_TEMPLATE_MAX) return true;
  return hammingHex(visual.robust[a], visual.robust[b]) <= SERIES_PHASH_MAX && structure <= .105;
}

function addSeriesEdges(union, media, visual) {
  const count = media.length;
  const vectors = new Float32Array(count * SERIES_VECTOR_DIM);
  const active = [];
  for (let index = 0; index < count; index++) if (visual.features[index]) { seriesVector(visual.features[index], vectors, index * SERIES_VECTOR_DIM); active.push(index); }
  if (active.length < 2) return 0;
  post('progress', { done:0, total:active.length, detail:'Finding repeated visual layouts…', stage:'hard-families' });
  const projections = [];
  for (let projectionIndex = 0; projectionIndex < SERIES_PROJECTIONS; projectionIndex++) {
    abort();
    const weights = seriesProjectionWeights(projectionIndex), values = new Float32Array(count);
    for (const index of active) {
      let sum = 0, offset = index * SERIES_VECTOR_DIM;
      for (let dimension = 0; dimension < SERIES_VECTOR_DIM; dimension++) sum += vectors[offset + dimension] * weights[dimension];
      values[index] = sum;
    }
    const order = active.slice().sort((a, b) => values[a] - values[b] || a - b);
    const positions = new Int32Array(count); positions.fill(-1);
    for (let rank = 0; rank < order.length; rank++) positions[order[rank]] = rank;
    projections.push({ order, positions });
  }
  const stamp = new Int32Array(count);
  let generation = 1, checked = 0, joined = 0;
  for (let activeIndex = 0; activeIndex < active.length; activeIndex++) {
    const index = active[activeIndex];
    if (++generation === 2147483647) { stamp.fill(0); generation = 1; }
    for (const projection of projections) {
      const position = projection.positions[index];
      const start = Math.max(0, position - SERIES_WINDOW), end = Math.min(projection.order.length, position + SERIES_WINDOW + 1);
      for (let cursor = start; cursor < end; cursor++) {
        const other = projection.order[cursor];
        if (other === index || other > index || stamp[other] === generation) continue;
        stamp[other] = generation;
        if (seriesSimilar(index, other, media, visual, vectors)) { union.union(index, other); joined++; }
        if (++checked % 250000 === 0) abort();
      }
    }
    if (activeIndex && activeIndex % 5000 === 0) post('progress', { done:activeIndex, total:active.length, detail:`Repeated layouts · ${activeIndex.toLocaleString()} / ${active.length.toLocaleString()} scanned…`, stage:'hard-families' });
  }
  return joined;
}

function hardFamilies(media, visual) {
  const union = makeUnion(media.length);
  addDuplicateEdges(union, visual);
  const seriesEdges = addSeriesEdges(union, media, visual);
  const grouped = new Map();
  for (let index = 0; index < media.length; index++) {
    const root = union.find(index);
    if (union.size[root] < 2) continue;
    let members = grouped.get(root);
    if (!members) grouped.set(root, members = []);
    members.push(index);
  }
  const groups = [...grouped.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  const ids = new Int32Array(media.length); ids.fill(-1);
  let locked = 0;
  groups.forEach((members, id) => { for (const index of members) ids[index] = id; locked += members.length; });
  return { ids, groups, count:groups.length, locked, seriesEdges };
}

function loadMultimodal(media) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`./ai-global-multimodal-worker.js?v=${MULTIMODAL_WORKER_REV}`, import.meta.url), { type:'module' });
    child = worker;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (child === worker) child = null;
      try { worker.terminate(); } catch {}
      fn(value);
    };
    worker.onerror = event => finish(reject, new Error(event.message || 'Multimodal family worker failed'));
    worker.onmessageerror = () => finish(reject, new Error('Multimodal family worker returned unreadable data'));
    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'progress') {
        post('progress', { ...data, detail:data.detail ? `AI families · ${data.detail}` : 'Finding AI families…' });
        return;
      }
      if (data.type === 'error') {
        const error = new Error(data.error || 'Multimodal family worker failed');
        if (data.aborted) error.name = 'AbortError';
        finish(reject, error);
        return;
      }
      if (data.type === 'result') finish(resolve, data.result || {});
    };
    worker.postMessage({ action:'sort', payload:{ media } });
  });
}

function unionFamilyIds(union, ids) {
  if (!ids?.length) return;
  const sizes = new Map();
  for (const raw of ids) {
    const id = Number(raw);
    if (id >= 0) sizes.set(id, (sizes.get(id) || 0) + 1);
  }
  const first = new Map();
  for (let index = 0; index < ids.length; index++) {
    const id = Number(ids[index]);
    if (id < 0 || (sizes.get(id) || 0) < 2) continue;
    if (first.has(id)) union.union(first.get(id), index);
    else first.set(id, index);
  }
}

function mergeFamilies(media, hard, broad) {
  const union = makeUnion(media.length);
  unionFamilyIds(union, broad?.familyIds);
  for (const members of hard.groups) for (let index = 1; index < members.length; index++) union.union(members[0], members[index]);

  const grouped = new Map();
  for (let index = 0; index < media.length; index++) {
    const root = union.find(index);
    let members = grouped.get(root);
    if (!members) grouped.set(root, members = []);
    members.push(index);
  }
  const groups = [...grouped.values()].filter(group => group.length > 1);
  const ids = new Int32Array(media.length); ids.fill(-1);
  groups.forEach((members, id) => { for (const index of members) ids[index] = id; });

  const broadOrder = Array.isArray(broad?.order) ? broad.order : [];
  const byHash = new Map(media.map((item, index) => [String(item.hash), index]));
  const positions = new Int32Array(media.length); positions.fill(1e9);
  for (let position = 0; position < broadOrder.length; position++) {
    const index = byHash.get(String(broadOrder[position]));
    if (index != null) positions[index] = position;
  }
  for (let index = 0; index < positions.length; index++) if (positions[index] === 1e9) positions[index] = broadOrder.length + index;

  const sortedGroups = groups.map(members => {
    members.sort((a, b) => positions[a] - positions[b] || a - b);
    return { members, anchor:positions[members[Math.floor(members.length / 2)]], first:positions[members[0]] };
  }).sort((a, b) => a.anchor - b.anchor || a.first - b.first);

  const familyMembers = new Uint8Array(media.length);
  const orderedIndexes = [];
  for (const group of sortedGroups) {
    for (const index of group.members) { familyMembers[index] = 1; orderedIndexes.push(index); }
  }
  const singles = Array.from({ length:media.length }, (_, index) => index).filter(index => !familyMembers[index]).sort((a, b) => positions[a] - positions[b] || a - b);
  const rail = [];
  if (orderedIndexes.length) rail.push({ index:0, label:'Families' });
  if (singles.length) rail.push({ index:orderedIndexes.length, label:'Singles' });
  orderedIndexes.push(...singles);

  return {
    familyIds:ids,
    groups:sortedGroups.map(group => group.members),
    order:orderedIndexes.map(index => media[index].hash),
    rail,
    families:sortedGroups.length,
    locked:sortedGroups.reduce((sum, group) => sum + group.members.length, 0)
  };
}

async function build(payload) {
  const media = (Array.isArray(payload?.media) ? payload.media : []).filter(item => HASH_RE.test(String(item?.hash || '')));
  if (!media.length) return { order:[], rail:[], familyIds:new Int32Array(0), hardIds:new Int32Array(0), families:0, locked:0, hardFamilies:0, hardLocked:0, indexed:0, unavailable:0, algorithm:'shared-family-engine-v1' };
  const key = datasetKey(media);
  if (cache?.key === key) return cache.result;

  const [visual, broad] = await Promise.all([
    loadVisual(media),
    loadMultimodal(media).catch(error => {
      if (error?.name === 'AbortError') throw error;
      return null;
    })
  ]);
  abort();
  const hard = hardFamilies(media, visual);
  post('progress', { done:media.length, total:media.length, detail:`Hard visual families · ${hard.count.toLocaleString()} groups · ${hard.locked.toLocaleString()} media`, stage:'hard-families' });
  const merged = mergeFamilies(media, hard, broad);
  const result = {
    order:merged.order,
    rail:merged.rail,
    familyIds:merged.familyIds,
    hardIds:hard.ids,
    families:merged.families,
    locked:merged.locked,
    hardFamilies:hard.count,
    hardLocked:hard.locked,
    multimodalFamilies:Number(broad?.families) || 0,
    dinoIndexed:Number(broad?.dinoIndexed) || 0,
    semanticIndexed:Number(broad?.semanticIndexed) || 0,
    indexed:Number(broad?.indexed) || 0,
    unavailable:Number(broad?.unavailable) || 0,
    algorithm:'shared-family-engine-v1'
  };
  cache = { key, result };
  post('progress', { done:media.length, total:media.length, detail:`Shared families · ${result.families.toLocaleString()} groups · ${result.locked.toLocaleString()} media locked`, stage:'families' });
  return result;
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.action === 'cancel') {
    canceled = true;
    try { child?.postMessage({ action:'cancel' }); } catch {}
    try { child?.terminate(); } catch {}
    child = null;
    return;
  }
  if (data.action !== 'build' && data.action !== 'sort') return;
  canceled = false;
  try {
    const result = await build(data.payload || {});
    abort();
    post('result', { result });
  } catch (error) {
    post('error', { error:error?.name === 'AbortError' ? 'Canceled' : (error?.message || String(error)), aborted:error?.name === 'AbortError' });
  }
};
