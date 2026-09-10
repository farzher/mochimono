const THUMB_VERSION = 3;
const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const ROBUST_VERSION = 'phash32-dct16-v1';
const COLOR_VERSION = 'oklab-grid4-v1';
const SAMPLE = 32;
const LOW = 16;
const HASH_RE = /^[0-9a-f]{64}$/;
const BATCH = 16;
const K_NEIGHBORS = 14;
const ROBUST_WINDOW = 16;
const COLOR_WINDOW = 28;

const POPCOUNT16 = new Uint8Array(1 << 16);
for (let value = 1; value < POPCOUNT16.length; value++) POPCOUNT16[value] = POPCOUNT16[value >> 1] + (value & 1);

const COS = Array.from({ length:LOW }, (_, u) =>
  Array.from({ length:SAMPLE }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / (2 * SAMPLE)))
);
const SCALE = Array.from({ length:LOW }, (_, u) =>
  u === 0 ? Math.sqrt(1 / SAMPLE) : Math.sqrt(2 / SAMPLE)
);

const words256 = value => Array.from({ length:16 }, (_, index) => parseInt(value.slice(index * 4, index * 4 + 4), 16));
const aspectFor = item => Math.max(1e-6, (Number(item?.width) || 1) / (Number(item?.height) || 1));
const aspectDistance = (left, right) => Math.abs(Math.log2(left / right));

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
    tx.onabort = () => reject(tx.error || new Error('Could not cache visual ordering descriptors'));
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

function colorDescriptor(data) {
  const sums = Array.from({ length:5 }, () => [0,0,0,0]);
  for (let y = 1; y < SAMPLE; y += 4) for (let x = 1; x < SAMPLE; x += 4) {
    const pixel = (y * SAMPLE + x) * 4;
    const lab = oklab(data[pixel], data[pixel + 1], data[pixel + 2]);
    const quadrant = 1 + (y >= SAMPLE / 2 ? 2 : 0) + (x >= SAMPLE / 2 ? 1 : 0);
    for (const bucket of [0, quadrant]) {
      sums[bucket][0] += lab[0];
      sums[bucket][1] += lab[1];
      sums[bucket][2] += lab[2];
      sums[bucket][3]++;
    }
  }
  const result = [];
  for (const sum of sums) {
    const count = Math.max(1, sum[3]);
    result.push(sum[0] / count, sum[1] / count, sum[2] / count);
  }
  return result;
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
    return { robust:robustPHash(data), color:colorDescriptor(data) };
  } finally { bitmap.close?.(); }
}

function validColor(value) {
  return Array.isArray(value) && value.length === 15 && value.every(Number.isFinite);
}

async function ensureDescriptors(media) {
  const rows = await loadRows();
  const descriptors = new Map();
  const missing = [];

  for (const item of media) {
    const row = rows.get(item.hash);
    const robust = row?.robustVersion === ROBUST_VERSION && HASH_RE.test(String(row.robust || '')) ? String(row.robust) : '';
    const color = row?.visualColorVersion === COLOR_VERSION && validColor(row.visualColor) ? row.visualColor : null;
    if (robust && color) descriptors.set(item.hash, { robust, color });
    else missing.push(item.hash);
  }

  let done = media.length - missing.length;
  self.postMessage({ type:'progress', done, total:media.length, stage:'descriptors' });

  for (let offset = 0; offset < missing.length; offset += BATCH) {
    const chunk = missing.slice(offset, offset + BATCH);
    const computed = await Promise.all(chunk.map(async hash => {
      try { return [hash, await computeDescriptor(hash)]; }
      catch { return [hash, null]; }
    }));
    const writes = [];
    for (const [hash, descriptor] of computed) {
      if (!descriptor || !HASH_RE.test(descriptor.robust) || !validColor(descriptor.color)) continue;
      descriptors.set(hash, descriptor);
      const previous = rows.get(hash) || { hash };
      const row = {
        ...previous,
        hash,
        robust:descriptor.robust,
        robustVersion:ROBUST_VERSION,
        visualColor:descriptor.color,
        visualColorVersion:COLOR_VERSION,
        updatedAt:Date.now()
      };
      rows.set(hash, row);
      writes.push(row);
    }
    try { await saveRows(writes); } catch {}
    done += chunk.length;
    self.postMessage({ type:'progress', done, total:media.length, stage:'descriptors' });
  }
  return descriptors;
}

function hueInfo(color) {
  const L = Number(color[0]) || 0;
  const a = Number(color[1]) || 0;
  const b = Number(color[2]) || 0;
  const chroma = Math.hypot(a, b);
  let hue = Math.atan2(b, a) / (Math.PI * 2);
  if (hue < 0) hue += 1;
  return { L, chroma, hue };
}

function colorDistance(left, right) {
  let spatial = 0;
  for (let block = 0; block < 5; block++) {
    const offset = block * 3;
    const dL = left[offset] - right[offset];
    const da = left[offset + 1] - right[offset + 1];
    const db = left[offset + 2] - right[offset + 2];
    const distance = Math.sqrt(dL * dL * 1.15 + da * da * 1.8 + db * db * 1.8);
    spatial += block ? distance : distance * 2.2;
  }
  return Math.min(128, spatial / 6.2 * 220);
}

function colorKey(node) {
  if (node.chroma < .025) return [2, node.light, 0, node.hash];
  return [node.hue, node.light, -node.chroma, node.hash];
}

function compareTuple(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function buildNodes(media, descriptors) {
  const nodes = [];
  const unavailable = [];
  for (let index = 0; index < media.length; index++) {
    const item = media[index];
    const descriptor = descriptors.get(item.hash);
    if (!descriptor) {
      unavailable.push(index);
      continue;
    }
    const hue = hueInfo(descriptor.color);
    nodes.push({
      mediaIndex:index,
      hash:item.hash,
      robust:descriptor.robust,
      robustWords:words256(descriptor.robust),
      color:descriptor.color,
      aspect:aspectFor(item),
      light:hue.L,
      chroma:hue.chroma,
      hue:hue.hue
    });
  }
  return { nodes, unavailable };
}

function robustBuckets(nodes) {
  const wordSlots = [0,2,4,6,8,10,12,14];
  const buckets = wordSlots.map(() => new Map());
  for (let index = 0; index < nodes.length; index++) for (let slot = 0; slot < wordSlots.length; slot++) {
    const word = nodes[index].robustWords[wordSlots[slot]];
    let bucket = buckets[slot].get(word);
    if (!bucket) buckets[slot].set(word, bucket = []);
    bucket.push(index);
  }
  return { buckets, wordSlots };
}

function eachWordNeighbor(word, visit) {
  visit(word);
  for (let bit = 0; bit < 16; bit++) visit(word ^ (1 << bit));
}

function addWindowCandidates(set, order, position, radius) {
  const start = Math.max(0, position - radius);
  const end = Math.min(order.length, position + radius + 1);
  for (let cursor = start; cursor < end; cursor++) set.add(order[cursor]);
}

function metric(left, right, mode) {
  const structure = hamming(left.robustWords, right.robustWords);
  const aspect = Math.min(3, aspectDistance(left.aspect, right.aspect));
  if (mode === 'structure') return structure + aspect * 4;
  const color = colorDistance(left.color, right.color) * 2;
  return structure * .64 + color * .36 + aspect * 3;
}

function buildNeighborGraph(nodes, mode) {
  const count = nodes.length;
  const robustOrder = nodes.map((_, index) => index).sort((a, b) => nodes[a].robust.localeCompare(nodes[b].robust));
  const robustPosition = new Uint32Array(count);
  robustOrder.forEach((index, position) => { robustPosition[index] = position; });

  const colorOrder = nodes.map((_, index) => index).sort((a, b) => compareTuple(colorKey(nodes[a]), colorKey(nodes[b])));
  const colorPosition = new Uint32Array(count);
  colorOrder.forEach((index, position) => { colorPosition[index] = position; });

  const { buckets, wordSlots } = robustBuckets(nodes);
  const graph = Array.from({ length:count }, () => []);

  for (let index = 0; index < count; index++) {
    const candidates = new Set();
    const node = nodes[index];
    for (let slot = 0; slot < wordSlots.length; slot++) {
      const word = node.robustWords[wordSlots[slot]];
      eachWordNeighbor(word, key => {
        const bucket = buckets[slot].get(key) || [];
        const limit = Math.min(bucket.length, 192);
        for (let cursor = 0; cursor < limit; cursor++) candidates.add(bucket[cursor]);
      });
    }
    addWindowCandidates(candidates, robustOrder, robustPosition[index], ROBUST_WINDOW);
    if (mode === 'flow') addWindowCandidates(candidates, colorOrder, colorPosition[index], COLOR_WINDOW);
    candidates.delete(index);

    const ranked = [];
    for (const other of candidates) ranked.push({ index:other, distance:metric(node, nodes[other], mode) });
    ranked.sort((a, b) => a.distance - b.distance || nodes[a.index].hash.localeCompare(nodes[b.index].hash));
    graph[index] = ranked.slice(0, K_NEIGHBORS);
  }

  for (let index = 0; index < count; index++) for (const edge of [...graph[index]]) {
    const reverse = graph[edge.index];
    if (!reverse.some(item => item.index === index)) reverse.push({ index, distance:edge.distance });
  }
  for (const edges of graph) edges.sort((a, b) => a.distance - b.distance);

  return { graph, robustOrder, robustPosition, colorOrder, colorPosition };
}

function nearestUnvisitedInOrder(current, order, positions, visited, nodes, mode, radius = 96) {
  const position = positions[current];
  let best = -1;
  let bestDistance = Infinity;
  for (let delta = 1; delta <= radius; delta++) {
    for (const cursor of [position - delta, position + delta]) {
      if (cursor < 0 || cursor >= order.length) continue;
      const candidate = order[cursor];
      if (visited[candidate]) continue;
      const distance = metric(nodes[current], nodes[candidate], mode);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best >= 0 && delta >= 12) break;
  }
  return best;
}

function flowOrder(nodes, mode) {
  if (nodes.length < 2) return nodes.map((_, index) => index);
  const graphData = buildNeighborGraph(nodes, mode);
  const { graph, robustOrder, robustPosition, colorOrder, colorPosition } = graphData;
  const visited = new Uint8Array(nodes.length);
  const result = [];
  const fallbackOrder = mode === 'structure' ? robustOrder : colorOrder;
  const fallbackPosition = mode === 'structure' ? robustPosition : colorPosition;
  let fallbackCursor = 0;
  let current = fallbackOrder[0];

  while (result.length < nodes.length) {
    if (!visited[current]) {
      visited[current] = 1;
      result.push(current);
    }

    let next = -1;
    for (const edge of graph[current]) {
      if (!visited[edge.index]) { next = edge.index; break; }
    }
    if (next < 0) next = nearestUnvisitedInOrder(current, fallbackOrder, fallbackPosition, visited, nodes, mode);
    if (next < 0) {
      while (fallbackCursor < fallbackOrder.length && visited[fallbackOrder[fallbackCursor]]) fallbackCursor++;
      next = fallbackOrder[fallbackCursor] ?? -1;
    }
    if (next < 0) break;
    current = next;
  }
  return result;
}

function colorOrder(nodes) {
  return nodes.map((_, index) => index).sort((a, b) => compareTuple(colorKey(nodes[a]), colorKey(nodes[b])));
}

async function build(media, mode) {
  const descriptors = await ensureDescriptors(media);
  self.postMessage({ type:'progress', done:media.length, total:media.length, stage:'ordering' });
  const { nodes, unavailable } = buildNodes(media, descriptors);
  let nodeOrder;
  if (mode === 'color') nodeOrder = colorOrder(nodes);
  else nodeOrder = flowOrder(nodes, mode === 'structure' ? 'structure' : 'flow');

  const order = nodeOrder.map(index => media[nodes[index].mediaIndex]);
  for (const mediaIndex of unavailable) order.push(media[mediaIndex]);
  return { order, indexed:nodes.length, unavailable:unavailable.length };
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