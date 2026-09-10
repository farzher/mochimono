const CORE_BLOCK_RADIUS = 2;
const EXPAND_BLOCK_RADIUS = 3;

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

function buildGroups(images, fingerprintEntries, config) {
  const fingerprints = new Map(fingerprintEntries);
  const maxDistance = Math.max(0, Number(config?.maxDistance) || 0);
  const expandDistance = Math.max(maxDistance, Number(config?.expandDistance) || maxDistance);
  const fileIndex = new Map(images.map((file, index) => [file.hash, index]));
  const parent = Int32Array.from(images, (_, index) => index);
  const best = new Uint8Array(images.length);
  const partner = new Int32Array(images.length);
  best.fill(64);
  partner.fill(-1);

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
  const union = (left, right) => {
    left = find(left);
    right = find(right);
    if (left !== right) parent[right] = left;
  };
  const consider = (index, other, delta) => {
    if (delta < best[index] || (delta === best[index] && (partner[index] < 0 || images[other].hash < images[partner[index]].hash))) {
      best[index] = delta;
      partner[index] = other;
    }
  };

  const identical = new Map();
  for (const file of images) {
    const value = fingerprints.get(file.hash);
    if (!value) continue;
    let members = identical.get(value);
    if (!members) identical.set(value, members = []);
    members.push(fileIndex.get(file.hash));
  }

  const unique = [];
  for (const [value, members] of identical) {
    const first = members[0];
    if (members.length > 1) {
      for (let index = 0; index < members.length; index++) {
        const member = members[index];
        const other = members[index === 0 ? 1 : 0];
        consider(member, other, 0);
        if (index) union(first, member);
      }
    }
    unique.push({ value, words:wordsFor(value), members, representative:first });
  }

  const buckets = Array.from({ length:4 }, () => new Map());
  for (let index = 0; index < unique.length; index++) for (let block = 0; block < 4; block++) {
    const word = unique[index].words[block];
    let bucket = buckets[block].get(word);
    if (!bucket) buckets[block].set(word, bucket = []);
    bucket.push(index);
  }

  const candidatesForWords = (words, radius, after = -1) => {
    const candidates = new Set();
    for (let block = 0; block < 4; block++) {
      eachNeighbor(words[block], radius, key => {
        for (const index of buckets[block].get(key) || []) if (index > after) candidates.add(index);
      });
    }
    return candidates;
  };

  if (maxDistance > 0) {
    for (let index = 0; index < unique.length; index++) {
      const item = unique[index];
      for (const otherIndex of candidatesForWords(item.words, CORE_BLOCK_RADIUS, index)) {
        const other = unique[otherIndex];
        const delta = distanceWords(item.words, other.words);
        if (delta > maxDistance) continue;
        union(item.representative, other.representative);
        const leftPartner = other.members[0];
        const rightPartner = item.members[0];
        for (const member of item.members) consider(member, leftPartner, delta);
        for (const member of other.members) consider(member, rightPartner, delta);
      }
    }
  }

  const groupsByRoot = new Map();
  for (let index = 0; index < images.length; index++) {
    if (best[index] > maxDistance || partner[index] < 0) continue;
    const root = find(index);
    let group = groupsByRoot.get(root);
    if (!group) {
      group = { members:[], bestDistance:64, newest:0, key:images[index].hash };
      groupsByRoot.set(root, group);
    }
    group.members.push(index);
    group.bestDistance = Math.min(group.bestDistance, best[index]);
    group.newest = Math.max(group.newest, images[index].dateMs || 0);
    if (images[index].hash < group.key) group.key = images[index].hash;
  }

  const groups = [...groupsByRoot.values()].filter(group => group.members.length > 1);

  if (expandDistance > maxDistance && groups.length) {
    const owner = new Int32Array(images.length);
    owner.fill(-1);
    groups.forEach((group, groupId) => {
      group.coreSize = group.members.length;
      for (const index of group.members) owner[index] = groupId;
    });

    const centroid = members => {
      const ones = new Uint32Array(64);
      let count = 0;
      for (const index of members) {
        const value = fingerprints.get(images[index].hash);
        if (!value) continue;
        count++;
        for (let nibble = 0; nibble < 16; nibble++) {
          const valueNibble = parseInt(value[nibble], 16);
          for (let bit = 0; bit < 4; bit++) if (valueNibble & (1 << (3 - bit))) ones[nibble * 4 + bit]++;
        }
      }
      if (!count) return '';
      let value = '';
      for (let nibble = 0; nibble < 16; nibble++) {
        let valueNibble = 0;
        for (let bit = 0; bit < 4; bit++) if (ones[nibble * 4 + bit] * 2 >= count) valueNibble |= 1 << (3 - bit);
        value += valueNibble.toString(16);
      }
      return value;
    };

    const assignments = new Map();
    for (let groupId = 0; groupId < groups.length; groupId++) {
      const group = groups[groupId];
      const center = centroid(group.members);
      if (!center) continue;
      const centerWords = wordsFor(center);
      for (const uniqueIndex of candidatesForWords(centerWords, EXPAND_BLOCK_RADIUS)) {
        const item = unique[uniqueIndex];
        const delta = distanceWords(centerWords, item.words);
        if (delta > expandDistance) continue;
        for (const member of item.members) {
          if (owner[member] >= 0) continue;
          const previous = assignments.get(member);
          if (previous && (previous.distance < delta || (previous.distance === delta && previous.coreSize >= group.coreSize))) continue;
          assignments.set(member, { groupId, distance:delta, coreSize:group.coreSize });
        }
      }
    }

    for (const [index, assignment] of assignments) {
      const group = groups[assignment.groupId];
      group.members.push(index);
      best[index] = assignment.distance;
      group.newest = Math.max(group.newest, images[index].dateMs || 0);
      if (images[index].hash < group.key) group.key = images[index].hash;
    }
  }

  const scores = [];
  const partners = [];
  for (const group of groups) for (const index of group.members) {
    scores.push([images[index].hash, similarityScore(best[index])]);
    if (partner[index] >= 0) partners.push([images[index].hash, images[partner[index]].hash]);
  }

  for (const group of groups) {
    group.members.sort((a, b) =>
      best[a] - best[b] ||
      (images[b].dateMs || 0) - (images[a].dateMs || 0) ||
      images[a].hash.localeCompare(images[b].hash)
    );
  }

  groups.sort((a, b) =>
    b.members.length - a.members.length ||
    a.bestDistance - b.bestDistance ||
    b.newest - a.newest ||
    a.key.localeCompare(b.key)
  );

  const order = [];
  const groupByHash = [];
  const groupInfo = [];
  for (let groupId = 0; groupId < groups.length; groupId++) {
    const group = groups[groupId];
    const start = order.length;
    for (const index of group.members) {
      const file = images[index];
      order.push(file);
      groupByHash.push([file.hash, groupId]);
    }
    groupInfo.push({ id:groupId, start, size:group.members.length, bestDistance:group.bestDistance, bestScore:similarityScore(group.bestDistance) });
  }

  return { order, scores, partners, groupByHash, groupInfo, groups:groups.length, matched:order.length };
}

self.onmessage = event => {
  try {
    const { images = [], fingerprints = [], config = {} } = event.data || {};
    self.postMessage({ result:buildGroups(images, fingerprints, config) });
  } catch (error) {
    self.postMessage({ error:error?.message || String(error) });
  }
};
