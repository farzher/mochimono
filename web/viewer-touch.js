const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const media = document.querySelector('#viewer-media');
const prev = document.querySelector('#viewer-prev');
const next = document.querySelector('#viewer-next');

if (viewer && stage && media && prev && next) {
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_DISTANCE = 44;
  const TAP_TRAVEL = 14;
  const PAN_START = 14;
  const SIDE_EDGE = .36;
  const VIDEO_EDGE = .22;
  const MAX_SCALE = 4;

  const pointers = new Map();
  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let pinch = null;
  let lastTap = null;
  let tapTimer = 0;
  let consumedPointer = null;

  const image = () => media.querySelector('img');
  const zoomed = () => zoom.scale > 1.01;

  function clearTap() {
    clearTimeout(tapTimer);
    tapTimer = 0;
    lastTap = null;
  }

  function toggleControls() {
    window.mochimonoViewerControls?.toggle();
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
    stage.classList.toggle('viewer-zoomed', active);
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
    pointers.clear();
    clearTap();
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
    if (!current || zoomed()) return;
    const scale = naturalScale(current);
    zoom.scale = scale;
    zoom.x = (1 - scale) * (clientX - innerWidth / 2);
    zoom.y = (1 - scale) * (clientY - innerHeight / 2);
    clearTap();
    applyZoom(true);
  }

  function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function sideButton(clientX, video = false) {
    const edge = video ? VIDEO_EDGE : SIDE_EDGE;
    if (clientX < innerWidth * edge) return prev;
    if (clientX > innerWidth * (1 - edge)) return next;
    return null;
  }

  function navigate(button) {
    if (!button || button.disabled || zoomed()) return false;
    clearTap();
    button.click();
    return true;
  }

  function isDoubleTap(clientX, clientY) {
    return Boolean(lastTap &&
      performance.now() - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE);
  }

  function rememberTap(clientX, clientY) {
    clearTimeout(tapTimer);
    lastTap = { time: performance.now(), x: clientX, y: clientY };
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      lastTap = null;
      if (!viewer.hidden) toggleControls();
    }, DOUBLE_TAP_MS + 20);
  }

  function ignoredTarget(target) {
    return target.closest?.('.viewer-bar,.viewer-collections,.viewer-info,dialog,.viewer-nav');
  }

  function beginPinch() {
    const values = [...pointers.values()].filter(point => point.image);
    if (values.length < 2 || !image()) return false;
    const [a, b] = values;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    pinch = {
      distance: Math.max(1, pointDistance(a, b)),
      scale: zoom.scale,
      anchorX: (cx - innerWidth / 2 - zoom.x) / zoom.scale,
      anchorY: (cy - innerHeight / 2 - zoom.y) / zoom.scale
    };
    pan = null;
    clearTap();
    return true;
  }

  function updatePinch() {
    const values = [...pointers.values()].filter(point => point.image);
    if (!pinch || values.length < 2) return;
    const [a, b] = values;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    zoom.scale = Math.max(1, Math.min(MAX_SCALE, pinch.scale * pointDistance(a, b) / pinch.distance));
    zoom.x = cx - innerWidth / 2 - pinch.anchorX * zoom.scale;
    zoom.y = cy - innerHeight / 2 - pinch.anchorY * zoom.scale;
    applyZoom();
  }

  stage.addEventListener('pointerdown', event => {
    if (viewer.hidden || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    if (ignoredTarget(event.target)) return;

    const imageHit = Boolean(event.target.closest?.('#viewer-media img'));
    const video = event.target.closest?.('#viewer-media video');
    const startedZoomed = zoomed();
    const side = !startedZoomed ? sideButton(event.clientX, Boolean(video)) : null;

    // Side navigation never participates in double-tap zoom. Clearing here
    // makes rapid left/right taps independent navigation gestures.
    if (side) clearTap();

    // A zoomed double-tap reset is atomic: recognize tap #2 immediately,
    // reset once, and consume the rest of this physical pointer sequence.
    if (startedZoomed && imageHit && isDoubleTap(event.clientX, event.clientY)) {
      clearTap();
      consumedPointer = event.pointerId;
      resetZoom(true);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const rect = video?.getBoundingClientRect();
    const point = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      startedZoomed,
      image: imageHit,
      video: Boolean(video),
      videoControls: Boolean(rect && event.clientY >= rect.bottom - Math.min(64, rect.height * .22)),
      side,
      moved: false
    };
    pointers.set(event.pointerId, point);

    if (pointers.size >= 2 && beginPinch()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (startedZoomed && imageHit) {
      pan = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        zoomX: zoom.x,
        zoomY: zoom.y,
        active: false
      };
    }

    if (!video || startedZoomed) {
      try { stage.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  stage.addEventListener('pointermove', event => {
    if (event.pointerId === consumedPointer) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

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

    const dx = event.clientX - point.startX;
    const dy = event.clientY - point.startY;
    const travel = Math.hypot(dx, dy);
    if (travel >= TAP_TRAVEL) point.moved = true;

    if (point.startedZoomed && pan?.id === event.pointerId) {
      if (!pan.active && travel < PAN_START) return;
      if (!pan.active) {
        pan.active = true;
        clearTap();
      }
      zoom.x = pan.zoomX + dx;
      zoom.y = pan.zoomY + dy;
      applyZoom();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // Fit-mode image gestures are viewer-owned. Prevent root scrolling once a
    // horizontal/meaningful gesture begins; the document itself is also locked
    // while the viewer is open.
    if (!point.video && travel >= TAP_TRAVEL) {
      clearTap();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  stage.addEventListener('pointerup', event => {
    if (event.pointerId === consumedPointer) {
      consumedPointer = null;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const point = pointers.get(event.pointerId);
    if (!point) return;

    const dx = event.clientX - point.startX;
    const dy = event.clientY - point.startY;
    const travel = Math.hypot(dx, dy);
    const duration = Math.max(1, performance.now() - point.startedAt);
    const wasPinching = Boolean(pinch) || pointers.size > 1;
    const wasPanning = pan?.id === event.pointerId && pan.active;

    pointers.delete(event.pointerId);
    if (pan?.id === event.pointerId) pan = null;
    try { stage.releasePointerCapture(event.pointerId); } catch {}

    if (wasPinching) {
      pointers.clear();
      pinch = null;
      pan = null;
      clearTap();
      if (zoom.scale <= 1.03) resetZoom(true);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (pointers.size < 2) pinch = null;

    if (wasPanning) {
      clearTap();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (point.startedZoomed) {
      if (travel >= PAN_START) {
        clearTap();
      } else {
        rememberTap(event.clientX, event.clientY);
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const swipe = horizontal && (Math.abs(dx) >= 26 || (Math.abs(dx) >= 16 && velocity >= .18));

    if (swipe && !point.videoControls) {
      clearTap();
      navigate(dx < 0 ? next : prev);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (travel > TAP_TRAVEL) {
      clearTap();
      if (!point.video) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    if (point.video) {
      clearTap();
      if (!point.videoControls && navigate(sideButton(event.clientX, true))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }

    if (point.side && navigate(point.side)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (point.image && isDoubleTap(event.clientX, event.clientY)) {
      clearTap();
      zoomIn(event.clientX, event.clientY);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    rememberTap(event.clientX, event.clientY);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  stage.addEventListener('pointercancel', event => {
    if (event.pointerId === consumedPointer) consumedPointer = null;
    pointers.delete(event.pointerId);
    if (pan?.id === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    clearTap();
  }, true);

  new MutationObserver(() => {
    consumedPointer = null;
    resetZoom();
  }).observe(media, { childList: true });

  new MutationObserver(() => {
    if (viewer.hidden) {
      consumedPointer = null;
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
