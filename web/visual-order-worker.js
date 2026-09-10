const THUMB_VERSION = 3;
const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const ROBUST_VERSION = 'phash32-dct16-v1';
const COLOR_VERSION = 'oklab-grid4-v2';
const FEATURE_VERSION = 'layout-edge-palette-v3';
const SAMPLE = 32;
const LOW = 16;
const GRID = 4;
const HASH_RE = /^[0-9a-f]{64}$/;
const BATCH = 12;
const K_NEIGHBORS = 32;
const PROJECTION_WINDOW = 44;
const ROUTE_SEARCH_WINDOW = 110;
const TWO_OPT_WINDOW = 32;
const EXACT_GRAPH_LIMIT = 650;
const HUE_BINS = 24;
const COLOR_BUCKETS = 36;

const POPCOUNT16 = new Uint8Array(1 << 16);
for (let value = 1; value < POPCOUNT16.length; value++) POPCOUNT16[value] = POPCOUNT16[value >> 1] + (value & 1);

const COS = Array.from({ length:LOW }, (_, u) =>
  Array.from({ length:SAMPLE }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / (2 * SAMPLE)))
);
const SCALE = Array.from({ length:LOW }, (_, u) =>
  u === 0 ? Math.sqrt(1 / SAMPLE) : Math.sqrt(2 / SAMPLE)
);

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const words256 = value => Array.from({ length:16 }, (_, index) => parseInt(value.slice(index * 4, index * 4 + 4), 16));
const aspectFor = item => Math.max(1e-6, (Number(item?.width) || 1) / (Number(item?.height) || 1));
const aspectDistance = (left, right) => Math.min(2, Math.abs(Math.log2(left / right))) / 2;
const q01 = value => Math.round(clamp(value) * 255);
const uq01 = value => (Number(value) || 0) / 255;
const qab = value => Math.round((clamp(value, -.35, .35) + .35) / .7 * 255);
const uab = value => (Number(value) || 0) / 255 * .7 - .35;

function hamming(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index++) total += POPCOUNT16[left[index] ^ right[index]];
  return total;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath:'hash' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadRows() {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const rows = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    return new Map(rows.map(row => [String(row.hash || ''), row]));
  } finally { db.close(); }
}

async function saveRows(rows) {
  if (!rows.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows) store.put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Could not cache visual descriptors'));
  }).finally(() => db.close());
}

function hashBits(bits) {
  let hex = '';
  for (let nibble = 0; nibble < bits.length / 4; nibble++) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) if (bits[nibble * 4 + bit]) value |= 1 << (3 - bit);
    hex += value.toString(16);
  }
  return hex;
}

function robustPHash(data) {
  const gray = new Float32Array(SAMPLE * SAMPLE);
  for (let pixel = 0, index = 0; index < gray.length; index++, pixel += 4) {
    gray[index] = data[pixel] * .299 + data[pixel + 1] * .587 + data[pixel + 2] * .114;
  }

  const horizontal = new Float32Array(SAMPLE * LOW);
  for (let y = 0; y < SAMPLE; y++) for (let u = 0; u < LOW; u++) {
    let sum = 0;
    for (let x = 0; x < SAMPLE; x++) sum += gray[y * SAMPLE + x] * COS[u][x];
    horizontal[y * LOW + u] = sum * SCALE[u];
  }

  const low = new Float32Array(LOW * LOW);
  for (let v = 0; v < LOW; v++) for (let u = 0; u < LOW; u++) {
    let sum = 0;
    for (let y = 0; y < SAMPLE; y++) sum += horizontal[y * LOW + u] * COS[v][y];
    low[v * LOW + u] = sum * SCALE[v];
  }

  const values = [...low.slice(1)].sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  const bits = new Uint8Array(LOW * LOW);
  for (let index = 1; index < low.length; index++) bits[index] = low[index] > median ? 1 : 0;
  return hashBits(bits);
}

function srgbLinear(value) {
  value /= 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
}

function oklab(red, green, blue) {
  const r = srgbLinear(red);
  const g = srgbLinear(green);
  const b = srgbLinear(blue);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [
    .2104542553 * l + .793617785 * m - .0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s
  ];
}

function analyzePixels(data) {
  const count = SAMPLE * SAMPLE;
  const gray = new Float32Array(count);
  const colorSums = Array.from({ length:GRID * GRID }, () => [0,0,0,0]);
  const legacySums = Array.from({ length:5 }, () => [0,0,0,0]);
  const hueWeight = new Float64Array(HUE_BINS);
  const hueX = new Float64Array(HUE_BINS);
  const hueY = new Float64Array(HUE_BINS);
  let chromaSum = 0;
  let spreadSum = 0;
  let colorful = 0;
  let lumaSum = 0;
  let lumaSq = 0;

  for (let y = 0; y < SAMPLE; y++) for (let x = 0; x < SAMPLE; x++) {
    const index = y * SAMPLE + x;
    const pixel = index * 4;
    const red = data[pixel];
    const green = data[pixel + 1];
    const blue = data[pixel + 2];
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    const value = oklab(red, green, blue);
    const L = value[0];
    const a = value[1];
    const b = value[2];
    const chroma = Math.hypot(a, b);
    gray[index] = L;

    const cellX = Math.min(GRID - 1, Math.floor(x * GRID / SAMPLE));
    const cellY = Math.min(GRID - 1, Math.floor(y * GRID / SAMPLE));
    const cell = cellY * GRID + cellX;
    const sum = colorSums[cell];
    sum[0] += L; sum[1] += a; sum[2] += b; sum[3]++;

    const quadrant = 1 + (y >= SAMPLE / 2 ? 2 : 0) + (x >= SAMPLE / 2 ? 1 : 0);
    for (const bucket of [0, quadrant]) {
      legacySums[bucket][0] += L;
      legacySums[bucket][1] += a;
      legacySums[bucket][2] += b;
      legacySums[bucket][3]++;
    }

    lumaSum += L;
    lumaSq += L * L;
    chromaSum += chroma;
    spreadSum += spread;
    if (spread > 10) colorful++;
    if (spread > 5 && chroma > .006) {
      let angle = Math.atan2(b, a);
      if (angle < 0) angle += Math.PI * 2;
      const bin = Math.floor(angle / (Math.PI * 2) * HUE_BINS) % HUE_BINS;
      const weight = chroma * (1 + spread / 255);
      hueWeight[bin] += weight;
      hueX[bin] += Math.cos(angle) * weight;
      hueY[bin] += Math.sin(angle) * weight;
    }
  }

  const edgeSums = Array.from({ length:GRID * GRID }, () => [0,0,0,0,0]);
  let totalGradient = 0;
  for (let y = 1; y < SAMPLE - 1; y++) for (let x = 1; x < SAMPLE - 1; x++) {
    const index = y * SAMPLE + x;
    const gx = gray[index + 1] - gray[index - 1];
    const gy = gray[index + SAMPLE] - gray[index - SAMPLE];
    const magnitude = Math.hypot(gx, gy);
    if (magnitude < .006) continue;
    let angle = Math.atan2(gy, gx);
    if (angle < 0) angle += Math.PI;
    if (angle >= Math.PI) angle -= Math.PI;
    const orientation = Math.min(3, Math.floor((angle + Math.PI / 8) / (Math.PI / 4)) % 4);
    const cellX = Math.min(GRID - 1, Math.floor(x * GRID / SAMPLE));
    const cellY = Math.min(GRID - 1, Math.floor(y * GRID / SAMPLE));
    const edge = edgeSums[cellY * GRID + cellX];
    edge[orientation] += magnitude;
    edge[4] += magnitude;
    totalGradient += magnitude;
  }

  const layout = [];
  for (const sum of colorSums) {
    const n = Math.max(1, sum[3]);
    layout.push(q01(sum[0] / n), qab(sum[1] / n), qab(sum[2] / n));
  }

  const edges = [];
  const energy = [];
  for (const sum of edgeSums) {
    const total = Math.max(1e-8, sum[4]);
    for (let orientation = 0; orientation < 4; orientation++) edges.push(q01(sum[orientation] / total));
    const pixelsPerCell = SAMPLE * SAMPLE / (GRID * GRID);
    energy.push(q01(Math.min(1, sum[4] / Math.max(1, pixelsPerCell) * 8)));
  }

  const totalHue = hueWeight.reduce((sum, value) => sum + value, 0);
  const smoothHue = Array.from({ length:HUE_BINS }, (_, index) =>
    hueWeight[index] * .5 + hueWeight[(index + HUE_BINS - 1) % HUE_BINS] * .25 + hueWeight[(index + 1) % HUE_BINS] * .25
  );
  const smoothTotal = smoothHue.reduce((sum, value) => sum + value, 0);
  const hues = smoothHue.map(value => q01(smoothTotal > 0 ? value / smoothTotal : 0));

  let dominantBin = 0;
  let dominantScore = -1;
  for (let index = 0; index < HUE_BINS; index++) {
    const score = hueWeight[index] + .5 * (hueWeight[(index + HUE_BINS - 1) % HUE_BINS] + hueWeight[(index + 1) % HUE_BINS]);
    if (score > dominantScore) { dominantScore = score; dominantBin = index; }
  }
  let hueVectorX = 0;
  let hueVectorY = 0;
  for (const index of [(dominantBin + HUE_BINS - 1) % HUE_BINS, dominantBin, (dominantBin + 1) % HUE_BINS]) {
    hueVectorX += hueX[index];
    hueVectorY += hueY[index];
  }
  let dominantHue = Math.atan2(hueVectorY, hueVectorX) / (Math.PI * 2);
  if (dominantHue < 0) dominantHue += 1;
  if (!Number.isFinite(dominantHue) || totalHue <= 1e-8) dominantHue = 0;

  const legacyGrid = [];
  for (const sum of legacySums) {
    const n = Math.max(1, sum[3]);
    legacyGrid.push(sum[0] / n, sum[1] / n, sum[2] / n);
  }

  const meanLuma = lumaSum / count;
  const contrast = Math.sqrt(Math.max(0, lumaSq / count - meanLuma * meanLuma));
  const meanChroma = chromaSum / count;
  const colorFraction = colorful / count;
  const meanSpread = spreadSum / count;

  return {
    color:{
      grid:legacyGrid,
      meanChroma,
      colorFraction,
      meanSpread,
      dominantHue,
      dominantStrength:totalHue > 0 ? Math.max(0, dominantScore) / totalHue : 0
    },
    feature:{
      version:FEATURE_VERSION,
      layout,
      edges,
      energy,
      hues,
      meanLuma:q01(meanLuma),
      contrast:q01(Math.min(1, contrast * 2.5)),
      colorfulness:q01(Math.min(1, meanChroma * 5)),
      edgeDensity:q01(Math.min(1, totalGradient / (SAMPLE * SAMPLE) * 8))
    }
  };
}

async function computeDescriptor(hash) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache' });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(SAMPLE, SAMPLE);
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(bitmap, 0, 0, SAMPLE, SAMPLE);
    const data = context.getImageData(0, 0, SAMPLE, SAMPLE).data;
    const analyzed = analyzePixels(data);
    return { robust:robustPHash(data), color:analyzed.color, feature:analyzed.feature };
  } finally { bitmap.close?.(); }
}

function validColor(value) {
  return Boolean(value) && Array.isArray(value.grid) && value.grid.length === 15 && value.grid.every(Number.isFinite) &&
    ['meanChroma','colorFraction','meanSpread','dominantHue','dominantStrength'].every(key => Number.isFinite(value[key]));
}

function validFeature(value) {
  return value?.version === FEATURE_VERSION &&
    Array.isArray(value.layout) && value.layout.length === 48 && value.layout.every(Number.isFinite) &&
    Array.isArray(value.edges) && value.edges.length === 64 && value.edges.every(Number.isFinite) &&
    Array.isArray(value.energy) && value.energy.length === 16 && value.energy.every(Number.isFinite) &&
    Array.isArray(value.hues) && value.hues.length === HUE_BINS && value.hues.every(Number.isFinite) &&
    ['meanLuma','contrast','colorfulness','edgeDensity'].every(key => Number.isFinite(value[key]));
}

async function ensureDescriptors(media) {
  const rows = await loadRows();
  const descriptors = new Map();
  const missing = [];

  for (const item of media) {
    const row = rows.get(item.hash);
    const robust = row?.robustVersion === ROBUST_VERSION && HASH_RE.test(String(row.robust || '')) ? String(row.robust) : '';
    const color = row?.visualColorVersion === COLOR_VERSION && validColor(row.visualColor) ? row.visualColor : null;
    const feature = row?.visualFeatureVersion === FEATURE_VERSION && validFeature(row.visualFeature) ? row.visualFeature : null;
    if (robust && color && feature) descriptors.set(item.hash, { robust, color, feature });
    else missing.push(item);
  }

  let done = media.length - missing.length;
  self.postMessage({ type:'progress', done, total:media.length, stage:'descriptors' });

  for (let offset = 0; offset < missing.length; offset += BATCH) {
    const chunk = missing.slice(offset, offset + BATCH);
    const computed = await Promise.all(chunk.map(async item => {
      try { return [item, await computeDescriptor(item.hash)]; }
      catch { return [item, null]; }
    }));
    const writes = [];
    for (const [item, value] of computed) {
      if (!value || !HASH_RE.test(value.robust) || !validColor(value.color) || !validFeature(value.feature)) continue;
      descriptors.set(item.hash, value);
      const previous = rows.get(item.hash) || { hash:item.hash };
      const row = {
        ...previous,
        hash:item.hash,
        robust:value.robust,
        robustVersion:ROBUST_VERSION,
        visualColor:value.color,
        visualColorVersion:COLOR_VERSION,
        visualFeature:value.feature,
        visualFeatureVersion:FEATURE_VERSION,
        updatedAt:Date.now()
      };
      rows.set(item.hash, row);
      writes.push(row);
    }
    try { await saveRows(writes); } catch {}
    done += chunk.length;
    self.postMessage({ type:'progress', done, total:media.length, stage:'descriptors' });
  }
  return descriptors;
}

function hueInfo(grid) {
  const L = Number(grid?.[0]) || 0;
  const a = Number(grid?.[1]) || 0;
  const b = Number(grid?.[2]) || 0;
  const chroma = Math.hypot(a, b);
  let hue = Math.atan2(b, a) / (Math.PI * 2);
  if (hue < 0) hue += 1;
  return { L, chroma, hue };
}

function layoutDistances(left, right) {
  let color = 0;
  let luma = 0;
  for (let cell = 0; cell < 16; cell++) {
    const offset = cell * 3;
    const lL = uq01(left.layout[offset]);
    const rL = uq01(right.layout[offset]);
    const la = uab(left.layout[offset + 1]);
    const ra = uab(right.layout[offset + 1]);
    const lb = uab(left.layout[offset + 2]);
    const rb = uab(right.layout[offset + 2]);
    const dL = lL - rL;
    const da = la - ra;
    const db = lb - rb;
    const center = cell === 5 || cell === 6 || cell === 9 || cell === 10;
    const weight = center ? 1.25 : 1;
    color += Math.sqrt(dL * dL + da * da * 2.2 + db * db * 2.2) * weight;
    luma += Math.abs(dL) * weight;
  }
  return { color:clamp(color / 17), luma:clamp(luma / 17) };
}

function edgeDistance(left, right) {
  let orientation = 0;
  let energy = 0;
  for (let cell = 0; cell < 16; cell++) {
    let local = 0;
    for (let bin = 0; bin < 4; bin++) local += Math.abs(uq01(left.edges[cell * 4 + bin]) - uq01(right.edges[cell * 4 + bin]));
    orientation += Math.min(1, local / 2);
    energy += Math.abs(uq01(left.energy[cell]) - uq01(right.energy[cell]));
  }
  return clamp((orientation / 16) * .78 + (energy / 16) * .22);
}

function hueDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < HUE_BINS; index++) distance += Math.abs(uq01(left.hues[index]) - uq01(right.hues[index]));
  return clamp(distance / 2);
}

function statsDistance(left, right) {
  return clamp((
    Math.abs(uq01(left.contrast) - uq01(right.contrast)) +
    Math.abs(uq01(left.colorfulness) - uq01(right.colorfulness)) +
    Math.abs(uq01(left.edgeDensity) - uq01(right.edgeDensity))
  ) / 3);
}

function metric(left, right, mode) {
  const featureLeft = left.feature;
  const featureRight = right.feature;
  const layout = layoutDistances(featureLeft, featureRight);
  const edges = edgeDistance(featureLeft, featureRight);
  const hues = hueDistance(featureLeft, featureRight);
  const stats = statsDistance(featureLeft, featureRight);
  const robust = hamming(left.robustWords, right.robustWords) / 256;
  const aspect = aspectDistance(left.aspect, right.aspect);

  if (mode === 'structure') {
    return edges * .44 + layout.luma * .22 + robust * .12 + stats * .10 + layout.color * .06 + aspect * .06;
  }
  if (mode === 'color-detail') {
    return layout.color * .34 + hues * .22 + edges * .20 + layout.luma * .10 + stats * .08 + aspect * .06;
  }
  return layout.color * .30 + edges * .23 + hues * .18 + layout.luma * .10 + stats * .08 + robust * .05 + aspect * .06;
}

function shiftedHue(hue) {
  const value = (Number(hue) || 0) + 15 / 360;
  return value >= 1 ? value - 1 : value;
}

function colorSection(node) {
  if (node.trueGray) return 'Gray';
  const sector = Math.floor(shiftedHue(node.hue) * 8) % 8;
  return ['Red','Orange','Yellow','Green','Cyan','Blue','Purple','Magenta'][sector];
}

function colorKey(node) {
  if (node.trueGray) return [1, node.light, node.hash];
  return [0, shiftedHue(node.hue), node.light, -node.colorfulness, node.hash];
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function compactVector(feature) {
  const vector = [];
  for (let cell = 0; cell < 16; cell++) vector.push(uq01(feature.layout[cell * 3]));
  for (let cell = 0; cell < 16; cell++) vector.push(uq01(feature.energy[cell]));
  for (let group = 0; group < 8; group++) {
    let sum = 0;
    for (let offset = 0; offset < 3; offset++) sum += uq01(feature.hues[group * 3 + offset]);
    vector.push(sum / 3);
  }
  for (let orientation = 0; orientation < 4; orientation++) {
    let sum = 0;
    for (let cell = 0; cell < 16; cell++) sum += uq01(feature.edges[cell * 4 + orientation]);
    vector.push(sum / 16);
  }
  vector.push(uq01(feature.contrast), uq01(feature.colorfulness), uq01(feature.edgeDensity));
  return vector;
}

function buildNodes(media, descriptors) {
  const nodes = [];
  const unavailable = [];
  for (let index = 0; index < media.length; index++) {
    const item = media[index];
    const descriptor = descriptors.get(item.hash);
    if (!descriptor?.feature) { unavailable.push(index); continue; }
    const global = hueInfo(descriptor.color.grid);
    const color = descriptor.color;
    const trueGray = color.colorFraction < .008 && color.meanSpread < 3.5 && color.meanChroma < .006;
    const dominantHue = Number.isFinite(color.dominantHue) ? color.dominantHue : global.hue;
    nodes.push({
      mediaIndex:index,
      hash:item.hash,
      robust:descriptor.robust,
      robustWords:words256(descriptor.robust),
      color,
      feature:descriptor.feature,
      vector:compactVector(descriptor.feature),
      aspect:aspectFor(item),
      light:global.L,
      colorfulness:color.meanChroma + color.colorFraction * .05,
      trueGray,
      hue:dominantHue
    });
  }
  return { nodes, unavailable };
}

function projectionWeights(length, seed) {
  const weights = new Float32Array(length);
  let state = (seed * 2654435761) >>> 0;
  for (let index = 0; index < length; index++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    weights[index] = (state & 1) ? 1 : -1;
  }
  return weights;
}

function projectionValue(node, weights) {
  let value = 0;
  for (let index = 0; index < node.vector.length; index++) value += node.vector[index] * weights[index];
  return value;
}

function orderWithPositions(nodes, key) {
  const order = nodes.map((_, index) => index).sort((a, b) => {
    const left = key(nodes[a]);
    const right = key(nodes[b]);
    return typeof left === 'number' ? left - right : compareTuple(left, right);
  });
  const positions = new Uint32Array(nodes.length);
  order.forEach((index, position) => { positions[index] = position; });
  return { order, positions };
}

function addWindowCandidates(set, order, position, radius) {
  const start = Math.max(0, position - radius);
  const end = Math.min(order.length, position + radius + 1);
  for (let cursor = start; cursor < end; cursor++) set.add(order[cursor]);
}

function buildNeighborGraph(nodes, mode) {
  const graph = Array.from({ length:nodes.length }, () => []);
  if (nodes.length <= EXACT_GRAPH_LIMIT) {
    for (let left = 0; left < nodes.length; left++) {
      const ranked = [];
      for (let right = 0; right < nodes.length; right++) if (right !== left) ranked.push({ index:right, distance:metric(nodes[left], nodes[right], mode) });
      ranked.sort((a, b) => a.distance - b.distance || nodes[a.index].hash.localeCompare(nodes[b.index].hash));
      graph[left] = ranked.slice(0, K_NEIGHBORS);
    }
    return { graph, projections:[] };
  }

  const vectorLength = nodes[0]?.vector.length || 1;
  const projections = [1,2,3,4,5,6].map(seed => {
    const weights = projectionWeights(vectorLength, seed);
    return orderWithPositions(nodes, node => projectionValue(node, weights));
  });
  projections.push(orderWithPositions(nodes, colorKey));
  projections.push(orderWithPositions(nodes, node => [node.light, node.feature.edgeDensity, node.hash]));

  for (let index = 0; index < nodes.length; index++) {
    const candidates = new Set();
    for (const projection of projections) addWindowCandidates(candidates, projection.order, projection.positions[index], PROJECTION_WINDOW);
    candidates.delete(index);
    const ranked = [];
    for (const other of candidates) ranked.push({ index:other, distance:metric(nodes[index], nodes[other], mode) });
    ranked.sort((a, b) => a.distance - b.distance || nodes[a.index].hash.localeCompare(nodes[b.index].hash));
    graph[index] = ranked.slice(0, K_NEIGHBORS);
  }

  for (let index = 0; index < graph.length; index++) for (const edge of [...graph[index]]) {
    const reverse = graph[edge.index];
    if (!reverse.some(item => item.index === index)) reverse.push({ index, distance:edge.distance });
  }
  for (const edges of graph) edges.sort((a, b) => a.distance - b.distance);
  return { graph, projections };
}

function contextualCandidate(endpoint, context, graph, visited, nodes, mode) {
  let best = { index:-1, distance:Infinity, score:Infinity };
  let considered = 0;
  for (const edge of graph[endpoint]) {
    if (visited[edge.index]) continue;
    let contextDistance = 0;
    let contextCount = 0;
    for (let cursor = context.length - 2; cursor >= 0 && contextCount < 6; cursor--, contextCount++) {
      contextDistance += metric(nodes[context[cursor]], nodes[edge.index], mode);
    }
    const score = edge.distance * .62 + (contextCount ? contextDistance / contextCount : edge.distance) * .38;
    if (score < best.score || (score === best.score && nodes[edge.index].hash < (nodes[best.index]?.hash || '~'))) {
      best = { index:edge.index, distance:edge.distance, score };
    }
    if (++considered >= 10) break;
  }
  return best;
}

function nearestFromOrders(endpoint, orders, visited, nodes, mode) {
  let best = { index:-1, distance:Infinity, score:Infinity };
  for (const projection of orders) {
    const position = projection.positions[endpoint];
    for (let delta = 1; delta <= ROUTE_SEARCH_WINDOW; delta++) {
      for (const cursor of [position - delta, position + delta]) {
        if (cursor < 0 || cursor >= projection.order.length) continue;
        const candidate = projection.order[cursor];
        if (visited[candidate]) continue;
        const distance = metric(nodes[endpoint], nodes[candidate], mode);
        if (distance < best.distance) best = { index:candidate, distance, score:distance };
      }
      if (best.index >= 0 && delta >= 18) break;
    }
  }
  return best;
}

function optimizeRoute(route, nodes, mode) {
  if (route.length < 5) return route;
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let left = 0; left < route.length - 3; left++) {
      const a = route[left];
      const b = route[left + 1];
      const limit = Math.min(route.length - 2, left + TWO_OPT_WINDOW);
      for (let right = left + 2; right <= limit; right++) {
        const c = route[right];
        const d = route[right + 1];
        const before = metric(nodes[a], nodes[b], mode) + metric(nodes[c], nodes[d], mode);
        const after = metric(nodes[a], nodes[c], mode) + metric(nodes[b], nodes[d], mode);
        if (after + .012 >= before) continue;
        for (let i = left + 1, j = right; i < j; i++, j--) [route[i], route[j]] = [route[j], route[i]];
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  return route;
}

function routeOrder(nodes, mode) {
  if (nodes.length < 2) return { order:nodes.map((_, index) => index), graph:[] };
  const { graph, projections } = buildNeighborGraph(nodes, mode);
  const fallback = orderWithPositions(nodes, colorKey);
  const orders = projections.length ? projections : [fallback];
  if (!projections.length) orders.push(fallback);
  const visited = new Uint8Array(nodes.length);

  let seed = 0;
  let bestDensity = Infinity;
  for (let index = 0; index < nodes.length; index++) {
    const edges = graph[index].slice(0, Math.min(8, graph[index].length));
    const density = edges.length ? edges.reduce((sum, edge) => sum + edge.distance, 0) / edges.length : Infinity;
    if (density < bestDensity) { bestDensity = density; seed = index; }
  }

  const leftPath = [seed];
  const rightPath = [seed];
  let left = seed;
  let right = seed;
  visited[seed] = 1;
  let count = 1;
  let fallbackCursor = 0;

  while (count < nodes.length) {
    let leftCandidate = contextualCandidate(left, leftPath, graph, visited, nodes, mode);
    let rightCandidate = contextualCandidate(right, rightPath, graph, visited, nodes, mode);
    if (leftCandidate.index < 0) leftCandidate = nearestFromOrders(left, orders, visited, nodes, mode);
    if (rightCandidate.index < 0) rightCandidate = nearestFromOrders(right, orders, visited, nodes, mode);

    let next = -1;
    let prepend = false;
    if (leftCandidate.index >= 0 || rightCandidate.index >= 0) {
      prepend = leftCandidate.score < rightCandidate.score;
      next = (prepend ? leftCandidate : rightCandidate).index;
    }
    if (next < 0) {
      while (fallbackCursor < fallback.order.length && visited[fallback.order[fallbackCursor]]) fallbackCursor++;
      next = fallback.order[fallbackCursor] ?? -1;
      prepend = false;
    }
    if (next < 0) break;

    visited[next] = 1;
    count++;
    if (prepend) { leftPath.push(next); left = next; }
    else { rightPath.push(next); right = next; }
  }

  const route = [...leftPath.slice(1).reverse(), seed, ...rightPath.slice(1)];
  return { order:optimizeRoute(route, nodes, mode), graph };
}

function countNeighborhoods(graph, threshold) {
  if (!graph.length) return 0;
  const seen = new Uint8Array(graph.length);
  let groups = 0;
  for (let start = 0; start < graph.length; start++) {
    if (seen[start]) continue;
    groups++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const current = stack.pop();
      for (const edge of graph[current]) {
        if (edge.distance > threshold || seen[edge.index]) continue;
        seen[edge.index] = 1;
        stack.push(edge.index);
      }
    }
  }
  return groups;
}

function colorBucket(node) {
  if (node.trueGray) return 1000 + Math.min(9, Math.floor(node.light * 10));
  return Math.floor(shiftedHue(node.hue) * COLOR_BUCKETS) % COLOR_BUCKETS;
}

function colorOrder(nodes) {
  const buckets = new Map();
  for (let index = 0; index < nodes.length; index++) {
    const key = colorBucket(nodes[index]);
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(index);
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const result = [];
  let previous = -1;
  for (const key of keys) {
    const members = buckets.get(key);
    let local;
    if (members.length <= 2) local = [...members].sort((a, b) => nodes[a].hash.localeCompare(nodes[b].hash));
    else {
      const subNodes = members.map(index => nodes[index]);
      local = routeOrder(subNodes, 'color-detail').order.map(index => members[index]);
    }
    if (previous >= 0 && local.length > 1) {
      const forward = metric(nodes[previous], nodes[local[0]], 'color-detail');
      const reverse = metric(nodes[previous], nodes[local[local.length - 1]], 'color-detail');
      if (reverse < forward) local.reverse();
    }
    result.push(...local);
    previous = local.at(-1) ?? previous;
  }
  return result;
}

function colorRail(order, nodes, unavailableCount) {
  const entries = [];
  let previous = '';
  for (let position = 0; position < order.length; position++) {
    const label = colorSection(nodes[order[position]]);
    if (label === previous) continue;
    previous = label;
    entries.push({ index:position, label });
  }
  if (unavailableCount) entries.push({ index:order.length, label:'Other' });
  return entries;
}

async function build(media, mode) {
  const descriptors = await ensureDescriptors(media);
  self.postMessage({ type:'progress', done:media.length, total:media.length, stage:'ordering' });
  const { nodes, unavailable } = buildNodes(media, descriptors);
  let nodeOrder = [];
  let families = nodes.length;
  let rail = [];

  if (mode === 'color') {
    nodeOrder = colorOrder(nodes);
    rail = colorRail(nodeOrder, nodes, unavailable.length);
    families = new Set(nodeOrder.map(index => colorSection(nodes[index]))).size;
  } else {
    const routed = routeOrder(nodes, mode === 'structure' ? 'structure' : 'flow');
    nodeOrder = routed.order;
    families = countNeighborhoods(routed.graph, mode === 'structure' ? .23 : .25);
  }

  const order = nodeOrder.map(index => media[nodes[index].mediaIndex]);
  for (const mediaIndex of unavailable) order.push(media[mediaIndex]);
  return { order, indexed:nodes.length, unavailable:unavailable.length, families, rail, featureVersion:FEATURE_VERSION };
}

self.onmessage = async event => {
  try {
    const media = Array.isArray(event.data?.media) ? event.data.media : [];
    const mode = ['flow','structure','color'].includes(event.data?.mode) ? event.data.mode : 'flow';
    const result = await build(media, mode);
    self.postMessage({ type:'result', result });
  } catch (error) {
    self.postMessage({ type:'error', error:error?.message || String(error) });
  }
};