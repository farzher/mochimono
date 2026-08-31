const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const media = document.querySelector('#viewer-media');
const prev = document.querySelector('#viewer-prev');
const next = document.querySelector('#viewer-next');

if (viewer && stage && media) {
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_DISTANCE = 44;
  const TAP_TRAVEL = 16;
  const PAN_START = 18;
  const DOUBLE_TAP_CANCEL = 32;
  const SIDE_EDGE = .36;
  const VIDEO_EDGE = .22;
  const MAX_SCALE = 4;

  const style = document.createElement('style');
  style.textContent = `
    .viewer-stage.viewer-touch-image{touch-action:none}
    .viewer-stage.viewer-touch-image .viewer-media>img{touch-action:none}
  `;
  document.head.append(style);

  let zoom = { scale: 1, x: 0, y: 0 };
  let gesture = null;
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

  function cancelChromeTimer() {
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
    gesture = null;
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

  function toggleZoom(clientX, clientY) {
    const current = image();
    if (!current) return;
    if (zoomed()) {
      resetZoom(true);
      return;
    }
    const scale = naturalScale(current);
    zoom.scale = scale;
    zoom.x = (1 - scale) * (clientX - innerWidth / 2);
    zoom.y = (1 - scale) * (clientY - innerHeight / 2);
    clearTap();
    applyZoom(true);
  }

  function distance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function touchById(list, id) {
    return [...list].find(item => item.identifier === id) || null;
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

  function rememberSingleTap(clientX, clientY, imageHit) {
    lastTap = { time: performance.now(), x: clientX, y: clientY, image: imageHit };
    cancelChromeTimer();
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      lastTap = null;
      if (!viewer.hidden) toggleChrome();
    }, DOUBLE_TAP_MS + 20);
  }

  function isDoubleCandidate(clientX, clientY, imageHit) {
    return Boolean(imageHit && lastTap?.image &&
      performance.now() - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE);
  }

  function ignoredTarget(target) {
    return target.closest?.('.viewer-bar,.viewer-collections,.viewer-info,dialog,.viewer-nav');
  }

  function startPinch(event) {
    const touches = [...event.touches].filter(touch => touch.target.closest?.('#viewer-media img'));
    if (touches.length < 2 || !image()) return false;
    const [a, b] = touches;
    const centerX = (a.clientX + b.clientX) / 2;
    const centerY = (a.clientY + b.clientY) / 2;
    const scale = zoom.scale;
    pinch = {
      distance: Math.max(1, distance(a, b)),
      scale,
      anchorX: (centerX - innerWidth / 2 - zoom.x) / scale,
      anchorY: (centerY - innerHeight / 2 - zoom.y) / scale
    };
    gesture = null;
    clearTap();
    return true;
  }

  function updatePinch(event) {
    if (!pinch) return false;
    const touches = [...event.touches].filter(touch => touch.target.closest?.('#viewer-media img'));
    if (touches.length < 2) return false;
    const [a, b] = touches;
    const centerX = (a.clientX + b.clientX) / 2;
    const centerY = (a.clientY + b.clientY) / 2;
    zoom.scale = Math.max(1, Math.min(MAX_SCALE, pinch.scale * distance(a, b) / pinch.distance));
    zoom.x = centerX - innerWidth / 2 - pinch.anchorX * zoom.scale;
    zoom.y = centerY - innerHeight / 2 - pinch.anchorY * zoom.scale;
    applyZoom();
    return true;
  }

  stage.addEventListener('touchstart', event => {
    if (viewer.hidden || ignoredTarget(event.target)) return;

    if (event.touches.length >= 2 && startPinch(event)) {
      if (event.cancelable) event.preventDefault();
      return;
    }

    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const video = event.target.closest?.('#viewer-media video');
    const rect = video?.getBoundingClientRect();
    const imageHit = Boolean(event.target.closest?.('#viewer-media img'));
    const startedZoomed = zoomed();
    const doubleCandidate = isDoubleCandidate(touch.clientX, touch.clientY, imageHit);

    gesture = {
      id: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      x: touch.clientX,
      y: touch.clientY,
      startedAt: performance.now(),
      image: imageHit,
      video: Boolean(video),
      videoControls: Boolean(rect && touch.clientY >= rect.bottom - Math.min(64, rect.height * .22)),
      startedZoomed,
      doubleCandidate,
      panning: false,
      startZoomX: zoom.x,
      startZoomY: zoom.y
    };

    if (!startedZoomed && sideButton(touch.clientX, Boolean(video))) gesture.doubleCandidate = false;
    if (gesture.doubleCandidate) cancelChromeTimer();

    // Keep native video controls native. Image/background gestures are fully
    // owned by the viewer while the image is displayed.
    if (!video && event.cancelable) event.preventDefault();
  }, { passive: false });

  stage.addEventListener('touchmove', event => {
    if (pinch) {
      if (updatePinch(event) && event.cancelable) event.preventDefault();
      return;
    }
    if (!gesture) return;
    const touch = touchById(event.touches, gesture.id);
    if (!touch) return;

    gesture.x = touch.clientX;
    gesture.y = touch.clientY;
    const dx = gesture.x - gesture.startX;
    const dy = gesture.y - gesture.startY;
    const travel = Math.hypot(dx, dy);

    if (!gesture.startedZoomed && gesture.doubleCandidate && travel >= TAP_TRAVEL) {
      gesture.doubleCandidate = false;
      clearTap();
    }

    if (gesture.startedZoomed && gesture.image) {
      const threshold = gesture.doubleCandidate ? DOUBLE_TAP_CANCEL : PAN_START;
      if (!gesture.panning && travel >= threshold) {
        gesture.panning = true;
        gesture.doubleCandidate = false;
        clearTap();
      }
      if (gesture.panning) {
        zoom.x = gesture.startZoomX + dx;
        zoom.y = gesture.startZoomY + dy;
        applyZoom();
      }
    }

    if (!gesture.video && event.cancelable) event.preventDefault();
  }, { passive: false });

  stage.addEventListener('touchend', event => {
    if (pinch) {
      if (event.touches.length < 2) {
        pinch = null;
        gesture = null;
        clearTap();
        if (zoom.scale <= 1.03) resetZoom(true);
      }
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (!gesture) return;
    const touch = touchById(event.changedTouches, gesture.id);
    if (!touch) return;

    const current = gesture;
    gesture = null;
    const dx = touch.clientX - current.startX;
    const dy = touch.clientY - current.startY;
    const travel = Math.hypot(dx, dy);
    const duration = Math.max(1, performance.now() - current.startedAt);

    if (current.panning) {
      clearTap();
      if (!current.video && event.cancelable) event.preventDefault();
      return;
    }

    if (current.doubleCandidate) {
      const limit = current.startedZoomed ? DOUBLE_TAP_CANCEL : TAP_TRAVEL;
      if (travel < limit) {
        toggleZoom(touch.clientX, touch.clientY);
        clearTap();
        if (event.cancelable) event.preventDefault();
        return;
      }
      clearTap();
    }

    if (current.startedZoomed || zoomed()) {
      if (travel <= TAP_TRAVEL) rememberSingleTap(touch.clientX, touch.clientY, current.image);
      else clearTap();
      if (event.cancelable) event.preventDefault();
      return;
    }

    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const swipe = horizontal && (Math.abs(dx) >= 26 || (Math.abs(dx) >= 16 && velocity >= .18));

    if (swipe && !current.videoControls) {
      clearTap();
      const button = dx < 0 ? next : prev;
      if (!button?.disabled) button.click();
      if (event.cancelable) event.preventDefault();
      return;
    }

    if (travel > TAP_TRAVEL) {
      clearTap();
      return;
    }

    if (current.video) {
      clearTap();
      if (!current.videoControls && navigateAt(touch.clientX, true) && event.cancelable) event.preventDefault();
      return;
    }

    if (navigateAt(touch.clientX)) {
      if (event.cancelable) event.preventDefault();
      return;
    }

    rememberSingleTap(touch.clientX, touch.clientY, current.image);
    if (event.cancelable) event.preventDefault();
  }, { passive: false });

  stage.addEventListener('touchcancel', () => {
    gesture = null;
    pinch = null;
    clearTap();
  }, { passive: true });

  syncMediaMode();
  new MutationObserver(() => {
    gesture = null;
    pinch = null;
    resetZoom();
    syncMediaMode();
  }).observe(media, { childList: true });

  new MutationObserver(() => {
    if (viewer.hidden) resetZoom();
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
