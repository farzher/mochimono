const run = new URL(self.location.href).searchParams.get('run') || Date.now().toString(36);
const BASE_WORKER = './ai-global-sort-worker-v6.js';
const FAMILY_WORKER = './ai-global-multimodal-worker.js';
const MULTIMODAL_MODES = new Set(['flow','color','structure','hybrid','topics','moments']);
const SECTION_MODES = new Set(['color','structure','topics']);
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
  const result = consolidateFamilies(base, familyResult, Array.isArray(data.payload?.media) ? data.payload.media : [], mode);
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
