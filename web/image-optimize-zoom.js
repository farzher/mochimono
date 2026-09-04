const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.image-optimize-compare');
const original = compare?.querySelector('[data-opt-original]');
const optimized = compare?.querySelector('[data-opt-after]');

if (viewer && compare && original && optimized) {
  const style = document.createElement('style');
  style.textContent = `
.image-optimize-after-mask{position:absolute;inset:0;clip-path:inset(0 0 0 var(--split));pointer-events:none}
.image-optimize-after-mask>.image-optimize-after{clip-path:none!important}
.image-optimize-compare{cursor:grab}
.image-optimize-compare.image-optimize-panning{cursor:grabbing}
.image-optimize-compare img{will-change:transform}
`;
  document.head.append(style);

  const mask = document.createElement('div');
  mask.className = 'image-optimize-after-mask';
  optimized.before(mask);
  mask.append(optimized);

  const MIN_SCALE = 0.1;
  const MAX_SCALE = 16;
  const PAN_START = 3;
  const pointers = new Map();
  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let pinch = null;

  const active = () => viewer.classList.contains('image-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function clampPan() {
    const rect = compare.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Optimize is a workspace rather than a constrained photo viewer. Keep the
    // image movable at fitted size and below, only preventing it from becoming
    // completely lost offscreen.
    const extraX = rect.width * Math.max(0, zoom.scale - 1) / 2;
    const extraY = rect.height * Math.max(0, zoom.scale - 1) / 2;
    const maxX = rect.width * .9 + extraX;
    const maxY = rect.height * .9 + extraY;
    zoom.x = clamp(zoom.x, -maxX, maxX);
    zoom.y = clamp(zoom.y, -maxY, maxY);
  }

  function applyZoom() {
    zoom.scale = clamp(Number(zoom.scale) || 1, MIN_SCALE, MAX_SCALE);
    clampPan();
    const transform = `translate3d(${zoom.x}px,${zoom.y}px,0) scale(${zoom.scale})`;
    original.style.transform = transform;
    optimized.style.transform = transform;
  }

  function setView(view = {}) {
    pan = null;
    pinch = null;
    pointers.clear();
    compare.classList.remove('image-optimize-panning');
    zoom = {
      scale: clamp(Number(view.scale) || 1, MIN_SCALE, MAX_SCALE),
      x: Number(view.x) || 0,
      y: Number(view.y) || 0
    };
    applyZoom();
  }

  function resetZoom() {
    setView({ scale:1, x:0, y:0 });
  }

  function zoomAt(nextScale, clientX, clientY) {
    const rect = compare.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const previous = zoom.scale;
    const next = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - previous) < .0001) return;
    const px = clientX - (rect.left + rect.width / 2);
    const py = clientY - (rect.top + rect.height / 2);
    const anchorX = (px - zoom.x) / previous;
    const anchorY = (py - zoom.y) / previous;
    zoom.scale = next;
    zoom.x = px - anchorX * next;
    zoom.y = py - anchorY * next;
    applyZoom();
  }

  compare.addEventListener('wheel', event => {
    if (!active() || !original.src || !optimized.src) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = compare.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= rect.height;
    zoomAt(zoom.scale * Math.exp(-delta * .0015), event.clientX, event.clientY);
  }, { passive:false, capture:true });

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function beginPinch() {
    const values = [...pointers.values()];
    if (values.length < 2) return false;
    const [a, b] = values;
    const rect = compare.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - (rect.left + rect.width / 2);
    const cy = (a.y + b.y) / 2 - (rect.top + rect.height / 2);
    pinch = {
      distance: Math.max(1, distance(a, b)),
      scale: zoom.scale,
      anchorX: (cx - zoom.x) / zoom.scale,
      anchorY: (cy - zoom.y) / zoom.scale
    };
    pan = null;
    compare.classList.add('image-optimize-panning');
    return true;
  }

  function updatePinch() {
    const values = [...pointers.values()];
    if (!pinch || values.length < 2) return;
    const [a, b] = values;
    const rect = compare.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - (rect.left + rect.width / 2);
    const cy = (a.y + b.y) / 2 - (rect.top + rect.height / 2);
    zoom.scale = clamp(pinch.scale * distance(a, b) / pinch.distance, MIN_SCALE, MAX_SCALE);
    zoom.x = cx - pinch.anchorX * zoom.scale;
    zoom.y = cy - pinch.anchorY * zoom.scale;
    applyZoom();
  }

  compare.addEventListener('pointerdown', event => {
    if (!active()) return;
    pointers.set(event.pointerId, { id:event.pointerId, x:event.clientX, y:event.clientY });
    try { compare.setPointerCapture(event.pointerId); } catch {}

    if (pointers.size >= 2) beginPinch();
    else {
      pan = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: zoom.x,
        y: zoom.y,
        active: false
      };
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  compare.addEventListener('pointermove', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;

    if (pointers.size >= 2) {
      if (!pinch) beginPinch();
      updatePinch();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (!pan || pan.id !== event.pointerId) return;
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (!pan.active && Math.hypot(dx, dy) < PAN_START) return;
    if (!pan.active) {
      pan.active = true;
      compare.classList.add('image-optimize-panning');
    }
    zoom.x = pan.x + dx;
    zoom.y = pan.y + dy;
    applyZoom();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function finishPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    try { compare.releasePointerCapture(event.pointerId); } catch {}
    if (pan?.id === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) compare.classList.remove('image-optimize-panning');
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  compare.addEventListener('pointerup', finishPointer, true);
  compare.addEventListener('pointercancel', finishPointer, true);

  window.addEventListener('mochimono:optimize-open', event => {
    setView(event.detail?.view || { scale:1, x:0, y:0 });
  });
  window.addEventListener('mochimono:optimize-close', resetZoom);

  new MutationObserver(() => {
    if (!active() || viewer.hidden) resetZoom();
  }).observe(viewer, { attributes:true, attributeFilter:['class','hidden'] });

  window.addEventListener('resize', () => {
    if (active()) applyZoom();
  }, { passive:true });

  window.mochimonoImageOptimizeZoom = {
    state: () => ({ ...zoom }),
    set: setView,
    reset: resetZoom
  };
}
