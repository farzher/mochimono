const run = new URL(self.location.href).searchParams.get('run') || Date.now().toString(36);
const BASE_WORKER = './ai-global-sort-worker-v6.js';
const FAMILY_WORKER = './ai-global-multimodal-worker.js';
const MULTIMODAL_MODES = new Set(['flow','color','structure','hybrid','topics','moments']);
const SECTION_MODES = new Set(['color','structure','topics']);
const COLOR_LABELS = ['Red','Orange','Yellow','Green','Cyan','Blue','Purple','Magenta'];
const VIS_DB = 'mochimono-visual-similarity';
const VIS_VERSION = 1;
const VIS_STORE = 'fingerprints';
const children = new Map();
const pending = new Set();
let canceled = false;

function childUrl(path) {
  const url = new URL(path, import.meta.url);
  url.searchParams.set('run', run);
  return url;
}

function workerFor(path) {
  if (children.has(path)) return children.get(path);
  const worker = new Worker(childUrl(path), { type:'module' });
  children.set(path, worker);
  return worker;
}

function abortError() {
  const error = new Error('Canceled');
  error.name = 'AbortError';
  return error;
}

function callWorker(path, message, progressPrefix = '') {
  return new Promise((resolve, reject) => {
    const worker = workerFor(path);
    let settled = false;
    const request = { worker, reject };
    pending.add(request);

    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      pending.delete(request);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onMessage = event => {
      const data = event.data || {};
      if (data.type === 'progress') {
        self.postMessage({ ...data, detail:progressPrefix ? `${progressPrefix}${data.detail || ''}` : data.detail });
        return;
      }
      if (data.type === 'error') {
        const error = new Error(data.error || 'AI sort child worker failed');
        if (data.aborted) error.name = 'AbortError';
        finish(reject, error);
        return;
      }
      if (data.type === 'result') finish(resolve, data.result || {});
    };
    const onError = event => finish(reject, new Error(event.message || 'AI sort child worker failed'));
    const onMessageError = () => finish(reject, new Error('AI sort child worker returned unreadable data'));

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    worker.postMessage(message);
  });
}

function stopAll() {
  canceled = true;
  for (const request of [...pending]) request.reject(abortError());
  pending.clear();
  for (const worker of children.values()) {
    try { worker.postMessage({ action:'cancel' }); } catch {}
    try { worker.terminate(); } catch {}
  }
  children.clear();
}

function cleanFamilyResult(result) {
  const { familyIds, ...clean } = result || {};
  return clean;
}

function railSections(result) {
  const order = Array.from(result?.order || [], String);
  const entries = Array.isArray(result?.rail)
    ? result.rail.map(entry => ({ index:Math.max(0, Math.min(order.length - 1, Number(entry.index) || 0)), label:String(entry.label || '') })).filter(entry => entry.label).sort((a,b) => a.index - b.index)
    : [];
  const keys = new Map();
  const labels = new Map();
  if (!entries.length) return { keys, labels };
  let section = 0;
  for (let position = 0; position < order.length; position++) {
    while (section + 1 < entries.length && entries[section + 1].index <= position) section++;
    const hash = order[position];
    keys.set(hash, `${section}:${entries[section].label}`);
    labels.set(hash, entries[section].label);
  }
  return { keys, labels };
}

function monthKey(file) {
  const ms = Number(file?.dateMs) || 0;
  if (!ms) return 'Undated';
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}`;
}

function remapRail(rail, oldOrder, newOrder) {
  if (!Array.isArray(rail) || !rail.length || !oldOrder.length || !newOrder.length) return [];
  const position = new Map(newOrder.map((hash, index) => [hash, index]));
  return rail.map(entry => {
    const oldIndex = Math.max(0, Math.min(oldOrder.length - 1, Number(entry.index) || 0));
    const hash = oldOrder[oldIndex];
    return { ...entry, index:position.get(hash) ?? oldIndex };
  }).sort((a,b) => a.index - b.index);
}

function rebuildSectionRail(order, sections) {
  const rail = [];
  let previous = '';
  for (let index = 0; index < order.length; index++) {
    const hash = order[index];
    const key = sections.keys.get(hash) || '';
    if (!key || key === previous) continue;
    previous = key;
    rail.push({ index, label:sections.labels.get(hash) || key.split(':').slice(1).join(':') });
  }
  return rail;
}

function rebuildMomentsRail(order, byHash) {
  const rail = [];
  let previous = '';
  for (let index = 0; index < order.length; index++) {
    const file = byHash.get(order[index]);
    const key = monthKey(file);
    const label = key === 'Undated' ? 'Undated' : key.slice(0,4);
    if (label === previous) continue;
    previous = label;
    rail.push({ index, label });
  }
  return rail;
}

function consolidateFamilies(base, familyResult, media, mode) {
  const oldOrder = Array.from(base?.order || [], String);
  const ids = familyResult?.familyIds;
  if (!oldOrder.length || !ids?.length || ids.length !== media.length) return base;

  const mediaIndex = new Map(media.map((file, index) => [String(file?.hash || ''), index]));
  const byHash = new Map(media.map(file => [String(file?.hash || ''), file]));
  const positions = new Map(oldOrder.map((hash, index) => [hash, index]));
  const familySizes = new Map();
  for (let index = 0; index < ids.length; index++) {
    const id = Number(ids[index]);
    if (id >= 0) familySizes.set(id, (familySizes.get(id) || 0) + 1);
  }

  const sections = SECTION_MODES.has(mode) ? railSections(base) : null;
  const boundaryFor = hash => {
    if (SECTION_MODES.has(mode)) return sections.keys.get(hash) || 'unsectioned';
    if (mode === 'moments') return monthKey(byHash.get(hash));
    return 'all';
  };

  const groups = new Map();
  for (const hash of oldOrder) {
    const index = mediaIndex.get(hash);
    if (index == null) continue;
    const family = Number(ids[index]);
    if (family < 0 || (familySizes.get(family) || 0) < 2) continue;
    const key = `${family}|${boundaryFor(hash)}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = []);
    group.push(hash);
  }

  const memberGroup = new Map();
  let lockedGroups = 0;
  let lockedMedia = 0;
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    lockedGroups++;
    lockedMedia += members.length;
    for (const hash of members) memberGroup.set(hash, key);
  }
  if (!lockedGroups) return base;

  const units = [];
  const seenGroups = new Set();
  for (let position = 0; position < oldOrder.length; position++) {
    const hash = oldOrder[position];
    const key = memberGroup.get(hash);
    if (!key) {
      units.push({ anchor:position, first:position, members:[hash] });
      continue;
    }
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    const members = groups.get(key).slice().sort((a,b) => positions.get(a) - positions.get(b));
    const memberPositions = members.map(item => positions.get(item));
    units.push({
      anchor:memberPositions[Math.floor(memberPositions.length / 2)],
      first:memberPositions[0],
      members
    });
  }

  units.sort((a,b) => a.anchor - b.anchor || a.first - b.first);
  const order = units.flatMap(unit => unit.members);
  let moved = 0;
  for (let index = 0; index < order.length; index++) if (order[index] !== oldOrder[index]) moved++;

  let rail;
  if (SECTION_MODES.has(mode)) rail = rebuildSectionRail(order, sections);
  else if (mode === 'moments') rail = rebuildMomentsRail(order, byHash);
  else rail = remapRail(base.rail, oldOrder, order);

  return {
    ...base,
    order,
    rail,
    families:lockedGroups,
    multimodalFamilies:lockedGroups,
    multimodalLocked:lockedMedia,
    multimodalMoved:moved,
    dinoIndexed:Math.max(Number(base.dinoIndexed) || 0, Number(familyResult.dinoIndexed) || 0),
    semanticIndexed:Math.max(Number(base.semanticIndexed) || 0, Number(familyResult.semanticIndexed) || 0),
    algorithm:`${base.algorithm || 'ai-sort'}+multimodal-lock-v1`
  };
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function colorMetaFromRow(row) {
  const cached = row?.aiSortColor;
  if (cached && row?.aiSortColorVersion === 'ai-sort-color-v1') {
    return { ok:1, h:clamp(cached.h), l:clamp(cached.l), c:Math.max(0, Number(cached.c) || 0), f:clamp(cached.f) };
  }
  const flow = row?.aiColorFlow;
  if (flow && Array.isArray(flow.v) && flow.v.length === 56) {
    return { ok:1, h:clamp(flow.h), l:clamp(flow.l), c:Math.max(0, Number(flow.c) || 0), f:clamp(flow.f) };
  }
  const color = row?.visualColor;
  const feature = row?.visualFeature;
  if (color && feature) {
    return {
      ok:1,
      h:clamp(color.dominantHue),
      l:clamp((Number(feature.meanLuma) || 0) / 255),
      c:Math.max(0, Number(color.meanChroma) || 0),
      f:clamp(color.colorFraction)
    };
  }
  return null;
}

async function loadColorMeta(media) {
  const wanted = new Set(media.map(file => String(file?.hash || '')));
  const meta = new Map();
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(VIS_DB, VIS_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!db.objectStoreNames.contains(VIS_STORE)) return meta;
    const tx = db.transaction(VIS_STORE, 'readonly');
    const request = tx.objectStore(VIS_STORE).openCursor();
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        const row = cursor.value || {};
        const hash = String(row.hash || '');
        if (wanted.has(hash)) {
          const value = colorMetaFromRow(row);
          if (value) meta.set(hash, value);
        }
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
  return meta;
}

function shiftedHue(hue) {
  const value = (Number(hue) || 0) + 15 / 360;
  return value >= 1 ? value - 1 : value;
}

function averageUnitColor(members, meta) {
  let x = 0, y = 0, l = 0, count = 0;
  for (const hash of members) {
    const value = meta.get(hash);
    if (!value?.ok) continue;
    const angle = value.h * Math.PI * 2;
    const weight = .08 + Math.min(1, value.c * 7) * value.f;
    x += Math.cos(angle) * weight;
    y += Math.sin(angle) * weight;
    l += value.l;
    count++;
  }
  if (!count) return null;
  let h = Math.atan2(y, x) / (Math.PI * 2);
  if (h < 0) h++;
  return { h, l:l / count };
}

async function applyColorSerpentine(result, familyResult, media) {
  const oldOrder = Array.from(result?.order || [], String);
  const ids = familyResult?.familyIds;
  if (!oldOrder.length || !ids?.length || ids.length !== media.length) return result;

  const meta = await loadColorMeta(media);
  if (!meta.size) return result;

  const sections = railSections(result);
  const mediaIndex = new Map(media.map((file, index) => [String(file?.hash || ''), index]));
  const positions = new Map(oldOrder.map((hash, index) => [hash, index]));
  const familySizes = new Map();
  for (let index = 0; index < ids.length; index++) {
    const id = Number(ids[index]);
    if (id >= 0) familySizes.set(id, (familySizes.get(id) || 0) + 1);
  }

  const sectionOrder = [];
  const sectionMembers = new Map();
  for (const hash of oldOrder) {
    const key = sections.keys.get(hash) || 'unsectioned';
    if (!sectionMembers.has(key)) {
      sectionMembers.set(key, []);
      sectionOrder.push(key);
    }
    sectionMembers.get(key).push(hash);
  }

  const output = [];
  const rail = [];
  for (const sectionKey of sectionOrder) {
    const hashes = sectionMembers.get(sectionKey);
    const label = sections.labels.get(hashes[0]) || sectionKey.split(':').slice(1).join(':');
    rail.push({ index:output.length, label });
    const zone = COLOR_LABELS.indexOf(label);
    if (zone < 0) {
      output.push(...hashes);
      continue;
    }

    const groups = new Map();
    for (const hash of hashes) {
      const index = mediaIndex.get(hash);
      const family = index == null ? -1 : Number(ids[index]);
      const familyKey = family >= 0 && (familySizes.get(family) || 0) > 1 ? `f:${family}` : `s:${hash}`;
      let members = groups.get(familyKey);
      if (!members) groups.set(familyKey, members = []);
      members.push(hash);
    }

    const cells = Array.from({ length:3 }, () => Array.from({ length:5 }, () => []));
    const missing = [];
    for (const members of groups.values()) {
      members.sort((a,b) => positions.get(a) - positions.get(b));
      const color = averageUnitColor(members, meta);
      const anchor = members.reduce((sum, hash) => sum + positions.get(hash), 0) / members.length;
      if (!color) {
        missing.push({ members, anchor });
        continue;
      }
      const local = ((shiftedHue(color.h) * 8 - zone) + 8) % 8;
      const hueBin = Math.max(0, Math.min(2, Math.floor(local * 3)));
      const lightBin = Math.max(0, Math.min(4, Math.floor(color.l * 5)));
      cells[hueBin][lightBin].push({ members, anchor });
    }

    for (let hueBin = 0; hueBin < 3; hueBin++) {
      const brightToDark = ((zone + hueBin) & 1) === 0;
      const lightBins = brightToDark ? [4,3,2,1,0] : [0,1,2,3,4];
      for (const lightBin of lightBins) {
        const list = cells[hueBin][lightBin].sort((a,b) => a.anchor - b.anchor);
        for (const unit of list) output.push(...unit.members);
      }
    }
    missing.sort((a,b) => a.anchor - b.anchor);
    for (const unit of missing) output.push(...unit.members);
  }

  if (output.length !== oldOrder.length || new Set(output).size !== oldOrder.length) return result;
  let moved = 0;
  for (let index = 0; index < output.length; index++) if (output[index] !== oldOrder[index]) moved++;
  return {
    ...result,
    order:output,
    rail,
    colorSerpentineMoved:moved,
    algorithm:`${result.algorithm || 'ai-sort'}+color-serpentine-v1`
  };
}

async function sort(data) {
  const mode = String(data.payload?.mode || 'flow');
  if (mode === 'families') {
    const familyResult = await callWorker(FAMILY_WORKER, data);
    return cleanFamilyResult(familyResult);
  }

  let familyResult = null;
  if (MULTIMODAL_MODES.has(mode)) {
    familyResult = await callWorker(FAMILY_WORKER, { action:'sort', payload:{ ...(data.payload || {}), mode:'families' } }, 'Families · ');
    if (canceled) throw abortError();
  }

  const base = await callWorker(BASE_WORKER, data);
  if (canceled || !familyResult) return base;

  self.postMessage({
    type:'progress',
    done:Array.isArray(data.payload?.media) ? data.payload.media.length : 1,
    total:Array.isArray(data.payload?.media) ? data.payload.media.length : 1,
    detail:`Locking multimodal families into ${mode}…`,
    stage:'multimodal-lock'
  });
  let result = consolidateFamilies(base, familyResult, Array.isArray(data.payload?.media) ? data.payload.media : [], mode);
  if (mode === 'color') {
    self.postMessage({
      type:'progress',
      done:Array.isArray(data.payload?.media) ? data.payload.media.length : 1,
      total:Array.isArray(data.payload?.media) ? data.payload.media.length : 1,
      detail:'Smoothing brightness across color transitions…',
      stage:'color-flow'
    });
    result = await applyColorSerpentine(result, familyResult, Array.isArray(data.payload?.media) ? data.payload.media : []);
  }
  self.postMessage({
    type:'progress',
    done:Array.isArray(data.payload?.media) ? data.payload.media.length : 1,
    total:Array.isArray(data.payload?.media) ? data.payload.media.length : 1,
    detail:`${mode[0].toUpperCase() + mode.slice(1)} · ${(Number(result.multimodalFamilies) || 0).toLocaleString()} multimodal families · ${(Number(result.multimodalLocked) || 0).toLocaleString()} media locked`,
    stage:'multimodal-lock'
  });
  return result;
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.action === 'cancel') {
    stopAll();
    return;
  }
  if (data.action !== 'sort') return;
  canceled = false;
  try {
    const result = await sort(data);
    if (!canceled) self.postMessage({ type:'result', result });
  } catch (error) {
    if (canceled || error?.name === 'AbortError') {
      self.postMessage({ type:'error', error:'Canceled', aborted:true });
      return;
    }
    self.postMessage({ type:'error', error:String(error?.message || error) });
  }
};

self.postMessage({ type:'progress', done:0, total:1, detail:'Neighborhood AI sorter ready…', stage:'startup' });