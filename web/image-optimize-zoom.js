const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.image-optimize-compare');
const original = compare?.querySelector('[data-opt-original]');
const optimized = compare?.querySelector('[data-opt-after]');

if (viewer && compare && original && optimized) {
  const style = document.createElement('style');
  style.textContent = `
.image-optimize-after-mask{position:absolute;inset:0;clip-path:inset(0 0 0 var(--split));pointer-events:none}
.image-optimize-after-mask>.image-optimize-after{clip-path:none!important}
.image-optimize-compare.image-optimize-zoomed{cursor:grab}
.image-optimize-compare.image-optimize-panning{cursor:grabbing}
.image-optimize-compare.image-optimize-zoomed img{will-change:transform}
`;
  document.head.append(style);

  const mask = document.createElement('div');
  mask.className = 'image-optimize-after-mask';
  optimized.before(mask);
  mask.append(optimized);

  const MAX_SCALE = 8;
  const DIVIDER_GRAB = 34;
  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;

  const active = () => viewer.classList.contains('image-optimize-active');

  function clampPan() {
    if (zoom.scale <= 1) {
      zoom.x = 0;
      zoom.y = 0;
      return;
    }
    const rect = compare.getBoundingClientRect();
    const maxX = Math.max(0, rect.width * (zoom.scale - 1) / 2);
    const maxY = Math.max(0, rect.height * (zoom.scale - 1) / 2);
    zoom.x = Math.max(-maxX, Math.min(maxX, zoom.x));
    zoom.y = Math.max(-maxY, Math.min(maxY, zoom.y));
  }

  function applyZoom() {
    if (zoom.scale <= 1.01) zoom = { scale: 1, x: 0, y: 0 };
    clampPan();
    const transform = zoom.scale > 1
      ? `translate3d(${zoom.x}px,${zoom.y}px,0) scale(${zoom.scale})`
      : '';
    original.style.transform = transform;
    optimized.style.transform = transform;
    original.style.transformOrigin = '50% 50%';
    optimized.style.transformOrigin = '50% 50%';
    compare.classList.toggle('image-optimize-zoomed', zoom.scale > 1.01);
  }

  function resetZoom() {
    pan = null;
    zoom = { scale: 1, x: 0, y: 0 };
    compare.classList.remove('image-optimize-panning');
    applyZoom();
  }

  function splitX(rect) {
    const raw = getComputedStyle(compare).getPropertyValue('--split').trim();
    const percent = Number.parseFloat(raw) || 50;
    return rect.left + rect.width * percent / 100;
  }

  compare.addEventListener('wheel', event => {
    if (!active() || !original.src || !optimized.src) return;
    event.preventDefault();

    const rect = compare.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= rect.height;

    const previous = zoom.scale;
    const factor = Math.exp(-delta * 0.0015);
    const next = Math.max(1, Math.min(MAX_SCALE, previous * factor));
    if (Math.abs(next - previous) < 0.0001) return;

    const px = event.clientX - (rect.left + rect.width / 2);
    const py = event.clientY - (rect.top + rect.height / 2);
    const ratio = next / previous;
    zoom.x = px - (px - zoom.x) * ratio;
    zoom.y = py - (py - zoom.y) * ratio;
    zoom.scale = next;
    applyZoom();
  }, { passive: false, capture: true });

  compare.addEventListener('pointerdown', event => {
    if (!active() || zoom.scale <= 1.01 || !loadingReady()) return;
    const rect = compare.getBoundingClientRect();
    if (Math.abs(event.clientX - splitX(rect)) <= DIVIDER_GRAB) return;

    pan = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: zoom.x,
      y: zoom.y
    };
    compare.classList.add('image-optimize-panning');
    try { compare.setPointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  compare.addEventListener('pointermove', event => {
    if (!pan || event.pointerId !== pan.id) return;
    zoom.x = pan.x + event.clientX - pan.startX;
    zoom.y = pan.y + event.clientY - pan.startY;
    applyZoom();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function finishPan(event) {
    if (!pan || event.pointerId !== pan.id) return;
    try { compare.releasePointerCapture(event.pointerId); } catch {}
    pan = null;
    compare.classList.remove('image-optimize-panning');
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  compare.addEventListener('pointerup', finishPan, true);
  compare.addEventListener('pointercancel', finishPan, true);

  function loadingReady() {
    const loading = compare.querySelector('[data-opt-loading]');
    return !loading || loading.hidden;
  }

  new MutationObserver(() => {
    if (!active() || viewer.hidden) resetZoom();
  }).observe(viewer, { attributes: true, attributeFilter: ['class', 'hidden'] });

  window.addEventListener('resize', () => {
    if (active() && zoom.scale > 1) applyZoom();
  }, { passive: true });
}
