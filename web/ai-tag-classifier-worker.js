const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';
const DINO_MODEL_ID = 'onnx-community/dinov3-vitb16-pretrain-lvd1689m-ONNX';
const DB_NAME = 'mochimono-ai';
const DB_VERSION = 2;
const EMBEDDINGS = 'embeddings';
const EMBEDDING_SCHEMA = 3;
const DINO_INDEX_VERSION = 'dinov3-vitb16-v2';
const LOCAL_INDEX_VERSION = 'dinov3-vitb16-local5x64-v1';
const CLASSIFIER_VERSION = 'exact-local-v2';
const THUMB_VERSION = 3;
const LOCAL_DIMENSION = 64;
const LOCAL_REGIONS = 5;
const LOCAL_NEIGHBORS = 6;
const MAX_MATCHES = 10000;

const running = new Map();
let localRuntimePromise = null;

function post(id, type, payload = {}) { self.postMessage({ id, type, ...payload }); }
function progress(id, done, total, detail) { post(id, 'progress', { stage:'classify', done, total, detail }); }
function aborted(id) { if (running.get(id)?.aborted) throw new DOMException('Aborted', 'AbortError'); }
function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function thumbUrl(hash) { return new URL(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, self.location.origin).href; }

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('AI database transaction aborted'));
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function embeddingId(hash) { return `${DINO_INDEX_VERSION}:${hash}`; }
function localEmbeddingId(hash) { return `${LOCAL_INDEX_VERSION}:${hash}`; }

function record(row) {
  if (!row?.vector || Number(row.schema) !== EMBEDDING_SCHEMA || Number(row.normSq) <= 0) return null;
  return {
    data:row.vector instanceof Int8Array ? row.vector : Int8Array.from(row.vector),
    normSq:Number(row.normSq)
  };
}

function localRecord(row) {
  const regions = Math.trunc(Number(row?.regions) || 0);
  const dimension = Math.trunc(Number(row?.dimension) || 0);
  const norms = row?.regionNormSq;
  if (!row?.vector || Number(row.schema) !== EMBEDDING_SCHEMA || regions !== LOCAL_REGIONS || dimension !== LOCAL_DIMENSION || !norms?.length) return null;
  return {
    data:row.vector instanceof Int8Array ? row.vector : Int8Array.from(row.vector),
    norms:norms instanceof Float64Array ? norms : Float64Array.from(norms),
    regions,
    dimension
  };
}

function dot(left, right) {
  if (!left || !right) return -1;
  const a = left.data;
  const b = right.data;
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index++) total += a[index] * b[index];
  return total / Math.sqrt(left.normSq * right.normSq);
}

function localDot(left, leftRegion, right, rightRegion) {
  if (!left || !right) return -1;
  const dimension = Math.min(left.dimension, right.dimension);
  const leftOffset = leftRegion * left.dimension;
  const rightOffset = rightRegion * right.dimension;
  let total = 0;
  for (let index = 0; index < dimension; index++) total += left.data[leftOffset + index] * right.data[rightOffset + index];
  return total / Math.sqrt(Math.max(1, left.norms[leftRegion]) * Math.max(1, right.norms[rightRegion]));
}

function insertTop(top, value, limit = 4) {
  if (!Number.isFinite(value)) return;
  let index = 0;
  while (index < top.length && top[index] >= value) index++;
  if (index >= limit) return;
  top.splice(index, 0, value);
  if (top.length > limit) top.length = limit;
}

function insertNeighbor(top, item, limit = LOCAL_NEIGHBORS) {
  let index = 0;
  while (index < top.length && top[index].similarity >= item.similarity) index++;
  if (index >= limit) return;
  top.splice(index, 0, item);
  if (top.length > limit) top.length = limit;
}

function affinity(top) {
  if (!top.length) return -1;
  const weights = [.55, .25, .13, .07];
  let total = 0;
  let weight = 0;
  for (let index = 0; index < top.length; index++) {
    const current = weights[index] ?? .04;
    total += top[index] * current;
    weight += current;
  }
  return total / Math.max(.0001, weight);
}

function localAffinity(values) {
  const ranked = values.filter(Number.isFinite).sort((a, b) => b - a).slice(0, 3);
  if (!ranked.length) return -1;
  const weights = [.50, .30, .20];
  let total = 0;
  let weight = 0;
  for (let index = 0; index < ranked.length; index++) {
    total += ranked[index] * weights[index];
    weight += weights[index];
  }
  return total / Math.max(.0001, weight);
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = clamp(q) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function scoresAgainst(candidate, examples, skipHash = '') {
  const top = [];
  const neighbors = [];
  let bestHash = '';
  let best = -1;
  for (const example of examples) {
    if (skipHash && example.hash === skipHash) continue;
    const similarity = dot(candidate, example.record);
    if (similarity > best) { best = similarity; bestHash = example.hash; }
    insertTop(top, similarity);
    insertNeighbor(neighbors, { hash:example.hash, similarity });
  }
  return { best, bestHash, affinity:affinity(top), top, neighbors };
}

function localScoresAgainst(candidate, examplesByHash, neighbors) {
  if (!candidate || !neighbors?.length) return { best:-1, affinity:-1 };
  const perRegion = [];
  let best = -1;
  for (let candidateRegion = 0; candidateRegion < candidate.regions; candidateRegion++) {
    let regionBest = -1;
    for (const neighbor of neighbors) {
      const example = examplesByHash.get(neighbor.hash);
      if (!example) continue;
      for (let exampleRegion = 0; exampleRegion < example.regions; exampleRegion++) {
        const similarity = localDot(candidate, candidateRegion, example, exampleRegion);
        if (similarity > regionBest) regionBest = similarity;
        if (similarity > best) best = similarity;
      }
    }
    if (regionBest >= 0) perRegion.push(regionBest);
  }
  return { best, affinity:localAffinity(perRegion) };
}

async function loadExamples(db, hashes) {
  const wanted = [...new Set((hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
  if (!wanted.length) return [];
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const store = tx.objectStore(EMBEDDINGS);
  const rows = await Promise.all(wanted.map(hash => requestResult(store.get(embeddingId(hash))).then(row => ({ hash, row }))));
  await transactionDone(tx).catch(() => {});
  return rows.map(({ hash, row }) => {
    const value = record(row);
    return value ? { hash, record:value } : null;
  }).filter(Boolean);
}

async function existingLocalHashes(db) {
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const keys = await requestResult(tx.objectStore(EMBEDDINGS).index('model').getAllKeys(IDBKeyRange.only(LOCAL_INDEX_VERSION)));
  await transactionDone(tx).catch(() => {});
  const prefix = `${LOCAL_INDEX_VERSION}:`;
  const result = new Set();
  for (const key of keys || []) {
    const value = String(key || '');
    if (value.startsWith(prefix)) result.add(value.slice(prefix.length));
  }
  return result;
}

async function loadLocalMap(db, allowed) {
  const result = new Map();
  const tx = db.transaction(EMBEDDINGS, 'readonly');
  const request = tx.objectStore(EMBEDDINGS).index('model').openCursor(IDBKeyRange.only(LOCAL_INDEX_VERSION));
  await new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      const row = cursor.value;
      if (!allowed || allowed.has(row.hash)) {
        const value = localRecord(row);
        if (value) result.set(String(row.hash), value);
      }
      cursor.continue();
    };
  });
  await transactionDone(tx).catch(() => {});
  return result;
}

function normalizeFloat(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

function quantizeFloat(vector) {
  let maxAbs = 0;
  for (const value of vector) maxAbs = Math.max(maxAbs, Math.abs(Number(value) || 0));
  const multiplier = maxAbs > 0 ? 127 / maxAbs : 1;
  const data = new Int8Array(vector.length);
  let normSq = 0;
  for (let index = 0; index < vector.length; index++) {
    const value = Math.max(-127, Math.min(127, Math.round((Number(vector[index]) || 0) * multiplier)));
    data[index] = value;
    normSq += value * value;
  }
  return { data, normSq:Math.max(1, normSq) };
}

function denseLocalDescriptor(tensor) {
  const data = tensor?.data || tensor?.cpuData;
  const dims = Array.isArray(tensor?.dims) ? tensor.dims.map(Number) : [];
  if (!data?.length || !dims.length) throw new Error('DINO returned no dense patch features');
  const dimension = Number(dims.at(-1)) || 0;
  if (!dimension) throw new Error('DINO returned invalid dense patch features');
  const tokenCount = Math.floor(data.length / dimension);
  let grid = tokenCount >= 196 ? 14 : Math.floor(Math.sqrt(tokenCount));
  if (grid < 2) throw new Error('DINO returned too few patch features');
  const patchCount = grid * grid;
  const patchStart = Math.max(0, tokenCount - patchCount);

  const bounds = [
    [0, Math.ceil(grid / 2), 0, Math.ceil(grid / 2)],
    [0, Math.ceil(grid / 2), Math.floor(grid / 2), grid],
    [Math.floor(grid / 2), grid, 0, Math.ceil(grid / 2)],
    [Math.floor(grid / 2), grid, Math.floor(grid / 2), grid],
    [Math.floor(grid * .22), Math.ceil(grid * .78), Math.floor(grid * .22), Math.ceil(grid * .78)]
  ];
  const selected = Array.from({ length:LOCAL_DIMENSION }, (_, index) => Math.min(dimension - 1, Math.floor(index * dimension / LOCAL_DIMENSION)));
  const packed = new Int8Array(LOCAL_REGIONS * LOCAL_DIMENSION);
  const norms = new Float64Array(LOCAL_REGIONS);

  for (let regionIndex = 0; regionIndex < bounds.length; regionIndex++) {
    const [rowStart, rowEnd, colStart, colEnd] = bounds[regionIndex];
    const region = new Float32Array(LOCAL_DIMENSION);
    let count = 0;
    for (let row = rowStart; row < rowEnd; row++) {
      for (let col = colStart; col < colEnd; col++) {
        const token = patchStart + row * grid + col;
        const offset = token * dimension;
        for (let index = 0; index < selected.length; index++) region[index] += Number(data[offset + selected[index]]) || 0;
        count++;
      }
    }
    if (count) {
      const scale = 1 / count;
      for (let index = 0; index < region.length; index++) region[index] *= scale;
    }
    normalizeFloat(region);
    const quantized = quantizeFloat(region);
    packed.set(quantized.data, regionIndex * LOCAL_DIMENSION);
    norms[regionIndex] = quantized.normSq;
  }

  return { vector:packed, regionNormSq:norms, dimension:LOCAL_DIMENSION, regions:LOCAL_REGIONS };
}

function denseBatchDescriptors(output, expectedBatch) {
  if (Array.isArray(output)) {
    if (output.length !== expectedBatch) throw new Error(`DINO returned ${output.length} dense outputs for ${expectedBatch} images`);
    return output.map(denseLocalDescriptor);
  }
  const data = output?.data || output?.cpuData;
  const dims = Array.isArray(output?.dims) ? output.dims.map(Number) : [];
  if (!data?.length) throw new Error('DINO returned unreadable dense features');
  if (expectedBatch === 1) return [denseLocalDescriptor(output)];
  if (!dims.length || dims[0] !== expectedBatch) throw new Error(`DINO dense output batch does not match input batch (${dims[0] || '?'} != ${expectedBatch})`);
  const stride = Math.floor(data.length / expectedBatch);
  const perImageDims = dims.slice(1);
  const descriptors = [];
  for (let index = 0; index < expectedBatch; index++) {
    const slice = data.subarray ? data.subarray(index * stride, (index + 1) * stride) : data.slice(index * stride, (index + 1) * stride);
    descriptors.push(denseLocalDescriptor({ data:slice, dims:perImageDims }));
  }
  return descriptors;
}

async function loadLocalRuntime(id) {
  if (localRuntimePromise) return localRuntimePromise;
  localRuntimePromise = (async () => {
    const module = await import(TRANSFORMERS_URL);
    const preferredDevice = self.navigator?.gpu ? 'webgpu' : 'wasm';
    const load = async (device, dtype) => ({
      extractor:await module.pipeline('image-feature-extraction', DINO_MODEL_ID, { device, dtype }),
      RawImage:module.RawImage,
      backend:device
    });
    progress(id, 0, 4, `Visual AI ${CLASSIFIER_VERSION} · loading dense DINO features…`);
    try { return await load(preferredDevice, preferredDevice === 'webgpu' ? 'fp32' : 'q8'); }
    catch (error) {
      if (preferredDevice !== 'webgpu') throw error;
      progress(id, 0, 4, `Visual AI ${CLASSIFIER_VERSION} · WebGPU dense load failed · using CPU`);
      return load('wasm', 'q8');
    }
  })().catch(error => { localRuntimePromise = null; throw error; });
  return localRuntimePromise;
}

async function inferLocalBatch(id, runtime, items) {
  const loaded = [];
  for (const item of items) {
    try { loaded.push({ item, image:await runtime.RawImage.read(thumbUrl(item.hash)) }); }
    catch {}
  }
  if (!loaded.length) return [];
  aborted(id);
  const images = loaded.map(item => item.image);
  try {
    const output = await runtime.extractor(images.length === 1 ? images[0] : images, { pool:false });
    const descriptors = denseBatchDescriptors(output, loaded.length);
    return loaded.map((entry, index) => ({ hash:entry.item.hash, descriptor:descriptors[index] }));
  } catch (error) {
    if (loaded.length === 1) throw error;
    const result = [];
    for (const entry of loaded) {
      aborted(id);
      try {
        const output = await runtime.extractor(entry.image, { pool:false });
        result.push({ hash:entry.item.hash, descriptor:denseBatchDescriptors(output, 1)[0] });
      } catch {}
    }
    return result;
  }
}

async function putLocalRows(db, entries) {
  if (!entries.length) return;
  const tx = db.transaction(EMBEDDINGS, 'readwrite');
  const store = tx.objectStore(EMBEDDINGS);
  const stamp = Date.now();
  for (const entry of entries) {
    store.put({
      id:localEmbeddingId(entry.hash),
      model:LOCAL_INDEX_VERSION,
      modelKey:'dinov3-local',
      hash:entry.hash,
      schema:EMBEDDING_SCHEMA,
      dimension:entry.descriptor.dimension,
      regions:entry.descriptor.regions,
      vector:entry.descriptor.vector,
      regionNormSq:entry.descriptor.regionNormSq,
      updatedAt:stamp
    });
  }
  await transactionDone(tx);
}

async function ensureLocalEmbeddings(id, db, media) {
  const unique = [];
  const seen = new Set();
  for (const file of media) {
    const hash = String(file?.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash) || seen.has(hash)) continue;
    seen.add(hash);
    unique.push({ hash });
  }
  const existing = await existingLocalHashes(db);
  const missing = unique.filter(item => !existing.has(item.hash));
  if (!missing.length) {
    progress(id, 1, 4, `Visual AI ${CLASSIFIER_VERSION} · local patch index ready · ${unique.length.toLocaleString()} media`);
    return;
  }

  const runtime = await loadLocalRuntime(id);
  const batchSize = runtime.backend === 'webgpu' ? 4 : 1;
  let completed = 0;
  let indexed = 0;
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    aborted(id);
    const batch = missing.slice(offset, offset + batchSize);
    const entries = await inferLocalBatch(id, runtime, batch);
    await putLocalRows(db, entries);
    indexed += entries.length;
    completed += batch.length;
    if (completed === missing.length || completed % 100 < batchSize) {
      progress(id, 1, 4,
        `Visual AI ${CLASSIFIER_VERSION} · building local patch index ${completed.toLocaleString()} / ${missing.length.toLocaleString()} · ${runtime.backend === 'webgpu' ? 'WebGPU' : 'CPU'}`);
    }
  }
  progress(id, 1, 4,
    `Visual AI ${CLASSIFIER_VERSION} · local patch index ready · ${indexed.toLocaleString()} new · ${unique.length.toLocaleString()} total media`);
}

function calibrate(positives, negatives) {
  if (positives.length === 1) {
    return {
      nearestFloor:.62,
      affinityFloor:.62,
      nearestMarginFloor:negatives.length ? .01 : null,
      affinityMarginFloor:negatives.length ? .01 : null
    };
  }

  const nearest = [];
  const affinities = [];
  const nearestMargins = [];
  const affinityMargins = [];

  for (const positive of positives) {
    const positiveScore = scoresAgainst(positive.record, positives, positive.hash);
    if (positiveScore.best >= 0) nearest.push(positiveScore.best);
    if (positiveScore.affinity >= 0) affinities.push(positiveScore.affinity);

    if (negatives.length) {
      const negativeScore = scoresAgainst(positive.record, negatives);
      if (positiveScore.best >= 0 && negativeScore.best >= 0) nearestMargins.push(positiveScore.best - negativeScore.best);
      if (positiveScore.affinity >= 0 && negativeScore.affinity >= 0) affinityMargins.push(positiveScore.affinity - negativeScore.affinity);
    }
  }

  return {
    nearestFloor:clamp((quantile(nearest, .01) ?? .64) - .08, .30, .86),
    affinityFloor:clamp((quantile(affinities, .01) ?? .60) - .08, .28, .84),
    nearestMarginFloor:negatives.length
      ? clamp((quantile(nearestMargins, .05) ?? .01) - .04, -.03, .12)
      : null,
    affinityMarginFloor:negatives.length
      ? clamp((quantile(affinityMargins, .05) ?? .01) - .04, -.03, .12)
      : null
  };
}

function calibrateLocal(positives, negatives, localMap) {
  const localPositives = positives.filter(item => localMap.has(item.hash));
  if (localPositives.length < 2) return { enabled:false, floor:1, marginFloor:null };
  const affinities = [];
  const margins = [];

  for (const positive of localPositives) {
    const local = localMap.get(positive.hash);
    const positiveGlobal = scoresAgainst(positive.record, positives, positive.hash);
    const positiveLocal = localScoresAgainst(local, localMap, positiveGlobal.neighbors);
    if (positiveLocal.affinity >= 0) affinities.push(positiveLocal.affinity);

    if (negatives.length && positiveLocal.affinity >= 0) {
      const negativeGlobal = scoresAgainst(positive.record, negatives);
      const negativeLocal = localScoresAgainst(local, localMap, negativeGlobal.neighbors);
      if (negativeLocal.affinity >= 0) margins.push(positiveLocal.affinity - negativeLocal.affinity);
    }
  }

  return {
    enabled:Boolean(affinities.length),
    floor:clamp((quantile(affinities, .01) ?? .58) - .07, .24, .86),
    marginFloor:negatives.length
      ? clamp((quantile(margins, .05) ?? .01) - .04, -.04, .14)
      : null
  };
}

async function classify(id, payload) {
  const media = Array.isArray(payload?.media) ? payload.media : [];
  const allowed = new Set(media.map(file => String(file?.hash || '')).filter(hash => /^[a-f0-9]{64}$/.test(hash)));
  const positiveHashes = [...new Set((payload?.positives || []).map(String).filter(hash => allowed.has(hash)))];
  const positiveSet = new Set(positiveHashes);
  const negativeHashes = [...new Set((payload?.negatives || []).map(String).filter(hash => allowed.has(hash) && !positiveSet.has(hash)))];
  if (!positiveHashes.length) return { matches:[], stats:{ version:CLASSIFIER_VERSION, positiveExamples:0, negativeExamples:negativeHashes.length, scanned:0 } };

  const db = await openDb();
  try {
    progress(id, 0, 4, `Visual AI ${CLASSIFIER_VERSION} · preparing whole-image + local patch features…`);
    await ensureLocalEmbeddings(id, db, media);
    aborted(id);

    const [positives, negatives, localMap] = await Promise.all([
      loadExamples(db, positiveHashes),
      loadExamples(db, negativeHashes),
      loadLocalMap(db, allowed)
    ]);
    aborted(id);
    if (!positives.length) throw new Error('None of the positive examples have a DINO visual index.');

    const thresholds = calibrate(positives, negatives);
    const localThresholds = calibrateLocal(positives, negatives, localMap);
    progress(id, 2, 4,
      `Visual AI ${CLASSIFIER_VERSION} · ${positives.length.toLocaleString()} positive · ${negatives.length.toLocaleString()} negative · exact global + local scan`);

    const excluded = new Set([...positiveHashes, ...negativeHashes]);
    const matches = [];
    let scanned = 0;
    const tx = db.transaction(EMBEDDINGS, 'readonly');
    const cursorRequest = tx.objectStore(EMBEDDINGS).index('model').openCursor(IDBKeyRange.only(DINO_INDEX_VERSION));

    await new Promise((resolve, reject) => {
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        try {
          aborted(id);
          const cursor = cursorRequest.result;
          if (!cursor) return resolve();
          const row = cursor.value;
          const hash = String(row?.hash || '');
          if (!allowed.has(hash) || excluded.has(hash)) {
            cursor.continue();
            return;
          }
          const candidate = record(row);
          if (!candidate) {
            cursor.continue();
            return;
          }

          const positive = scoresAgainst(candidate, positives);
          const broadPositive = positive.affinity >= thresholds.affinityFloor;
          const nearestPositive = positive.best >= thresholds.nearestFloor;
          const candidateLocal = localMap.get(hash);
          const positiveLocal = localThresholds.enabled && candidateLocal
            ? localScoresAgainst(candidateLocal, localMap, positive.neighbors)
            : { best:-1, affinity:-1 };
          const localPositive = localThresholds.enabled && positiveLocal.affinity >= localThresholds.floor;
          scanned++;

          if (broadPositive || nearestPositive || localPositive) {
            const negative = negatives.length ? scoresAgainst(candidate, negatives) : { best:-1, affinity:-1, neighbors:[] };
            const nearestMargin = negatives.length ? positive.best - negative.best : null;
            const affinityMargin = negatives.length ? positive.affinity - negative.affinity : null;
            const broadContrast = !negatives.length || (broadPositive && affinityMargin >= thresholds.affinityMarginFloor);
            const nearestContrast = !negatives.length || (nearestPositive && nearestMargin >= thresholds.nearestMarginFloor);

            const negativeLocal = negatives.length && localThresholds.enabled && candidateLocal
              ? localScoresAgainst(candidateLocal, localMap, negative.neighbors)
              : { best:-1, affinity:-1 };
            const localMargin = negatives.length && localPositive ? positiveLocal.affinity - negativeLocal.affinity : null;
            const localContrast = localPositive && (!negatives.length || localMargin >= localThresholds.marginFloor);

            // Global identity and local UI identity are independent rescue paths.
            // A hard negative can veto the global path without erasing strong
            // repeated local evidence from the positive examples.
            const globalAccepted = (broadContrast || nearestContrast) && (!negatives.length || negative.best <= positive.best + .01);
            if (globalAccepted || localContrast) {
              const globalStrength = Math.max(
                clamp((positive.best - thresholds.nearestFloor) / Math.max(.08, 1 - thresholds.nearestFloor)),
                clamp((positive.affinity - thresholds.affinityFloor) / Math.max(.08, 1 - thresholds.affinityFloor))
              );
              const localStrength = localPositive
                ? clamp((positiveLocal.affinity - localThresholds.floor) / Math.max(.08, 1 - localThresholds.floor))
                : 0;
              const contrastStrength = negatives.length
                ? Math.max(
                    clamp((nearestMargin - thresholds.nearestMarginFloor) / .14),
                    clamp((affinityMargin - thresholds.affinityMarginFloor) / .14),
                    localMargin == null ? 0 : clamp((localMargin - localThresholds.marginFloor) / .14)
                  )
                : .5;
              const confidence = clamp(.55 + Math.max(globalStrength, localStrength) * .31 + contrastStrength * .13, .55, .99);
              matches.push({
                hash,
                confidence,
                similarity:positive.best,
                affinity:positive.affinity,
                localAffinity:positiveLocal.affinity,
                nearestPositive:positive.bestHash,
                negativeAffinity:negatives.length ? negative.affinity : null,
                nearestMargin,
                affinityMargin,
                localMargin,
                route:localContrast && !globalAccepted ? 'local' : 'global'
              });
            }
          }

          if (scanned && scanned % 250 === 0) {
            progress(id, 3, 4,
              `Visual AI ${CLASSIFIER_VERSION} · checked ${scanned.toLocaleString()} media · ${matches.length.toLocaleString()} matches`);
          }
          cursor.continue();
        } catch (error) { reject(error); }
      };
    });
    await transactionDone(tx).catch(() => {});
    aborted(id);

    matches.sort((a, b) => b.confidence - a.confidence || b.localAffinity - a.localAffinity || b.similarity - a.similarity || a.hash.localeCompare(b.hash));
    const truncated = matches.length > MAX_MATCHES;
    const resultMatches = matches.slice(0, MAX_MATCHES);
    const localMatches = resultMatches.filter(item => item.route === 'local').length;
    const stats = {
      version:CLASSIFIER_VERSION,
      positiveExamples:positives.length,
      negativeExamples:negatives.length,
      scanned,
      matches:resultMatches.length,
      localRescues:localMatches,
      truncated,
      nearestFloor:Number(thresholds.nearestFloor.toFixed(3)),
      affinityFloor:Number(thresholds.affinityFloor.toFixed(3)),
      localFloor:localThresholds.enabled ? Number(localThresholds.floor.toFixed(3)) : null,
      nearestMarginFloor:thresholds.nearestMarginFloor == null ? null : Number(thresholds.nearestMarginFloor.toFixed(3)),
      affinityMarginFloor:thresholds.affinityMarginFloor == null ? null : Number(thresholds.affinityMarginFloor.toFixed(3)),
      localMarginFloor:localThresholds.marginFloor == null ? null : Number(localThresholds.marginFloor.toFixed(3))
    };
    progress(id, 4, 4,
      `Visual AI ${CLASSIFIER_VERSION} · ${resultMatches.length.toLocaleString()} matches · ${localMatches.toLocaleString()} rescued by local UI features · checked every indexed file${truncated ? ' · capped at 10,000' : ''}`);
    return { matches:resultMatches, stats };
  } finally {
    db.close();
  }
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
    if (data.action !== 'classify') throw new Error(`Unknown AI tag classifier action: ${data.action}`);
    const result = await classify(id, data.payload || {});
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
