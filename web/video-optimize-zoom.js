const viewer = document.querySelector('#viewer');
const compare = document.querySelector('.video-optimize-compare');
const canvas = compare?.querySelector('[data-canvas]');
const original = compare?.querySelector('[data-o]');
const optimized = compare?.querySelector('[data-a]');

if (viewer && compare && canvas && original && optimized) {
  const ctx = canvas.getContext('2d', { alpha:false });
  const nativeDrawImage = ctx.drawImage.bind(ctx);
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 16;
  const FIT_SCALE = 1;
  const FIT_SNAP = 0.025;
  const PAN_START = 3;
  const pointers = new Map();
  let view = { scale:1, x:0, y:0 };
  let pan = null;
  let pinch = null;

  const style = document.createElement('style');
  style.textContent = `
.video-optimize-compare{cursor:grab}
.video-optimize-compare.video-optimize-panning{cursor:grabbing}
.video-optimize-divider{cursor:e-resize}
`;
  document.head.append(style);

  const active = () => viewer.classList.contains('video-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function fitRect() {
    const viewportWidth = compare.clientWidth || 1;
    const viewportHeight = compare.clientHeight || 1;
    const sourceWidth = optimized.videoWidth || original.videoWidth || viewportWidth;
    const sourceHeight = optimized.videoHeight || original.videoHeight || viewportHeight;
    const ratio = sourceWidth && sourceHeight ? sourceWidth / sourceHeight : viewportWidth / viewportHeight;
    let width = viewportWidth;
    let height = width / ratio;
    if (height > viewportHeight) {
      height = viewportHeight;
      width = height * ratio;
    }
    return {
      viewportWidth,
      viewportHeight,
      x:(viewportWidth - width) / 2,
      y:(viewportHeight - height) / 2,
      width,
      height
    };
  }

  function clampPan() {
    const metrics = fitRect();
    const displayedWidth = metrics.width * view.scale;
    const displayedHeight = metrics.height * view.scale;
    const extraX = Math.max(0, (displayedWidth - metrics.viewportWidth) / 2);
    const extraY = Math.max(0, (displayedHeight - metrics.viewportHeight) / 2);
    const maxX = metrics.viewportWidth * .9 + extraX;
    const maxY = metrics.viewportHeight * .9 + extraY;
    view.x = clamp(view.x, -maxX, maxX);
    view.y = clamp(view.y, -maxY, maxY);
  }

  function transformedDestination(x, y, width, height) {
    const viewportWidth = compare.clientWidth || 1;
    const viewportHeight = compare.clientHeight || 1;
    const centerX = viewportWidth / 2;
    const centerY = viewportHeight / 2;
    return {
      x:centerX + (x - centerX) * view.scale + view.x,
      y:centerY + (y - centerY) * view.scale + view.y,
      width:width * view.scale,
      height:height * view.scale
    };
  }

  // The video compressor composites both decoded videos into one canvas. Intercept
  // only those two destination draws so zoom/pan happens inside the renderer while
  // the comparison clip and divider remain fixed in screen space.
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
    resizeCanvas();
    clampPan();
    const metrics = fitRect();
    const split = clamp(parseFloat(getComputedStyle(compare).getPropertyValue('--split')) || 50, 0, 100);
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, metrics.viewportWidth, metrics.viewportHeight);
    ctx.drawImage(original, metrics.x, metrics.y, metrics.width, metrics.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(metrics.viewportWidth * split / 100, 0, metrics.viewportWidth * (1 - split / 100), metrics.viewportHeight);
    ctx.clip();
    ctx.drawImage(optimized, metrics.x, metrics.y, metrics.width, metrics.height);
    ctx.restore();
  }

  function snapFit(previous, requested) {
    const next = clamp(requested, MIN_SCALE, MAX_SCALE);
    if (Math.abs(previous - FIT_SCALE) < .0005) return next;
    if ((previous < FIT_SCALE && next >= FIT_SCALE) || (previous > FIT_SCALE && next <= FIT_SCALE)) return FIT_SCALE;
    if (previous < FIT_SCALE - FIT_SNAP && next >= FIT_SCALE - FIT_SNAP) return FIT_SCALE;
    if (previous > FIT_SCALE + FIT_SNAP && next <= FIT_SCALE + FIT_SNAP) return FIT_SCALE;
    return next;
  }

  function zoomAt(nextScale, clientX, clientY) {
    const rect = compare.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const previous = view.scale;
    const next = snapFit(previous, nextScale);
    if (Math.abs(next - previous) < .0001) return;
    const px = clientX - (rect.left + rect.width / 2);
    const py = clientY - (rect.top + rect.height / 2);
    const anchorX = (px - view.x) / previous;
    const anchorY = (py - view.y) / previous;
    view.scale = next;
    view.x = px - anchorX * next;
    view.y = py - anchorY * next;
    clampPan();
    redraw();
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
    if (values.length < 2) return false;
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
    const next = snapFit(view.scale, requested);
    view.scale = next;
    view.x = cx - pinch.anchorX * next;
    view.y = cy - pinch.anchorY * next;
    clampPan();
    redraw();
  }

  compare.addEventListener('pointerdown', event => {
    if (!active() || dividerHit(event)) return;
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
      compare.classList.add('video-optimize-panning');
    }
    view.x = pan.x + dx;
    view.y = pan.y + dy;
    clampPan();
    redraw();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

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
    view = { scale:1, x:0, y:0 };
    pan = null;
    pinch = null;
    pointers.clear();
    compare.classList.remove('video-optimize-panning');
    redraw();
  }

  window.addEventListener('mochimono:optimize-open', () => {
    if (active()) reset();
  });
  window.addEventListener('mochimono:optimize-close', reset);
  window.addEventListener('resize', () => {
    if (!active()) return;
    clampPan();
    redraw();
  }, { passive:true });

  window.mochimonoVideoOptimizeZoom = {
    state:() => ({ ...view, fit:1 }),
    set(next = {}) {
      view.scale = clamp(Number(next.scale) || 1, MIN_SCALE, MAX_SCALE);
      view.x = Number(next.x) || 0;
      view.y = Number(next.y) || 0;
      clampPan();
      redraw();
    },
    reset
  };
}
