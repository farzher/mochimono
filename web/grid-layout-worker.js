const ROW_GAP = 4;

let latestGeneration = 0;

function mediaRatio(item, diagnostics) {
  const type = String(item?.[2] || '');
  if (type !== 'image' && type !== 'video') return 4 / 3;
  const width = Number(item?.[3]) || 0;
  const height = Number(item?.[4]) || 0;
  if (width <= 0 || height <= 0) {
    diagnostics.missingMediaDimensions++;
    return 4 / 3;
  }
  const ratio = width / height;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    diagnostics.missingMediaDimensions++;
    return 4 / 3;
  }
  return ratio;
}

function buildItemData(items) {
  const count = items.length;
  const ratios = new Float32Array(count);
  const years = new Int32Array(count);
  const months = new Uint8Array(count);
  const days = new Uint8Array(count);
  const diagnostics = { missingMediaDimensions:0 };

  for (let index = 0; index < count; index++) {
    ratios[index] = mediaRatio(items[index], diagnostics);
    const date = new Date(Number(items[index]?.[5]) || 0);
    years[index] = date.getFullYear();
    months[index] = date.getMonth();
    days[index] = date.getDate();
  }
  return { ratios, years, months, days, diagnostics };
}

function layoutItems(items, config) {
  const started = performance.now();
  const { ratios, years, months, days, diagnostics } = buildItemData(items);
  const count = items.length;
  const width = Math.max(200, Number(config.width) || 1000);
  const target = Math.max(72, Number(config.target) || 170);
  const gap = Math.max(0, Number(config.gap ?? ROW_GAP));
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
    dayStarts,
    missingMediaDimensions:diagnostics.missingMediaDimensions,
    buildMs:performance.now() - started
  };
}

self.onmessage = event => {
  const message = event.data || {};
  if (message.type !== 'build') return;
  const generation = Number(message.generation) || 0;
  latestGeneration = generation;
  const items = Array.isArray(message.items) ? message.items : [];

  try {
    const geometry = layoutItems(items, message.config || {});
    if (generation !== latestGeneration) return;
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
      type:'ready', generation, count:items.length,
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
      missingMediaDimensions:geometry.missingMediaDimensions,
      buildMs:geometry.buildMs
    }, transfer);
  } catch (error) {
    if (generation === latestGeneration) postMessage({ type:'error', generation, message:String(error?.message || error) });
  }
};
