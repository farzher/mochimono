const THUMB_VERSION = 3;
const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const ROBUST_VERSION = 'phash32-dct16-v1';
const COLOR_VERSION = 'oklab-grid4-v2';
const SAMPLE = 32;
const LOW = 16;
const HASH_RE = /^[0-9a-f]{64}$/;
const BATCH = 16;
const K_NEIGHBORS = 24;
const ROBUST_WINDOW = 36;
const COLOR_WINDOW = 64;
const ROUTE_SEARCH_WINDOW = 96;
const TWO_OPT_WINDOW = 28;
const FAMILY_LINK_DISTANCE = 63;
const FAMILY_DIAMETER = 88;
const FAMILY_ASPECT_DISTANCE = 1;

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
  const hueWeight = new Float64Array(24);
  const hueX = new Float64Array(24);
  const hueY = new Float64Array(24);
  let chromaSum = 0;
  let spreadSum = 0;
  let colorful = 0;
  let samples = 0;

  for (let y = 1; y < SAMPLE; y += 2) for (let x = 1; x < SAMPLE; x += 2) {
    const pixel = (y * SAMPLE + x) * 4;
    const red = data[pixel];
    const green = data[pixel + 1];
    const blue = data[pixel + 2];
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    const lab = oklab(red, green, blue);
    const chroma = Math.hypot(lab[1], lab[2]);
    const quadrant = 1 + (y >= SAMPLE / 2 ? 2 : 0) + (x >= SAMPLE / 2 ? 1 : 0);
    for (const bucket of [0, quadrant]) {
      sums[bucket][0] += lab[0];
      sums[bucket][1] += lab[1];
      sums[bucket][2] += lab[2];
      sums[bucket][3]++;
    }

    samples++;
    chromaSum += chroma;
    spreadSum += spread;
    if (spread > 10) colorful++;
    if (spread > 5 && chroma > .006) {
      let angle = Math.atan2(lab[2], lab[1]);
      if (angle < 0) angle += Math.PI * 2;
      const bin = Math.floor(angle / (Math.PI * 2) * 24) % 24;
      const weight = chroma * (1 + spread / 255);
      hueWeight[bin] += weight;
      hueX[bin] += Math.cos(angle) * weight;
      hueY[bin] += Math.sin(angle) * weight;
    }
  }

  const grid = [];
  for (const sum of sums) {
    const count = Math.max(1, sum[3]);
    grid.push(sum[0] / count, sum[1] / count, sum[2] / count);
  }

  let dominantBin = 0;
  let dominantScore = -1;
  let totalHueWeight = 0;
  for (let index = 0; index < 24; index++) {
    totalHueWeight += hueWeight[index];
    const score = hueWeight[index] + .5 * (hueWeight[(index + 23) % 24] + hueWeight[(index + 1) % 24]);
    if (score > dominantScore) {
      dominantScore = score;
      dominantBin = index;
    }
  }

  let hueVectorX = 0;
  let hueVectorY = 0;
  for (const index of [(dominantBin + 23) % 24, dominantBin, (dominantBin + 1) % 24]) {
    hueVectorX += hueX[index];
    hueVectorY += hueY[index];
  }
  let dominantHue = Math.atan2(hueVectorY, hueVectorX) / (Math.PI * 2);
  if (dominantHue < 0) dominantHue += 1;
  if (!Number.isFinite(dominantHue) || totalHueWeight <= 1e-8) dominantHue = 0;

  return {
    grid,
    meanChroma:chromaSum / Math.max(1, samples),
    colorFraction:colorful / Math.max(1, samples),
    meanSpread:spreadSum / Math.max(1, samples),
    dominantHue,
    dominantStrength:totalHueWeight > 0 ? Math.max(0, dominantScore) / totalHueWeight : 0
  };
}

async function computeDescriptor(hash, needRobust, needColor) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache' });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(SAMPLE, SAMPLE);
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(bitmap, 0, 0, SAMPLE, SAMPLE);
    const data = context.getImageData(0, 0, SAMPLE, SAMPLE).data;
    return {
      robust:needRobust ? robustPHash(data) : '',
      color:needColor ? colorDescriptor(data) : null
    };
  } finally { bitmap.close?.(); }
}

function validColor(value) {
  return Boolean(value) &&
    Array.isArray(value.grid) && value.grid.length === 15 && value.grid.every(Number.isFinite) &&
    ['meanChroma','colorFraction','meanSpread','dominantHue','dominantStrength'].every(key => Number.isFinite(value[key]));
}

async function ensureDescriptors(media, mode) {
  const needColor = mode !== 'structure';
  const rows = await loadRows();
  const descriptors = new Map();
  const missing = [];

  for (const item of media) {
    const row = rows.get(item.hash);
    const robust = row?.robustVersion === ROBUST_VERSION && HASH_RE.test(String(row.robust || '')) ? String(row.robust) : '';
    const color = needColor && row?.visualColorVersion === COLOR_VERSION && validColor(row.visualColor) ? row.visualColor : null;
    if (robust && (!needColor || color)) descriptors.set(item.hash, { robust, color });
    else missing.push({ hash:item.hash, robust });
  }

  let done = media.length - missing.length;
  self.postMessage({ type:'progress', done, total:media.length, stage:'descriptors' });

  for (let offset = 0; offset < missing.length; offset += BATCH) {
    const chunk = missing.slice(offset, offset + BATCH);
    const computed = await Promise.all(chunk.map(async item => {
      try { return [item, await computeDescriptor(item.hash, !item.robust, needColor)]; }
      catch { return [item, null]; }
    }));
    const writes = [];
    for (const [item, computedDescriptor] of computed) {
      if (!computedDescriptor) continue;
      const robust = item.robust || computedDescriptor.robust;
      const color = needColor ? computedDescriptor.color : null;
      if (!HASH_RE.test(String(robust || '')) || (needColor && !validColor(color))) continue;
      descriptors.set(item.hash, { robust, color });
      const previous = rows.get(item.hash) || { hash:item.hash };
      const row = {
        ...previous,
        hash:item.hash,
        robust,
        robustVersion:ROBUST_VERSION,
        updatedAt:Date.now()
      };
      if (needColor) {
        row.visualColor = color;
        row.visualColorVersion = COLOR_VERSION;
      }
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

function colorDistance(left, right) {
  if (!left || !right) return 0;
  let spatial = 0;
  for (let block = 0; block < 5; block++) {
    const offset = block * 3;
    const dL = left.grid[offset] - right.grid[offset];
    const da = left.grid[offset + 1] - right.grid[offset + 1];
    const db = left.grid[offset + 2] - right.grid[offset + 2];
    const distance = Math.sqrt(dL * dL * 1.15 + da * da * 1.8 + db * db * 1.8);
    spatial += block ? distance : distance * 2.2;
  }
  return Math.min(128, spatial / 6.2 * 220);
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
    const color = descriptor.color;
    const globalHue = color ? hueInfo(color.grid) : { L:.5, chroma:0, hue:0 };
    const trueGray = color
      ? color.colorFraction < .008 && color.meanSpread < 3.5 && color.meanChroma < .006
      : true;
    const dominantHue = color && Number.isFinite(color.dominantHue) ? color.dominantHue : globalHue.hue;
    nodes.push({
      mediaIndex:index,
      hash:item.hash,
      robust:descriptor.robust,
      robustWords:words256(descriptor.robust),
      color,
      aspect:aspectFor(item),
      light:globalHue.L,
      colorfulness:color ? color.meanChroma + color.colorFraction * .05 : 0,
      trueGray,
      hue:dominantHue
    });
  }
  return { nodes, unavailable };
}

function metric(left, right, mode) {
  const structure = hamming(left.robustWords, right.robustWords);
  const aspect = Math.min(3, aspectDistance(left.aspect, right.aspect));
  if (mode === 'structure') return structure + aspect * 4;
  const color = colorDistance(left.color, right.color);
  return structure * .72 + color * .28 + aspect * 2.5;
}

function robustBytes(node) {
  if (node._robustBytes) return node._robustBytes;
  node._robustBytes = Array.from({ length:32 }, (_, index) => parseInt(node.robust.slice(index * 2, index * 2 + 2), 16));
  return node._robustBytes;
}

function eachByteNeighbor1(value, visit) {
  visit(value);
  for (let bit = 0; bit < 8; bit++) visit(value ^ (1 << bit));
}

function robustPairs(nodes, maxDistance) {
  if (nodes.length < 2) return [];
  const buckets = Array.from({ length:32 }, () => new Map());
  for (let index = 0; index < nodes.length; index++) {
    const bytes = robustBytes(nodes[index]);
    for (let block = 0; block < 32; block++) {
      let bucket = buckets[block].get(bytes[block]);
      if (!bucket) buckets[block].set(bytes[block], bucket = []);
      bucket.push(index);
    }
  }

  const pairs = [];
  for (let index = 0; index < nodes.length; index++) {
    const bytes = robustBytes(nodes[index]);
    const candidates = new Set();
    for (let block = 0; block < 32; block++) {
      eachByteNeighbor1(bytes[block], key => {
        for (const other of buckets[block].get(key) || []) if (other > index) candidates.add(other);
      });
    }
    for (const other of candidates) {
      const distance = hamming(nodes[index].robustWords, nodes[other].robustWords);
      if (distance <= maxDistance) pairs.push({ left:index, right:other, distance });
    }
  }
  return pairs;
}

function crossCompatible(leftMembers, rightMembers, nodes) {
  for (const leftIndex of leftMembers) for (const rightIndex of rightMembers) {
    if (hamming(nodes[leftIndex].robustWords, nodes[rightIndex].robustWords) > FAMILY_DIAMETER) return false;
    if (aspectDistance(nodes[leftIndex].aspect, nodes[rightIndex].aspect) > FAMILY_ASPECT_DISTANCE) return false;
  }
  return true;
}

function buildFamilies(nodes) {
  if (nodes.length < 2) return nodes.map((_, index) => [index]);
  const pairs = robustPairs(nodes, FAMILY_LINK_DISTANCE)
    .filter(pair => aspectDistance(nodes[pair.left].aspect, nodes[pair.right].aspect) <= FAMILY_ASPECT_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.left - b.left || a.right - b.right);
  const parent = Int32Array.from(nodes, (_, index) => index);
  const state = nodes.map((_, index) => [index]);
  const find = value => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };

  for (const pair of pairs) {
    let left = find(pair.left);
    let right = find(pair.right);
    if (left === right) continue;
    if (!crossCompatible(state[left], state[right], nodes)) continue;
    if (state[right].length > state[left].length) [left, right] = [right, left];
    parent[right] = left;
    state[left] = [...state[left], ...state[right]];
    state[right] = [];
  }

  const families = [];
  for (let index = 0; index < nodes.length; index++) if (find(index) === index && state[index].length) families.push(state[index]);
  return families;
}

function medoid(members, nodes, mode) {
  if (members.length <= 1) return members[0];
  let best = members[0];
  let bestTotal = Infinity;
  for (const candidate of members) {
    let total = 0;
    for (const other of members) if (other !== candidate) total += metric(nodes[candidate], nodes[other], mode);
    if (total < bestTotal || (total === bestTotal && nodes[candidate].hash < nodes[best].hash)) {
      best = candidate;
      bestTotal = total;
    }
  }
  return best;
}

function orderFamily(members, nodes, mode) {
  if (members.length < 3) return [...members].sort((a, b) => nodes[a].hash.localeCompare(nodes[b].hash));
  const result = [];
  const remaining = new Set(members);
  let current = medoid(members, nodes, mode);
  while (remaining.size) {
    result.push(current);
    remaining.delete(current);
    if (!remaining.size) break;
    let next = -1;
    let best = Infinity;
    for (const candidate of remaining) {
      const distance = metric(nodes[current], nodes[candidate], mode);
      if (distance < best || (distance === best && nodes[candidate].hash < (nodes[next]?.hash || '~'))) {
        next = candidate;
        best = distance;
      }
    }
    current = next;
  }
  return result;
}

function rotatedHash(hash, offset) {
  offset %= hash.length;
  return hash.slice(offset) + hash.slice(0, offset);
}

function orderWithPositions(nodes, key) {
  const order = nodes.map((_, index) => index).sort((a, b) => {
    const left = key(nodes[a]);
    const right = key(nodes[b]);
    return typeof left === 'string' ? left.localeCompare(right) : compareTuple(left, right);
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
  const projectionOffsets = [0,16,32,48];
  const projections = projectionOffsets.map(offset => orderWithPositions(nodes, node => rotatedHash(node.robust, offset)));
  const colorProjection = mode === 'flow' ? orderWithPositions(nodes, colorKey) : null;
  const graph = Array.from({ length:nodes.length }, () => []);

  for (let index = 0; index < nodes.length; index++) {
    const candidates = new Set();
    for (const projection of projections) addWindowCandidates(candidates, projection.order, projection.positions[index], ROBUST_WINDOW);
    if (colorProjection) addWindowCandidates(candidates, colorProjection.order, colorProjection.positions[index], COLOR_WINDOW);
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
  return { graph, projections, colorProjection };
}

function nearestFromOrders(endpoint, orders, visited, nodes, mode) {
  let best = -1;
  let bestDistance = Infinity;
  for (const projection of orders) {
    const position = projection.positions[endpoint];
    for (let delta = 1; delta <= ROUTE_SEARCH_WINDOW; delta++) {
      for (const cursor of [position - delta, position + delta]) {
        if (cursor < 0 || cursor >= projection.order.length) continue;
        const candidate = projection.order[cursor];
        if (visited[candidate]) continue;
        const distance = metric(nodes[endpoint], nodes[candidate], mode);
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
      if (best >= 0 && delta >= 16) break;
    }
  }
  return { index:best, distance:bestDistance };
}

function bestGraphCandidate(endpoint, graph, visited) {
  for (const edge of graph[endpoint]) if (!visited[edge.index]) return edge;
  return { index:-1, distance:Infinity };
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
        if (after + .25 >= before) continue;
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
  if (nodes.length < 2) return nodes.map((_, index) => index);
  const { graph, projections, colorProjection } = buildNeighborGraph(nodes, mode);
  const orders = colorProjection ? [colorProjection, ...projections] : projections;
  const fallback = colorProjection?.order || projections[0].order;
  const visited = new Uint8Array(nodes.length);
  const front = [];
  const back = [];
  let fallbackCursor = 0;
  let left = fallback[0];
  let right = left;
  visited[left] = 1;
  back.push(left);
  let count = 1;

  while (count < nodes.length) {
    let leftCandidate = bestGraphCandidate(left, graph, visited);
    let rightCandidate = bestGraphCandidate(right, graph, visited);
    if (leftCandidate.index < 0) leftCandidate = nearestFromOrders(left, orders, visited, nodes, mode);
    if (rightCandidate.index < 0) rightCandidate = nearestFromOrders(right, orders, visited, nodes, mode);

    let next = -1;
    let prepend = false;
    if (leftCandidate.index >= 0 || rightCandidate.index >= 0) {
      prepend = leftCandidate.distance < rightCandidate.distance;
      const chosen = prepend ? leftCandidate : rightCandidate;
      next = chosen.index;
    }

    if (next < 0) {
      while (fallbackCursor < fallback.length && visited[fallback[fallbackCursor]]) fallbackCursor++;
      next = fallback[fallbackCursor] ?? -1;
      prepend = false;
    }
    if (next < 0) break;

    visited[next] = 1;
    count++;
    if (prepend) {
      front.push(next);
      left = next;
    } else {
      back.push(next);
      right = next;
    }
  }

  return optimizeRoute([...front.reverse(), ...back], nodes, mode);
}

function familyFlowOrder(nodes, mode) {
  if (nodes.length < 2) return { order:nodes.map((_, index) => index), families:nodes.length };
  const families = buildFamilies(nodes);
  const representatives = families.map(members => nodes[medoid(members, nodes, mode)]);
  const familyOrder = routeOrder(representatives, mode);
  const result = [];
  for (const familyIndex of familyOrder) result.push(...orderFamily(families[familyIndex], nodes, mode));
  return { order:result, families:families.length };
}

function colorOrder(nodes) {
  return nodes.map((_, index) => index).sort((a, b) => compareTuple(colorKey(nodes[a]), colorKey(nodes[b])));
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
  const descriptors = await ensureDescriptors(media, mode);
  self.postMessage({ type:'progress', done:media.length, total:media.length, stage:'ordering' });
  const { nodes, unavailable } = buildNodes(media, descriptors);
  let nodeOrder;
  let families = nodes.length;
  let rail = [];

  if (mode === 'color') {
    nodeOrder = colorOrder(nodes);
    rail = colorRail(nodeOrder, nodes, unavailable.length);
  } else {
    const result = familyFlowOrder(nodes, mode === 'structure' ? 'structure' : 'flow');
    nodeOrder = result.order;
    families = result.families;
  }

  const order = nodeOrder.map(index => media[nodes[index].mediaIndex]);
  for (const mediaIndex of unavailable) order.push(media[mediaIndex]);
  return { order, indexed:nodes.length, unavailable:unavailable.length, families, rail };
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