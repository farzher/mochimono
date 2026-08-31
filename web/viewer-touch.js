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
  const ZOOMED_DOUBLE_TAP_CANCEL = 30;
  const SIDE_EDGE = .36;
  const VIDEO_EDGE = .22;
  const MAX_SCALE = 4;

  const style = document.createElement('style');
  style.textContent = `
    .viewer-stage.viewer-touch-image{touch-action:none}
    .viewer-stage.viewer-touch-image .viewer-media>img{touch-action:none}
  `;
  document.head.append(style);

  const pointers = new Map();
  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let pinch = null;
  let lastTap = null;
  let tapTimer = 0;

  const image = () => media.querySelector('img');
  const zoomed = () => zoom.scale > 1.01;
  const toggleChrome = () => window.mochimonoViewerControls?.toggle();

  function syncMediaMode() {
    stage.classList.toggle('viewer-touch-image', Boolean(image()));
  }

  function clearTap() {
    clearTimeout(tapTimer);
    tapTimer = 0;
    lastTap = null;
  }

  function cancelPendingChrome() {
    clearTimeout(tapTimer);
    tapTimer = 0;
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

  function isDoubleCandidate(clientX, clientY, imageHit) {
    if (!imageHit || !lastTap?.image) return false;
    return performance.now() - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE;
  }

  function beginPinch() {
    const values = [...pointers.values()].filter(point => point.image);
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
    if (clientX < innerWidth * edge) return prev;
    if (clientX > innerWidth * (1 - edge)) return next;
    return null;
  }

  function navigateAt(clientX, video = false) {
    if (zoomed()) return false;
    const button = sideButton(clientX, video);
    if (!button || button.disabled) return false;
    clearTap();
    button.click();
    return true;
  }

  function rememberSingleTap(point, clientX, clientY) {
    lastTap = { time: performance.now(), x: clientX, y: clientY, image: point.image };
    cancelPendingChrome();
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
    const imageHit = Boolean(event.target.closest?.('#viewer-media img'));
    const startedZoomed = zoomed();
    const point = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      image: imageHit,
      video: Boolean(video),
      videoControls: Boolean(rect && event.clientY >= rect.bottom - Math.min(64, rect.height * .22)),
      startedZoomed,
      doubleCandidate: isDoubleCandidate(event.clientX, event.clientY, imageHit)
    };

    // Side taps at fit are navigation, never the second half of a zoom gesture.
    if (!startedZoomed && sideButton(event.clientX, Boolean(video))) point.doubleCandidate = false;
    if (point.doubleCandidate) cancelPendingChrome();
    pointers.set(event.pointerId, point);

    // Image/background touches belong to Mochimono. Capture them immediately so
    // Android cannot turn a tap/swipe into pointercancel midway through it.
    // Video touches stay uncaptured so native play/seek controls keep working.
    if (!video) {
      try { stage.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
    }

    if ([...pointers.values()].filter(item => item.image).length >= 2) {
      beginPinch();
      event.preventDefault();
      return;
    }

    if (startedZoomed && imageHit) {
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

    const imagePointers = [...pointers.values()].filter(item => item.image);
    if (imagePointers.length >= 2) {
      if (!pinch) beginPinch();
      updatePinch();
      event.preventDefault();
      return;
    }

    const travel = Math.hypot(event.clientX - point.startX, event.clientY - point.startY);

    // At fit, moving past tap tolerance cancels a possible second tap so a
    // quick swipe after a tap can never become a zoom.
    if (!point.startedZoomed && point.doubleCandidate && travel >= TAP_TRAVEL) {
      point.doubleCandidate = false;
      clearTap();
    }

    if (!pan || pan.pointerId !== event.pointerId || !zoomed()) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    const threshold = pan.doubleCandidate ? ZOOMED_DOUBLE_TAP_CANCEL : PAN_START;
    if (!pan.active && Math.hypot(dx, dy) < threshold) return;

    if (!pan.active) {
      pan.active = true;
      pan.doubleCandidate = false;
      point.doubleCandidate = false;
      clearTap();
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
    const wasPinching = Boolean(pinch) || [...pointers.values()].filter(item => item.image).length > 1;
    const wasPanning = pan?.pointerId === event.pointerId && pan.active;

    pointers.delete(event.pointerId);
    if (pan?.pointerId === event.pointerId) pan = null;
    if ([...pointers.values()].filter(item => item.image).length < 2) pinch = null;
    if (!point.video) {
      try { stage.releasePointerCapture(event.pointerId); } catch {}
    }

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

    // A recognized second tap wins over pan jitter. Finishing either zoom-in or
    // zoom-out clears tap history, so the very next swipe starts fresh.
    if (point.doubleCandidate) {
      const limit = point.startedZoomed ? ZOOMED_DOUBLE_TAP_CANCEL : TAP_TRAVEL;
      if (travel < limit) {
        toggleZoom(event.clientX, event.clientY);
        clearTap();
        event.preventDefault();
        return;
      }
      clearTap();
    }

    if (point.startedZoomed || zoomed()) {
      if (travel > TAP_TRAVEL) {
        clearTap();
        return;
      }
      rememberSingleTap(point, event.clientX, event.clientY);
      event.preventDefault();
      return;
    }

    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const swipe = horizontal && (Math.abs(dx) >= 26 || (Math.abs(dx) >= 16 && velocity >= .18));

    if (swipe && !point.videoControls) {
      clearTap();
      const button = dx < 0 ? next : prev;
      if (!button?.disabled) button.click();
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

    rememberSingleTap(point, event.clientX, event.clientY);
    event.preventDefault();
  });

  stage.addEventListener('pointercancel', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    pointers.delete(event.pointerId);
    if (pan?.pointerId === event.pointerId) pan = null;
    if ([...pointers.values()].filter(item => item.image).length < 2) pinch = null;
    clearTap();
    if (!pointers.size && zoom.scale <= 1.03) resetZoom();
  });

  syncMediaMode();
  new MutationObserver(() => {
    pointers.clear();
    resetZoom();
    syncMediaMode();
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
