const rail = document.querySelector('.ai-global-rail');

if (rail) {
  let dragging = false;
  let pointerId = null;
  let lastMove = 0;

  const style = document.createElement('style');
  style.textContent = `
.ai-global-rail{pointer-events:auto!important;touch-action:none;user-select:none;-webkit-user-select:none;cursor:ns-resize;z-index:35}
.ai-global-rail.dragging{cursor:grabbing}
.ai-global-rail>.rail-thumb{pointer-events:none}
.ai-global-rail .rail-semantic-marker{max-width:92px;overflow:hidden;text-overflow:ellipsis}
`;
  document.head.append(style);

  function api() { return window.mochimonoAIGlobalSort; }
  function count() { return api()?.orderedHashes?.()?.length || 0; }

  function ensureThumb() {
    if (rail.hidden || !api()?.active?.() || count() < 2) return null;
    let thumb = rail.querySelector(':scope > .rail-thumb');
    if (!thumb) {
      thumb = document.createElement('div');
      thumb.className = 'rail-thumb';
      thumb.innerHTML = '<span></span><i></i>';
      rail.append(thumb);
    }
    return thumb;
  }

  function syncSemanticMarkers() {
    const total = count();
    if (rail.hidden || !api()?.active?.() || total < 2) return;
    const ticks = [...rail.querySelectorAll(':scope > .rail-tick[data-index]')];
    const wanted = ticks.map(tick => ({
      index:Math.max(0, Math.min(total - 1, Number(tick.dataset.index) || 0)),
      label:String(tick.title || tick.querySelector('span')?.textContent || '').trim()
    })).filter(item => item.label);
    const key = wanted.map(item => `${item.index}:${item.label}`).join('|');
    let semantic = rail.querySelector(':scope > .rail-semantic');
    if (semantic?.dataset.key === key) return;
    semantic?.remove();
    if (!wanted.length) return;
    semantic = document.createElement('div');
    semantic.className = 'rail-semantic';
    semantic.dataset.key = key;
    semantic.innerHTML = wanted.map(item => `<span class="rail-semantic-marker" data-index="${item.index}" style="top:${(item.index / (total - 1) * 100).toFixed(3)}%">${item.label.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}</span>`).join('');
    rail.append(semantic);
  }

  function setThumb(index) {
    const total = count();
    const thumb = ensureThumb();
    if (!thumb || total < 2) return;
    const safe = Math.max(0, Math.min(total - 1, Number(index) || 0));
    thumb.style.top = `${safe / (total - 1) * 100}%`;
    let active = null;
    let best = Infinity;
    for (const marker of rail.querySelectorAll('.rail-semantic-marker[data-index]')) {
      const delta = Math.abs(Number(marker.dataset.index) - safe);
      if (delta < best) { best = delta; active = marker; }
    }
    for (const marker of rail.querySelectorAll('.rail-semantic-marker')) marker.classList.toggle('active', marker === active);
  }

  function visibleIndex() {
    const value = Number(window.mochimonoStableGrid?.visibleIndex?.());
    return Number.isFinite(value) ? value : 0;
  }

  function indexFromPointer(event) {
    const total = count();
    if (total < 2) return 0;
    const rect = rail.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
    return Math.round(ratio * (total - 1));
  }

  function scrub(event, final = false) {
    if (!api()?.active?.() || rail.hidden) return;
    const index = indexFromPointer(event);
    setThumb(index);
    const now = performance.now();
    if (!final && now - lastMove < 28) return;
    lastMove = now;
    window.mochimonoStableGrid?.scrollToIndex?.(index, 'center');
  }

  rail.addEventListener('pointerdown', event => {
    if (!api()?.active?.() || rail.hidden || event.button > 0) return;
    dragging = true;
    pointerId = event.pointerId;
    rail.classList.add('dragging');
    try { rail.setPointerCapture(pointerId); } catch {}
    scrub(event, true);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  rail.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== pointerId) return;
    scrub(event);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function finish(event) {
    if (!dragging || (event?.pointerId != null && event.pointerId !== pointerId)) return;
    if (event) scrub(event, true);
    try { if (pointerId != null) rail.releasePointerCapture(pointerId); } catch {}
    dragging = false;
    pointerId = null;
    rail.classList.remove('dragging');
  }

  rail.addEventListener('pointerup', event => { finish(event); event.preventDefault(); event.stopImmediatePropagation(); }, true);
  rail.addEventListener('pointercancel', finish, true);

  let frame = 0;
  const scheduleSync = () => {
    if (dragging || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!api()?.active?.()) return;
      syncSemanticMarkers();
      setThumb(visibleIndex());
    });
  };

  new MutationObserver(() => {
    if (!api()?.active?.() || rail.hidden) return;
    ensureThumb();
    syncSemanticMarkers();
    scheduleSync();
  }).observe(rail, { childList:true, attributes:true, attributeFilter:['hidden'] });

  window.addEventListener('scroll', scheduleSync, { passive:true });
  window.addEventListener('resize', scheduleSync, { passive:true });
  window.addEventListener('mochimono:stable-grid-installed', scheduleSync);
}
