const CATALOG_DB = 'mochimono-library';
const CATALOG_META_KEY = 'catalog';
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['m4v','mp4','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);

const sessions = new Map();
let latestBuildGeneration = 0;

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
    return { version:wanted, files };
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
    if (!sourceId) return true;
    const ids = Array.isArray(file.importIds)
      ? file.importIds.map(Number)
      : String(file.importIds || '').split(',').map(Number);
    return ids.includes(sourceId);
  });

  if (config.sort === 'date-added') {
    result.sort((a, b) => timelineMs(b, config.sort) - timelineMs(a, config.sort) || String(a.hash).localeCompare(String(b.hash)));
  } else if (config.sort === 'date-asc') {
    result.sort((a, b) => timelineMs(a, config.sort) - timelineMs(b, config.sort) || String(a.hash).localeCompare(String(b.hash)));
  } else if (config.sort === 'size-desc') {
    result.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || String(a.filename || '').localeCompare(String(b.filename || '')));
  } else {
    result.sort((a, b) => timelineMs(b, config.sort) - timelineMs(a, config.sort) || String(a.hash).localeCompare(String(b.hash)));
  }
  return result;
}

function ratio(file) {
  const width = Number(file.width) || 0;
  const height = Number(file.height) || 0;
  return width && height ? Math.max(.65, Math.min(2.1, width / height)) : 4 / 3;
}

function dateParts(ms) {
  const date = new Date(Number(ms) || 0);
  return { year:date.getFullYear(), month:date.getMonth(), day:date.getDate() };
}

function layoutFiles(files, config) {
  const width = Math.max(200, Number(config.width) || 1000);
  const target = Math.max(72, Number(config.target) || 170);
  const gap = Math.max(0, Number(config.gap) || 4);
  const grouped = String(config.sort || '').startsWith('date-');
  const MAX_ROW_HEIGHT = target * 1.28;
  const LAST_ROW_FILL_MAX = target * 1.16;
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

  function idealHeight(start, end) {
    const count = end - start;
    let sum = 0;
    for (let index = start; index < end; index++) sum += ratio(files[index]);
    return (width - gap * Math.max(0, count - 1)) / Math.max(.001, sum);
  }

  function finishRow(start, end, fill) {
    const count = end - start;
    if (!count) return;
    const ideal = idealHeight(start, end);
    const naturalAtTarget = files.slice(start, end).reduce((sum, file) => sum + ratio(file) * target, 0) + gap * Math.max(0, count - 1);
    const height = fill
      ? ideal
      : naturalAtTarget > width ? Math.min(target, ideal) : target;
    const safeHeight = Math.max(1, Math.min(MAX_ROW_HEIGHT, height));
    const row = rowStarts.length;
    rowStarts.push(start);
    rowCounts.push(count);
    rowTops.push(y);
    rowHeights.push(safeHeight);

    let x = 0;
    for (let index = start; index < end; index++) {
      const isLast = index === end - 1;
      const naturalWidth = ratio(files[index]) * safeHeight;
      const remaining = Math.max(1, width - x);
      const itemWidth = fill && isLast ? remaining : Math.min(naturalWidth, remaining);
      itemRows[index] = row;
      itemX[index] = x;
      itemW[index] = itemWidth;

      const parts = dateParts(timelineMs(files[index], config.sort));
      const dayKey = `${parts.year}-${parts.month + 1}-${parts.day}`;
      if (grouped && dayKey !== previousDayKey) {
        dayStarts.push({ index, row, x, top:y, year:parts.year, month:parts.month, day:parts.day });
        previousDayKey = dayKey;
      }
      x += itemWidth + gap;
    }
    y += safeHeight + gap;
  }

  function chooseFullRowEnd(start, end) {
    let sum = 0;
    let previousHeight = Infinity;
    for (let index = start; index < end; index++) {
      const nextRatio = ratio(files[index]);
      sum += nextRatio;
      const count = index - start + 1;
      const height = (width - gap * Math.max(0, count - 1)) / Math.max(.001, sum);
      if (count >= 2 && height <= target) {
        if (count > 2 && previousHeight <= MAX_ROW_HEIGHT && Math.abs(previousHeight - target) < Math.abs(height - target)) return index;
        return index + 1;
      }
      previousHeight = height;
    }
    return end;
  }

  function layoutRange(start, end) {
    let rowStart = start;
    while (rowStart < end) {
      const rowEnd = chooseFullRowEnd(rowStart, end);
      if (rowEnd >= end) {
        const count = end - rowStart;
        const ideal = idealHeight(rowStart, end);
        const fillLast = count >= 2 && ideal >= target && ideal <= LAST_ROW_FILL_MAX;
        finishRow(rowStart, end, fillLast);
        break;
      }
      finishRow(rowStart, rowEnd, true);
      rowStart = rowEnd;
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
        headers.push({ kind:'year', year:first.year, month:first.month, top:y });
        y += YEAR_HEIGHT;
        previousYear = first.year;
      }
      headers.push({ kind:'month', year:first.year, month:first.month, top:y });
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
    totalHeight:Math.max(1, y),
    rowStarts:Uint32Array.from(rowStarts),
    rowCounts:Uint16Array.from(rowCounts),
    rowTops:Float32Array.from(rowTops),
    rowHeights:Float32Array.from(rowHeights),
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
  if (generation !== latestBuildGeneration) return;
  if (!snapshot) {
    postMessage({ type:'unavailable', generation });
    return;
  }

  const files = filterAndSort(snapshot.files, config);
  if (generation !== latestBuildGeneration) return;
  const geometry = layoutFiles(files, config);
  if (generation !== latestBuildGeneration) return;

  const hashIndex = new Map(files.map((file, index) => [String(file.hash || ''), index]));
  sessions.set(generation, {
    generation,
    files,
    config:{ ...config, version:snapshot.version },
    layout:geometry,
    hashIndex
  });
  while (sessions.size > 4) sessions.delete(sessions.keys().next().value);

  const rowStarts = geometry.rowStarts.slice();
  const rowCounts = geometry.rowCounts.slice();
  const rowTops = geometry.rowTops.slice();
  const rowHeights = geometry.rowHeights.slice();
  const itemRows = geometry.itemRows.slice();

  postMessage({
    type:'ready',
    generation,
    version:snapshot.version,
    count:files.length,
    totalHeight:geometry.totalHeight,
    rowStarts,
    rowCounts,
    rowTops,
    rowHeights,
    itemRows,
    headers:geometry.headers,
    dayStarts:geometry.dayStarts
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
      x:current.layout.itemX[index],
      width:current.layout.itemW[index],
      hash:String(file.hash || ''),
      filename:String(file.filename || ''),
      mime:String(file.mime || ''),
      kind:kind(file),
      sourceWidth:Number(file.width) || 0,
      sourceHeight:Number(file.height) || 0,
      dateMs:timelineMs(file, current.config.sort),
      size:Number(file.size) || 0
    });
  }

  return {
    row,
    top:current.layout.rowTops[row],
    height:current.layout.rowHeights[row],
    items
  };
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'build') {
    latestBuildGeneration = Number(message.generation) || 0;
    build(message).catch(error => {
      if (Number(message.generation) !== latestBuildGeneration) return;
      postMessage({ type:'error', generation:message.generation, message:String(error?.message || error) });
    });
    return;
  }

  const current = sessions.get(Number(message.generation));
  if (!current) return;
  if (message.type === 'rows') {
    const rows = (message.rows || []).map(row => rowPayload(current, row)).filter(Boolean);
    postMessage({ type:'rows', generation:current.generation, requestId:message.requestId, rows });
    return;
  }
  if (message.type === 'locate') {
    const index = current.hashIndex.get(String(message.hash || ''));
    postMessage({ type:'located', generation:current.generation, requestId:message.requestId, index:Number.isInteger(index) ? index : -1 });
  }
};
