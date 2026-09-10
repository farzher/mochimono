const THUMB_VERSION = 3;
const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const ROBUST_VERSION = 'phash32-dct16-v1';
const ROBUST_SAMPLE = 32;
const ROBUST_LOW = 16;
const HASH64_RE = /^[0-9a-f]{16}$/;
const HASH256_RE = /^[0-9a-f]{64}$/;
const HASH_BATCH = 16;

const POPCOUNT16 = new Uint8Array(1 << 16);
for (let value = 1; value < POPCOUNT16.length; value++) POPCOUNT16[value] = POPCOUNT16[value >> 1] + (value & 1);

const COS = Array.from({ length:ROBUST_LOW }, (_, u) =>
  Array.from({ length:ROBUST_SAMPLE }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / (2 * ROBUST_SAMPLE)))
);
const SCALE = Array.from({ length:ROBUST_LOW }, (_, u) =>
  u === 0 ? Math.sqrt(1 / ROBUST_SAMPLE) : Math.sqrt(2 / ROBUST_SAMPLE)
);

const words64 = value => [0,4,8,12].map(offset => parseInt(value.slice(offset, offset + 4), 16));
const words256 = value => Array.from({ length:16 }, (_, index) => parseInt(value.slice(index * 4, index * 4 + 4), 16));

function hamming(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index++) total += POPCOUNT16[left[index] ^ right[index]];
  return total;
}

// A random 256-bit pHash pair is about 128 bits apart. Mapping 128 -> 0
// makes the badge intuitive: 100 is a true high-resolution pHash identity,
// while broad-but-useful visual relationships naturally fall lower.
function similarityScore(distance) {
  return Math.max(0, Math.min(100, Math.round(100 - distance * 100 / 128)));
}

const aspectFor = image => Math.max(1e-6, (Number(image?.width) || 1) / (Number(image?.height) || 1));
const aspectDistance = (left, right) => Math.abs(Math.log2(left / right));

function eachNeighbor(word, radius, visit) {
  visit(word);
  if (radius < 1) return;
  for (let a = 0; a < 16; a++) {
    const one = word ^ (1 << a);
    visit(one);
    if (radius < 2) continue;
    for (let b = a + 1; b < 16; b++) {
      const two = one ^ (1 << b);
      visit(two);
      if (radius < 3) continue;
      for (let c = b + 1; c < 16; c++) visit(two ^ (1 << c));
    }
  }
}

function blockRadius(distance) {
  return Math.max(0, Math.min(3, Math.floor(Math.max(0, Number(distance) || 0) / 4)));
}

function buildBuckets(nodes) {
  const buckets = Array.from({ length:4 }, () => new Map());
  for (let index = 0; index < nodes.length; index++) {
    for (let block = 0; block < 4; block++) {
      const word = nodes[index].coarseWords[block];
      let bucket = buckets[block].get(word);
      if (!bucket) buckets[block].set(word, bucket = []);
      bucket.push(index);
    }
  }
  return buckets;
}

function candidatesFor(words, buckets, distance, after = -1) {
  const candidates = new Set();
  const radius = blockRadius(distance);
  for (let block = 0; block < 4; block++) {
    eachNeighbor(words[block], radius, key => {
      for (const index of buckets[block].get(key) || []) if (index > after) candidates.add(index);
    });
  }
  return candidates;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadRobustHashes() {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const rows = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    return new Map(rows
      .filter(row => row?.robustVersion === ROBUST_VERSION && HASH256_RE.test(String(row.robust || '')))
      .map(row => [String(row.hash), String(row.robust)]));
  } finally { db.close(); }
}

async function saveRobustHashes(rows) {
  if (!rows.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows) store.put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Could not cache robust perceptual hashes'));
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

async function robustPHash(hash) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache' });
  if (!response.ok) return '';
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(ROBUST_SAMPLE, ROBUST_SAMPLE);
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(bitmap, 0, 0, ROBUST_SAMPLE, ROBUST_SAMPLE);
    const data = context.getImageData(0, 0, ROBUST_SAMPLE, ROBUST_SAMPLE).data;
    const gray = new Float32Array(ROBUST_SAMPLE * ROBUST_SAMPLE);
    for (let pixel = 0, index = 0; index < gray.length; index++, pixel += 4) {
      gray[index] = data[pixel] * .299 + data[pixel + 1] * .587 + data[pixel + 2] * .114;
    }

    const horizontal = new Float32Array(ROBUST_SAMPLE * ROBUST_LOW);
    for (let y = 0; y < ROBUST_SAMPLE; y++) for (let u = 0; u < ROBUST_LOW; u++) {
      let sum = 0;
      for (let x = 0; x < ROBUST_SAMPLE; x++) sum += gray[y * ROBUST_SAMPLE + x] * COS[u][x];
      horizontal[y * ROBUST_LOW + u] = sum * SCALE[u];
    }

    const low = new Float32Array(ROBUST_LOW * ROBUST_LOW);
    for (let v = 0; v < ROBUST_LOW; v++) for (let u = 0; u < ROBUST_LOW; u++) {
      let sum = 0;
      for (let y = 0; y < ROBUST_SAMPLE; y++) sum += horizontal[y * ROBUST_LOW + u] * COS[v][y];
      low[v * ROBUST_LOW + u] = sum * SCALE[v];
    }

    const values = [...low.slice(1)].sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    const bits = new Uint8Array(ROBUST_LOW * ROBUST_LOW);
    for (let index = 1; index < low.length; index++) bits[index] = low[index] > median ? 1 : 0;
    return hashBits(bits);
  } finally { bitmap.close?.(); }
}

async function ensureRobustHashes(imageIndices, images, coarseHashes, known) {
  const hashes = [...new Set(imageIndices.map(index => images[index]?.hash).filter(Boolean))];
  const missing = hashes.filter(hash => !known.has(hash));
  if (!missing.length) return known;

  for (let offset = 0; offset < missing.length; offset += HASH_BATCH) {
    const chunk = missing.slice(offset, offset + HASH_BATCH);
    const computed = await Promise.all(chunk.map(async hash => {
      try { return [hash, await robustPHash(hash)]; }
      catch { return [hash, '']; }
    }));
    const rows = [];
    for (const [hash, robust] of computed) {
      if (!HASH256_RE.test(robust)) continue;
      known.set(hash, robust);
      rows.push({
        hash,
        value:coarseHashes.get(hash) || '',
        version:'phash16-dct8-v1',
        robust,
        robustVersion:ROBUST_VERSION,
        updatedAt:Date.now()
      });
    }
    try { await saveRobustHashes(rows); } catch {}
  }
  return known;
}

function coarseNodes(images, coarseHashes) {
  const nodes = [];
  for (let index = 0; index < images.length; index++) {
    const coarse = coarseHashes.get(images[index].hash);
    if (!HASH64_RE.test(String(coarse || ''))) continue;
    nodes.push({
      imageIndex:index,
      coarse,
      coarseWords:words64(coarse),
      aspect:aspectFor(images[index])
    });
  }
  return nodes;
}

function visualNodes(images, imageIndices, coarseHashes, robustHashes) {
  const byKey = new Map();
  for (const imageIndex of imageIndices) {
    const image = images[imageIndex];
    const coarse = coarseHashes.get(image.hash);
    const robust = robustHashes.get(image.hash);
    if (!HASH64_RE.test(String(coarse || '')) || !HASH256_RE.test(String(robust || ''))) continue;
    const aspect = aspectFor(image);
    const aspectBucket = Math.round(Math.log2(aspect) * 8);
    const key = `${coarse}:${robust}:${aspectBucket}`;
    let node = byKey.get(key);
    if (!node) {
      node = {
        coarse,
        coarseWords:words64(coarse),
        robust,
        robustWords:words256(robust),
        aspect,
        members:[]
      };
      byKey.set(key, node);
    }
    node.members.push(imageIndex);
  }
  return [...byKey.values()];
}

function nodeCompatible(candidate, accepted, nodes, robustDiameter, maxAspectDistance) {
  for (const acceptedIndex of accepted) {
    const other = nodes[acceptedIndex];
    if (hamming(candidate.robustWords, other.robustWords) > robustDiameter) return false;
    if (aspectDistance(candidate.aspect, other.aspect) > maxAspectDistance) return false;
  }
  return true;
}

function nearestScores(images, groups, nodeLookup) {
  const scoreByIndex = new Map();
  const partnerByIndex = new Map();
  for (const group of groups) {
    for (const imageIndex of group.members) {
      const ownNode = nodeLookup.get(imageIndex);
      let best = 257;
      let partner = -1;
      for (const otherIndex of group.members) {
        if (otherIndex === imageIndex) continue;
        const otherNode = nodeLookup.get(otherIndex);
        if (!ownNode || !otherNode) continue;
        const distance = ownNode === otherNode ? 0 : hamming(ownNode.robustWords, otherNode.robustWords);
        if (distance < best || (distance === best && images[otherIndex].hash < (images[partner]?.hash || '~'))) {
          best = distance;
          partner = otherIndex;
        }
      }
      if (partner >= 0) {
        scoreByIndex.set(imageIndex, best);
        partnerByIndex.set(imageIndex, partner);
      }
    }
    group.worstNearestDistance = Math.max(...group.members.map(index => scoreByIndex.get(index) ?? 256));
  }
  return { scoreByIndex, partnerByIndex };
}

function finalizeGroups(images, groups, nodeLookup) {
  const { scoreByIndex, partnerByIndex } = nearestScores(images, groups, nodeLookup);
  groups = groups.filter(group => group.members.length > 1 && group.members.every(index => scoreByIndex.has(index)));
  groups.sort((a, b) =>
    b.members.length - a.members.length ||
    a.worstNearestDistance - b.worstNearestDistance ||
    b.newest - a.newest ||
    a.key.localeCompare(b.key)
  );

  const order = [];
  const scores = [];
  const partners = [];
  const groupByHash = [];
  const groupInfo = [];

  for (let groupId = 0; groupId < groups.length; groupId++) {
    const group = groups[groupId];
    group.members.sort((a, b) =>
      (scoreByIndex.get(a) ?? 256) - (scoreByIndex.get(b) ?? 256) ||
      (images[b].dateMs || 0) - (images[a].dateMs || 0) ||
      images[a].hash.localeCompare(images[b].hash)
    );
    const start = order.length;
    for (const index of group.members) {
      order.push(images[index]);
      scores.push([images[index].hash, similarityScore(scoreByIndex.get(index))]);
      groupByHash.push([images[index].hash, groupId]);
      const partner = partnerByIndex.get(index);
      if (partner != null) partners.push([images[index].hash, images[partner].hash]);
    }
    groupInfo.push({
      id:groupId,
      start,
      size:group.members.length,
      bestDistance:group.worstNearestDistance,
      bestScore:similarityScore(group.worstNearestDistance)
    });
  }
  return { order, scores, partners, groupByHash, groupInfo, groups:groups.length, matched:order.length };
}

async function buildGroups(images, fingerprintEntries, config) {
  const coarseHashes = new Map(fingerprintEntries);

  // The UI's legacy `near` config is maxDistance=0. Treat that only as a
  // mode marker now: exact 64-bit pHash equality is far too collision-prone
  // to define near-duplicates. The 64-bit hash remains a coarse lookup key.
  const nearMode = Number(config?.maxDistance) === 0 && Number(config?.expandDistance) === 0;
  const coarseCoreDistance = nearMode ? 4 : Math.max(0, Number(config?.maxDistance) || 9);
  const coarseExpandDistance = nearMode ? 4 : Math.max(coarseCoreDistance, Number(config?.expandDistance) || 14);
  const robustCoreDistance = nearMode ? 24 : 72;
  const robustExpandDistance = nearMode ? 24 : 88;
  const robustDiameter = nearMode ? 32 : 96;
  const maxAspectDistance = nearMode ? .75 : 1;

  const coarse = coarseNodes(images, coarseHashes);
  const coarseBuckets = buildBuckets(coarse);
  const coreNeeded = new Set();

  // Stage 1: tiny 64-bit pHash is only a fast index. It never decides final
  // membership or the visible score.
  for (let index = 0; index < coarse.length; index++) {
    const item = coarse[index];
    for (const otherIndex of candidatesFor(item.coarseWords, coarseBuckets, coarseCoreDistance, index)) {
      const other = coarse[otherIndex];
      if (hamming(item.coarseWords, other.coarseWords) > coarseCoreDistance) continue;
      coreNeeded.add(item.imageIndex);
      coreNeeded.add(other.imageIndex);
    }
  }

  if (!coreNeeded.size) return { order:[], scores:[], partners:[], groupByHash:[], groupInfo:[], groups:0, matched:0 };

  const robustHashes = await loadRobustHashes();
  await ensureRobustHashes([...coreNeeded], images, coarseHashes, robustHashes);
  const nodes = visualNodes(images, coreNeeded, coarseHashes, robustHashes);
  const buckets = buildBuckets(nodes);
  const neighbors = Array.from({ length:nodes.length }, () => []);

  for (let index = 0; index < nodes.length; index++) {
    const item = nodes[index];
    for (const otherIndex of candidatesFor(item.coarseWords, buckets, coarseCoreDistance, index)) {
      const other = nodes[otherIndex];
      if (hamming(item.coarseWords, other.coarseWords) > coarseCoreDistance) continue;
      const robustDistance = hamming(item.robustWords, other.robustWords);
      if (robustDistance > robustCoreDistance) continue;
      if (aspectDistance(item.aspect, other.aspect) > maxAspectDistance) continue;
      neighbors[index].push({ index:otherIndex, robustDistance });
      neighbors[otherIndex].push({ index, robustDistance });
    }
  }

  const weight = nodes.map((node, index) =>
    node.members.length + neighbors[index].reduce((sum, edge) => sum + nodes[edge.index].members.length, 0)
  );
  const seedOrder = nodes.map((_, index) => index).sort((a, b) =>
    weight[b] - weight[a] || nodes[b].members.length - nodes[a].members.length || nodes[a].robust.localeCompare(nodes[b].robust)
  );

  const owner = new Int32Array(nodes.length);
  owner.fill(-1);
  const imageOwner = new Int32Array(images.length);
  imageOwner.fill(-1);
  const groups = [];
  const nodeLookup = new Map();

  for (const seed of seedOrder) {
    if (owner[seed] >= 0) continue;
    const candidates = neighbors[seed]
      .filter(edge => owner[edge.index] < 0)
      .sort((a, b) => a.robustDistance - b.robustDistance || nodes[b.index].members.length - nodes[a.index].members.length);
    const accepted = [seed];
    for (const edge of candidates) {
      if (nodeCompatible(nodes[edge.index], accepted, nodes, robustDiameter, maxAspectDistance)) accepted.push(edge.index);
    }
    const memberCount = accepted.reduce((sum, nodeIndex) => sum + nodes[nodeIndex].members.length, 0);
    if (memberCount < 2) continue;

    const groupId = groups.length;
    const group = { nodeIndices:[...accepted], representative:seed, members:[], newest:0, key:'' };
    for (const nodeIndex of accepted) {
      owner[nodeIndex] = groupId;
      for (const imageIndex of nodes[nodeIndex].members) {
        imageOwner[imageIndex] = groupId;
        group.members.push(imageIndex);
        nodeLookup.set(imageIndex, nodes[nodeIndex]);
        group.newest = Math.max(group.newest, images[imageIndex].dateMs || 0);
        if (!group.key || images[imageIndex].hash < group.key) group.key = images[imageIndex].hash;
      }
    }
    groups.push(group);
  }

  if (!groups.length || coarseExpandDistance <= coarseCoreDistance || robustExpandDistance <= robustCoreDistance) {
    return finalizeGroups(images, groups, nodeLookup);
  }

  // Stage 2: only inspect loose candidates surrounding groups that survived
  // robust verification. This keeps the broad view useful without hashing the
  // entire library or allowing weak pHash collisions to form groups.
  const expansionNeeded = new Set();
  for (const group of groups) {
    const representative = nodes[group.representative];
    for (const coarseIndex of candidatesFor(representative.coarseWords, coarseBuckets, coarseExpandDistance)) {
      const item = coarse[coarseIndex];
      if (imageOwner[item.imageIndex] >= 0) continue;
      if (hamming(representative.coarseWords, item.coarseWords) > coarseExpandDistance) continue;
      expansionNeeded.add(item.imageIndex);
    }
  }

  await ensureRobustHashes([...expansionNeeded], images, coarseHashes, robustHashes);
  const expansionNodes = visualNodes(images, expansionNeeded, coarseHashes, robustHashes);
  const assignments = new Map();
  const representatives = groups.map((group, groupId) => ({ ...nodes[group.representative], groupId }));
  const representativeBuckets = buildBuckets(representatives);

  for (let candidateIndex = 0; candidateIndex < expansionNodes.length; candidateIndex++) {
    const candidate = expansionNodes[candidateIndex];
    for (const representativeIndex of candidatesFor(candidate.coarseWords, representativeBuckets, coarseExpandDistance)) {
      const representative = representatives[representativeIndex];
      const groupId = representative.groupId;
      const group = groups[groupId];
      if (hamming(candidate.coarseWords, representative.coarseWords) > coarseExpandDistance) continue;
      const robustDistance = hamming(candidate.robustWords, representative.robustWords);
      if (robustDistance > robustExpandDistance) continue;
      if (!nodeCompatible(candidate, group.nodeIndices, nodes, robustDiameter, maxAspectDistance)) continue;
      const previous = assignments.get(candidateIndex);
      if (previous && previous.robustDistance <= robustDistance) continue;
      assignments.set(candidateIndex, { groupId, robustDistance });
    }
  }

  const byGroup = new Map();
  for (const [candidateIndex, assignment] of assignments) {
    let list = byGroup.get(assignment.groupId);
    if (!list) byGroup.set(assignment.groupId, list = []);
    list.push({ candidateIndex, ...assignment });
  }

  for (const [groupId, list] of byGroup) {
    const group = groups[groupId];
    list.sort((a, b) => a.robustDistance - b.robustDistance);
    const acceptedExpansion = [];
    for (const assignment of list) {
      const candidate = expansionNodes[assignment.candidateIndex];
      let okay = nodeCompatible(candidate, group.nodeIndices, nodes, robustDiameter, maxAspectDistance);
      if (okay) {
        for (const otherIndex of acceptedExpansion) {
          const other = expansionNodes[otherIndex];
          if (hamming(candidate.robustWords, other.robustWords) > robustDiameter ||
              aspectDistance(candidate.aspect, other.aspect) > maxAspectDistance) {
            okay = false;
            break;
          }
        }
      }
      if (!okay) continue;

      acceptedExpansion.push(assignment.candidateIndex);
      for (const imageIndex of candidate.members) {
        imageOwner[imageIndex] = groupId;
        group.members.push(imageIndex);
        nodeLookup.set(imageIndex, candidate);
        group.newest = Math.max(group.newest, images[imageIndex].dateMs || 0);
        if (!group.key || images[imageIndex].hash < group.key) group.key = images[imageIndex].hash;
      }
    }
  }

  return finalizeGroups(images, groups, nodeLookup);
}

self.onmessage = async event => {
  try {
    const { images = [], fingerprints = [], config = {} } = event.data || {};
    self.postMessage({ result:await buildGroups(images, fingerprints, config) });
  } catch (error) {
    self.postMessage({ error:error?.message || String(error) });
  }
};
