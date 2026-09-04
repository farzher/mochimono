const GAP = 4;
const FLAT_TOP = 16;
const FIRST_YEAR_TOP = 20;
const YEAR_TOP = 42;
const SAME_YEAR_TOP = 24;
const YEAR_HEIGHT = 23;
const YEAR_BOTTOM = 15;
const MONTH_HEIGHT = 16;
const MONTH_BOTTOM = 8;
const OVERSCAN_SCREENS = 2.25;
const SAFE_SCREENS = .7;

const style = document.createElement('style');
style.textContent = `
.files.stable-media-grid{position:relative!important;display:block!important;overflow:visible!important}
.stable-media-grid>.stable-media-row{position:absolute;left:0;width:100%;margin:0;padding:0}
.stable-media-row>.stable-media-card{position:absolute!important;top:0!important;margin:0!important}
.stable-media-row>.stable-day-control{position:absolute!important}
.stable-media-grid>.stable-year-heading,.stable-media-grid>.stable-month-heading{position:absolute!important;left:2px!important;margin:0!important;padding:0!important;white-space:nowrap}
.stable-media-grid>.stable-year-heading{height:${YEAR_HEIGHT}px!important;line-height:${YEAR_HEIGHT}px!important}
.stable-media-grid>.stable-month-heading{height:${MONTH_HEIGHT}px!important;line-height:${MONTH_HEIGHT}px!important}
`;
document.head.append(style);

const px = value => `${Math.round(value * 100) / 100}px`;

function lowerBound(rows, y) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const row = rows[mid];
    if (row.y + row.height < y) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, Math.max(0, rows.length - 1));
}

function upperBound(rows, y) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].y <= y) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, Math.min(rows.length - 1, low - 1));
}

function elementFromHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '').trim();
  return template.content.firstElementChild;
}

function groupButton(period, key, label, escapeHtml) {
  return `<button type="button" class="timeline-group-select" data-select-period="${period}" data-period-key="${escapeHtml(key)}" data-period-label="${escapeHtml(label)}" aria-label="Select ${escapeHtml(label)}"><span class="timeline-check" aria-hidden="true"></span><span>${escapeHtml(label)}</span></button>`;
}

export function createStableMediaGrid({
  files,
  isMedia,
  ratioFor,
  renderCard,
  monthKey,
  monthName,
  dayKey,
  dayLabel,
  escapeHtml,
  mediaSize
}) {
  let active = false;
  let items = [];
  let itemIndex = new Map();
  let sort = 'date-desc';
  let rows = [];
  let itemToRow = [];
  let headers = [];
  let totalHeight = 0;
  let layoutWidth = 0;
  let layoutMediaSize = 0;
  let firstRow = -1;
  let lastRow = -1;
  let renderedTop = 0;
  let renderedBottom = 0;
  let scrollFrame = 0;
  let rebuildFrame = 0;

  function supported(nextItems, view) {
    if (view !== 'grid' || !nextItems?.length) return false;
    for (const file of nextItems) if (!isMedia(file)) return false;
    return true;
  }

  function fileIndexByHash(hash) {
    const index = itemIndex.get(String(hash || ''));
    return Number.isInteger(index) ? index : -1;
  }

  function viewportTop() {
    return Math.max(0, document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0);
  }

  function visibleAnchor() {
    if (!active || !files.isConnected) return null;
    const top = viewportTop();
    const bounds = files.getBoundingClientRect();
    const xs = [bounds.left + 8, (bounds.left + bounds.right) / 2, bounds.right - 8]
      .map(x => Math.max(1, Math.min(innerWidth - 2, x)));
    for (const y of [top + 2, top + 40, top + 80, top + 120]) {
      if (y >= innerHeight) break;
      for (const x of xs) {
        const card = document.elementFromPoint(x, y)?.closest?.('#files [data-hash]');
        if (card) return { hash: card.dataset.hash, top: card.getBoundingClientRect().top };
      }
    }
    return null;
  }

  function finalizeRow(indices, ratioSum, width, target, fill, y) {
    if (!indices.length) return y;
    const height = fill ? (width - GAP * (indices.length - 1)) / ratioSum : target;
    let x = 0;
    const rowIndex = rows.length;
    const boxes = [];
    for (const index of indices) {
      const itemWidth = ratioFor(items[index]) * height;
      boxes.push({ index, x, width: itemWidth, height });
      itemToRow[index] = rowIndex;
      x += itemWidth + GAP;
    }
    rows.push({ y, height, start: indices[0], end: indices.at(-1) + 1, boxes });
    return y + height + GAP;
  }

  function packRange(start, end, y, width, target) {
    let row = [];
    let ratioSum = 0;
    for (let index = start; index < end; index++) {
      const ratio = ratioFor(items[index]);
      const nextWidth = (ratioSum + ratio) * target + GAP * row.length;
      if (row.length && nextWidth >= width) {
        const currentWidth = ratioSum * target + GAP * (row.length - 1);
        if (Math.abs(width - currentWidth) < Math.abs(nextWidth - width)) {
          y = finalizeRow(row, ratioSum, width, target, true, y);
          row = [index];
          ratioSum = ratio;
          continue;
        }
        row.push(index);
        ratioSum += ratio;
        y = finalizeRow(row, ratioSum, width, target, true, y);
        row = [];
        ratioSum = 0;
        continue;
      }
      row.push(index);
      ratioSum += ratio;
    }
    if (row.length) {
      const filledHeight = row.length > 1 ? (width - GAP * (row.length - 1)) / ratioSum : Infinity;
      y = finalizeRow(row, ratioSum, width, target, row.length > 1 && filledHeight <= target * 1.42, y);
    }
    return rows.length ? y - GAP : y;
  }

  function buildLayout() {
    rows = [];
    headers = [];
    itemToRow = new Array(items.length);
    itemIndex = new Map(items.map((file, index) => [file.hash, index]));
    layoutWidth = Math.max(1, files.clientWidth || files.getBoundingClientRect().width || innerWidth);
    layoutMediaSize = Math.max(48, Number(mediaSize()) || 170);
    let y = 0;

    if (!sort.startsWith('date-')) {
      totalHeight = Math.max(1, packRange(0, items.length, FLAT_TOP, layoutWidth, layoutMediaSize));
      return;
    }

    let start = 0;
    let previousYear = '';
    let groupIndex = 0;
    while (start < items.length) {
      const key = monthKey(items[start]);
      const year = key.slice(0, 4);
      let end = start + 1;
      while (end < items.length && monthKey(items[end]) === key) end++;

      if (year !== previousYear) {
        y += groupIndex === 0 ? FIRST_YEAR_TOP : YEAR_TOP;
        headers.push({ kind: 'year', top: y, height: YEAR_HEIGHT, key: year, label: year });
        y += YEAR_HEIGHT + YEAR_BOTTOM;
      } else y += SAME_YEAR_TOP;

      const month = monthName(items[start]);
      headers.push({ kind: 'month', top: y, height: MONTH_HEIGHT, key, label: month });
      y += MONTH_HEIGHT + MONTH_BOTTOM;
      y = packRange(start, end, y, layoutWidth, layoutMediaSize);
      previousYear = year;
      start = end;
      groupIndex++;
    }
    totalHeight = Math.max(1, y);
  }

  function planeTop() {
    return window.scrollY + files.getBoundingClientRect().top;
  }

  function contentViewport() {
    const top = window.scrollY - planeTop() + viewportTop();
    const height = Math.max(1, innerHeight - viewportTop());
    return { top: Math.max(0, top), bottom: Math.max(0, top) + height };
  }

  function updateCardGeometry(card, file, box) {
    card.style.left = px(box.x);
    card.style.width = px(box.width);
    card.style.height = px(box.height);
    card.style.flexBasis = px(box.width);
    card.style.setProperty('--ratio', String(ratioFor(file)));
    card.dataset.filename = file.filename;
    card.dataset.width = String(file.width || 0);
    card.dataset.height = String(file.height || 0);
    card.dataset.day = dayKey(file);
    card.dataset.dayLabel = dayLabel(file);
    card.title = file.filename;
  }

  function makeHeader(header) {
    const tag = header.kind === 'year' ? 'h2' : 'h3';
    const className = header.kind === 'year' ? 'year-heading stable-year-heading' : 'date-heading stable-month-heading';
    const node = document.createElement(tag);
    node.className = className;
    node.dataset.stableHeader = `${header.kind}:${header.key}`;
    node.innerHTML = groupButton(header.kind, header.key, header.label, escapeHtml);
    return node;
  }

  function rowSignature(row) {
    return row.boxes.map(box => items[box.index].hash).join(',');
  }

  function syncRowNode(node, rowIndex) {
    const row = rows[rowIndex];
    const signature = rowSignature(row);
    node.dataset.stableRow = String(rowIndex);
    node.style.top = px(row.y);
    node.style.height = px(row.height);

    let cards = new Map([...node.querySelectorAll(':scope > .stable-media-card[data-hash]')].map(card => [card.dataset.hash, card]));
    if (node.dataset.rowSignature !== signature) {
      node.replaceChildren();
      cards = new Map();
      node.dataset.rowSignature = signature;
    }

    const wantedDays = new Set();
    const existingDays = new Map([...node.querySelectorAll(':scope > [data-stable-day]')].map(day => [day.dataset.stableDay, day]));
    for (const box of row.boxes) {
      const index = box.index;
      const file = items[index];
      let card = cards.get(file.hash);
      if (!card) {
        card = elementFromHtml(renderCard(file, { ...box, y: 0, index }));
        if (card) node.append(card);
      }
      if (card) updateCardGeometry(card, file, box);

      if (!sort.startsWith('date-')) continue;
      const previousDay = index > 0 ? dayKey(items[index - 1]) : '';
      const currentDay = dayKey(file);
      if (!currentDay || currentDay === previousDay) continue;
      wantedDays.add(currentDay);
      const label = dayLabel(file);
      let day = existingDays.get(currentDay);
      if (!day) {
        day = document.createElement('button');
        day.type = 'button';
        day.className = 'timeline-group-select day-group-control stable-day-control';
        day.dataset.stableDay = currentDay;
        day.dataset.selectPeriod = 'day';
        day.dataset.periodKey = currentDay;
        day.dataset.periodLabel = label;
        day.setAttribute('aria-label', `Select ${label}`);
        day.innerHTML = `<span class="timeline-check" aria-hidden="true"></span><span>${escapeHtml(label)}</span>`;
        node.append(day);
      }
      day.style.left = px(box.x);
      day.style.top = px(-19);
    }
    for (const [key, day] of existingDays) if (!wantedDays.has(key)) day.remove();
  }

  function insertRowInOrder(node, rowIndex) {
    for (const sibling of files.querySelectorAll(':scope > .stable-media-row')) {
      if (Number(sibling.dataset.stableRow) > rowIndex) {
        files.insertBefore(node, sibling);
        return;
      }
    }
    files.append(node);
  }

  function renderRows(nextFirst, nextLast) {
    if (!active || !rows.length) return;
    nextFirst = Math.max(0, Math.min(rows.length - 1, nextFirst));
    nextLast = Math.max(nextFirst, Math.min(rows.length - 1, nextLast));
    const minY = Math.max(0, rows[nextFirst].y - 70);
    const maxY = rows[nextLast].y + rows[nextLast].height + 70;
    const existingRows = new Map([...files.querySelectorAll(':scope > .stable-media-row')].map(node => [Number(node.dataset.stableRow), node]));
    const existingHeaders = new Map([...files.querySelectorAll(':scope > [data-stable-header]')].map(node => [node.dataset.stableHeader, node]));
    const wantedRows = new Set();
    const wantedHeaders = new Set();
    let changed = false;

    for (const header of headers) {
      if (header.top + header.height < minY || header.top > maxY) continue;
      const key = `${header.kind}:${header.key}`;
      wantedHeaders.add(key);
      let node = existingHeaders.get(key);
      if (!node) {
        node = makeHeader(header);
        files.append(node);
        changed = true;
      }
      node.style.top = px(header.top);
    }

    for (let rowIndex = nextFirst; rowIndex <= nextLast; rowIndex++) {
      wantedRows.add(rowIndex);
      let node = existingRows.get(rowIndex);
      if (!node) {
        node = document.createElement('div');
        node.className = 'stable-media-row';
        node.dataset.stableRow = String(rowIndex);
        insertRowInOrder(node, rowIndex);
        changed = true;
      }
      syncRowNode(node, rowIndex);
    }

    for (const [rowIndex, node] of existingRows) if (!wantedRows.has(rowIndex)) { node.remove(); changed = true; }
    for (const [key, node] of existingHeaders) if (!wantedHeaders.has(key)) { node.remove(); changed = true; }

    firstRow = nextFirst;
    lastRow = nextLast;
    renderedTop = rows[firstRow].y;
    renderedBottom = rows[lastRow].y + rows[lastRow].height;
    if (changed) window.dispatchEvent(new CustomEvent('mochimono:stable-grid-rendered'));
  }

  function renderAroundY(y, force = false) {
    if (!active || !rows.length) return;
    const viewportHeight = Math.max(300, innerHeight - viewportTop());
    const wantedTop = Math.max(0, y - viewportHeight * OVERSCAN_SCREENS);
    const wantedBottom = Math.min(totalHeight, y + viewportHeight * (OVERSCAN_SCREENS + 1));
    const nextFirst = lowerBound(rows, wantedTop);
    const nextLast = upperBound(rows, wantedBottom);
    if (!force && nextFirst === firstRow && nextLast === lastRow) return;
    renderRows(nextFirst, nextLast);
  }

  function refreshViewport(force = false) {
    if (!active || !rows.length) return;
    const viewport = contentViewport();
    const viewportHeight = Math.max(300, viewport.bottom - viewport.top);
    if (!force && firstRow >= 0 && viewport.top > renderedTop + viewportHeight * SAFE_SCREENS && viewport.bottom < renderedBottom - viewportHeight * SAFE_SCREENS) return;
    renderAroundY(viewport.top, true);
  }

  function scheduleViewport() {
    if (!active || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      refreshViewport(false);
    });
  }

  function restoreAnchor(anchor) {
    if (!anchor?.hash) return;
    const index = fileIndexByHash(anchor.hash);
    if (index < 0) return;
    ensureIndex(index);
    const card = files.querySelector(`[data-hash="${CSS.escape(anchor.hash)}"]`);
    if (!card) return;
    const delta = card.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > .5) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
  }

  function render(nextItems, options = {}) {
    const wasStable = active && files.classList.contains('stable-media-grid');
    items = nextItems || [];
    sort = String(options.sort || 'date-desc');
    active = true;
    if (!wasStable) files.replaceChildren();
    files.className = 'files grid stable-media-grid';
    files.style.position = 'relative';
    buildLayout();
    files.style.height = px(totalHeight);
    firstRow = lastRow = -1;
    renderedTop = renderedBottom = 0;

    const anchor = options.anchor || null;
    if (anchor?.hash && fileIndexByHash(anchor.hash) >= 0) {
      const row = itemToRow[fileIndexByHash(anchor.hash)];
      renderAroundY(rows[row]?.y || 0, true);
      restoreAnchor(anchor);
    } else refreshViewport(true);
    return true;
  }

  function destroy() {
    if (!active) return;
    active = false;
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    if (rebuildFrame) cancelAnimationFrame(rebuildFrame);
    scrollFrame = rebuildFrame = 0;
    rows = [];
    itemToRow = [];
    itemIndex = new Map();
    headers = [];
    items = [];
    firstRow = lastRow = -1;
    renderedTop = renderedBottom = totalHeight = 0;
    layoutWidth = layoutMediaSize = 0;
    files.style.removeProperty('height');
    files.style.removeProperty('position');
    files.classList.remove('stable-media-grid');
  }

  function ensureIndex(index) {
    if (!active || !Number.isInteger(index) || index < 0 || index >= itemToRow.length) return false;
    const row = itemToRow[index];
    if (!Number.isInteger(row)) return false;
    if (row >= firstRow && row <= lastRow) return false;
    renderAroundY(rows[row].y, true);
    return true;
  }

  function extend(direction) {
    if (!active || !rows.length || firstRow < 0) return false;
    const viewportHeight = Math.max(300, innerHeight - viewportTop());
    if (direction < 0) {
      if (firstRow <= 0) return false;
      const nextFirst = lowerBound(rows, Math.max(0, rows[firstRow].y - viewportHeight * 2));
      renderRows(nextFirst, lastRow);
      return true;
    }
    if (lastRow >= rows.length - 1) return false;
    const nextLast = upperBound(rows, Math.min(totalHeight, rows[lastRow].y + rows[lastRow].height + viewportHeight * 2));
    renderRows(firstRow, nextLast);
    return true;
  }

  function state() {
    if (!active || !rows.length || firstRow < 0) return null;
    const start = rows[firstRow].start;
    const end = rows[lastRow].end;
    return {
      virtual: true,
      offset: start,
      loaded: Math.max(0, end - start),
      hasPrevious: firstRow > 0,
      hasMore: lastRow < rows.length - 1
    };
  }

  function rebuildPreservingAnchor() {
    if (!active || rebuildFrame) return;
    const anchor = visibleAnchor();
    rebuildFrame = requestAnimationFrame(() => {
      rebuildFrame = 0;
      if (!active) return;
      const width = Math.max(1, files.clientWidth || files.getBoundingClientRect().width || innerWidth);
      const target = Math.max(48, Number(mediaSize()) || 170);
      if (Math.abs(width - layoutWidth) < .5 && Math.abs(target - layoutMediaSize) < .5) return;
      buildLayout();
      files.style.height = px(totalHeight);
      firstRow = lastRow = -1;
      renderedTop = renderedBottom = 0;
      if (anchor?.hash && fileIndexByHash(anchor.hash) >= 0) {
        const row = itemToRow[fileIndexByHash(anchor.hash)];
        renderAroundY(rows[row]?.y || 0, true);
        restoreAnchor(anchor);
      } else refreshViewport(true);
    });
  }

  window.addEventListener('scroll', scheduleViewport, { passive: true });
  window.addEventListener('resize', rebuildPreservingAnchor, { passive: true });
  window.addEventListener('mochimono:media-size', rebuildPreservingAnchor);

  return {
    supported,
    render,
    destroy,
    active: () => active,
    extend,
    ensureIndex,
    state,
    refresh: () => refreshViewport(true)
  };
}
