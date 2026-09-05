const viewer = document.querySelector('#viewer');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');
const viewerName = document.querySelector('#viewer-name');
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
.image-optimize-compare img{image-rendering:auto}
`;
  document.head.append(style);

  const mask = document.createElement('div');
  mask.className = 'image-optimize-after-mask';
  optimized.before(mask);
  mask.append(optimized);

  const DIRECT_BROWSER = new Set(['jpg','jpeg','png','webp','avif','bmp','gif']);
  const MIN_SCALE = 0.01;
  const MAX_SCALE = 16;
  const PAN_START = 3;
  const pointers = new Map();
  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let pinch = null;
  let reportedScale = 0;
  let metrics = null;
  let pendingView = null;
  let fitLocked = true;

  const active = () => viewer.classList.contains('image-optimize-active');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const extension = value => String(value || '').toLowerCase().match(/\.([^.]+)$/)?.[1] || '';

  function referenceMetrics() {
    if (!original.naturalWidth || !original.naturalHeight) return null;
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    const nativeWidth = original.naturalWidth / dpr;
    const nativeHeight = original.naturalHeight / dpr;
    const rect = compare.getBoundingClientRect();
    if (!nativeWidth || !nativeHeight || !rect.width || !rect.height) return null;
    return {
      dpr,
      nativeWidth,
      nativeHeight,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      fit: Math.min(1, rect.width / nativeWidth, rect.height / nativeHeight)
    };
  }

  function clearImageStyle(image) {
    if (!image) return;
    for (const property of ['position','inset','left','top','width','height','maxWidth','maxHeight','marginLeft','marginTop','objectFit','transformOrigin','imageRendering','transform']) {
      image.style[property] = '';
    }
  }

  function styleImage(image) {
    if (!metrics || !image) return;
    const width = metrics.nativeWidth * zoom.scale;
    const height = metrics.nativeHeight * zoom.scale;
    image.style.position = 'absolute';
    image.style.inset = 'auto';
    image.style.left = '50%';
    image.style.top = '50%';
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.maxWidth = 'none';
    image.style.maxHeight = 'none';
    image.style.marginLeft = `${-width / 2}px`;
    image.style.marginTop = `${-height / 2}px`;
    image.style.objectFit = 'fill';
    image.style.transformOrigin = '50% 50%';
    image.style.imageRendering = 'auto';
    image.style.transform = `translate3d(${zoom.x}px,${zoom.y}px,0)`;
  }

  function refreshMetrics() {
    const next = referenceMetrics();
    if (!next) return false;
    metrics = next;
    return true;
  }

  function clampPan() {
    if (!metrics) return;
    const displayedWidth = metrics.nativeWidth * zoom.scale;
    const displayedHeight = metrics.nativeHeight * zoom.scale;
    const extraX = Math.max(0, (displayedWidth - metrics.viewportWidth) / 2);
    const extraY = Math.max(0, (displayedHeight - metrics.viewportHeight) / 2);
    const maxX = metrics.viewportWidth * .9 + extraX;
    const maxY = metrics.viewportHeight * .9 + extraY;
    zoom.x = clamp(zoom.x, -maxX, maxX);
    zoom.y = clamp(zoom.y, -maxY, maxY);
  }

  function reportZoom(force = false) {
    if (!force && Math.abs(reportedScale - zoom.scale) < .0005) return;
    reportedScale = zoom.scale;
    window.dispatchEvent(new CustomEvent('mochimono:optimize-zoom', {
      detail:{ ...zoom, fit: metrics?.fit || 1, native:true }
    }));
  }

  function applyZoom(forceReport = false) {
    if (!metrics && !refreshMetrics()) return;
    zoom.scale = clamp(Number(zoom.scale) || metrics.fit, MIN_SCALE, MAX_SCALE);
    clampPan();
    styleImage(original);
    styleImage(optimized);
    if (active()) reportZoom(forceReport);
  }

  function applyPendingView() {
    if (!active() || !refreshMetrics()) return;
    const view = pendingView;
    pendingView = null;
    if (view?.fit || !Number.isFinite(Number(view?.scale))) {
      fitLocked = true;
      zoom = { scale: metrics.fit, x:0, y:0 };
    } else {
      fitLocked = false;
      zoom = {
        scale: clamp(Number(view.scale) || metrics.fit, MIN_SCALE, MAX_SCALE),
        x: Number(view.x) || 0,
        y: Number(view.y) || 0
      };
    }
    applyZoom(true);
  }

  function setView(view = {}) {
    pan = null;
    pinch = null;
    pointers.clear();
    compare.classList.remove('image-optimize-panning');
    pendingView = view;
    if (original.complete && original.naturalWidth) applyPendingView();
  }

  function resetZoom(clearStyles = false) {
    reportedScale = 0;
    pendingView = null;
    metrics = null;
    fitLocked = true;
    zoom = { scale:1, x:0, y:0 };
    pan = null;
    pinch = null;
    pointers.clear();
    compare.classList.remove('image-optimize-panning');
    if (clearStyles) {
      clearImageStyle(original);
      clearImageStyle(optimized);
    }
  }

  function zoomAt(nextScale, clientX, clientY) {
    if (!metrics && !refreshMetrics()) return;
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
    fitLocked = false;
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
    if (values.length < 2 || (!metrics && !refreshMetrics())) return false;
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
    fitLocked = false;
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
      fitLocked = false;
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

  original.addEventListener('load', () => {
    if (!active()) return;
    if (pendingView) applyPendingView();
    else {
      if (!refreshMetrics()) return;
      if (fitLocked) {
        zoom.scale = metrics.fit;
        zoom.x = 0;
        zoom.y = 0;
      }
      applyZoom(true);
    }
  });

  optimized.addEventListener('load', () => {
    if (!active() || !metrics) return;
    applyZoom();
  });

  window.addEventListener('mochimono:optimize-open', event => {
    resetZoom(true);
    const shown = viewerMedia?.querySelector(':scope > img');
    const fullReady = Boolean(shown && !shown.dataset.fullSrc && shown.naturalWidth);
    const viewerState = window.mochimonoViewerPixelZoom?.state?.();
    const eventView = event.detail?.view || {};
    pendingView = fullReady && viewerState?.ready
      ? { scale:Number(viewerState.scale), x:Number(viewerState.x) || 0, y:Number(viewerState.y) || 0 }
      : fullReady && Number.isFinite(Number(eventView.scale))
        ? { scale:Number(eventView.scale), x:Number(eventView.x) || 0, y:Number(eventView.y) || 0 }
        : { fit:true };

    const sourceExt = extension(viewerName?.textContent);
    const rawUrl = viewerOpen?.href || '';
    if (rawUrl && DIRECT_BROWSER.has(sourceExt)) {
      original.dataset.pixelSource = 'raw';
      if (original.src !== rawUrl) original.src = rawUrl;
    }

    if (original.complete && original.naturalWidth) applyPendingView();
  });

  window.addEventListener('mochimono:optimize-close', () => {
    delete original.dataset.pixelSource;
    resetZoom(true);
  });

  new MutationObserver(() => {
    if (!active() || viewer.hidden) resetZoom(true);
  }).observe(viewer, { attributes:true, attributeFilter:['class','hidden'] });

  window.addEventListener('resize', () => {
    if (!active() || !refreshMetrics()) return;
    if (fitLocked) {
      zoom.scale = metrics.fit;
      zoom.x = 0;
      zoom.y = 0;
    }
    applyZoom(true);
  }, { passive:true });

  window.mochimonoImageOptimizeZoom = {
    state: () => ({ ...zoom, fit:metrics?.fit || 1, native:true }),
    set: setView,
    reset: () => resetZoom(false)
  };
}
