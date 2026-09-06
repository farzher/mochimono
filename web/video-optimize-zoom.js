const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.video-optimize-compare');
const canvas = compare?.querySelector('[data-canvas]');
const original = compare?.querySelector('[data-o]');
const optimized = compare?.querySelector('[data-a]');
const rightCard = document.querySelector('.video-optimize-card-right');

if (viewer && compare && canvas && original && optimized) {
  const ctx = canvas.getContext('2d', { alpha:false });
  const nativeDrawImage = ctx.drawImage.bind(ctx);
  const MIN_SCALE = 0.01;
  const MAX_SCALE = 16;
  const NATIVE_SCALE = 1;
  const NATIVE_SNAP = 0.025;
  const PAN_START = 3;
  const pointers = new Map();
  let view = { scale:1, x:0, y:0 };
  let metrics = null;
  let fitLocked = true;
  let pan = null;
  let pinch = null;
  let redrawFrame = 0;

  const style = document.createElement('style');
  style.textContent = `
.video-optimize-compare{cursor:grab}
.video-optimize-compare.video-optimize-panning{cursor:grabbing}
.video-optimize-divider{cursor:e-resize}
.video-optimize-status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;margin-top:6px}
.video-optimize-status-row>.video-optimize-status{min-width:0;margin-top:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.video-optimize-zoom-readout{flex:0 0 auto;color:#b9b1ad;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
@media(max-width:760px){.video-optimize-zoom-readout{font-size:10.5px}}
`;
  document.head.append(style);

  let zoomLabel = rightCard?.querySelector('.video-optimize-zoom-readout') || null;
  const status = rightCard?.querySelector('.video-optimize-status') || null;
  if (rightCard && status && !zoomLabel) {
    const row = document.createElement('div');
    row.className = 'video-optimize-status-row';
    status.before(row);
    row.append(status);
    zoomLabel = document.createElement('div');
    zoomLabel.className = 'video-optimize-zoom-readout';
    zoomLabel.textContent = '100%';
    row.append(zoomLabel);
  }

  const active = () => viewer.classList.contains('video-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function zoomText(scale) {
    const percent = Math.max(1, scale * 100);
    return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
  }

  function updateZoomLabel() {
    if (zoomLabel) zoomLabel.textContent = zoomText(view.scale);
  }

  function referenceMetrics() {
    const pixelWidth = Number(original.videoWidth) || Number(optimized.videoWidth) || 0;
    const pixelHeight = Number(original.videoHeight) || Number(optimized.videoHeight) || 0;
    const viewportWidth = compare.clientWidth || 0;
    const viewportHeight = compare.clientHeight || 0;
    if (!pixelWidth || !pixelHeight || !viewportWidth || !viewportHeight) return null;
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    const nativeWidth = pixelWidth / dpr;
    const nativeHeight = pixelHeight / dpr;
    return {
      dpr,
      pixelWidth,
      pixelHeight,
      nativeWidth,
      nativeHeight,
      viewportWidth,
      viewportHeight,
      fit:Math.min(viewportWidth / nativeWidth, viewportHeight / nativeHeight)
    };
  }

  function refreshMetrics() {
    const next = referenceMetrics();
    if (!next) return false;
    metrics = next;
    return true;
  }

  function fitRect() {
    if (!metrics && !refreshMetrics()) return null;
    const width = metrics.nativeWidth * metrics.fit;
    const height = metrics.nativeHeight * metrics.fit;
    return {
      viewportWidth:metrics.viewportWidth,
      viewportHeight:metrics.viewportHeight,
      x:(metrics.viewportWidth - width) / 2,
      y:(metrics.viewportHeight - height) / 2,
      width,
      height
    };
  }

  function clampPan() {
    if (!metrics && !refreshMetrics()) return;
    const displayedWidth = metrics.nativeWidth * view.scale;
    const displayedHeight = metrics.nativeHeight * view.scale;
    const extraX = Math.max(0, (displayedWidth - metrics.viewportWidth) / 2);
    const extraY = Math.max(0, (displayedHeight - metrics.viewportHeight) / 2);
    const maxX = metrics.viewportWidth * .9 + extraX;
    const maxY = metrics.viewportHeight * .9 + extraY;
    view.x = clamp(view.x, -maxX, maxX);
    view.y = clamp(view.y, -maxY, maxY);
  }

  function transformedDestination(x, y, width, height) {
    if (!metrics && !refreshMetrics()) return { x, y, width, height };
    const factor = view.scale / Math.max(.000001, metrics.fit);
    const centerX = metrics.viewportWidth / 2;
    const centerY = metrics.viewportHeight / 2;
    return {
      x:centerX + (x - centerX) * factor + view.x,
      y:centerY + (y - centerY) * factor + view.y,
      width:width * factor,
      height:height * factor
    };
  }

  // Base video comparison draws both decoded frames at their fitted destination.
  // Transform only those two draws so the divider/clip remain fixed in screen space.
  ctx.drawImage = function(...args) {
    if (active() && args.length === 5 && (args[0] === original || args[0] === optimized)) {
      const destination = transformedDestination(args[1], args[2], args[3], args[4]);
      return nativeDrawImage(args[0], destination.x, destination.y, destination.width, destination.height);
    }
    return nativeDrawImage(...args);
  };

  function resizeCanvas() {
    const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
    const width = Math.max(1, Math.round((compare.clientWidth || 1) * dpr));
    const height = Math.max(1, Math.round((compare.clientHeight || 1) * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function redraw() {
    if (!active() || !original.videoWidth || !optimized.videoWidth) return;
    if (!refreshMetrics()) return;
    resizeCanvas();
    clampPan();
    const rect = fitRect();
    if (!rect) return;
    const split = clamp(parseFloat(getComputedStyle(compare).getPropertyValue('--split')) || 50, 0, 100);
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, rect.viewportWidth, rect.viewportHeight);
    ctx.drawImage(original, rect.x, rect.y, rect.width, rect.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.viewportWidth * split / 100, 0, rect.viewportWidth * (1 - split / 100), rect.viewportHeight);
    ctx.clip();
    ctx.drawImage(optimized, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    updateZoomLabel();
  }

  function queueRedraw() {
    if (redrawFrame) return;
    redrawFrame = requestAnimationFrame(() => {
      redrawFrame = 0;
      redraw();
    });
  }

  function snapNative(previous, requested) {
    const next = clamp(requested, MIN_SCALE, MAX_SCALE);
    if (Math.abs(previous - NATIVE_SCALE) < .0005) return next;
    if ((previous < NATIVE_SCALE && next >= NATIVE_SCALE) || (previous > NATIVE_SCALE && next <= NATIVE_SCALE)) return NATIVE_SCALE;
    if (previous < NATIVE_SCALE - NATIVE_SNAP && next >= NATIVE_SCALE - NATIVE_SNAP) return NATIVE_SCALE;
    if (previous > NATIVE_SCALE + NATIVE_SNAP && next <= NATIVE_SCALE + NATIVE_SNAP) return NATIVE_SCALE;
    return next;
  }

  function zoomAt(nextScale, clientX, clientY) {
    if (!metrics && !refreshMetrics()) return;
    const rect = compare.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const previous = view.scale;
    const next = snapNative(previous, nextScale);
    if (Math.abs(next - previous) < .0001) return;
    const px = clientX - (rect.left + rect.width / 2);
    const py = clientY - (rect.top + rect.height / 2);
    const anchorX = (px - view.x) / previous;
    const anchorY = (py - view.y) / previous;
    view.scale = next;
    view.x = px - anchorX * next;
    view.y = py - anchorY * next;
    fitLocked = false;
    clampPan();
    redraw();
  }

  function fitView() {
    if (!refreshMetrics()) return false;
    fitLocked = true;
    view = { scale:metrics.fit, x:0, y:0 };
    redraw();
    return true;
  }

  compare.addEventListener('wheel', event => {
    if (!active() || !original.videoWidth || !optimized.videoWidth) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = compare.getBoundingClientRect();
    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= rect.height;
    zoomAt(view.scale * Math.exp(-delta * .0015), event.clientX, event.clientY);
  }, { passive:false, capture:true });

  function dividerHit(event) {
    if (event.target.closest?.('.video-optimize-divider')) return true;
    const rect = compare.getBoundingClientRect();
    const split = clamp(parseFloat(getComputedStyle(compare).getPropertyValue('--split')) || 50, 0, 100);
    const dividerX = rect.left + rect.width * split / 100;
    return Math.abs(event.clientX - dividerX) <= (event.pointerType === 'touch' ? 50 : 32);
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function beginPinch() {
    const values = [...pointers.values()];
    if (values.length < 2 || (!metrics && !refreshMetrics())) return false;
    const [a, b] = values;
    const rect = compare.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - (rect.left + rect.width / 2);
    const cy = (a.y + b.y) / 2 - (rect.top + rect.height / 2);
    pinch = {
      distance:Math.max(1, distance(a, b)),
      scale:view.scale,
      anchorX:(cx - view.x) / view.scale,
      anchorY:(cy - view.y) / view.scale
    };
    pan = null;
    fitLocked = false;
    compare.classList.add('video-optimize-panning');
    return true;
  }

  function updatePinch() {
    const values = [...pointers.values()];
    if (!pinch || values.length < 2) return;
    const [a, b] = values;
    const rect = compare.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - (rect.left + rect.width / 2);
    const cy = (a.y + b.y) / 2 - (rect.top + rect.height / 2);
    const requested = pinch.scale * distance(a, b) / pinch.distance;
    const next = snapNative(view.scale, requested);
    view.scale = next;
    view.x = cx - pinch.anchorX * next;
    view.y = cy - pinch.anchorY * next;
    clampPan();
    redraw();
  }

  compare.addEventListener('pointerdown', event => {
    if (!active()) return;
    if (dividerHit(event)) {
      queueRedraw();
      return;
    }
    pointers.set(event.pointerId, { id:event.pointerId, x:event.clientX, y:event.clientY });
    try { compare.setPointerCapture(event.pointerId); } catch {}
    if (pointers.size >= 2) beginPinch();
    else {
      pan = {
        id:event.pointerId,
        startX:event.clientX,
        startY:event.clientY,
        x:view.x,
        y:view.y,
        active:false
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
      fitLocked = false;
      compare.classList.add('video-optimize-panning');
    }
    view.x = pan.x + dx;
    view.y = pan.y + dy;
    clampPan();
    redraw();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  // Divider dragging belongs to the base comparison module. Redraw on the
  // bubbling phase so the updated split is reflected immediately even while a
  // replacement preview is still encoding and the base session is temporarily busy.
  compare.addEventListener('pointermove', event => {
    if (active() && event.buttons) queueRedraw();
  });

  function finishPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    try { compare.releasePointerCapture(event.pointerId); } catch {}
    if (pan?.id === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) compare.classList.remove('video-optimize-panning');
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  compare.addEventListener('pointerup', finishPointer, true);
  compare.addEventListener('pointercancel', finishPointer, true);

  function reset() {
    metrics = null;
    fitLocked = true;
    view = { scale:1, x:0, y:0 };
    pan = null;
    pinch = null;
    pointers.clear();
    compare.classList.remove('video-optimize-panning');
    updateZoomLabel();
  }

  function mediaReady() {
    if (!active()) return;
    if (fitLocked) fitView();
    else {
      refreshMetrics();
      clampPan();
      redraw();
    }
  }

  original.addEventListener('loadedmetadata', mediaReady);
  optimized.addEventListener('loadedmetadata', mediaReady);
  original.addEventListener('loadeddata', mediaReady);
  optimized.addEventListener('loadeddata', mediaReady);

  window.addEventListener('mochimono:optimize-open', () => {
    if (!active()) return;
    reset();
    fitView();
  });
  window.addEventListener('mochimono:optimize-close', reset);
  window.addEventListener('resize', () => {
    if (!active() || !refreshMetrics()) return;
    if (fitLocked) {
      view.scale = metrics.fit;
      view.x = 0;
      view.y = 0;
    }
    clampPan();
    redraw();
  }, { passive:true });

  window.mochimonoVideoOptimizeZoom = {
    state:() => ({ ...view, fit:metrics?.fit || 1, native:true }),
    set(next = {}) {
      if (next.fit || !Number.isFinite(Number(next.scale))) {
        fitView();
        return;
      }
      if (!refreshMetrics()) return;
      fitLocked = false;
      view.scale = clamp(Number(next.scale) || metrics.fit, MIN_SCALE, MAX_SCALE);
      view.x = Number(next.x) || 0;
      view.y = Number(next.y) || 0;
      clampPan();
      redraw();
    },
    reset:fitView
  };
}
