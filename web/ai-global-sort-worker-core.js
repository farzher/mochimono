const AI_DB = 'mochimono-ai';
const AI_DB_VERSION = 2;
const EMBEDDINGS = 'embeddings';
const METADATA = 'metadata';
const EMBEDDING_SCHEMA = 3;
const THUMB_VERSION = 3;
const DINO_VERSION = 'dinov3-vitb16-v2';
const SIGLIP_VERSION = 'siglip2-base-224-v2';
const VISUAL_DB = 'mochimono-visual-similarity';
const VISUAL_STORE = 'fingerprints';
const VISUAL_DB_VERSION = 1;
const AUX_VERSION = 'ai-global-sort-aux-v1';
const PROJECTION_DIMS = 48;
const AUX_SAMPLE = 24;
const AUX_BATCH = 24;
const HASH_RE = /^[a-f0-9]{64}$/;

const MODE_INFO = {
  flow:{ label:'Flow', model:'dinov3' },
  families:{ label:'Families', model:'dinov3' },
  color:{ label:'Color', model:'dinov3', aux:true },
  structure:{ label:'Structure', model:'dinov3', aux:true },
  meaning:{ label:'Meaning', model:'siglip2' },
  topics:{ label:'Topics', model:'siglip2' },
  hybrid:{ label:'Hybrid', model:'hybrid' },
  moments:{ label:'Moments', model:'dinov3' }
};

let canceled = false;
const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const progress = (done, total, detail, stage = 'ordering') => post('progress', { done, total, detail, stage });
const abortIfNeeded = () => { if (canceled) throw new DOMException('Aborted', 'AbortError'); };
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const uq = value => (Number(value) || 0) / 255;

function openAiDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AI_DB, AI_DB_VERSION);
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openVisualDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VISUAL_DB, VISUAL_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(VISUAL_STORE)) request.result.createObjectStore(VISUAL_STORE, { keyPath:'hash' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function modelVersion(model) { return model === 'siglip2' ? SIGLIP_VERSION : DINO_VERSION; }

function projectVector(source, target, offset, dims = PROJECTION_DIMS) {
  const invSqrt2 = Math.SQRT1_2;
  for (let j = 0; j < source.length; j++) {
    const x = Number(source[j]) || 0;
    const h1 = Math.imul(j + 1, 0x9e3779b1) >>> 0;
    const h2 = Math.imul(j + 17, 0x85ebca6b) >>> 0;
    const b1 = h1 % dims;
    const b2 = h2 % dims;
    target[offset + b1] += (h1 & 0x80000000 ? -x : x) * invSqrt2;
    target[offset + b2] += (h2 & 0x40000000 ? -x : x) * invSqrt2;
  }
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += target[offset + d] * target[offset + d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dims; d++) target[offset + d] /= norm;
}

async function loadProjected(model, media, indexByHash) {
  const count = media.length;
  const data = new Float32Array(count * PROJECTION_DIMS);
  const available = new Uint8Array(count);
  const db = await openAiDb();
  const version = modelVersion(model);
  let loaded = 0;
  try {
    const tx = db.transaction(EMBEDDINGS, 'readonly');
    const index = tx.objectStore(EMBEDDINGS).index('model');
    const request = index.openCursor(IDBKeyRange.only(version));
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (canceled) return reject(new DOMException('Aborted', 'AbortError'));
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value;
        const mediaIndex = indexByHash.get(String(row?.hash || ''));
        if (mediaIndex != null && Number(row?.schema) === EMBEDDING_SCHEMA && row?.vector?.length) {
          projectVector(row.vector, data, mediaIndex * PROJECTION_DIMS);
          available[mediaIndex] = 1;
          loaded++;
          if (loaded % 5000 === 0) progress(loaded, count, `Loading ${model === 'dinov3' ? 'DINOv3 visual' : 'SigLIP semantic'} embeddings · ${loaded.toLocaleString()}`, 'embeddings');
        }
        cursor.continue();
      };
    });
  } finally { db.close(); }
  return { model, count, data, available, loaded, dim:PROJECTION_DIMS };
}

function oklab(red, green, blue) {
  const linear = value => {
    value /= 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  const r = linear(red), g = linear(green), b = linear(blue);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [
    .2104542553 * l + .793617785 * m - .0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s
  ];
}

function classicAux(row) {
  const color = row?.visualColor;
  const feature = row?.visualFeature;
  if (!color || !Array.isArray(color.grid) || color.grid.length < 3 || !feature) return null;
  const L = Number(color.grid[0]) || 0;
  const a = Number(color.grid[1]) || 0;
  const b = Number(color.grid[2]) || 0;
  const chroma = Number(color.meanChroma) || Math.hypot(a, b);
  const structure = new Float32Array(12);
  const layout = Array.isArray(feature.layout) ? feature.layout : [];
  const energy = Array.isArray(feature.energy) ? feature.energy : [];
  const edges = Array.isArray(feature.edges) ? feature.edges : [];
  for (let q = 0; q < 4; q++) {
    let luma = 0, edge = 0, cells = 0;
    const x0 = q % 2 ? 2 : 0;
    const y0 = q >= 2 ? 2 : 0;
    for (let y = y0; y < y0 + 2; y++) for (let x = x0; x < x0 + 2; x++) {
      const cell = y * 4 + x;
      luma += uq(layout[cell * 3]);
      edge += uq(energy[cell]);
      cells++;
    }
    structure[q] = luma / Math.max(1, cells);
    structure[4 + q] = edge / Math.max(1, cells);
  }
  let horizontal = 0, vertical = 0;
  for (let cell = 0; cell < 16; cell++) {
    horizontal += uq(edges[cell * 4]) + uq(edges[cell * 4 + 2]);
    vertical += uq(edges[cell * 4 + 1]) + uq(edges[cell * 4 + 3]);
  }
  structure[8] = horizontal / 32;
  structure[9] = vertical / 32;
  structure[10] = uq(feature.contrast);
  structure[11] = uq(feature.edgeDensity);
  return { color:new Float32Array([L, a, b, chroma]), structure };
}

function cachedAux(row) {
  if (row?.aiGlobalSortAuxVersion !== AUX_VERSION) return null;
  const value = row.aiGlobalSortAux;
  if (!Array.isArray(value?.color) || value.color.length !== 4 || !Array.isArray(value?.structure) || value.structure.length !== 12) return null;
  return { color:Float32Array.from(value.color), structure:Float32Array.from(value.structure) };
}

async function computeAux(hash) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache' });
  if (!response.ok) throw new Error(`Thumbnail unavailable (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(AUX_SAMPLE, AUX_SAMPLE);
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(bitmap, 0, 0, AUX_SAMPLE, AUX_SAMPLE);
    const pixels = context.getImageData(0, 0, AUX_SAMPLE, AUX_SAMPLE).data;
    const quadrantLuma = new Float64Array(4);
    const quadrantCount = new Uint16Array(4);
    const gray = new Float32Array(AUX_SAMPLE * AUX_SAMPLE);
    let red = 0, green = 0, blue = 0, sum = 0, sumSq = 0;
    for (let y = 0; y < AUX_SAMPLE; y++) for (let x = 0; x < AUX_SAMPLE; x++) {
      const i = y * AUX_SAMPLE + x;
      const p = i * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      red += r; green += g; blue += b;
      const luma = (r * .2126 + g * .7152 + b * .0722) / 255;
      gray[i] = luma;
      sum += luma; sumSq += luma * luma;
      const q = (y >= AUX_SAMPLE / 2 ? 2 : 0) + (x >= AUX_SAMPLE / 2 ? 1 : 0);
      quadrantLuma[q] += luma;
      quadrantCount[q]++;
    }
    const quadrantEdge = new Float64Array(4);
    let horizontal = 0, vertical = 0, edgeTotal = 0;
    for (let y = 1; y < AUX_SAMPLE - 1; y++) for (let x = 1; x < AUX_SAMPLE - 1; x++) {
      const i = y * AUX_SAMPLE + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + AUX_SAMPLE] - gray[i - AUX_SAMPLE]);
      const magnitude = Math.hypot(gx, gy);
      const q = (y >= AUX_SAMPLE / 2 ? 2 : 0) + (x >= AUX_SAMPLE / 2 ? 1 : 0);
      quadrantEdge[q] += magnitude;
      horizontal += gx;
      vertical += gy;
      edgeTotal += magnitude;
    }
    const count = AUX_SAMPLE * AUX_SAMPLE;
    const lab = oklab(red / count, green / count, blue / count);
    const mean = sum / count;
    const structure = new Float32Array(12);
    for (let q = 0; q < 4; q++) {
      structure[q] = quadrantLuma[q] / Math.max(1, quadrantCount[q]);
      structure[4 + q] = clamp(quadrantEdge[q] / Math.max(1, quadrantCount[q]) * 4);
    }
    structure[8] = clamp(horizontal / count * 4);
    structure[9] = clamp(vertical / count * 4);
    structure[10] = clamp(Math.sqrt(Math.max(0, sumSq / count - mean * mean)) * 2.5);
    structure[11] = clamp(edgeTotal / count * 4);
    return { color:new Float32Array([lab[0], lab[1], lab[2], Math.hypot(lab[1], lab[2])]), structure };
  } finally { bitmap.close?.(); }
}

async function saveAuxBatch(entries) {
  if (!entries.length) return;
  const db = await openVisualDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VISUAL_STORE, 'readwrite');
      const store = tx.objectStore(VISUAL_STORE);
      for (const entry of entries) {
        const request = store.get(entry.hash);
        request.onsuccess = () => store.put({
          ...(request.result || { hash:entry.hash }),
          hash:entry.hash,
          aiGlobalSortAuxVersion:AUX_VERSION,
          aiGlobalSortAux:{ color:[...entry.color], structure:[...entry.structure] },
          updatedAt:Date.now()
        });
        request.onerror = () => tx.abort();
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Could not cache AI sort descriptors'));
    });
  } finally { db.close(); }
}

async function loadAux(media, indexByHash, dinoAvailable) {
  const count = media.length;
  const color = new Float32Array(count * 4);
  const structure = new Float32Array(count * 12);
  const available = new Uint8Array(count);
  const db = await openVisualDb();
  try {
    const tx = db.transaction(VISUAL_STORE, 'readonly');
    const request = tx.objectStore(VISUAL_STORE).openCursor();
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (canceled) return reject(new DOMException('Aborted', 'AbortError'));
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value;
        const index = indexByHash.get(String(row?.hash || ''));
        if (index != null && dinoAvailable[index]) {
          const aux = cachedAux(row) || classicAux(row);
          if (aux) {
            color.set(aux.color, index * 4);
            structure.set(aux.structure, index * 12);
            available[index] = 1;
          }
        }
        cursor.continue();
      };
    });
  } finally { db.close(); }

  const missing = [];
  for (let i = 0; i < count; i++) if (dinoAvailable[i] && !available[i]) missing.push(i);
  let done = count - missing.length;
  if (missing.length) progress(done, count, `Reading color / structure summaries · ${done.toLocaleString()} / ${count.toLocaleString()}`, 'aux');
  for (let offset = 0; offset < missing.length; offset += AUX_BATCH) {
    abortIfNeeded();
    const chunk = missing.slice(offset, offset + AUX_BATCH);
    const results = await Promise.allSettled(chunk.map(index => computeAux(media[index].hash)));
    const writes = [];
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const index = chunk[j];
      if (result.status !== 'fulfilled') continue;
      color.set(result.value.color, index * 4);
      structure.set(result.value.structure, index * 12);
      available[index] = 1;
      writes.push({ hash:media[index].hash, ...result.value });
    }
    await saveAuxBatch(writes).catch(() => {});
    done += chunk.length;
    progress(done, count, `Reading color / structure summaries · ${done.toLocaleString()} / ${count.toLocaleString()}`, 'aux');
  }
  return { color, structure, available };
}

function createSpace(count, dim) {
  return { count, dim, data:new Float32Array(count * dim), available:new Uint8Array(count) };
}

function normalizeSegment(data, offset, dim) {
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += data[offset + d] * data[offset + d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) data[offset + d] /= norm;
}

function combinedSpace(mode, media, dino, siglip, aux) {
  const count = media.length;
  if (mode === 'flow' || mode === 'families' || mode === 'moments' || mode === 'color') return dino;
  if (mode === 'meaning' || mode === 'topics') return siglip;
  if (mode === 'structure') {
    const dim = PROJECTION_DIMS + 12;
    const out = createSpace(count, dim);
    for (let i = 0; i < count; i++) {
      if (!dino?.available[i]) continue;
      const offset = i * dim;
      const dinoOffset = i * PROJECTION_DIMS;
      for (let d = 0; d < PROJECTION_DIMS; d++) out.data[offset + d] = dino.data[dinoOffset + d] * .68;
      if (aux?.available[i]) {
        let norm = 0;
        for (let d = 0; d < 12; d++) { const v = aux.structure[i * 12 + d]; norm += v * v; }
        norm = Math.sqrt(norm) || 1;
        for (let d = 0; d < 12; d++) out.data[offset + PROJECTION_DIMS + d] = aux.structure[i * 12 + d] / norm * .95;
      }
      normalizeSegment(out.data, offset, dim);
      out.available[i] = 1;
    }
    return out;
  }
  if (mode === 'hybrid') {
    const dim = PROJECTION_DIMS * 2;
    const out = createSpace(count, dim);
    for (let i = 0; i < count; i++) {
      if (!dino?.available[i] || !siglip?.available[i]) continue;
      const offset = i * dim;
      const a = i * PROJECTION_DIMS;
      for (let d = 0; d < PROJECTION_DIMS; d++) {
        out.data[offset + d] = dino.data[a + d] * Math.SQRT1_2;
        out.data[offset + PROJECTION_DIMS + d] = siglip.data[a + d] * Math.SQRT1_2;
      }
      normalizeSegment(out.data, offset, dim);
      out.available[i] = 1;
    }
    return out;
  }
  return dino;
}

function distance(space, left, right) {
  const dim = space.dim;
  const a = left * dim;
  const b = right * dim;
  let dot = 0;
  for (let d = 0; d < dim; d++) dot += space.data[a + d] * space.data[b + d];
  return 1 - dot;
}

function projection(space, index, axis) {
  const offset = index * space.dim;
  let total = 0;
  for (let d = 0; d < space.dim; d++) total += space.data[offset + d] * axis[d];
  return total;
}

function farthestFrom(space, sample, source) {
  let best = source, bestDistance = -1;
  for (const index of sample) {
    const value = distance(space, source, index);
    if (value > bestDistance) { bestDistance = value; best = index; }
  }
  return best;
}

function splitIndexes(indexes, space, scratch) {
  if (indexes.length < 2) return [indexes, []];
  const sampleCount = Math.min(24, indexes.length);
  const sample = [];
  for (let i = 0; i < sampleCount; i++) sample.push(indexes[Math.min(indexes.length - 1, Math.floor((i + .5) * indexes.length / sampleCount))]);
  const leftPivot = farthestFrom(space, sample, sample[0]);
  const rightPivot = farthestFrom(space, sample, leftPivot);
  const axis = new Float32Array(space.dim);
  const a = leftPivot * space.dim;
  const b = rightPivot * space.dim;
  let axisNorm = 0;
  for (let d = 0; d < space.dim; d++) { axis[d] = space.data[b + d] - space.data[a + d]; axisNorm += axis[d] * axis[d]; }
  if (axisNorm < 1e-8) axis[0] = 1;
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
    let bestAt = 0, best = Infinity;
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
  const a0 = left[0], a1 = left.at(-1), b0 = right[0], b1 = right.at(-1);
  const choices = [
    [distance(space, a1, b0), false, false],
    [distance(space, a1, b1), false, true],
    [distance(space, a0, b0), true, false],
    [distance(space, a0, b1), true, true]
  ].sort((x, y) => x[0] - y[0]);
  if (choices[0][1]) left.reverse();
  if (choices[0][2]) right.reverse();
  return left.concat(right);
}

function rpRoute(indexes, space, options = {}, scratch = new Float32Array(space.count)) {
  abortIfNeeded();
  const leafSize = Math.max(8, Number(options.leafSize) || 28);
  if (indexes.length <= leafSize) return options.smooth ? greedyLeaf(indexes, space) : indexes.slice();
  const [leftPart, rightPart] = splitIndexes(indexes.slice(), space, scratch);
  const left = rpRoute(leftPart, space, options, scratch);
  const right = rpRoute(rightPart, space, options, scratch);
  return orientJoin(left, right, space);
}

function clusteredRoute(indexes, space) {
  const targetGroups = Math.max(16, Math.min(80, Math.round(Math.sqrt(indexes.length / 32))));
  const scratch = new Float32Array(space.count);
  const groups = [indexes.slice()];
  while (groups.length < targetGroups) {
    abortIfNeeded();
    let largestAt = -1;
    for (let i = 0; i < groups.length; i++) if (groups[i].length > 12 && (largestAt < 0 || groups[i].length > groups[largestAt].length)) largestAt = i;
    if (largestAt < 0) break;
    const group = groups.splice(largestAt, 1)[0];
    const [left, right] = splitIndexes(group, space, scratch);
    groups.push(left, right);
  }

  const centroid = createSpace(groups.length, space.dim);
  for (let g = 0; g < groups.length; g++) {
    for (const index of groups[g]) {
      const source = index * space.dim;
      const target = g * space.dim;
      for (let d = 0; d < space.dim; d++) centroid.data[target + d] += space.data[source + d];
    }
    normalizeSegment(centroid.data, g * space.dim, space.dim);
    centroid.available[g] = 1;
  }
  const groupOrder = rpRoute([...groups.keys()], centroid, { leafSize:8, smooth:true });
  const route = [];
  const boundaries = [];
  for (let orderIndex = 0; orderIndex < groupOrder.length; orderIndex++) {
    const group = groups[groupOrder[orderIndex]];
    boundaries.push({ index:route.length, label:`Family ${orderIndex + 1}` });
    route.push(...rpRoute(group, space, { leafSize:28, smooth:true }, scratch));
  }
  return { route, families:groups.length, rail:boundaries };
}

function colorSpectrumRoute(indexes, space, aux) {
  const bins = Array.from({ length:36 }, () => []);
  const gray = Array.from({ length:12 }, () => []);
  const unknown = [];
  for (const index of indexes) {
    if (!aux?.available[index]) { unknown.push(index); continue; }
    const o = index * 4;
    const L = clamp(aux.color[o]);
    const a = aux.color[o + 1];
    const b = aux.color[o + 2];
    const chroma = Math.max(0, aux.color[o + 3]);
    if (chroma < .012) {
      gray[Math.min(11, Math.floor(L * 12))].push(index);
      continue;
    }
    let hue = Math.atan2(b, a) / (Math.PI * 2);
    if (hue < 0) hue += 1;
    hue = (hue + 15 / 360) % 1;
    bins[Math.min(35, Math.floor(hue * 36))].push(index);
  }
  const route = [];
  const rail = [];
  const sections = new Map([[0,'Red'],[4,'Orange'],[7,'Yellow'],[11,'Green'],[16,'Cyan'],[20,'Blue'],[25,'Purple'],[30,'Magenta']]);
  const scratch = new Float32Array(space.count);
  for (let bin = 0; bin < bins.length; bin++) {
    if (!bins[bin].length) continue;
    if (sections.has(bin)) rail.push({ index:route.length, label:sections.get(bin) });
    route.push(...rpRoute(bins[bin], space, { leafSize:24, smooth:true }, scratch));
  }
  const grayCount = gray.reduce((sum, bucket) => sum + bucket.length, 0);
  if (grayCount) rail.push({ index:route.length, label:'Gray' });
  for (const bucket of gray) if (bucket.length) route.push(...rpRoute(bucket, space, { leafSize:24, smooth:true }, scratch));
  if (unknown.length) {
    rail.push({ index:route.length, label:'Other' });
    route.push(...rpRoute(unknown, space, { leafSize:24, smooth:true }, scratch));
  }
  return { route, rail, families:bins.filter(bucket => bucket.length).length + gray.filter(bucket => bucket.length).length + (unknown.length ? 1 : 0) };
}

function momentsRoute(indexes, space, media) {
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
  const route = [];
  const rail = [];
  const scratch = new Float32Array(space.count);
  let previousYear = '';
  for (const key of keys) {
    const year = key.slice(0, 4);
    if (year !== previousYear) rail.push({ index:route.length, label:year });
    previousYear = year;
    route.push(...rpRoute(groups.get(key), space, { leafSize:28, smooth:true }, scratch));
  }
  if (undated.length) {
    rail.push({ index:route.length, label:'Undated' });
    route.push(...rpRoute(undated, space, { leafSize:28, smooth:true }, scratch));
  }
  return { route, rail, families:keys.length + (undated.length ? 1 : 0) };
}

function genericRail(length) {
  if (!length) return [];
  const ticks = Math.min(17, length);
  return [...new Set(Array.from({ length:ticks }, (_, i) => Math.round(i * (length - 1) / Math.max(1, ticks - 1))))]
    .map(index => ({ index, label:`${Math.round(index / Math.max(1, length - 1) * 100)}%` }));
}

function indexedIndexes(space) {
  const result = [];
  for (let i = 0; i < space.count; i++) if (space.available[i]) result.push(i);
  return result;
}

async function buildOrder(payload) {
  const mode = MODE_INFO[payload?.mode] ? payload.mode : 'flow';
  const media = Array.isArray(payload?.media) ? payload.media.filter(item => HASH_RE.test(String(item?.hash || ''))) : [];
  if (!media.length) return { order:[], indexed:0, unavailable:0, families:0, rail:[] };
  const indexByHash = new Map(media.map((item, index) => [String(item.hash), index]));
  progress(0, media.length, `Opening ${MODE_INFO[mode].label} AI sort…`, 'embeddings');

  const needDino = !['meaning','topics'].includes(mode);
  const needSiglip = ['meaning','topics','hybrid'].includes(mode);
  const dino = needDino ? await loadProjected('dinov3', media, indexByHash) : null;
  abortIfNeeded();
  const siglip = needSiglip ? await loadProjected('siglip2', media, indexByHash) : null;
  abortIfNeeded();

  if (needDino && !dino.loaded) throw new Error('No DINOv3 visual embeddings found. Index Visual in AI Lab first.');
  if (needSiglip && !siglip.loaded) throw new Error('No SigLIP semantic embeddings found. Index Semantic in AI Lab first.');

  const aux = MODE_INFO[mode].aux ? await loadAux(media, indexByHash, dino.available) : null;
  abortIfNeeded();
  const space = combinedSpace(mode, media, dino, siglip, aux);
  const availableIndexes = indexedIndexes(space);
  if (!availableIndexes.length) throw new Error('No files have the embeddings required for this AI sort.');
  const missing = [];
  for (let i = 0; i < media.length; i++) if (!space.available[i]) missing.push(i);

  progress(0, availableIndexes.length, `Arranging ${availableIndexes.length.toLocaleString()} indexed media · ${MODE_INFO[mode].label}…`, 'ordering');
  let route, rail = [], families = 0;
  if (mode === 'families' || mode === 'topics') {
    const clustered = clusteredRoute(availableIndexes, space);
    route = clustered.route; rail = clustered.rail; families = clustered.families;
  } else if (mode === 'color') {
    const result = colorSpectrumRoute(availableIndexes, space, aux);
    route = result.route; rail = result.rail; families = result.families;
  } else if (mode === 'moments') {
    const result = momentsRoute(availableIndexes, space, media);
    route = result.route; rail = result.rail; families = result.families;
  } else {
    route = rpRoute(availableIndexes, space, { leafSize:mode === 'flow' ? 24 : 30, smooth:mode !== 'flow' });
  }
  abortIfNeeded();
  route.push(...missing);
  if (!rail.length) rail = genericRail(route.length);
  progress(route.length, media.length, `${MODE_INFO[mode].label} AI order ready`, 'ordering');

  return {
    order:route.map(index => media[index].hash),
    indexed:availableIndexes.length,
    unavailable:missing.length,
    families,
    rail,
    dinoIndexed:dino?.loaded || 0,
    semanticIndexed:siglip?.loaded || 0,
    auxIndexed:aux ? aux.available.reduce((sum, value) => sum + value, 0) : 0
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
