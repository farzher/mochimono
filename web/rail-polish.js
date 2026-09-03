const rail = document.querySelector('#dateRail');
const sort = document.querySelector('#sort');

if (rail && sort) {
  let source = [];
  let sourceKey = '';
  let markerMode = '';
  let hover = null;
  let layer = null;
  let decorateFrame = 0;
  let hoverFrame = 0;
  let pointerY = 0;
  let activeFrame = 0;

  const positionOf = element => {
    const value = parseFloat(element.style.top || '0');
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 : 0;
  };

  function tickSource() {
    return [...rail.querySelectorAll(':scope > .rail-tick[data-index]')]
      .map(element => ({
        index: Number(element.dataset.index) || 0,
        position: positionOf(element),
        label: String(element.title || element.querySelector('span')?.textContent || '').trim()
      }))
      .sort((a, b) => a.position - b.position);
  }

  function yearOf(label) {
    return String(label || '').match(/(?:^|\D)(\d{4})(?!.*\d)/)?.[1] || '';
  }

  function dateMarkers(ticks) {
    const markers = [];
    let previous = '';
    for (const tick of ticks) {
      const year = yearOf(tick.label);
      if (year && year !== previous) markers.push({ label: year, position: tick.position });
      if (year) previous = year;
    }
    return markers;
  }

  function sizeMarkers(ticks) {
    if (!ticks.length) return [];
    const wanted = [0, .25, .5, .75, 1];
    const picked = [];
    for (const position of wanted) {
      let best = ticks[0];
      for (const tick of ticks) if (Math.abs(tick.position - position) < Math.abs(best.position - position)) best = tick;
      if (!picked.some(item => item.label === best.label && Math.abs(item.position - best.position) < .02)) picked.push(best);
    }
    return picked.map(item => ({ label: item.label, position: item.position }));
  }

  function createLayer(markers, mode) {
    layer = document.createElement('div');
    layer.className = `rail-semantic rail-semantic-${mode}`;
    for (const marker of markers) {
      const label = document.createElement('span');
      label.className = 'rail-semantic-marker';
      label.style.top = `${(marker.position * 100).toFixed(3)}%`;
      label.textContent = marker.label;
      label.dataset.railLabel = marker.label;
      label.dataset.railPosition = String(marker.position);
      layer.append(label);
    }

    hover = document.createElement('div');
    hover.className = 'rail-hover-label';
    hover.hidden = true;
    hover.innerHTML = '<span></span><i></i>';
    layer.append(hover);
    rail.append(layer);
  }

  function decorate() {
    decorateFrame = 0;
    const ticks = tickSource();
    if (!ticks.length) {
      rail.querySelector(':scope > .rail-semantic')?.remove();
      layer = hover = null;
      source = [];
      sourceKey = '';
      return;
    }

    const mode = sort.value === 'size-desc' ? 'size' : 'date';
    const key = `${mode}|${ticks.map(tick => `${tick.index}:${tick.position.toFixed(5)}:${tick.label}`).join('|')}`;
    if (key === sourceKey && rail.querySelector(':scope > .rail-semantic')) return;

    source = ticks;
    sourceKey = key;
    markerMode = mode;
    rail.dataset.railMode = mode;
    rail.querySelector(':scope > .rail-semantic')?.remove();
    createLayer(mode === 'size' ? sizeMarkers(ticks) : dateMarkers(ticks), mode);
    updateActive();
  }

  function scheduleDecorate() {
    if (!decorateFrame) decorateFrame = requestAnimationFrame(decorate);
  }

  function parseBytes(label) {
    const match = String(label || '').trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)$/i);
    if (!match) return NaN;
    const units = ['B','KB','MB','GB','TB','PB'];
    const unit = units.indexOf(match[2].toUpperCase());
    return Number(match[1]) * 1000 ** Math.max(0, unit);
  }

  function formatBytes(bytes) {
    const units = ['B','KB','MB','GB','TB','PB'];
    let value = Math.max(0, Number(bytes) || 0);
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
    return `${value < 10 && unit ? value.toFixed(2) : value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }

  function dateLabelAt(position) {
    if (!source.length) return '';
    let current = source[0];
    for (const tick of source) {
      if (tick.position > position) break;
      current = tick;
    }
    return current.label;
  }

  function sizeLabelAt(position) {
    if (!source.length) return '';
    if (position <= source[0].position) return source[0].label;
    if (position >= source.at(-1).position) return source.at(-1).label;
    let right = source.findIndex(tick => tick.position >= position);
    if (right <= 0) right = 1;
    const a = source[right - 1];
    const b = source[right];
    const av = parseBytes(a.label);
    const bv = parseBytes(b.label);
    if (!Number.isFinite(av) || !Number.isFinite(bv) || b.position <= a.position) {
      return Math.abs(a.position - position) <= Math.abs(b.position - position) ? a.label : b.label;
    }
    const t = (position - a.position) / (b.position - a.position);
    return formatBytes(av + (bv - av) * t);
  }

  function paintHover() {
    hoverFrame = 0;
    if (!hover || !source.length || rail.hidden) return;
    const rect = rail.getBoundingClientRect();
    if (!rect.height) return;
    const position = Math.max(0, Math.min(1, (pointerY - rect.top) / rect.height));
    hover.style.top = `${Math.max(1.2, Math.min(98.8, position * 100))}%`;
    hover.querySelector('span').textContent = markerMode === 'size' ? sizeLabelAt(position) : dateLabelAt(position);
    hover.hidden = false;
  }

  function updateHover(event) {
    pointerY = event.clientY;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(paintHover);
  }

  function hideHover() {
    if (!rail.classList.contains('dragging') && hover) hover.hidden = true;
  }

  function updateActive() {
    activeFrame = 0;
    if (rail.hidden || window.mochimonoGridInteraction?.active?.()) return;
    const markers = [...rail.querySelectorAll(':scope > .rail-semantic .rail-semantic-marker')];
    if (!markers.length) return;
    const thumb = rail.querySelector(':scope > .rail-thumb');
    const thumbPosition = thumb ? positionOf(thumb) : 0;
    let active = markers[0];

    if (markerMode === 'date') {
      const year = yearOf(thumb?.querySelector('span')?.textContent || '');
      active = markers.find(marker => marker.dataset.railLabel === year) || active;
    } else {
      let distance = Infinity;
      for (const marker of markers) {
        const next = Math.abs(Number(marker.dataset.railPosition) - thumbPosition);
        if (next < distance) { distance = next; active = marker; }
      }
    }
    markers.forEach(marker => marker.classList.toggle('active', marker === active));
  }

  function scheduleActive() {
    if (rail.hidden || window.mochimonoGridInteraction?.active?.()) return;
    if (!activeFrame) activeFrame = requestAnimationFrame(updateActive);
  }

  rail.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'touch') updateHover(event);
  }, { passive: true });
  rail.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch' || rail.classList.contains('dragging')) updateHover(event);
  }, { passive: true });
  rail.addEventListener('pointerdown', updateHover, { passive: true });
  rail.addEventListener('pointerleave', hideHover, { passive: true });
  rail.addEventListener('pointerup', scheduleActive, { passive: true });
  rail.addEventListener('pointercancel', hideHover, { passive: true });

  window.addEventListener('scroll', scheduleActive, { passive: true });
  window.addEventListener('mochimono:grid-interaction-end', scheduleActive);
  sort.addEventListener('change', scheduleDecorate);

  new MutationObserver(scheduleDecorate).observe(rail, { childList: true, subtree: false });
  scheduleDecorate();
}
