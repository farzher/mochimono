const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const rail = document.querySelector('#dateRail');
const sort = document.querySelector('#sort');
const viewerOpen = document.querySelector('#viewer-open');

if (files && viewer) {
  const style = document.createElement('style');
  style.textContent = `
    /* Day labels are timeline text, not chips. Keep the selection affordance but
       inset the text from the thumbnail edge by the same small visual gutter used
       by media labels elsewhere in the grid. */
    .files.grid .day-group-control,
    .files.grid .day-group-control:hover,
    .files.grid .day-group-control:focus-visible{
      padding:0 6px!important;
      border:0!important;
      border-radius:0!important;
      background:transparent!important;
      box-shadow:none!important;
    }
  `;
  document.head.append(style);

  // A first-time thumbnail can arrive before the catalog knows its dimensions.
  // The grid initially reserves the conservative 4:3 fallback in that case.
  // Once the decoded thumbnail tells us its real dimensions, immediately hand
  // them to the canonical library geometry path. gallery.js already listens for
  // that geometry event and re-justifies only the affected grid.
  files.addEventListener('load', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.closest('.media-thumb')) return;
    const card = image.closest('.media-card[data-hash]');
    const width = Number(image.naturalWidth) || 0;
    const height = Number(image.naturalHeight) || 0;
    if (!card || !width || !height) return;
    window.mochimonoLibrary?.rememberDimensions?.(card.dataset.hash, width, height);
  }, true);

  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const centerX = rect => rect.left + rect.width / 2;

  function currentViewerHash() {
    const match = viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([^/?#]+)/);
    if (match) return decodeURIComponent(match[1]);
    return new URL(location.href).searchParams.get('file') || '';
  }

  function cardFor(hash) {
    return hash ? files.querySelector(`.file-card[data-hash="${CSS.escape(hash)}"]`) : null;
  }

  async function ensureCard(hash) {
    let card = cardFor(hash);
    if (card) return card;
    const hashes = window.mochimonoLibrary?.filteredHashes?.() || [];
    const index = hashes.indexOf(hash);
    if (index < 0) return null;
    window.mochimonoLibrary?.ensureIndex?.(index);
    await frame();
    await frame();
    return cardFor(hash);
  }

  function visualRows() {
    const items = [...files.querySelectorAll('.file-card[data-hash]')]
      .map(card => ({ card, rect: card.getBoundingClientRect() }))
      .filter(item => item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const rows = [];
    for (const item of items) {
      const row = rows.at(-1);
      if (!row || Math.abs(item.rect.top - row.top) > 4) {
        rows.push({ top: item.rect.top, items: [item] });
      } else {
        row.items.push(item);
        row.top = Math.min(row.top, item.rect.top);
      }
    }
    return rows;
  }

  function verticalTarget(current, direction) {
    if (!current) return null;
    const rows = visualRows();
    const rowIndex = rows.findIndex(row => row.items.some(item => item.card === current));
    if (rowIndex < 0) return null;
    const targetRow = rows[rowIndex + direction];
    if (!targetRow) return null;
    const x = centerX(current.getBoundingClientRect());
    return targetRow.items
      .slice()
      .sort((a, b) => Math.abs(centerX(a.rect) - x) - Math.abs(centerX(b.rect) - x))[0]?.card || null;
  }

  let verticalNavigation = false;
  async function navigateVertical(direction) {
    if (verticalNavigation) return;
    verticalNavigation = true;
    try {
      const hash = currentViewerHash();
      let current = await ensureCard(hash);
      if (!current) return;
      await frame();
      let target = verticalTarget(current, direction);
      if (!target && window.mochimonoLibrary?.extend?.(direction)) {
        await frame();
        await frame();
        current = cardFor(hash) || current;
        target = verticalTarget(current, direction);
      }
      if (target?.dataset.hash) window.mochimonoOpenViewer?.(target.dataset.hash);
    } finally {
      verticalNavigation = false;
    }
  }

  // Own Up/Down at window capture level while the viewer is open. The grid
  // keyboard cursor also listens at window capture; registering this earlier and
  // stopping propagation prevents it from focusing the hidden grid underneath.
  window.addEventListener('keydown', event => {
    if (viewer.hidden || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigateVertical(event.key === 'ArrowUp' ? -1 : 1).catch(console.warn);
  }, true);
}

if (rail && sort) {
  let railFrame = 0;
  const yearOf = value => String(value || '').match(/(?:^|\D)(\d{4})(?!.*\d)/)?.[1] || '';

  function tickPosition(tick) {
    const position = parseFloat(tick.style.top || '');
    return Number.isFinite(position) ? position : null;
  }

  function alignYearMarkers() {
    railFrame = 0;
    if (sort.value === 'size-desc') return;
    const boundaries = new Map();
    const ticks = [...rail.querySelectorAll(':scope > .rail-tick[data-index]')]
      .map(tick => ({ tick, position: tickPosition(tick) }))
      .filter(item => item.position != null)
      .sort((a, b) => a.position - b.position);

    // The first month encountered for a year is exactly the year boundary in
    // the current display direction (December for Newest, January for Oldest).
    for (const { tick, position } of ticks) {
      const year = yearOf(tick.title || tick.textContent);
      if (year && !boundaries.has(year)) boundaries.set(year, position);
    }

    for (const marker of rail.querySelectorAll(':scope > .rail-semantic-date .rail-semantic-marker')) {
      const position = boundaries.get(marker.textContent.trim());
      if (position == null) continue;
      const next = `${position.toFixed(3)}%`;
      if (marker.style.top !== next) marker.style.top = next;
    }
  }

  function scheduleRailAlignment() {
    if (!railFrame) railFrame = requestAnimationFrame(alignYearMarkers);
  }

  new MutationObserver(scheduleRailAlignment).observe(rail, {
    childList: true,
    subtree: true
  });
  sort.addEventListener('change', scheduleRailAlignment);
  scheduleRailAlignment();
}
