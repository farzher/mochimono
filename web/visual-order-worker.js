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
const HUE_BINS = 24;
const HUE_WINDOW = 18 / 360;
const HUE_FRONTIER_MIN = 18;
const HUE_FRONTIER_MAX = 84;
const GRAY_LIGHT_WINDOW = .14;
const GRAY_FRONTIER_MIN = 12;
const GRAY_FRONTIER_MAX = 56;

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
    for (const row of rows) {
      const request = store.get(row.hash);
      request.onsuccess = () => store.put({ ...(request.result || {}), ...row });
      request.onerror = () => tx.abort();
    }
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

function localVisualDistance(left, right) {
  const layout = layoutDistances(left.feature, right.feature);
  const edges = edgeDistance(left.feature, right.feature);
  const hues = hueDistance(left.feature, right.feature);
  const stats = statsDistance(left.feature, right.feature);
  const aspect = aspectDistance(left.aspect, right.aspect);
  return layout.color * .34 + hues * .22 + edges * .20 + layout.luma * .10 + stats * .08 + aspect * .06;
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
      robustWords:words256(descriptor.robust),
      color,
      feature:descriptor.feature,
      aspect:aspectFor(item),
      light:global.L,
      trueGray,
      hue:dominantHue
    });
  }
  return { nodes, unavailable };
}

function continuationCost(candidate, buffer, nodes) {
  let best = Infinity;
  const limit = Math.min(buffer.length, 12);
  for (let index = 0; index < limit; index++) {
    const other = buffer[index].index;
    if (other === candidate) continue;
    best = Math.min(best, localVisualDistance(nodes[candidate], nodes[other]));
  }
  return Number.isFinite(best) ? best : 0;
}

function frontierOrder(indices, nodes, axis, windowSize, minFrontier, maxFrontier) {
  if (indices.length < 2) return [...indices];
  const sorted = [...indices].sort((a, b) => axis(nodes[a]) - axis(nodes[b]) || nodes[a].hash.localeCompare(nodes[b].hash));
  const buffer = [];
  const result = [];
  const history = [];
  let cursor = 0;

  const refill = () => {
    if (!buffer.length && cursor < sorted.length) buffer.push({ index:sorted[cursor++], age:0 });
    if (!buffer.length) return;
    const base = axis(nodes[buffer[0].index]);
    while (cursor < sorted.length && buffer.length < maxFrontier) {
      const value = axis(nodes[sorted[cursor]]);
      if (buffer.length >= minFrontier && value - base > windowSize) break;
      buffer.push({ index:sorted[cursor++], age:0 });
    }
  };

  while (result.length < sorted.length) {
    refill();
    if (!buffer.length) break;

    let bestPosition = 0;
    if (history.length) {
      const previous = history.at(-1);
      const base = axis(nodes[buffer[0].index]);
      const far = axis(nodes[buffer.at(-1).index]);
      const span = Math.max(.001, windowSize, far - base);
      let bestScore = Infinity;

      for (let position = 0; position < buffer.length; position++) {
        const entry = buffer[position];
        const candidate = entry.index;
        const direct = localVisualDistance(nodes[previous], nodes[candidate]);

        let context = 0;
        let contextCount = 0;
        for (let offset = 2; offset <= 3 && history.length >= offset; offset++) {
          context += localVisualDistance(nodes[history.at(-offset)], nodes[candidate]);
          contextCount++;
        }
        if (contextCount) context /= contextCount;
        else context = direct;

        const axisAdvance = clamp((axis(nodes[candidate]) - base) / span);
        const positionPenalty = position / Math.max(1, buffer.length - 1);
        const continuation = continuationCost(candidate, buffer, nodes);
        const ageBonus = Math.min(.18, entry.age * .014);
        const score = direct * .55 + context * .13 + continuation * .08 + axisAdvance * .14 + positionPenalty * .10 - ageBonus;

        if (score < bestScore || (score === bestScore && nodes[candidate].hash < nodes[buffer[bestPosition].index].hash)) {
          bestScore = score;
          bestPosition = position;
        }
      }
    }

    const [chosen] = buffer.splice(bestPosition, 1);
    for (const entry of buffer) entry.age++;
    result.push(chosen.index);
    history.push(chosen.index);
    if (history.length > 3) history.shift();
  }

  return result;
}

function colorOrder(nodes) {
  const chromatic = [];
  const gray = [];
  for (let index = 0; index < nodes.length; index++) (nodes[index].trueGray ? gray : chromatic).push(index);

  const chromaticOrder = frontierOrder(
    chromatic,
    nodes,
    node => shiftedHue(node.hue),
    HUE_WINDOW,
    HUE_FRONTIER_MIN,
    HUE_FRONTIER_MAX
  );
  const grayOrder = frontierOrder(
    gray,
    nodes,
    node => node.light,
    GRAY_LIGHT_WINDOW,
    GRAY_FRONTIER_MIN,
    GRAY_FRONTIER_MAX
  );
  return [...chromaticOrder, ...grayOrder];
}

function colorRail(order, nodes, unavailableCount) {
  const entries = [];
  const seen = new Set();
  for (let position = 0; position < order.length; position++) {
    const label = colorSection(nodes[order[position]]);
    if (seen.has(label)) continue;
    seen.add(label);
    entries.push({ index:position, label });
  }
  if (unavailableCount) entries.push({ index:order.length, label:'Other' });
  return entries;
}

async function build(media) {
  const descriptors = await ensureDescriptors(media);
  self.postMessage({ type:'progress', done:media.length, total:media.length, stage:'ordering' });
  const { nodes, unavailable } = buildNodes(media, descriptors);
  const nodeOrder = colorOrder(nodes);
  const rail = colorRail(nodeOrder, nodes, unavailable.length);
  const order = nodeOrder.map(index => media[nodes[index].mediaIndex]);
  for (const mediaIndex of unavailable) order.push(media[mediaIndex]);
  return { order, indexed:nodes.length, unavailable:unavailable.length, rail, featureVersion:FEATURE_VERSION };
}

self.onmessage = async event => {
  try {
    const media = Array.isArray(event.data?.media) ? event.data.media : [];
    const result = await build(media);
    self.postMessage({ type:'result', result });
  } catch (error) {
    self.postMessage({ type:'error', error:error?.message || String(error) });
  }
};