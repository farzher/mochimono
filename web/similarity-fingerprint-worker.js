const DB_NAME = 'mochimono-visual-similarity';
const DB_VERSION = 1;
const STORE = 'fingerprints';
const VERSION = 'phash16-dct8-v1';
const THUMB_VERSION = 3;
const SAMPLE = 16;
const LOW = 8;
const BATCH = 16;

const COS = Array.from({ length:LOW }, (_, u) =>
  Array.from({ length:SAMPLE }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / (2 * SAMPLE)))
);
const SCALE = Array.from({ length:LOW }, (_, u) => u === 0 ? Math.sqrt(1 / SAMPLE) : Math.sqrt(2 / SAMPLE));

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
    tx.onabort = () => reject(tx.error || new Error('Could not cache similarity fingerprints'));
  }).finally(() => db.close());
}

function pHash(data) {
  const gray = new Float64Array(SAMPLE * SAMPLE);
  for (let pixel = 0, index = 0; index < gray.length; index++, pixel += 4) {
    gray[index] = data[pixel] * .299 + data[pixel + 1] * .587 + data[pixel + 2] * .114;
  }

  const horizontal = new Float64Array(SAMPLE * LOW);
  for (let y = 0; y < SAMPLE; y++) for (let u = 0; u < LOW; u++) {
    let sum = 0;
    for (let x = 0; x < SAMPLE; x++) sum += gray[y * SAMPLE + x] * COS[u][x];
    horizontal[y * LOW + u] = sum * SCALE[u];
  }

  const low = new Float64Array(LOW * LOW);
  for (let v = 0; v < LOW; v++) for (let u = 0; u < LOW; u++) {
    let sum = 0;
    for (let y = 0; y < SAMPLE; y++) sum += horizontal[y * LOW + u] * COS[v][y];
    low[v * LOW + u] = sum * SCALE[v];
  }

  const values = [...low.slice(1)].sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) {
      const index = nibble * 4 + bit;
      if (index && low[index] > median) value |= 1 << (3 - bit);
    }
    hex += value.toString(16);
  }
  return hex;
}

async function fingerprint(hash) {
  const response = await fetch(`/api/thumbs/${hash}?v=${THUMB_VERSION}`, { cache:'force-cache' });
  if (!response.ok) return '';
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(SAMPLE, SAMPLE);
    const context = canvas.getContext('2d', { willReadFrequently:true, alpha:false });
    context.drawImage(bitmap, 0, 0, SAMPLE, SAMPLE);
    return pHash(context.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } finally { bitmap.close?.(); }
}

async function build(hashes) {
  const rows = await loadRows();
  const missing = hashes.filter(hash => {
    const row = rows.get(hash);
    return !(row?.version === VERSION && /^[0-9a-f]{16}$/.test(String(row.value || '')));
  });
  let done = hashes.length - missing.length;
  postMessage({ type:'progress', done, total:hashes.length });

  for (let offset = 0; offset < missing.length; offset += BATCH) {
    const chunk = missing.slice(offset, offset + BATCH);
    const values = await Promise.all(chunk.map(async hash => {
      try { return [hash, await fingerprint(hash)]; }
      catch { return [hash, '']; }
    }));
    const writes = [];
    for (const [hash, value] of values) {
      if (!/^[0-9a-f]{16}$/.test(value)) continue;
      const row = { ...(rows.get(hash) || {}), hash, value, version:VERSION, updatedAt:Date.now() };
      rows.set(hash, row);
      writes.push(row);
    }
    try { await saveRows(writes); } catch {}
    done += chunk.length;
    postMessage({ type:'progress', done, total:hashes.length });
  }
  return { total:hashes.length, indexed:missing.length };
}

self.onmessage = async event => {
  try {
    const hashes = [...new Set((event.data?.hashes || []).map(String).filter(hash => /^[a-f0-9]{64}$/.test(hash)))];
    const result = await build(hashes);
    postMessage({ type:'ready', result });
  } catch (error) {
    postMessage({ type:'error', error:error?.message || String(error) });
  }
};