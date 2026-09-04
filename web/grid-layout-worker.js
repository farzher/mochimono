const CATALOG_DB = 'mochimono-library';
const CATALOG_META_KEY = 'catalog';
const THUMB_CHECK_LIMIT = 500;
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['m4v','mp4','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);

const sessions = new Map();

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

function openCatalog() {
  return new Promise(resolve => {
    let request;
    try { request = indexedDB.open(CATALOG_DB); }
    catch { return resolve(null); }
    request.onupgradeneeded = () => {
      try { request.transaction?.abort(); } catch {}
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function loadCatalog(version = '') {
  const db = await openCatalog();
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains('meta') || !db.objectStoreNames.contains('files')) return null;
    const transaction = db.transaction(['meta','files'], 'readonly');
    const done = transactionDone(transaction);
    const [meta, all] = await Promise.all([
      requestResult(transaction.objectStore('meta').get(CATALOG_META_KEY)),
      requestResult(transaction.objectStore('files').getAll())
    ]);
    await done;
    const wanted = String(version || meta?.version || '');
    if (!wanted || !meta?.version || String(meta.version) !== wanted) return null;
    const files = all.filter(file => file?.__snapshot === wanted);
    if (files.length !== Number(meta.count || 0)) return null;
    return { version: wanted, files };
  } finally {
    try { db.close(); } catch {}
  }
}

function extension(name) {
  return String(name || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
}

function kind(file) {
  const base = String(file?.mime || '').split('/')[0];
  if (base && base !== 'application') return base;
  const ext = extension(file?.filename);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return base || 'other';
}

function matchesType(file, wanted) {
  const value = kind(file);
  if (wanted === 'image' || wanted === 'video') return value === wanted;
  return wanted === 'media' ? value === 'image' || value === 'video' : false;
}

function matchesLocation(file, location) {
  if (!location || location === 'server') return true;
  if (location === 'backup') return Number(file.backupCount) > 0;
  if (location === 'unbacked') return Number(file.backupCount) === 0;
  return false;
}

function timelineMs(file, sort) {
  if (sort === 'date-added') return Number(file.addedMs) || Number(file.dateMs) || Date.parse(file.addedAt || file.createdAt || 0) || 0;
  return Number(file.dateMs) || Date.parse(file.fileDate || file.createdAt || 0) || 0;
}

function filterAndSort(files, config) {
  const sourceId = Number(config.sourceId) || 0;
  const wanted = String(config.type || 'media');
  const location = String(config.locationFilter || '');
  const result = files.filter(file => {
    if (!matchesType(file, wanted) || !matchesLocation(file, location)) return false;
    if (sourceId) {
      const ids = Array.isArray(file.importIds) ? file.importIds.map(Number) : String(file.importIds || '').split(',').map(Number);
      if (!ids.includes(sourceId)) return false;
    }
    return true;
  });

  if (config.sort === 'date-added') result.sort((a, b) => timelineMs(b, config.sort) - timelineMs(a, config.sort) || String(a.hash).localeCompare(String(b.hash)));
  else if (config.sort === 'date-asc') result.sort((a, b) => timelineMs(a, config.sort) - timelineMs(b, config.sort) || String(a.hash).localeCompare(String(b.hash)));
  else if (config.sort === 'size-desc') result.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || String(a.filename || '').localeCompare(String(b.filename || '')));
  else result.sort((a, b) => timelineMs(b, config.sort) - timelineMs(a, config.sort) || String(a.hash).localeCompare(String(b.hash)));
  return result;
}

async function resolveThumbnailGeometry(files) {
  const missing = files.filter(file => !(Number(file.width) > 0 && Number(file.height) > 0)).map(file => String(file.hash || '')).filter(Boolean);
  if (!missing.length) return { unresolved: 0, learned: [] };
  const byHash = new Map(files.map(file => [String(file.hash || ''), file]));
  const learned = [];
  let unresolved = 0;

  for (let offset = 0; offset < missing.length; offset += THUMB_CHECK_LIMIT) {
    const hashes = missing.slice(offset, offset + THUMB_CHECK_LIMIT);
    try {
      const response = await fetch('/api/thumbs/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hashes })
      });
      if (!response.ok) throw new Error(`thumbnail check ${response.status}`);
      const data = await response.json();
      const ready = new Set();
      for (const item of data.thumbnails || []) {
        const hash = String(item.hash || '');
        const width = Number(item.width) || 0;
        const height = Number(item.height) || 0;
        const file = byHash.get(hash);
        if (!file || !width || !height) continue;
        ready.add(hash);
        file.width = width;
        file.height = height;
        learned.push([hash, width, height]);
      }
      unresolved += hashes.length - ready.size;
    } catch {
      unresolved += hashes.length;
    }
  }
  return { unresolved, learned };
}

function ratio(file) {
  const width = Number(file.width) || 0;
  const height = Number(file.height) || 0;
  return width && height ? Math.max(.65, Math.min(2.1, width / height)) : 4 / 3;
}

function dateParts(ms) {
  const date = new Date(Number(ms) || 0);
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

function layoutFiles(files, config) {
  const width = Math.max(200, Number(config.width) || 1000);
  const target = Math.max(72, Number(config.target) || 170);
  const gap = Math.max(0, Number(config.gap) || 4);
  const grouped = String(config.sort || '').startsWith('date-');
  const GROUP_GAP = 24;
  const YEAR_HEIGHT = 31;
  const MONTH_HEIGHT = 27;
  const FLAT_TOP = 16;

  const rowStarts = [];
  const rowCounts = [];
  const rowTops = [];
  const rowHeights = [];
  const itemRows = new Uint32Array(files.length);
  const itemX = new Float32Array(files.length);
  const itemW = new Float32Array(files.length);
  const headers = [];
  const dayStarts = [];
  let y = grouped ? 0 : FLAT_TOP;
  let previousYear = null;
  let previousDayKey = '';

  function finishRow(start, end, fill) {
    const count = end - start;
    if (!count) return;
    let sum = 0;
    for (let index = start; index < end; index++) sum += ratio(files[index]);
    const filledHeight = (width - gap * (count - 1)) / Math.max(.001, sum);
    const height = fill && count > 1 ? Math.min(filledHeight, target * 1.42) : target;
    const row = rowStarts.length;
    rowStarts.push(start);
    rowCounts.push(count);
    rowTops.push(y);
    rowHeights.push(height);
    let x = 0;
    for (let index = start; index < end; index++) {
      const w = ratio(files[index]) * height;
      itemRows[index] = row;
      itemX[index] = x;
      itemW[index] = w;
      const parts = dateParts(timelineMs(files[index], config.sort));
      const dayKey = `${parts.year}-${parts.month + 1}-${parts.day}`;
      if (grouped && dayKey !== previousDayKey) {
        dayStarts.push({ index, row, x, top: y, year: parts.year, month: parts.month, day: parts.day });
        previousDayKey = dayKey;
      }
      x += w + gap;
    }
    y += height + gap;
  }

  function layoutRange(start, end) {
    let rowStart = start;
    let ratioSum = 0;
    for (let index = start; index < end; index++) {
      const nextRatio = ratio(files[index]);
      const count = index - rowStart;
      const nextWidth = (ratioSum + nextRatio) * target + gap * count;
      if (count && nextWidth >= width) {
        const currentWidth = ratioSum * target + gap * (count - 1);
        if (Math.abs(width - currentWidth) < Math.abs(nextWidth - width)) {
          finishRow(rowStart, index, true);
          rowStart = index;
          ratioSum = nextRatio;
          continue;
        }
        ratioSum += nextRatio;
        finishRow(rowStart, index + 1, true);
        rowStart = index + 1;
        ratioSum = 0;
        continue;
      }
      ratioSum += nextRatio;
    }
    if (rowStart < end) {
      const count = end - rowStart;
      let sum = 0;
      for (let index = rowStart; index < end; index++) sum += ratio(files[index]);
      const filledHeight = (width - gap * (count - 1)) / Math.max(.001, sum);
      const fill = count >= 2 && filledHeight <= target * 1.42;
      finishRow(rowStart, end, fill);
    }
  }

  if (grouped) {
    let start = 0;
    while (start < files.length) {
      const first = dateParts(timelineMs(files[start], config.sort));
      let end = start + 1;
      while (end < files.length) {
        const next = dateParts(timelineMs(files[end], config.sort));
        if (next.year !== first.year || next.month !== first.month) break;
        end++;
      }
      y += GROUP_GAP;
      if (first.year !== previousYear) {
        headers.push({ kind: 'year', year: first.year, month: first.month, top: y });
        y += YEAR_HEIGHT;
        previousYear = first.year;
      }
      headers.push({ kind: 'month', year: first.year, month: first.month, top: y });
      y += MONTH_HEIGHT;
      layoutRange(start, end);
      start = end;
    }
  } else {
    layoutRange(0, files.length);
  }

  if (rowStarts.length) y -= gap;
  y += 20;

  return {
    totalHeight: Math.max(1, y),
    rowStarts: Uint32Array.from(rowStarts),
    rowCounts: Uint16Array.from(rowCounts),
    rowTops: Float32Array.from(rowTops),
    rowHeights: Float32Array.from(rowHeights),
    itemRows,
    itemX,
    itemW,
    headers,
    dayStarts
  };
}

async function build(message) {
  const generation = Number(message.generation) || 0;
  const config = message.config || {};
  const snapshot = await loadCatalog(config.version);
  if (!snapshot) {
    postMessage({ type: 'unavailable', generation });
    return;
  }
  const files = filterAndSort(snapshot.files, config);
  const { unresolved, learned } = await resolveThumbnailGeometry(files);
  const geometry = layoutFiles(files, config);
  const hashIndex = new Map(files.map((file, index) => [String(file.hash || ''), index]));
  sessions.set(generation, { generation, files, config: { ...config, version: snapshot.version }, layout: geometry, hashIndex });
  while (sessions.size > 2) sessions.delete(sessions.keys().next().value);

  const rowStarts = geometry.rowStarts.slice();
  const rowCounts = geometry.rowCounts.slice();
  const rowTops = geometry.rowTops.slice();
  const rowHeights = geometry.rowHeights.slice();
  const itemRows = geometry.itemRows.slice();
  postMessage({
    type: 'ready',
    generation,
    version: snapshot.version,
    count: files.length,
    unresolved,
    learned,
    totalHeight: geometry.totalHeight,
    rowStarts,
    rowCounts,
    rowTops,
    rowHeights,
    itemRows,
    headers: geometry.headers,
    dayStarts: geometry.dayStarts,
    firstHashes: files.slice(0, 8).map(file => file.hash),
    lastHashes: files.slice(-8).map(file => file.hash)
  }, [rowStarts.buffer, rowCounts.buffer, rowTops.buffer, rowHeights.buffer, itemRows.buffer]);
}

function rowPayload(current, rowId) {
  if (!current?.layout) return null;
  const row = Number(rowId);
  if (!Number.isInteger(row) || row < 0 || row >= current.layout.rowStarts.length) return null;
  const start = current.layout.rowStarts[row];
  const count = current.layout.rowCounts[row];
  const items = [];
  for (let index = start; index < start + count; index++) {
    const file = current.files[index];
    items.push({
      index,
      x: current.layout.itemX[index],
      width: current.layout.itemW[index],
      hash: String(file.hash || ''),
      filename: String(file.filename || ''),
      mime: String(file.mime || ''),
      kind: kind(file),
      sourceWidth: Number(file.width) || 0,
      sourceHeight: Number(file.height) || 0,
      dateMs: timelineMs(file, current.config.sort),
      size: Number(file.size) || 0
    });
  }
  return { row, top: current.layout.rowTops[row], height: current.layout.rowHeights[row], items };
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'build') {
    build(message).catch(error => postMessage({ type: 'error', generation: message.generation, message: String(error?.message || error) }));
    return;
  }
  const current = sessions.get(Number(message.generation));
  if (!current) return;
  if (message.type === 'rows') {
    const rows = (message.rows || []).map(row => rowPayload(current, row)).filter(Boolean);
    postMessage({ type: 'rows', generation: current.generation, requestId: message.requestId, rows });
    return;
  }
  if (message.type === 'locate') {
    const index = current.hashIndex.get(String(message.hash || ''));
    postMessage({ type: 'located', generation: current.generation, requestId: message.requestId, index: Number.isInteger(index) ? index : -1 });
  }
};