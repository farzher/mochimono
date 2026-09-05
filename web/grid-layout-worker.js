const CATALOG_DB = 'mochimono-library';
const CATALOG_META_KEY = 'catalog';
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','gif','webp','heic','heif','avif','bmp','tif','tiff']);
const VIDEO_EXTENSIONS = new Set(['m4v','mp4','mov','mkv','webm','avi','mpg','mpeg','m2v','mts','m2ts','3gp']);

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

async function loadCachedCatalog() {
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
    const version = String(meta?.version || '');
    if (!version) return null;
    const files = all.filter(file => file?.__snapshot === version);
    if (files.length !== Number(meta.count || 0)) return null;
    return { version, files };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

async function loadRemoteCatalog() {
  const files = [];
  let after = '';
  do {
    const response = await fetch(`/api/catalog?limit=5000&after=${encodeURIComponent(after)}`, {
      credentials:'same-origin',
      cache:'no-store'
    });
    if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
    const page = await response.json();
    files.push(...(page.files || []));
    after = String(page.nextAfter || '');
  } while (after);

  let version = '';
  try {
    const response = await fetch('/api/catalog/version', { credentials:'same-origin', cache:'no-store' });
    if (response.ok) version = String((await response.json()).version || '');
  } catch {}
  return { version, files };
}

async function loadCatalog() {
  return await loadCachedCatalog() || await loadRemoteCatalog();
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

function buildItemData(files, config) {
  const count = files.length;
  const ratios = new Float32Array(count);
  const dates = new Float64Array(count);
  const years = new Int32Array(count);
  const months = new Uint8Array(count);
  const days = new Uint8Array(count);
  const items = new Array(count);

  for (let index = 0; index < count; index++) {
    const file = files[index];
    const width = Number(file.width) || 0;
    const height = Number(file.height) || 0;
    ratios[index] = width && height ? Math.max(.65, Math.min(2.1, width / height)) : 4 / 3;
    const ms = timelineMs(file, config.sort);
    dates[index] = ms;
    const date = new Date(ms || 0);
    years[index] = date.getFullYear();
    months[index] = date.getMonth();
    days[index] = date.getDate();
    items[index] = [
      String(file.hash || ''),
      String(file.filename || ''),
      kind(file) === 'video' ? 1 : 0,
      width,
      height,
      ms
    ];
  }
  return { ratios, dates, years, months, days, items };
}

function layoutFiles(data, config) {
  const { ratios, years, months, days } = data;
  const count = ratios.length;
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
  const itemRows = new Uint32Array(count);
  const itemX = new Float32Array(count);
  const itemW = new Float32Array(count);
  const headers = [];
  const dayStarts = [];
  let y = grouped ? 0 : FLAT_TOP;
  let previousYear = null;
  let previousDayKey = '';

  function ratioSum(start, end) {
    let sum = 0;
    for (let index = start; index < end; index++) sum += ratios[index];
    return sum;
  }

  function idealHeight(start, end) {
    const n = end - start;
    return (width - gap * Math.max(0, n - 1)) / Math.max(.001, ratioSum(start, end));
  }

  function finishRow(start, end, fill) {
    const n = end - start;
    if (!n) return;
    const sum = ratioSum(start, end);
    const ideal = (width - gap * Math.max(0, n - 1)) / Math.max(.001, sum);
    const naturalAtTarget = sum * target + gap * Math.max(0, n - 1);
    const height = fill ? ideal : naturalAtTarget > width ? Math.min(target, ideal) : target;
    const safeHeight = Math.max(1, Math.min(MAX_ROW_HEIGHT, height));
    const row = rowStarts.length;
    rowStarts.push(start);
    rowCounts.push(n);
    rowTops.push(y);
    rowHeights.push(safeHeight);

    let x = 0;
    for (let index = start; index < end; index++) {
      const last = index === end - 1;
      const naturalWidth = ratios[index] * safeHeight;
      const remaining = Math.max(1, width - x);
      const itemWidth = fill && last ? remaining : Math.min(naturalWidth, remaining);
      itemRows[index] = row;
      itemX[index] = x;
      itemW[index] = itemWidth;

      if (grouped) {
        const key = `${years[index]}-${months[index] + 1}-${days[index]}`;
        if (key !== previousDayKey) {
          dayStarts.push({ index, row, x, top:y, year:years[index], month:months[index], day:days[index] });
          previousDayKey = key;
        }
      }
      x += itemWidth + gap;
    }
    y += safeHeight + gap;
  }

  function chooseFullRowEnd(start, end) {
    let sum = 0;
    let previousHeight = Infinity;
    for (let index = start; index < end; index++) {
      sum += ratios[index];
      const n = index - start + 1;
      const height = (width - gap * Math.max(0, n - 1)) / Math.max(.001, sum);
      if (n >= 2 && height <= target) {
        if (n > 2 && previousHeight <= MAX_ROW_HEIGHT && Math.abs(previousHeight - target) < Math.abs(height - target)) return index;
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
        const n = end - rowStart;
        const ideal = idealHeight(rowStart, end);
        finishRow(rowStart, end, n >= 2 && ideal >= target && ideal <= LAST_ROW_FILL_MAX);
        break;
      }
      finishRow(rowStart, rowEnd, true);
      rowStart = rowEnd;
    }
  }

  if (grouped) {
    let start = 0;
    while (start < count) {
      const year = years[start];
      const month = months[start];
      let end = start + 1;
      while (end < count && years[end] === year && months[end] === month) end++;
      y += GROUP_GAP;
      if (year !== previousYear) {
        headers.push({ kind:'year', year, month, top:y });
        y += YEAR_HEIGHT;
        previousYear = year;
      }
      headers.push({ kind:'month', year, month, top:y });
      y += MONTH_HEIGHT;
      layoutRange(start, end);
      start = end;
    }
  } else {
    layoutRange(0, count);
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
  const snapshot = await loadCatalog();
  if (generation !== latestBuildGeneration || !snapshot) return;

  const files = filterAndSort(snapshot.files, config);
  if (generation !== latestBuildGeneration) return;
  const data = buildItemData(files, config);
  const geometry = layoutFiles(data, config);
  if (generation !== latestBuildGeneration) return;

  const transfer = [
    geometry.rowStarts.buffer,
    geometry.rowCounts.buffer,
    geometry.rowTops.buffer,
    geometry.rowHeights.buffer,
    geometry.itemRows.buffer,
    geometry.itemX.buffer,
    geometry.itemW.buffer
  ];

  postMessage({
    type:'ready',
    generation,
    version:snapshot.version,
    count:files.length,
    totalHeight:geometry.totalHeight,
    rowStarts:geometry.rowStarts,
    rowCounts:geometry.rowCounts,
    rowTops:geometry.rowTops,
    rowHeights:geometry.rowHeights,
    itemRows:geometry.itemRows,
    itemX:geometry.itemX,
    itemW:geometry.itemW,
    headers:geometry.headers,
    dayStarts:geometry.dayStarts,
    items:data.items
  }, transfer);
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type !== 'build') return;
  latestBuildGeneration = Number(message.generation) || 0;
  build(message).catch(error => {
    if (Number(message.generation) !== latestBuildGeneration) return;
    postMessage({ type:'error', generation:message.generation, message:String(error?.message || error) });
  });
};