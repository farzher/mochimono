let canceled = false;
const children = new Set();
const HASH_RE = /^[a-f0-9]{64}$/;
const FAMILY_WORKER = './ai-family-engine-worker.js';
const FLOW_WORKER = './ai-global-sort-worker-v6.js';
const BASE_LAYOUT_WORKER = './experimental-layout-worker-v1.js';
const REV = 'shared-family-v1';

const post = (type, payload = {}) => self.postMessage({ type, ...payload });
const abort = () => { if (canceled) throw new DOMException('Aborted', 'AbortError'); };

function callWorker(path, message, prefix = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(path, import.meta.url);
    url.searchParams.set('v', REV);
    const worker = new Worker(url, { type:'module' });
    children.add(worker);
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      children.delete(worker);
      try { worker.terminate(); } catch {}
      fn(value);
    };
    worker.onerror = event => finish(reject, new Error(event.message || 'Experimental child worker failed'));
    worker.onmessageerror = () => finish(reject, new Error('Experimental child worker returned unreadable data'));
    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'progress') {
        post('progress', { ...data, detail:prefix && data.detail ? `${prefix}${data.detail}` : data.detail });
        return;
      }
      if (data.type === 'error') {
        const error = new Error(data.error || 'Experimental child worker failed');
        if (data.aborted) error.name = 'AbortError';
        finish(reject, error);
        return;
      }
      if (data.type === 'result') finish(resolve, data.result || {});
    };
    worker.postMessage(message);
  });
}

function groupsFromIds(ids, count) {
  const grouped = new Map();
  if (!ids?.length) return [];
  for (let index = 0; index < Math.min(count, ids.length); index++) {
    const id = Number(ids[index]);
    if (id < 0) continue;
    let group = grouped.get(id);
    if (!group) grouped.set(id, group = []);
    group.push(index);
  }
  return [...grouped.values()].filter(group => group.length > 1);
}

function basePositions(order, count) {
  const positions = new Int32Array(count);
  positions.fill(1e9);
  for (let position = 0; position < order.length; position++) {
    const index = Number(order[position]);
    if (index >= 0 && index < count) positions[index] = position;
  }
  for (let index = 0; index < count; index++) if (positions[index] === 1e9) positions[index] = order.length + index;
  return positions;
}

function consolidateGrid(result, familyResult, media) {
  const original = Array.from(result?.order || [], Number);
  if (original.length !== media.length) return result;
  const groups = groupsFromIds(familyResult?.familyIds, media.length);
  if (!groups.length) return { ...result, detail:`${result.detail || 'Experimental grid'} · shared families ready` };
  const positions = basePositions(original, media.length);
  const groupOf = new Int32Array(media.length); groupOf.fill(-1);
  groups.forEach((group, id) => group.forEach(index => { groupOf[index] = id; }));
  const seen = new Uint8Array(groups.length);
  const output = [];
  for (const item of original) {
    const id = groupOf[item];
    if (id < 0) { output.push(item); continue; }
    if (seen[id]) continue;
    seen[id] = 1;
    output.push(...groups[id].slice().sort((a, b) => positions[a] - positions[b] || a - b));
  }
  return {
    ...result,
    order:Uint32Array.from(output),
    detail:`${result.detail || 'Experimental grid'} · ${groups.length.toLocaleString()} shared families locked`
  };
}

function familyQuilt(media, familyResult) {
  const groups = groupsFromIds(familyResult?.familyIds, media.length);
  const byHash = new Map(media.map((item, index) => [String(item.hash), index]));
  const positions = new Int32Array(media.length); positions.fill(1e9);
  const familyOrder = Array.isArray(familyResult?.order) ? familyResult.order : [];
  for (let position = 0; position < familyOrder.length; position++) {
    const index = byHash.get(String(familyOrder[position]));
    if (index != null) positions[index] = position;
  }
  for (let index = 0; index < media.length; index++) if (positions[index] === 1e9) positions[index] = familyOrder.length + index;

  for (const group of groups) group.sort((a, b) => positions[a] - positions[b] || a - b);
  groups.sort((a, b) => positions[a[Math.floor(a.length / 2)]] - positions[b[Math.floor(b.length / 2)]] || b.length - a.length || a[0] - b[0]);
  const grouped = new Uint8Array(media.length);
  for (const group of groups) for (const index of group) grouped[index] = 1;
  const singles = Array.from({ length:media.length }, (_, index) => index).filter(index => !grouped[index]).sort((a, b) => positions[a] - positions[b] || a - b);

  const worldW = Math.max(18, Math.ceil(Math.sqrt(media.length * 1.55)));
  const x = new Float32Array(media.length), y = new Float32Array(media.length), renderW = new Float32Array(media.length), renderH = new Float32Array(media.length), labels = [];
  x.fill(-1); y.fill(-1); renderW.fill(1); renderH.fill(1);
  let px = 0, py = 0, rowH = 0;
  const place = (members, label = '') => {
    const width = Math.min(worldW, Math.max(1, Math.ceil(Math.sqrt(members.length * 1.4))));
    const height = Math.max(1, Math.ceil(members.length / width));
    if (px && px + width > worldW) { px = 0; py += rowH + 1; rowH = 0; }
    const ox = px, oy = py;
    for (let position = 0; position < members.length; position++) {
      x[members[position]] = ox + (position % width);
      y[members[position]] = oy + Math.floor(position / width);
    }
    if (label) labels.push({ x:ox, y:oy, w:width, h:height, label });
    px += width + 1;
    rowH = Math.max(rowH, height);
  };
  for (const group of groups) place(group, group.length >= 3 ? `Family · ${group.length}` : '');
  if (singles.length) {
    if (px) { px = 0; py += rowH + 1; rowH = 0; }
    const height = Math.ceil(singles.length / worldW);
    for (let position = 0; position < singles.length; position++) {
      x[singles[position]] = position % worldW;
      y[singles[position]] = py + Math.floor(position / worldW);
    }
    labels.push({ x:0, y:py, w:worldW, h:height, label:'Singles' });
    py += height;
  }
  return {
    kind:'map', x, y, renderW, renderH, worldW, worldH:Math.max(1, py + rowH + 1), labels,
    skipDensify:true,
    detail:`Family Quilt · ${groups.length.toLocaleString()} shared families`
  };
}

function rectangleFree(used, x, y, width, height, worldW, worldH) {
  if (x < 0 || y < 0 || x + width > worldW || y + height > worldH) return false;
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) if (used[yy * worldW + xx]) return false;
  return true;
}
function occupy(used, x, y, width, height, worldW) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) used[yy * worldW + xx] = 1;
}

function compactMap(result, familyResult, media) {
  if (!result?.x?.length || !result?.y?.length) return result;
  const groups = groupsFromIds(familyResult?.familyIds, media.length);
  const grouped = new Uint8Array(media.length);
  for (const group of groups) for (const index of group) grouped[index] = 1;
  const units = [...groups, ...Array.from({ length:media.length }, (_, index) => index).filter(index => !grouped[index]).map(index => [index])];

  let worldW = Math.max(1, Math.ceil(Number(result.worldW) || 1));
  let worldH = Math.max(1, Math.ceil(Number(result.worldH) || 1));
  const metas = units.map((group, id) => {
    let x = 0, y = 0, count = 0;
    for (const index of group) {
      const px = Number(result.x[index]), py = Number(result.y[index]);
      if (Number.isFinite(px) && Number.isFinite(py) && px >= 0 && py >= 0) { x += px; y += py; count++; }
    }
    return { id, group, cx:count ? x / count : worldW / 2, cy:count ? y / count : worldH / 2 };
  }).sort((a, b) => b.group.length - a.group.length || a.cy - b.cy || a.cx - b.cx);

  const extra = Math.max(8, Math.ceil(Math.sqrt(media.length) * .08));
  worldW += extra; worldH += extra;
  let used = new Uint8Array(worldW * worldH);
  const xout = new Float32Array(media.length), yout = new Float32Array(media.length);
  xout.fill(-1); yout.fill(-1);
  for (const meta of metas) {
    abort();
    const size = meta.group.length;
    const width = Math.max(1, Math.ceil(Math.sqrt(size * 1.3)));
    const height = Math.max(1, Math.ceil(size / width));
    const wantedX = Math.round(meta.cx - width / 2), wantedY = Math.round(meta.cy - height / 2);
    let found = null;
    for (let radius = 0; radius <= Math.max(worldW, worldH) && !found; radius++) {
      const tests = radius === 0 ? [[wantedX, wantedY]] : [[wantedX-radius,wantedY-radius],[wantedX,wantedY-radius],[wantedX+radius,wantedY-radius],[wantedX+radius,wantedY],[wantedX+radius,wantedY+radius],[wantedX,wantedY+radius],[wantedX-radius,wantedY+radius],[wantedX-radius,wantedY]];
      for (const [x, y] of tests) if (rectangleFree(used, x, y, width, height, worldW, worldH)) { found = [x, y]; break; }
    }
    if (!found) {
      const oldHeight = worldH;
      worldH += height + 2;
      const next = new Uint8Array(worldW * worldH); next.set(used); used = next;
      found = [0, oldHeight + 1];
    }
    const [x, y] = found;
    occupy(used, x, y, width, height, worldW);
    const members = meta.group.slice().sort((a, b) => Number(result.y[a]) - Number(result.y[b]) || Number(result.x[a]) - Number(result.x[b]) || a - b);
    for (let position = 0; position < members.length; position++) {
      xout[members[position]] = x + (position % width);
      yout[members[position]] = y + Math.floor(position / width);
    }
  }
  return {
    ...result,
    x:xout, y:yout, worldW, worldH, preserveRows:true,
    detail:`${result.detail || 'Experimental map'} · ${groups.length.toLocaleString()} shared families locked`
  };
}

async function mosaic(media, columns, familyResult) {
  const flow = await callWorker(FLOW_WORKER, { action:'sort', payload:{ mode:'flow', media } }, 'Mosaic · ');
  abort();
  const byHash = new Map(media.map((item, index) => [String(item.hash), index]));
  const order = (flow.order || []).map(hash => byHash.get(String(hash))).filter(Number.isInteger);
  const seen = new Uint8Array(media.length);
  for (const index of order) seen[index] = 1;
  for (let index = 0; index < media.length; index++) if (!seen[index]) order.push(index);
  return consolidateGrid({ kind:'grid', order:Uint32Array.from(order), detail:`2D Mosaic · ${Math.max(2, Number(columns) || 8)} columns` }, familyResult, media);
}

async function baseMap(payload, familyResult, media) {
  const base = await callWorker(BASE_LAYOUT_WORKER, { action:'build', payload }, 'Layout · ');
  abort();
  return compactMap(base, familyResult, media);
}

async function build(payload) {
  const mode = String(payload?.mode || 'mosaic');
  const media = (Array.isArray(payload?.media) ? payload.media : []).filter(item => HASH_RE.test(String(item?.hash || '')));
  if (!media.length) return { kind:'grid', order:new Uint32Array(), detail:'No media' };
  const familyResult = await callWorker(FAMILY_WORKER, { action:'build', payload:{ media } }, 'Families · ');
  abort();
  post('progress', { done:media.length, total:media.length, detail:`Building ${mode.replaceAll('-', ' ')} with shared families…`, stage:'layout' });
  if (mode === 'mosaic') return mosaic(media, payload.columns, familyResult);
  if (mode === 'family-quilt') return familyQuilt(media, familyResult);
  if (mode === 'atlas' || mode === 'time-appearance') return baseMap({ ...payload, media }, familyResult, media);
  throw new Error(`Unknown experimental layout: ${mode}`);
}

self.onmessage = async event => {
  const data = event.data || {};
  if (data.action === 'cancel') {
    canceled = true;
    for (const worker of children) { try { worker.postMessage({ action:'cancel' }); } catch {} try { worker.terminate(); } catch {} }
    children.clear();
    return;
  }
  if (data.action !== 'build') return;
  canceled = false;
  try {
    const result = await build(data.payload || {});
    abort();
    const transfer = [];
    for (const key of ['order','x','y','renderW','renderH']) if (result[key]?.buffer) transfer.push(result[key].buffer);
    self.postMessage({ type:'result', result }, transfer);
  } catch (error) {
    post('error', { error:error?.name === 'AbortError' ? 'Canceled' : String(error?.message || error), aborted:error?.name === 'AbortError' });
  } finally {
    for (const worker of children) { try { worker.terminate(); } catch {} }
    children.clear();
  }
};
