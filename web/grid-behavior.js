const files = document.querySelector('#files');
const rail = document.querySelector('#dateRail');
const sort = document.querySelector('#sort');

if (files) {
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

  // Thumbnail geometry is learned and persisted by thumbs.js for the next grid
  // render/reload. Do not resize already-painted cards when a late thumbnail
  // decodes: that turns harmless cache warming into visible row reflow.
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
