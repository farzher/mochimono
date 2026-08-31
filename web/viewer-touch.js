const touchViewer = document.querySelector('#viewer');
const touchStage = document.querySelector('#viewer-stage');
const touchMedia = document.querySelector('#viewer-media');
const touchPrev = document.querySelector('#viewer-prev');
const touchNext = document.querySelector('#viewer-next');

if (touchViewer && touchStage && touchMedia) {
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_DISTANCE = 44;
  const TAP_TRAVEL = 12;
  const PAN_START = 9;
  const DOUBLE_TAP_PAN_CANCEL = 30;
  const SIDE_EDGE = .36;
  const VIDEO_EDGE = .22;

  const touchActionStyle = document.createElement('style');
  touchActionStyle.textContent = `
    .viewer-stage{touch-action:pan-y!important}
    .viewer-stage.viewer-zoomed,.viewer-stage.viewer-touch-zoomed{touch-action:none!important}
  `;
  document.head.append(touchActionStyle);

  const pointers = new Map();
  const videoPointerIds = new Set();
  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let pinch = null;
  let lastTap = null;
  let tapTimer = 0;
  let suppressDoubleTapUntil = 0;

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
    return Math.max(2.25, Math.min(4, scale || 2.25));
  }

  function zoomAt(clientX, clientY) {
    const current = image();
    if (!current) return;
    if (zoomed()) {
      resetZoom(true);
      // A completed zoom-out ends the old tap sequence completely. Without a
      // short guard, the next small swipe/tap can be mistaken for another
      // double-tap and immediately zoom back in.
      suppressDoubleTapUntil = performance.now() + DOUBLE_TAP_MS + 80;
      return;
    }
    const scale = naturalScale(current);
    zoom.scale = scale;
    zoom.x = (1 - scale) * (clientX - innerWidth / 2);
    zoom.y = (1 - scale) * (clientY - innerHeight / 2);
    applyZoom(true);
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
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
    const scale = Math.max(1, Math.min(4, pinch.scale * distance(a, b) / pinch.distance));
    zoom.scale = scale;
    zoom.x = cx - innerWidth / 2 - pinch.anchorX * scale;
    zoom.y = cy - innerHeight / 2 - pinch.anchorY * scale;
    applyZoom();
  }

  function navigateAt(clientX, videoHit = false) {
    if (zoomed()) return false;
    const edge = videoHit ? VIDEO_EDGE : SIDE_EDGE;
    const button = clientX < innerWidth * edge
      ? touchPrev
      : clientX > innerWidth * (1 - edge)
        ? touchNext
        : null;
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }

  function scheduleChromeTap(clientX, clientY, canZoom) {
    const now = performance.now();
    const isDouble = Boolean(canZoom && now >= suppressDoubleTapUntil && lastTap?.canZoom &&
      now - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(clientX - lastTap.x, clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE);

    clearTimeout(tapTimer);
    tapTimer = 0;

    if (isDouble) {
      lastTap = null;
      zoomAt(clientX, clientY);
      return;
    }

    lastTap = { time: now, x: clientX, y: clientY, canZoom };
    tapTimer = setTimeout(() => {
      tapTimer = 0;
      lastTap = null;
      if (!touchViewer.hidden) toggleChrome();
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

    const rect = video?.getBoundingClientRect();
    const controlBand = rect ? Math.min(64, rect.height * .22) : 0;
    const point = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      image: Boolean(event.target.closest?.('#viewer-media img')),
      video: Boolean(video),
      videoControls: Boolean(rect && event.clientY >= rect.bottom - controlBand)
    };
    point.doubleCandidate = Boolean(point.image && performance.now() >= suppressDoubleTapUntil && lastTap?.canZoom &&
      performance.now() - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE);
    if (point.doubleCandidate) {
      clearTimeout(tapTimer);
      tapTimer = 0;
    }
    pointers.set(event.pointerId, point);

    if (pointers.size >= 2) {
      beginPinch();
      event.preventDefault();
      return;
    }

    if (zoomed()) {
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
  }, true);

  touchStage.addEventListener('pointermove', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (!point.video) event.stopImmediatePropagation();
    point.x = event.clientX;
    point.y = event.clientY;
    const dx = event.clientX - point.startX;
    const dy = event.clientY - point.startY;
    const travel = Math.hypot(dx, dy);

    if (pointers.size >= 2) {
      if (!pinch) beginPinch();
      updatePinch();
      event.preventDefault();
      return;
    }

    // Once a fit-mode touch clearly becomes a swipe, it cannot remain the
    // second half of any pending double-tap sequence.
    if (!zoomed() && point.doubleCandidate && travel >= TAP_TRAVEL) {
      point.doubleCandidate = false;
      clearTap();
    }

    if (pan?.pointerId === event.pointerId && zoomed()) {
      const threshold = pan.doubleCandidate ? DOUBLE_TAP_PAN_CANCEL : PAN_START;
      if (!pan.active && travel >= threshold) {
        pan.active = true;
        pan.doubleCandidate = false;
        point.doubleCandidate = false;
        clearTap();
      }
      if (!pan.active) return;
      zoom.x = pan.startX + dx;
      zoom.y = pan.startY + dy;
      applyZoom();
      event.preventDefault();
    }
  }, true);

  touchStage.addEventListener('pointerup', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (!point.video) event.stopImmediatePropagation();

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
      scheduleChromeTap(event.clientX, event.clientY, Boolean(image()));
      event.preventDefault();
      return;
    }

    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const swipe = horizontal && (Math.abs(dx) >= 26 || (Math.abs(dx) >= 16 && velocity >= .18));

    if (swipe && !point.videoControls) {
      clearTap();
      const button = dx < 0 ? touchNext : touchPrev;
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

    if (navigateAt(event.clientX, false)) {
      clearTap();
      event.preventDefault();
      return;
    }

    scheduleChromeTap(event.clientX, event.clientY, point.image);
    event.preventDefault();
  }, true);

  touchStage.addEventListener('pointercancel', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (!point.video) event.stopImmediatePropagation();
    pointers.delete(event.pointerId);
    if (pan?.pointerId === event.pointerId) pan = null;
    if (pointers.size < 2) pinch = null;
    clearTap();
    if (!pointers.size && zoom.scale <= 1.03) resetZoom();
  }, true);

  // Video pointer events must reach the native player, so they are not stopped
  // during capture. Stop them here on the way back up, before the legacy
  // viewer gesture handlers get a second chance to interpret the same touch.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    touchStage.addEventListener(type, event => {
      if (!videoPointerIds.has(event.pointerId)) return;
      event.stopImmediatePropagation();
      if (type === 'pointerup' || type === 'pointercancel') videoPointerIds.delete(event.pointerId);
    });
  }

  new MutationObserver(() => resetZoom()).observe(touchMedia, { childList: true });
  new MutationObserver(() => {
    if (touchViewer.hidden) resetZoom();
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
