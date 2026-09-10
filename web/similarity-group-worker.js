const THUMB_VERSION = 3;
const DHASH_VERSION = 'dhash9x8-v1';
const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const CORE_BLOCK_RADIUS = 2;
const EXPAND_BLOCK_RADIUS = 3;
const CORE_DHASH_DISTANCE = 20;
const EXPAND_DHASH_DISTANCE = 24;
const GROUP_PHASH_DIAMETER = 18;
const GROUP_DHASH_DIAMETER = 28;
const EXPAND_GROUP_PHASH_DIAMETER = 20;
const EXPAND_GROUP_DHASH_DIAMETER = 28;
const HASH_RE = /^[0-9a-f]{16}$/;

const POPCOUNT16 = new Uint8Array(1 << 16);
for (let value = 1; value < POPCOUNT16.length; value++) POPCOUNT16[value] = POPCOUNT16[value >> 1] + (value & 1);

const wordsFor = value => [0,4,8,12].map(offset => parseInt(value.slice(offset, offset + 4), 16));

function distanceWords(left, right) {
  return POPCOUNT16[left[0] ^ right[0]] +
    POPCOUNT16[left[1] ^ right[1]] +
    POPCOUNT16[left[2] ^ right[2]] +
    POPCOUNT16[left[3] ^ right[3]];
}

function similarityScore(delta) {
  return Math.max(0, Math.round(100 - delta * 4));
}

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

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRows(hashes) {
  if (!hashes.length) return new Map();
  const wanted = new Set(hashes);
  const db = await openDb();
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const rows = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    return new Map(rows.filter(row => wanted.has(String(row.hash))).map(row => [String(row.hash), row]));
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
    tx.onabort = () => reject(tx.error || new Error('Could not cache gradient hashes'));
  }).finally(() => db.close());
}

async function dHashFor(hash) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache' });
  if (!response.ok) return '';
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(9, 8);
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(bitmap, 0, 0, 9, 8);
    const data = context.getImageData(0, 0, 9, 8).data;
    const gray = new Float32Array(72);
    for (let pixel = 0, index = 0; index < gray.length; index++, pixel += 4) gray[index] = data[pixel] * .299 + data[pixel + 1] * .587 + data[pixel + 2] * .114;
    let hex = '';
    for (let nibble = 0; nibble < 16; nibble++) {
      let value = 0;
      for (let bit = 0; bit < 4; bit++) {
        const index = nibble * 4 + bit;
        const y = Math.floor(index / 8);
        const x = index % 8;
        if (gray[y * 9 + x + 1] > gray[y * 9 + x]) value |= 1 << (3 - bit);
      }
      hex += value.toString(16);
    }
    return hex;
  } finally { bitmap.close?.(); }
}

async function ensureDHashes(hashes, pHashes, known = new Map()) {
  const unique = [...new Set(hashes)].filter(hash => !known.has(hash));
  if (!unique.length) return known;
  const rows = await readRows(unique);
  const missing = [];
  for (const hash of unique) {
    const row = rows.get(hash);
    if (row?.dhashVersion === DHASH_VERSION && HASH_RE.test(String(row.dhash || ''))) known.set(hash, String(row.dhash));
    else missing.push(hash);
  }

  const writes = [];
  for (let offset = 0; offset < missing.length; offset += 24) {
    const chunk = missing.slice(offset, offset + 24);
    const computed = await Promise.all(chunk.map(async hash => {
      try { return [hash, await dHashFor(hash)]; }
      catch { return [hash, '']; }
    }));
    for (const [hash, value] of computed) {
      if (!HASH_RE.test(value)) continue;
      known.set(hash, value);
      const old = rows.get(hash) || { hash, value:pHashes.get(hash) || '' };
      writes.push({ ...old, hash, dhash:value, dhashVersion:DHASH_VERSION });
    }
  }
  try { await saveRows(writes); } catch {}
  return known;
}

function exactPHashGroups(images, pHashes) {
  const byValue = new Map();
  for (let index = 0; index < images.length; index++) {
    const value = pHashes.get(images[index].hash);
    if (!HASH_RE.test(String(value || ''))) continue;
    let members = byValue.get(value);
    if (!members) byValue.set(value, members = []);
    members.push(index);
  }

  const groups = [...byValue.values()]
    .filter(members => members.length > 1)
    .map(members => ({
      members,
      representative:members[0],
      bestDistance:0,
      newest:Math.max(...members.map(index => images[index].dateMs || 0)),
      key:members.map(index => images[index].hash).sort()[0]
    }));
  return finalizeGroups(images, groups, new Map(groups.flatMap(group => group.members.map(index => [index, 0]))));
}

function buildBuckets(nodes) {
  const buckets = Array.from({ length:4 }, () => new Map());
  for (let index = 0; index < nodes.length; index++) for (let block = 0; block < 4; block++) {
    const word = nodes[index].pWords[block];
    let bucket = buckets[block].get(word);
    if (!bucket) buckets[block].set(word, bucket = []);
    bucket.push(index);
  }
  return buckets;
}

function candidatesForWords(words, buckets, radius, after = -1) {
  const candidates = new Set();
  for (let block = 0; block < 4; block++) {
    eachNeighbor(words[block], radius, key => {
      for (const index of buckets[block].get(key) || []) if (index > after) candidates.add(index);
    });
  }
  return candidates;
}

function compatible(node, accepted, nodes, pLimit, dLimit) {
  for (const index of accepted) {
    const other = nodes[index];
    if (distanceWords(node.pWords, other.pWords) > pLimit) return false;
    if (distanceWords(node.dWords, other.dWords) > dLimit) return false;
  }
  return true;
}

function finalizeGroups(images, groups, pDistanceByIndex, partnerByIndex = new Map()) {
  const scores = [];
  const partners = [];
  const order = [];
  const groupByHash = [];
  const groupInfo = [];

  groups.sort((a, b) =>
    b.members.length - a.members.length ||
    a.bestDistance - b.bestDistance ||
    b.newest - a.newest ||
    a.key.localeCompare(b.key)
  );

  for (let groupId = 0; groupId < groups.length; groupId++) {
    const group = groups[groupId];
    group.members.sort((a, b) =>
      (pDistanceByIndex.get(a) ?? 64) - (pDistanceByIndex.get(b) ?? 64) ||
      (images[b].dateMs || 0) - (images[a].dateMs || 0) ||
      images[a].hash.localeCompare(images[b].hash)
    );
    const start = order.length;
    for (const index of group.members) {
      const file = images[index];
      const delta = pDistanceByIndex.get(index) ?? 0;
      order.push(file);
      scores.push([file.hash, similarityScore(delta)]);
      groupByHash.push([file.hash, groupId]);
      const partner = partnerByIndex.get(index);
      if (partner != null && partner !== index) partners.push([file.hash, images[partner].hash]);
    }
    groupInfo.push({ id:groupId, start, size:group.members.length, bestDistance:group.bestDistance, bestScore:similarityScore(group.bestDistance) });
  }
  return { order, scores, partners, groupByHash, groupInfo, groups:groups.length, matched:order.length };
}

function pHashNodes(images, pHashes) {
  const byPHash = new Map();
  for (let index = 0; index < images.length; index++) {
    const pHash = pHashes.get(images[index].hash);
    if (!HASH_RE.test(String(pHash || ''))) continue;
    let members = byPHash.get(pHash);
    if (!members) byPHash.set(pHash, members = []);
    members.push(index);
  }
  return [...byPHash].map(([pHash, members]) => ({ pHash, pWords:wordsFor(pHash), members }));
}

function visualNodes(images, imageIndices, pHashes, dHashes) {
  const byKey = new Map();
  for (const index of imageIndices) {
    const hash = images[index].hash;
    const pHash = pHashes.get(hash);
    const dHash = dHashes.get(hash);
    if (!HASH_RE.test(String(pHash || '')) || !HASH_RE.test(String(dHash || ''))) continue;
    const key = `${pHash}:${dHash}`;
    let node = byKey.get(key);
    if (!node) {
      node = { pHash, dHash, pWords:wordsFor(pHash), dWords:wordsFor(dHash), members:[] };
      byKey.set(key, node);
    }
    node.members.push(index);
  }
  return [...byKey.values()];
}

async function buildSimilarGroups(images, pHashes, maxDistance, expandDistance) {
  const coarse = pHashNodes(images, pHashes);
  const coarseBuckets = buildBuckets(coarse);
  const coreNeeded = new Set();

  // Only images that participate in a strong pHash edge need the secondary
  // hash for core grouping. The previous implementation generated dHash for
  // every loose <=14 candidate up front, which made first-time grouping slow.
  for (let index = 0; index < coarse.length; index++) {
    const item = coarse[index];
    if (item.members.length > 1) for (const member of item.members) coreNeeded.add(member);
    for (const otherIndex of candidatesForWords(item.pWords, coarseBuckets, CORE_BLOCK_RADIUS, index)) {
      if (distanceWords(item.pWords, coarse[otherIndex].pWords) > maxDistance) continue;
      for (const member of item.members) coreNeeded.add(member);
      for (const member of coarse[otherIndex].members) coreNeeded.add(member);
    }
  }

  const dHashes = await ensureDHashes([...coreNeeded].map(index => images[index].hash), pHashes);
  const nodes = visualNodes(images, coreNeeded, pHashes, dHashes);
  const buckets = buildBuckets(nodes);
  const neighbors = Array.from({ length:nodes.length }, () => []);

  for (let index = 0; index < nodes.length; index++) {
    const item = nodes[index];
    for (const otherIndex of candidatesForWords(item.pWords, buckets, CORE_BLOCK_RADIUS, index)) {
      const other = nodes[otherIndex];
      const pDistance = distanceWords(item.pWords, other.pWords);
      if (pDistance > maxDistance) continue;
      const dDistance = distanceWords(item.dWords, other.dWords);
      if (dDistance > CORE_DHASH_DISTANCE) continue;
      neighbors[index].push({ index:otherIndex, pDistance, dDistance });
      neighbors[otherIndex].push({ index, pDistance, dDistance });
    }
  }

  const weight = nodes.map((node, index) =>
    node.members.length + neighbors[index].reduce((sum, edge) => sum + nodes[edge.index].members.length, 0)
  );
  const seedOrder = nodes.map((_, index) => index).sort((a, b) =>
    weight[b] - weight[a] ||
    nodes[b].members.length - nodes[a].members.length ||
    nodes[a].pHash.localeCompare(nodes[b].pHash)
  );
  const nodeOwner = new Int32Array(nodes.length);
  nodeOwner.fill(-1);
  const imageOwner = new Int32Array(images.length);
  imageOwner.fill(-1);
  const groups = [];
  const pDistanceByIndex = new Map();
  const partnerByIndex = new Map();

  for (const seed of seedOrder) {
    if (nodeOwner[seed] >= 0) continue;
    const candidates = neighbors[seed]
      .filter(edge => nodeOwner[edge.index] < 0)
      .sort((a, b) => a.pDistance - b.pDistance || a.dDistance - b.dDistance || nodes[b.index].members.length - nodes[a.index].members.length);

    const accepted = [seed];
    for (const edge of candidates) {
      if (compatible(nodes[edge.index], accepted, nodes, GROUP_PHASH_DIAMETER, GROUP_DHASH_DIAMETER)) accepted.push(edge.index);
    }
    if (accepted.reduce((sum, nodeIndex) => sum + nodes[nodeIndex].members.length, 0) < 2) continue;

    const groupId = groups.length;
    const group = { nodeIndices:accepted, representative:seed, members:[], bestDistance:0, newest:0, key:'' };
    for (const nodeIndex of accepted) {
      nodeOwner[nodeIndex] = groupId;
      const pDistance = nodeIndex === seed ? 0 : distanceWords(nodes[seed].pWords, nodes[nodeIndex].pWords);
      for (const member of nodes[nodeIndex].members) {
        imageOwner[member] = groupId;
        group.members.push(member);
        pDistanceByIndex.set(member, pDistance);
        if (nodeIndex !== seed) partnerByIndex.set(member, nodes[seed].members[0]);
        group.newest = Math.max(group.newest, images[member].dateMs || 0);
        if (!group.key || images[member].hash < group.key) group.key = images[member].hash;
      }
    }
    group.bestDistance = Math.max(...group.members.map(index => pDistanceByIndex.get(index) || 0));
    groups.push(group);
  }

  if (!groups.length || expandDistance <= maxDistance) {
    return finalizeGroups(images, groups, pDistanceByIndex, partnerByIndex);
  }

  // Find loose pHash candidates only around actual accepted group
  // representatives. This avoids hashing the entire loose candidate graph.
  const expansionImageIndices = new Set();
  for (const group of groups) {
    const representative = nodes[group.representative];
    for (const coarseIndex of candidatesForWords(representative.pWords, coarseBuckets, EXPAND_BLOCK_RADIUS)) {
      const item = coarse[coarseIndex];
      if (distanceWords(representative.pWords, item.pWords) > expandDistance) continue;
      for (const member of item.members) if (imageOwner[member] < 0) expansionImageIndices.add(member);
    }
  }

  await ensureDHashes([...expansionImageIndices].map(index => images[index].hash), pHashes, dHashes);
  const expansionNodes = visualNodes(images, expansionImageIndices, pHashes, dHashes);
  const assignments = new Map();

  for (let candidateIndex = 0; candidateIndex < expansionNodes.length; candidateIndex++) {
    const candidate = expansionNodes[candidateIndex];
    for (let groupId = 0; groupId < groups.length; groupId++) {
      const group = groups[groupId];
      const representative = nodes[group.representative];
      const pDistance = distanceWords(representative.pWords, candidate.pWords);
      if (pDistance > expandDistance) continue;
      const dDistance = distanceWords(representative.dWords, candidate.dWords);
      if (dDistance > EXPAND_DHASH_DISTANCE) continue;
      if (!compatible(candidate, group.nodeIndices, nodes, EXPAND_GROUP_PHASH_DIAMETER, EXPAND_GROUP_DHASH_DIAMETER)) continue;

      const closeness = pDistance * EXPAND_DHASH_DISTANCE + dDistance * expandDistance;
      const previous = assignments.get(candidateIndex);
      if (previous && (previous.closeness < closeness || (previous.closeness === closeness && groups[previous.groupId].members.length >= group.members.length))) continue;
      assignments.set(candidateIndex, { groupId, pDistance, closeness });
    }
  }

  // Add loose members one at a time and keep checking against the group as it
  // grows. A later member cannot make two mutually dissimilar images coexist.
  const expansionByGroup = new Map();
  for (const [candidateIndex, assignment] of assignments) {
    let list = expansionByGroup.get(assignment.groupId);
    if (!list) expansionByGroup.set(assignment.groupId, list = []);
    list.push({ candidateIndex, ...assignment });
  }

  for (const [groupId, list] of expansionByGroup) {
    const group = groups[groupId];
    list.sort((a, b) => a.closeness - b.closeness);
    const acceptedExpansion = [];
    for (const assignment of list) {
      const candidate = expansionNodes[assignment.candidateIndex];
      let okay = compatible(candidate, group.nodeIndices, nodes, EXPAND_GROUP_PHASH_DIAMETER, EXPAND_GROUP_DHASH_DIAMETER);
      if (okay) {
        for (const otherIndex of acceptedExpansion) {
          const other = expansionNodes[otherIndex];
          if (distanceWords(candidate.pWords, other.pWords) > EXPAND_GROUP_PHASH_DIAMETER ||
              distanceWords(candidate.dWords, other.dWords) > EXPAND_GROUP_DHASH_DIAMETER) {
            okay = false;
            break;
          }
        }
      }
      if (!okay) continue;

      acceptedExpansion.push(assignment.candidateIndex);
      for (const member of candidate.members) {
        imageOwner[member] = groupId;
        group.members.push(member);
        pDistanceByIndex.set(member, assignment.pDistance);
        partnerByIndex.set(member, nodes[group.representative].members[0]);
        group.newest = Math.max(group.newest, images[member].dateMs || 0);
        if (!group.key || images[member].hash < group.key) group.key = images[member].hash;
      }
      group.bestDistance = Math.max(group.bestDistance, assignment.pDistance);
    }
  }

  return finalizeGroups(images, groups.filter(group => group.members.length > 1), pDistanceByIndex, partnerByIndex);
}

async function buildGroups(images, fingerprintEntries, config) {
  const pHashes = new Map(fingerprintEntries);
  const maxDistance = Math.max(0, Number(config?.maxDistance) || 0);
  const expandDistance = Math.max(maxDistance, Number(config?.expandDistance) || maxDistance);
  if (maxDistance === 0) return exactPHashGroups(images, pHashes);
  return buildSimilarGroups(images, pHashes, maxDistance, expandDistance);
}

self.onmessage = async event => {
  try {
    const { images = [], fingerprints = [], config = {} } = event.data || {};
    self.postMessage({ result:await buildGroups(images, fingerprints, config) });
  } catch (error) {
    self.postMessage({ error:error?.message || String(error) });
  }
};
