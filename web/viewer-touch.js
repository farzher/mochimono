const touchViewer = document.querySelector('#viewer');
const touchStage = document.querySelector('#viewer-stage');
const touchMedia = document.querySelector('#viewer-media');
const touchPrev = document.querySelector('#viewer-prev');
const touchNext = document.querySelector('#viewer-next');

if (touchViewer && touchStage && touchMedia && touchPrev && touchNext) {
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_DISTANCE = 44;
  const TAP_TRAVEL = 12;
  const PAN_START = 18;
  const SIDE_EDGE = .36;
  const VIDEO_EDGE = .22;
  const MAX_SCALE = 4;

  const style = document.createElement('style');
  style.textContent = `
    .viewer-stage{touch-action:pan-y!important}
    .viewer-stage.viewer-touch-zoomed{touch-action:none!important}
  `;
  document.head.append(style);

  const pointers = new Map();
  const consumedPointers = new Set();
  const videoPointerIds = new Set();
  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let pinch = null;
  let lastTap = null;
  let tapTimer = 0;

  const image = () => touchMedia.querySelector('img');
  const zoomed = () => zoom.scale > 1.01;

  function clearTap() {
    clearTimeout(tapTimer);
    tapTimer = 0;
    lastTap = null;
  }

  function toggleChrome() {
    if (!touchViewer.hidden) touchViewer.classList.toggle('viewer-controls-hidden');
  }

  function clampPan(scale = zoom.scale, x = zoom.x, y = zoom.y) {
    const current = image();
    if (!current || scale <= 1) return { x: 0, y: 0 };
    return {
      x: Math.max(-(Math.max(0, current.clientWidth * scale - innerWidth) / 2), Math.min(Math.max(0, current.clientWidth * scale - innerWidth) / 2, x)),
      y: Math.max(-(Math.max(0, current.clientHeight * scale - innerHeight) / 2), Math.min(Math.max(0, current.clientHeight * scale - innerHeight) / 2, y))
    };
  }

  function applyZoom(animate = false) {
    const current = image();
    const active = zoomed();
    touchStage.classList.toggle('viewer-zoomed', active);
    touchStage.classList.toggle('viewer-touch-zoomed', active);
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
    videoPointerIds.clear();
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

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function beginPinch() {
    const values = [...pointers.values()].filter(point => point.image);
    if (values.length < 2 || !image()) return false;
    const [a, b] = values;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    pinch = {
      distance: Math.max(1, distance(a, b)),
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
    zoom.scale = Math.max(1, Math.min(MAX_SCALE, pinch.scale * distance(a, b) / pinch.distance));
    zoom.x = cx - innerWidth / 2 - pinch.anchorX * zoom.scale;
    zoom.y = cy - innerHeight / 2 - pinch.anchorY * zoom.scale;
    applyZoom();
  }

  function sideButton(clientX, video = false) {
    const edge = video ? VIDEO_EDGE : SIDE_EDGE;
    if (clientX < innerWidth * edge) return touchPrev;
    if (clientX > innerWidth * (1 - edge)) return touchNext;
    return null;
  }

  function navigate(button) {
    if (!button || button.disabled || zoomed()) return false;
    clearTap();
    button.click();
    return true;
  }

  function isDoubleTap(clientX, clientY, canZoom) {
    return Boolean(canZoom && lastTap?.canZoom &&
      performance.now() - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE);
  }

  function rememberTap(clientX, clientY, canZoom) {
    clearTimeout(tapTimer);
    lastTap = { time: performance.now(), x: clientX, y: clientY, canZoom };
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      lastTap = null;
      toggleChrome();
    }, DOUBLE_TAP_MS + 20);
  }

  function ignoredTarget(target) {
    return target.closest?.('.viewer-bar,.viewer-collections,.viewer-info,dialog,.viewer-nav');
  }

  touchStage.addEventListener('pointerdown', event => {
    if (touchViewer.hidden || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    if (ignoredTarget(event.target)) return;

    const video = event.target.closest?.('#viewer-media video');
    if (!video) event.stopImmediatePropagation();
    else videoPointerIds.add(event.pointerId);

    const imageHit = Boolean(event.target.closest?.('#viewer-media img'));
    const startedZoomed = zoomed();
    const doubleCandidate = isDoubleTap(event.clientX, event.clientY, imageHit);

    // Zoom-out is atomic. Once the second tap is recognized while zoomed, do
    // the reset immediately and consume the rest of this pointer sequence so
    // it can never fall through into pan, swipe, navigation, or another tap.
    if (startedZoomed && doubleCandidate) {
      clearTap();
      consumedPointers.add(event.pointerId);
      resetZoom(true);
      event.preventDefault();
      return;
    }

    const rect = video?.getBoundingClientRect();
    const point = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      startedZoomed,
      image: imageHit,
      video: Boolean(video),
      videoControls: Boolean(rect && event.clientY >= rect.bottom - Math.min(64, rect.height * .22)),
      doubleCandidate: false,
      captured: false
    };

    // Side taps at fit are always navigation and never participate in zoom.
    if (!(!point.startedZoomed && sideButton(event.clientX, Boolean(video)))) {
      point.doubleCandidate = doubleCandidate;
    }
    if (point.doubleCandidate) {
      clearTimeout(tapTimer);
      tapTimer = 0;
    }

    pointers.set(event.pointerId, point);

    if (pointers.size >= 2 && beginPinch()) {
      event.preventDefault();
      return;
    }

    if (point.startedZoomed && imageHit) {
      pan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        zoomX: zoom.x,
        zoomY: zoom.y,
        active: false
      };
      try {
        touchStage.setPointerCapture(event.pointerId);
        point.captured = true;
      } catch {}
      event.preventDefault();
    }
  }, true);

  touchStage.addEventListener('pointermove', event => {
    if (consumedPointers.has(event.pointerId)) {
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }

    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (!point.video) event.stopImmediatePropagation();
    point.x = event.clientX;
    point.y = event.clientY;

    if (pointers.size >= 2) {
      if (!pinch) beginPinch();
      updatePinch();
      event.preventDefault();
      return;
    }

    const dx = event.clientX - point.startX;
    const dy = event.clientY - point.startY;
    const travel = Math.hypot(dx, dy);

    if (!point.startedZoomed) {
      // A real swipe after a tap ends the pending double-tap sequence.
      if (point.doubleCandidate && travel >= TAP_TRAVEL) {
        point.doubleCandidate = false;
        clearTap();
      }
      return;
    }

    if (!pan || pan.pointerId !== event.pointerId) return;
    if (!pan.active && travel < PAN_START) return;
    if (!pan.active) {
      pan.active = true;
      point.doubleCandidate = false;
      clearTap();
    }
    zoom.x = pan.zoomX + dx;
    zoom.y = pan.zoomY + dy;
    applyZoom();
    event.preventDefault();
  }, true);

  touchStage.addEventListener('pointerup', event => {
    if (consumedPointers.has(event.pointerId)) {
      consumedPointers.delete(event.pointerId);
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }

    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (!point.video) event.stopImmediatePropagation();

    const dx = event.clientX - point.startX;
    const dy = event.clientY - point.startY;
    const travel = Math.hypot(dx, dy);
    const duration = Math.max(1, performance.now() - point.startedAt);
    const wasPinching = Boolean(pinch) || pointers.size > 1;
    const wasPanning = pan?.pointerId === event.pointerId && pan.active;

    pointers.delete(event.pointerId);
    if (pan?.pointerId === event.pointerId) pan = null;
    if (point.captured) {
      try { touchStage.releasePointerCapture(event.pointerId); } catch {}
    }

    if (wasPinching) {
      pointers.clear();
      pinch = null;
      pan = null;
      clearTap();
      if (zoom.scale <= 1.03) resetZoom(true);
      event.preventDefault();
      return;
    }
    if (pointers.size < 2) pinch = null;

    if (wasPanning) {
      clearTap();
      event.preventDefault();
      return;
    }

    if (point.startedZoomed) {
      if (travel >= PAN_START) {
        clearTap();
        event.preventDefault();
        return;
      }
      rememberTap(event.clientX, event.clientY, point.image);
      event.preventDefault();
      return;
    }

    if (point.doubleCandidate && travel < TAP_TRAVEL) {
      clearTap();
      zoomIn(event.clientX, event.clientY);
      event.preventDefault();
      return;
    }

    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const swipe = horizontal && (Math.abs(dx) >= 26 || (Math.abs(dx) >= 16 && velocity >= .18));
    if (swipe && !point.videoControls) {
      clearTap();
      navigate(dx < 0 ? touchNext : touchPrev);
      event.preventDefault();
      return;
    }

    if (travel > TAP_TRAVEL) {
      clearTap();
      return;
    }

    if (point.video) {
      clearTap();
      if (!point.videoControls) {
        const button = sideButton(event.clientX, true);
        if (navigate(button)) event.preventDefault();
      }
      return;
    }

    const side = sideButton(event.clientX);
    if (navigate(side)) {
      event.preventDefault();
      return;
    }

    rememberTap(event.clientX, event.clientY, point.image);
    event.preventDefault();
  }, true);

  touchStage.addEventListener('pointercancel', event => {
    if (consumedPointers.has(event.pointerId)) {
      consumedPointers.delete(event.pointerId);
      event.stopImmediatePropagation();
      return;
    }

    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (!point.video) event.stopImmediatePropagation();
    pointers.delete(event.pointerId);
    if (pan?.pointerId === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    clearTap();
  }, true);

  // Let native video controls receive the event first, then stop the legacy
  // viewer listener from interpreting the same touch a second time.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    touchStage.addEventListener(type, event => {
      if (!videoPointerIds.has(event.pointerId)) return;
      event.stopImmediatePropagation();
      if (type === 'pointerup' || type === 'pointercancel') videoPointerIds.delete(event.pointerId);
    });
  }

  new MutationObserver(() => {
    consumedPointers.clear();
    resetZoom();
  }).observe(touchMedia, { childList: true });
  new MutationObserver(() => {
    if (touchViewer.hidden) {
      consumedPointers.clear();
      resetZoom();
    }
  }).observe(touchViewer, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', () => {
    if (zoomed()) applyZoom();
  }, { passive: true });

  document.addEventListener('keydown', event => {
    if (!zoomed() || event.altKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}
