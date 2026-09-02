const rail = document.querySelector('#dateRail');
const sort = document.querySelector('#sort');

if (rail && sort) {
  const style = document.createElement('style');
  style.textContent = `
    .date-rail{width:104px;cursor:ns-resize}
    .date-rail>.rail-track,.date-rail>.rail-tick{opacity:0!important}
    .date-rail>.rail-thumb{width:104px;height:18px}
    .date-rail>.rail-thumb span{display:none!important}
    .date-rail>.rail-thumb i{right:4px;width:7px;height:3px;box-shadow:none;background:var(--pink)}
    .rail-semantic{position:absolute;inset:0;pointer-events:none}
    .rail-semantic-marker{position:absolute;right:15px;transform:translateY(-50%);max-width:82px;color:#786f6e;font-size:10px;font-weight:720;line-height:1;white-space:nowrap;text-align:right;text-shadow:0 1px 5px rgba(0,0,0,.7);transition:color .1s ease,opacity .1s ease,transform .1s ease;opacity:.82}
    .rail-semantic-marker.active{color:#d9cfcb;opacity:1;transform:translateY(-50%) translateX(-2px)}
    .date-rail:hover .rail-semantic-marker{color:#968c89;opacity:1}
    .date-rail:hover .rail-semantic-marker.active{color:#eee5e1}
    .rail-hover-label{position:absolute;z-index:5;right:2px;width:102px;height:24px;transform:translateY(-50%);pointer-events:none}
    .rail-hover-label[hidden]{display:none}
    .rail-hover-label span{position:absolute;right:16px;top:50%;transform:translateY(-50%);padding:4px 7px;border-radius:7px;background:#302a2e;color:#f5ece8;font-size:10px;font-weight:780;line-height:1.15;white-space:nowrap;box-shadow:0 5px 18px rgba(0,0,0,.32)}
    .rail-hover-label i{position:absolute;right:3px;top:50%;width:7px;height:3px;border-radius:99px;background:var(--pink);transform:translateY(-50%)}
    @media(max-width:980px){
      .date-rail{width:82px}
      .date-rail>.rail-thumb{width:82px}
      .rail-semantic-marker{right:14px;max-width:62px;font-size:9px}
      .rail-hover-label{right:1px;width:82px}
      .rail-hover-label span{right:15px}
    }
  `;
  document.head.append(style);

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