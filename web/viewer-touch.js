const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const media = document.querySelector('#viewer-media');
const prev = document.querySelector('#viewer-prev');
const next = document.querySelector('#viewer-next');

if (viewer && stage && media) {
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_DISTANCE = 44;
  const TAP_TRAVEL = 16;
  const PAN_START = 16;
  const DOUBLE_TAP_PAN_CANCEL = 30;
  const SIDE_EDGE = .36;
  const VIDEO_EDGE = .22;
  const MAX_SCALE = 4;

  const pointers = new Map();
  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let pinch = null;
  let lastTap = null;
  let tapTimer = 0;

  const image = () => media.querySelector('img');
  const zoomed = () => zoom.scale > 1.01;
  const toggleChrome = () => window.mochimonoViewerControls?.toggle();

  function clearTap() {
    clearTimeout(tapTimer);
    tapTimer = 0;
    lastTap = null;
  }

  function clampPan(scale = zoom.scale, x = zoom.x, y = zoom.y) {
    const current = image();
    if (!current || scale <= 1) return { x: 0, y: 0 };
    const maxX = Math.max(0, (current.clientWidth * scale - innerWidth) / 2);
    const maxY = Math.max(0, (current.clientHeight * scale - innerHeight) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y))
    };
  }

  function applyZoom(animate = false) {
    const current = image();
    const active = zoomed();
    stage.classList.toggle('viewer-touch-zoomed', active);
    if (!current) return;
    const clamped = clampPan();
    zoom.x = clamped.x;
    zoom.y = clamped.y;
    current.style.transition = animate ? 'transform 160ms ease-out' : 'none';
    current.style.transform = active
      ? `translate3d(${zoom.x}px,${zoom.y}px,0) scale(${zoom.scale})`
      : '';
    if (animate) setTimeout(() => {
      if (current.isConnected) current.style.transition = '';
    }, 180);
  }

  function resetZoom(animate = false) {
    zoom = { scale: 1, x: 0, y: 0 };
    pan = null;
    pinch = null;
    clearTap();
    stage.classList.remove('viewer-touch-zoomed');
    applyZoom(animate);
  }

  function naturalScale(current) {
    const scale = Math.max(
      Number(current.naturalWidth || 0) / Math.max(1, current.clientWidth),
      Number(current.naturalHeight || 0) / Math.max(1, current.clientHeight)
    );
    return Math.max(2.25, Math.min(MAX_SCALE, scale || 2.25));
  }

  function zoomIn(clientX, clientY) {
    const current = image();
    if (!current) return;
    const scale = naturalScale(current);
    zoom.scale = scale;
    zoom.x = (1 - scale) * (clientX - innerWidth / 2);
    zoom.y = (1 - scale) * (clientY - innerHeight / 2);
    clearTap();
    applyZoom(true);
  }

  function toggleZoom(clientX, clientY) {
    if (zoomed()) resetZoom(true);
    else zoomIn(clientX, clientY);
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function currentDoubleCandidate(clientX, clientY, imageHit) {
    if (!imageHit || !lastTap?.image) return false;
    const now = performance.now();
    return now - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE;
  }

  function beginPinch() {
    const values = [...pointers.values()];
    if (values.length < 2 || !image()) return;
    const [a, b] = values;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const scale = zoom.scale;
    pinch = {
      distance: Math.max(1, distance(a, b)),
      scale,
      anchorX: (cx - innerWidth / 2 - zoom.x) / scale,
      anchorY: (cy - innerHeight / 2 - zoom.y) / scale
    };
    pan = null;
    clearTap();
  }

  function updatePinch() {
    const values = [...pointers.values()];
    if (!pinch || values.length < 2) return;
    const [a, b] = values;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    zoom.scale = Math.max(1, Math.min(MAX_SCALE, pinch.scale * distance(a, b) / pinch.distance));
    zoom.x = cx - innerWidth / 2 - pinch.anchorX * zoom.scale;
    zoom.y = cy - innerHeight / 2 - pinch.anchorY * zoom.scale;
    applyZoom();
  }

  function navigateAt(clientX, video = false) {
    if (zoomed()) return false;
    const edge = video ? VIDEO_EDGE : SIDE_EDGE;
    const button = clientX < innerWidth * edge
      ? prev
      : clientX > innerWidth * (1 - edge)
        ? next
        : null;
    if (!button || button.disabled) return false;
    clearTap();
    button.click();
    return true;
  }

  function scheduleTap(point, clientX, clientY) {
    const now = performance.now();
    const isDouble = Boolean(point.image && lastTap?.image && (
      point.doubleCandidate ||
      (now - lastTap.time <= DOUBLE_TAP_MS &&
        Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE)
    ));

    clearTimeout(tapTimer);
    tapTimer = 0;

    if (isDouble) {
      lastTap = null;
      toggleZoom(clientX, clientY);
      return;
    }

    lastTap = { time: now, x: clientX, y: clientY, image: point.image };
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      lastTap = null;
      if (!viewer.hidden) toggleChrome();
    }, DOUBLE_TAP_MS + 20);
  }

  function ignoredTarget(target) {
    return target.closest?.('.viewer-bar,.viewer-collections,.viewer-info,dialog,.viewer-nav');
  }

  stage.addEventListener('pointerdown', event => {
    if (viewer.hidden || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    if (ignoredTarget(event.target)) return;

    const video = event.target.closest?.('#viewer-media video');
    const rect = video?.getBoundingClientRect();
    const controlBand = rect ? Math.min(64, rect.height * .22) : 0;
    const imageHit = Boolean(event.target.closest?.('#viewer-media img'));
    const point = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      image: imageHit,
      video: Boolean(video),
      videoControls: Boolean(rect && event.clientY >= rect.bottom - controlBand),
      doubleCandidate: currentDoubleCandidate(event.clientX, event.clientY, imageHit)
    };
    pointers.set(event.pointerId, point);

    if (pointers.size >= 2) {
      beginPinch();
      event.preventDefault();
      return;
    }

    if (zoomed() && imageHit) {
      pan = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: zoom.x,
        startY: zoom.y,
        active: false,
        doubleCandidate: point.doubleCandidate
      };
    }
  });

  stage.addEventListener('pointermove', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;

    if (pointers.size >= 2) {
      if (!pinch) beginPinch();
      updatePinch();
      event.preventDefault();
      return;
    }

    if (!pan || pan.pointerId !== event.pointerId || !zoomed()) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    const travel = Math.hypot(dx, dy);
    const threshold = pan.doubleCandidate ? DOUBLE_TAP_PAN_CANCEL : PAN_START;
    if (!pan.active && travel < threshold) return;

    if (!pan.active) {
      pan.active = true;
      pan.doubleCandidate = false;
      clearTap();
      try { stage.setPointerCapture(event.pointerId); } catch {}
    }

    zoom.x = pan.startX + dx;
    zoom.y = pan.startY + dy;
    applyZoom();
    event.preventDefault();
  });

  stage.addEventListener('pointerup', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;

    point.x = event.clientX;
    point.y = event.clientY;
    const dx = point.x - point.startX;
    const dy = point.y - point.startY;
    const travel = Math.hypot(dx, dy);
    const duration = Math.max(1, performance.now() - point.startedAt);
    const wasPinching = Boolean(pinch) || pointers.size > 1;
    const wasPanning = pan?.pointerId === event.pointerId && pan.active;

    pointers.delete(event.pointerId);
    if (pan?.pointerId === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    try { stage.releasePointerCapture(event.pointerId); } catch {}

    if (wasPinching) {
      clearTap();
      if (zoom.scale <= 1.03) resetZoom(true);
      event.preventDefault();
      return;
    }

    if (wasPanning) {
      clearTap();
      event.preventDefault();
      return;
    }

    if (zoomed()) {
      const tapLimit = point.doubleCandidate ? DOUBLE_TAP_PAN_CANCEL : TAP_TRAVEL;
      if (travel > tapLimit) {
        clearTap();
        return;
      }
      scheduleTap(point, event.clientX, event.clientY);
      event.preventDefault();
      return;
    }

    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const swipe = horizontal && (Math.abs(dx) >= 26 || (Math.abs(dx) >= 16 && velocity >= .18));

    if (swipe && !point.videoControls) {
      clearTap();
      const button = dx < 0 ? next : prev;
      if (!button?.disabled) button?.click();
      event.preventDefault();
      return;
    }

    if (travel > TAP_TRAVEL) {
      clearTap();
      return;
    }

    if (point.video) {
      clearTap();
      if (!point.videoControls && navigateAt(event.clientX, true)) event.preventDefault();
      return;
    }

    if (navigateAt(event.clientX)) {
      event.preventDefault();
      return;
    }

    scheduleTap(point, event.clientX, event.clientY);
    event.preventDefault();
  });

  stage.addEventListener('pointercancel', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pan?.pointerId === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    clearTap();
    if (!pointers.size && zoom.scale <= 1.03) resetZoom();
  });

  new MutationObserver(() => {
    pointers.clear();
    resetZoom();
  }).observe(media, { childList: true });

  new MutationObserver(() => {
    if (viewer.hidden) {
      pointers.clear();
      resetZoom();
    }
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  window.addEventListener('resize', () => {
    if (zoomed()) applyZoom();
  }, { passive: true });

  document.addEventListener('keydown', event => {
    if (viewer.hidden || !zoomed() || event.altKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}
