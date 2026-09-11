const AI_DB = 'mochimono-ai';
const AI_DB_VERSION = 2;
const EMBEDDINGS = 'embeddings';
const EMBEDDING_SCHEMA = 3;
const DINO_VERSION = 'dinov3-vitb16-v2';
const SIGLIP_VERSION = 'siglip2-base-224-v2';
const VISUAL_DB = 'mochimono-visual-similarity';
const VISUAL_STORE = 'fingerprints';
const VISUAL_DB_VERSION = 1;
const PROJECTION_DIMS = 96;
const HASH_RE = /^[a-f0-9]{64}$/;

const MODE_INFO = {
  flow:{ label:'Flow' },
  families:{ label:'Families' },
  color:{ label:'Color' },
  structure:{ label:'Structure' },
  meaning:{ label:'Meaning' },
  topics:{ label:'Topics' },
  hybrid:{ label:'Hybrid' },
  moments:{ label:'Moments' }
};

let canceled = false;
const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const progress = (done, total, detail, stage = 'ordering') => post('progress', { done, total, detail, stage });
const abortIfNeeded = () => { if (canceled) throw new DOMException('Aborted', 'AbortError'); };
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));

function openDb(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openAiDb() {
  return openDb(AI_DB, AI_DB_VERSION, db => {
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
  });
}

function openVisualDb() {
  return openDb(VISUAL_DB, VISUAL_DB_VERSION, db => {
    if (!db.objectStoreNames.contains(VISUAL_STORE)) db.createObjectStore(VISUAL_STORE, { keyPath:'hash' });
  });
}

function createSpace(count, dim = PROJECTION_DIMS) {
  return { count, dim, data:new Float32Array(count * dim), available:new Uint8Array(count) };
}

function normalizeSegment(data, offset, dim) {
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += data[offset + d] * data[offset + d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) data[offset + d] /= norm;
}

const projectionMaps = new Map();
function projectionMap(length) {
  if (projectionMaps.has(length)) return projectionMaps.get(length);
  const first = new Uint16Array(length);
  const second = new Uint16Array(length);
  const signs = new Int8Array(length * 2);
  for (let j = 0; j < length; j++) {
    const h1 = Math.imul(j + 1, 0x9e3779b1) >>> 0;
    const h2 = Math.imul(j + 17, 0x85ebca6b) >>> 0;
    first[j] = h1 % PROJECTION_DIMS;
    second[j] = h2 % PROJECTION_DIMS;
    signs[j * 2] = h1 & 0x80000000 ? -1 : 1;
    signs[j * 2 + 1] = h2 & 0x40000000 ? -1 : 1;
  }
  const value = { first, second, signs };
  projectionMaps.set(length, value);
  return value;
}

function projectVector(source, target, offset) {
  const map = projectionMap(source.length);
  for (let j = 0; j < source.length; j++) {
    const value = Number(source[j]) || 0;
    target[offset + map.first[j]] += value * map.signs[j * 2];
    target[offset + map.second[j]] += value * map.signs[j * 2 + 1];
  }
  normalizeSegment(target, offset, PROJECTION_DIMS);
}

function versionFor(model) { return model === 'siglip2' ? SIGLIP_VERSION : DINO_VERSION; }
function labelFor(model) { return model === 'siglip2' ? 'semantic' : 'visual'; }

async function loadEmbeddingSpace(model, media, indexByHash) {
  const space = createSpace(media.length);
  const version = versionFor(model);
  const db = await openAiDb();
  let loaded = 0;
  progress(0, media.length, `Reading saved ${labelFor(model)} AI index…`, 'embeddings');
  try {
    const tx = db.transaction(EMBEDDINGS, 'readonly');
    const store = tx.objectStore(EMBEDDINGS);
    const index = store.index('model');
    const request = index.openCursor(IDBKeyRange.only(version));
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (canceled) return reject(new DOMException('Aborted', 'AbortError'));
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value || {};
        const mediaIndex = indexByHash.get(String(row.hash || ''));
        if (mediaIndex != null && Number(row.schema) === EMBEDDING_SCHEMA && row.vector?.length) {
          projectVector(row.vector, space.data, mediaIndex * PROJECTION_DIMS);
          space.available[mediaIndex] = 1;
          loaded++;
          if (loaded % 2000 === 0) progress(loaded, media.length, `Reading saved ${labelFor(model)} AI index · ${loaded.toLocaleString()} matched…`, 'embeddings');
        }
        cursor.continue();
      };
    });
  } finally { db.close(); }
  space.loaded = loaded;
  progress(loaded, media.length, `${model === 'siglip2' ? 'Semantic' : 'Visual'} AI index · ${loaded.toLocaleString()} media ready`, 'embeddings');
  return space;
}

function descriptorSpace(count) {
  return {
    color:new Float32Array(count * 5),
    structure:new Float32Array(count * 16),
    available:new Uint8Array(count)
  };
}

function descriptorFromRow(row) {
  const color = row?.visualColor;
  const feature = row?.visualFeature;
  if (!color || !feature) return null;
  const grid = Array.isArray(color.grid) ? color.grid : [];
  const layout = Array.isArray(feature.layout) ? feature.layout : [];
  const energy = Array.isArray(feature.energy) ? feature.energy : [];
  const edges = Array.isArray(feature.edges) ? feature.edges : [];
  if (grid.length < 3) return null;
  const hue = Number(color.dominantHue);
  const strength = Number(color.dominantStrength);
  const meanLuma = Number(feature.meanLuma) / 255;
  const meanChroma = Number(color.meanChroma);
  const resultColor = new Float32Array([
    Number.isFinite(hue) ? hue : 0,
    Number.isFinite(strength) ? strength : 0,
    Number.isFinite(meanLuma) ? meanLuma : clamp(Number(grid[0]) || 0),
    Number.isFinite(meanChroma) ? meanChroma : Math.hypot(Number(grid[1]) || 0, Number(grid[2]) || 0),
    Number(color.colorFraction) || 0
  ]);
  const structure = new Float32Array(16);
  for (let q = 0; q < 4; q++) {
    let luma = 0, edge = 0, n = 0;
    const x0 = q % 2 ? 2 : 0;
    const y0 = q >= 2 ? 2 : 0;
    for (let y = y0; y < y0 + 2; y++) for (let x = x0; x < x0 + 2; x++) {
      const cell = y * 4 + x;
      luma += (Number(layout[cell * 3]) || 0) / 255;
      edge += (Number(energy[cell]) || 0) / 255;
      n++;
    }
    structure[q] = luma / Math.max(1, n);
    structure[4 + q] = edge / Math.max(1, n);
  }
  let horizontal = 0, vertical = 0;
  for (let cell = 0; cell < 16; cell++) {
    horizontal += (Number(edges[cell * 4]) || 0) / 255 + (Number(edges[cell * 4 + 2]) || 0) / 255;
    vertical += (Number(edges[cell * 4 + 1]) || 0) / 255 + (Number(edges[cell * 4 + 3]) || 0) / 255;
  }
  structure[8] = horizontal / 32;
  structure[9] = vertical / 32;
  structure[10] = (Number(feature.contrast) || 0) / 255;
  structure[11] = (Number(feature.edgeDensity) || 0) / 255;
  structure[12] = (Number(feature.colorfulness) || 0) / 255;
  structure[13] = resultColor[2];
  structure[14] = resultColor[3] * 4;
  structure[15] = resultColor[4];
  return { color:resultColor, structure };
}

async function loadDescriptors(media, indexByHash) {
  const result = descriptorSpace(media.length);
  const db = await openVisualDb();
  let loaded = 0;
  progress(0, media.length, 'Reading saved color / structure descriptors…', 'descriptors');
  try {
    const tx = db.transaction(VISUAL_STORE, 'readonly');
    const request = tx.objectStore(VISUAL_STORE).openCursor();
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (canceled) return reject(new DOMException('Aborted', 'AbortError'));
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value || {};
        const index = indexByHash.get(String(row.hash || ''));
        if (index != null) {
          const descriptor = descriptorFromRow(row);
          if (descriptor) {
            result.color.set(descriptor.color, index * 5);
            result.structure.set(descriptor.structure, index * 16);
            result.available[index] = 1;
            loaded++;
          }
        }
        cursor.continue();
      };
    });
  } finally { db.close(); }
  result.loaded = loaded;
  progress(loaded, media.length, `Color / structure descriptors · ${loaded.toLocaleString()} available`, 'descriptors');
  return result;
}

function distance(space, left, right) {
  const a = left * space.dim;
  const b = right * space.dim;
  let dot = 0;
  for (let d = 0; d < space.dim; d++) dot += space.data[a + d] * space.data[b + d];
  return 1 - dot;
}

function projection(space, index, axis) {
  const offset = index * space.dim;
  let total = 0;
  for (let d = 0; d < space.dim; d++) total += space.data[offset + d] * axis[d];
  return total;
}

function farthestFrom(space, sample, source) {
  let best = source;
  let bestDistance = -Infinity;
  for (const index of sample) {
    const value = distance(space, source, index);
    if (value > bestDistance) { bestDistance = value; best = index; }
  }
  return best;
}

function splitIndexes(indexes, space, scratch) {
  if (indexes.length < 2) return [indexes, []];
  const sampleCount = Math.min(32, indexes.length);
  const sample = Array.from({ length:sampleCount }, (_, i) => indexes[Math.min(indexes.length - 1, Math.floor((i + .5) * indexes.length / sampleCount))]);
  const first = farthestFrom(space, sample, sample[0]);
  const second = farthestFrom(space, sample, first);
  const axis = new Float32Array(space.dim);
  const a = first * space.dim;
  const b = second * space.dim;
  let norm = 0;
  for (let d = 0; d < space.dim; d++) { axis[d] = space.data[b + d] - space.data[a + d]; norm += axis[d] * axis[d]; }
  if (norm < 1e-9) axis[0] = 1;
  for (const index of indexes) scratch[index] = projection(space, index, axis);
  indexes.sort((x, y) => scratch[x] - scratch[y] || x - y);
  const middle = Math.ceil(indexes.length / 2);
  return [indexes.slice(0, middle), indexes.slice(middle)];
}

function greedyLeaf(indexes, space) {
  if (indexes.length < 3) return indexes.slice();
  const remaining = indexes.slice();
  const route = [remaining.shift()];
  while (remaining.length) {
    const current = route.at(-1);
    let bestAt = 0;
    let best = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const value = distance(space, current, remaining[i]);
      if (value < best) { best = value; bestAt = i; }
    }
    route.push(remaining.splice(bestAt, 1)[0]);
  }
  return route;
}

function orientJoin(left, right, space) {
  if (!left.length) return right;
  if (!right.length) return left;
  const choices = [
    [distance(space, left.at(-1), right[0]), false, false],
    [distance(space, left.at(-1), right.at(-1)), false, true],
    [distance(space, left[0], right[0]), true, false],
    [distance(space, left[0], right.at(-1)), true, true]
  ].sort((a, b) => a[0] - b[0]);
  if (choices[0][1]) left.reverse();
  if (choices[0][2]) right.reverse();
  return left.concat(right);
}

function route(indexes, space, leafSize = 36, scratch = new Float32Array(space.count)) {
  abortIfNeeded();
  if (indexes.length <= leafSize) return greedyLeaf(indexes, space);
  const [leftPart, rightPart] = splitIndexes(indexes.slice(), space, scratch);
  const left = route(leftPart, space, leafSize, scratch);
  const right = route(rightPart, space, leafSize, scratch);
  return orientJoin(left, right, space);
}

function recursiveGroups(indexes, space, wanted) {
  const scratch = new Float32Array(space.count);
  const groups = [indexes.slice()];
  while (groups.length < wanted) {
    abortIfNeeded();
    let largest = -1;
    for (let i = 0; i < groups.length; i++) if (groups[i].length > 24 && (largest < 0 || groups[i].length > groups[largest].length)) largest = i;
    if (largest < 0) break;
    const [left, right] = splitIndexes(groups.splice(largest, 1)[0], space, scratch);
    groups.push(left, right);
  }
  return groups.filter(group => group.length);
}

function centroidSpace(groups, source) {
  const result = createSpace(groups.length, source.dim);
  for (let g = 0; g < groups.length; g++) {
    const target = g * source.dim;
    for (const index of groups[g]) {
      const offset = index * source.dim;
      for (let d = 0; d < source.dim; d++) result.data[target + d] += source.data[offset + d];
    }
    normalizeSegment(result.data, target, source.dim);
    result.available[g] = 1;
  }
  return result;
}

function groupedRoute(indexes, clusterSpace, innerSpace, targetGroups, label = 'Family') {
  const groups = recursiveGroups(indexes, clusterSpace, targetGroups);
  const centroids = centroidSpace(groups, clusterSpace);
  const groupOrder = route([...groups.keys()], centroids, 8);
  const result = [];
  const rail = [];
  let previous = -1;
  for (let orderIndex = 0; orderIndex < groupOrder.length; orderIndex++) {
    const group = groups[groupOrder[orderIndex]];
    let inside = route(group, innerSpace, 32);
    if (previous >= 0 && inside.length > 1 && distance(innerSpace, previous, inside.at(-1)) < distance(innerSpace, previous, inside[0])) inside.reverse();
    rail.push({ index:result.length, label:`${label} ${orderIndex + 1}` });
    result.push(...inside);
    previous = inside.at(-1);
  }
  return { route:result, rail, families:groups.length };
}

function combinedSpace(left, right, leftWeight = 1, rightWeight = 1) {
  const count = Math.max(left?.count || 0, right?.count || 0);
  const leftDim = left?.dim || 0;
  const rightDim = right?.dim || 0;
  const result = createSpace(count, leftDim + rightDim);
  for (let i = 0; i < count; i++) {
    if (!left?.available[i] || !right?.available[i]) continue;
    const out = i * result.dim;
    const a = i * leftDim;
    const b = i * rightDim;
    for (let d = 0; d < leftDim; d++) result.data[out + d] = left.data[a + d] * leftWeight;
    for (let d = 0; d < rightDim; d++) result.data[out + leftDim + d] = right.data[b + d] * rightWeight;
    normalizeSegment(result.data, out, result.dim);
    result.available[i] = 1;
  }
  return result;
}

function structureSpace(dino, descriptors) {
  const result = createSpace(dino.count, dino.dim + 16);
  for (let i = 0; i < dino.count; i++) {
    if (!dino.available[i]) continue;
    const out = i * result.dim;
    const source = i * dino.dim;
    for (let d = 0; d < dino.dim; d++) result.data[out + d] = dino.data[source + d] * .55;
    if (descriptors?.available[i]) {
      let norm = 0;
      for (let d = 0; d < 16; d++) { const value = descriptors.structure[i * 16 + d]; norm += value * value; }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < 16; d++) result.data[out + dino.dim + d] = descriptors.structure[i * 16 + d] / norm * 1.15;
    }
    normalizeSegment(result.data, out, result.dim);
    result.available[i] = 1;
  }
  return result;
}

function availableIndexes(space) {
  const result = [];
  for (let i = 0; i < space.count; i++) if (space.available[i]) result.push(i);
  return result;
}

function colorRoute(indexes, dino, descriptors) {
  const hueBins = Array.from({ length:30 }, () => []);
  const grayBins = Array.from({ length:10 }, () => []);
  const unknown = [];
  for (const index of indexes) {
    if (!descriptors?.available[index]) { unknown.push(index); continue; }
    const offset = index * 5;
    const hue = descriptors.color[offset];
    const strength = descriptors.color[offset + 1];
    const luma = clamp(descriptors.color[offset + 2]);
    const chroma = descriptors.color[offset + 3];
    const colorful = descriptors.color[offset + 4];
    if (strength < .08 || chroma < .012 || colorful < .08) grayBins[Math.min(9, Math.floor(luma * 10))].push(index);
    else hueBins[Math.min(29, Math.floor(((hue + 1 / 24) % 1) * 30))].push(index);
  }
  const result = [];
  const rail = [];
  const labels = new Map([[0,'Red'],[4,'Orange'],[7,'Yellow'],[10,'Green'],[14,'Cyan'],[18,'Blue'],[22,'Purple'],[26,'Magenta']]);
  const scratch = new Float32Array(dino.count);
  for (let bin = 0; bin < hueBins.length; bin++) {
    if (!hueBins[bin].length) continue;
    if (labels.has(bin)) rail.push({ index:result.length, label:labels.get(bin) });
    result.push(...route(hueBins[bin], dino, 30, scratch));
  }
  if (grayBins.some(group => group.length)) rail.push({ index:result.length, label:'Neutral' });
  for (const group of grayBins) if (group.length) result.push(...route(group, dino, 30, scratch));
  if (unknown.length) {
    rail.push({ index:result.length, label:'Other' });
    result.push(...route(unknown, dino, 30, scratch));
  }
  return { route:result, rail, families:hueBins.filter(group => group.length).length + grayBins.filter(group => group.length).length + (unknown.length ? 1 : 0) };
}

function momentsRoute(indexes, innerSpace, media) {
  const groups = new Map();
  const undated = [];
  for (const index of indexes) {
    const ms = Number(media[index]?.dateMs) || 0;
    if (!ms) { undated.push(index); continue; }
    const date = new Date(ms);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  const keys = [...groups.keys()].sort().reverse();
  const result = [];
  const rail = [];
  let lastYear = '';
  for (const key of keys) {
    const year = key.slice(0, 4);
    if (year !== lastYear) rail.push({ index:result.length, label:year });
    lastYear = year;
    result.push(...route(groups.get(key), innerSpace, 28));
  }
  if (undated.length) {
    rail.push({ index:result.length, label:'Undated' });
    result.push(...route(undated, innerSpace, 28));
  }
  return { route:result, rail, families:keys.length + (undated.length ? 1 : 0) };
}

function genericRail(length) {
  if (!length) return [];
  const ticks = Math.min(17, length);
  return [...new Set(Array.from({ length:ticks }, (_, i) => Math.round(i * (length - 1) / Math.max(1, ticks - 1))))]
    .map(index => ({ index, label:`${Math.round(index / Math.max(1, length - 1) * 100)}%` }));
}

async function buildOrder(payload) {
  const mode = MODE_INFO[payload?.mode] ? payload.mode : 'flow';
  const media = Array.isArray(payload?.media) ? payload.media.filter(item => HASH_RE.test(String(item?.hash || ''))) : [];
  if (!media.length) return { order:[], indexed:0, unavailable:0, families:0, rail:[] };
  const indexByHash = new Map(media.map((item, index) => [String(item.hash), index]));
  progress(0, media.length, `Opening ${MODE_INFO[mode].label} AI order…`, 'opening');

  const needDino = ['flow','families','color','structure','topics','hybrid','moments'].includes(mode);
  const needSiglip = ['meaning','topics','hybrid','moments'].includes(mode);
  const needDescriptors = ['color','structure'].includes(mode);

  const dino = needDino ? await loadEmbeddingSpace('dinov3', media, indexByHash) : null;
  abortIfNeeded();
  const siglip = needSiglip ? await loadEmbeddingSpace('siglip2', media, indexByHash) : null;
  abortIfNeeded();
  const descriptors = needDescriptors ? await loadDescriptors(media, indexByHash) : null;
  abortIfNeeded();

  if (needDino && !dino.loaded) throw new Error('Visual AI index is empty for this view.');
  if (needSiglip && !siglip.loaded) throw new Error('Semantic AI index is empty for this view.');

  let space = dino || siglip;
  let built;
  if (mode === 'structure') space = structureSpace(dino, descriptors);
  else if (mode === 'hybrid') space = combinedSpace(siglip, dino, 1.05, .9);
  else if (mode === 'moments') space = siglip?.loaded && dino?.loaded ? combinedSpace(siglip, dino, .8, .8) : (dino || siglip);

  const indexed = availableIndexes(space);
  if (!indexed.length) throw new Error('No indexed media matched this view.');
  progress(0, indexed.length, `Arranging ${indexed.length.toLocaleString()} media with ${MODE_INFO[mode].label}…`, 'ordering');

  if (mode === 'families') {
    const groups = Math.max(20, Math.min(72, Math.round(Math.sqrt(indexed.length / 22))));
    built = groupedRoute(indexed, dino, dino, groups, 'Visual family');
  } else if (mode === 'color') {
    built = colorRoute(indexed, dino, descriptors);
  } else if (mode === 'topics') {
    const groups = Math.max(20, Math.min(64, Math.round(Math.sqrt(indexed.length / 26))));
    built = groupedRoute(indexed, siglip, dino?.loaded ? dino : siglip, groups, 'Semantic topic');
  } else if (mode === 'moments') {
    built = momentsRoute(indexed, space, media);
  } else {
    built = { route:route(indexed, space, mode === 'flow' || mode === 'meaning' ? 28 : 34), rail:[], families:0 };
  }

  const missing = [];
  for (let i = 0; i < media.length; i++) if (!space.available[i]) missing.push(i);
  built.route.push(...missing);
  if (!built.rail.length) built.rail = genericRail(built.route.length);
  progress(built.route.length, media.length, `${MODE_INFO[mode].label} AI order ready`, 'ordering');

  return {
    order:built.route.map(index => media[index].hash),
    indexed:indexed.length,
    unavailable:missing.length,
    families:built.families || 0,
    rail:built.rail,
    dinoIndexed:dino?.loaded || 0,
    semanticIndexed:siglip?.loaded || 0,
    descriptorIndexed:descriptors?.loaded || 0
  };
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.action === 'cancel') { canceled = true; return; }
  canceled = false;
  try {
    const result = await buildOrder(data.payload || {});
    abortIfNeeded();
    post('result', { result });
  } catch (error) {
    post('error', { error:error?.name === 'AbortError' ? 'Canceled' : (error?.message || String(error)), aborted:error?.name === 'AbortError' });
  }
};
