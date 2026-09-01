const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const rail = document.querySelector('#dateRail');
const sort = document.querySelector('#sort');
const viewerOpen = document.querySelector('#viewer-open');

if (files && viewer) {
  const style = document.createElement('style');
  style.textContent = `
    /* Day labels are timeline text, not chips. Keep the selection affordance but
       do not draw a pill/bubble behind the date itself. */
    .files.grid .day-group-control,
    .files.grid .day-group-control:hover,
    .files.grid .day-group-control:focus-visible{
      padding:0!important;
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
  const center = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

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

  function verticalTarget(current, direction) {
    if (!current) return null;
    const origin = center(current.getBoundingClientRect());
    const candidates = [];
    for (const card of files.querySelectorAll('.file-card[data-hash]')) {
      if (card === current || !card.isConnected) continue;
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const point = center(rect);
      const vertical = direction * (point.y - origin.y);
      if (vertical <= 3) continue;
      candidates.push({ card, point, vertical });
    }
    if (!candidates.length) return null;

    // The gallery is justified and columns are intentionally not fixed. Find the
    // immediately adjacent visual row first, then choose the item whose center is
    // horizontally closest to the current item. This behaves like navigating the
    // actual grid rather than guessing a column count.
    const nearestRow = Math.min(...candidates.map(item => item.vertical));
    const rowTolerance = 5;
    const row = candidates.filter(item => Math.abs(item.vertical - nearestRow) <= rowTolerance);
    row.sort((a, b) => Math.abs(a.point.x - origin.x) - Math.abs(b.point.x - origin.x));
    return row[0]?.card || null;
  }

  let verticalNavigation = false;
  async function navigateVertical(direction) {
    if (verticalNavigation) return;
    verticalNavigation = true;
    try {
      const hash = currentViewerHash();
      let current = await ensureCard(hash);
      if (!current) return;
      // gallery.js may still have a pending layout after a newly learned aspect
      // ratio or a virtual-window jump.
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

  document.addEventListener('keydown', event => {
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
