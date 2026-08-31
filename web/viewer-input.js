const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const media = document.querySelector('#viewer-media');
const prev = document.querySelector('#viewer-prev');
const next = document.querySelector('#viewer-next');

if (viewer && stage && media && prev && next) {
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_DISTANCE = 44;
  const TAP_TRAVEL = 14;
  const PAN_START = 16;
  const DOUBLE_TAP_PAN_CANCEL = 30;
  const SIDE_EDGE = .36;
  const VIDEO_EDGE = .22;
  const MAX_SCALE = 4;

  const style = document.createElement('style');
  style.textContent = `
    #viewer-media img{
      user-select:none;
      -webkit-user-select:none;
      -webkit-user-drag:none;
      touch-action:none;
    }
    .viewer-stage.viewer-image-zoomed .viewer-nav{
      opacity:0!important;
      pointer-events:none!important;
    }
    .viewer-stage.viewer-desktop-panning .viewer-media>img{cursor:grabbing}
    @media(hover:hover) and (pointer:fine){
      .viewer-stage.viewer-image-zoomed .viewer-media>img{cursor:grab;will-change:transform}
    }
  `;
  document.head.append(style);

  let zoom = { scale: 1, x: 0, y: 0 };
  let mousePan = null;
  let mouseClickTimer = 0;
  let touchGesture = null;
  let touchPinch = null;
  let lastTouchTap = null;
  let touchTapTimer = 0;

  const image = () => media.querySelector('img');
  const zoomed = () => zoom.scale > 1.01;
  const toggleChrome = () => window.mochimonoViewerControls?.toggle();

  function clearMouseClick() {
    clearTimeout(mouseClickTimer);
    mouseClickTimer = 0;
  }

  function clearTouchTap() {
    clearTimeout(touchTapTimer);
    touchTapTimer = 0;
    lastTouchTap = null;
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
    stage.classList.toggle('viewer-image-zoomed', active);
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
    mousePan = null;
    touchGesture = null;
    touchPinch = null;
    clearTouchTap();
    stage.classList.remove('viewer-desktop-panning');
    applyZoom(animate);
  }

  function naturalScale(current) {
    const scale = Math.max(
      Number(current.naturalWidth || 0) / Math.max(1, current.clientWidth),
      Number(current.naturalHeight || 0) / Math.max(1, current.clientHeight)
    );
    return Math.max(2.25, Math.min(MAX_SCALE, scale || 2.25));
  }

  function setScaleAt(nextScale, clientX, clientY, animate = false) {
    const current = image();
    if (!current) return;
    const oldScale = zoom.scale;
    const scale = Math.max(1, Math.min(MAX_SCALE, nextScale));
    if (scale <= 1.01) {
      resetZoom(animate);
      return;
    }
    const offsetX = clientX - innerWidth / 2;
    const offsetY = clientY - innerHeight / 2;
    const anchorX = (offsetX - zoom.x) / oldScale;
    const anchorY = (offsetY - zoom.y) / oldScale;
    zoom.scale = scale;
    zoom.x = offsetX - anchorX * scale;
    zoom.y = offsetY - anchorY * scale;
    applyZoom(animate);
  }

  function toggleZoom(clientX, clientY) {
    const current = image();
    if (!current) return;
    if (zoomed()) {
      resetZoom(true);
      return;
    }
    setScaleAt(naturalScale(current), clientX, clientY, true);
  }

  function activeUi(target) {
    return target?.closest?.('.viewer-nav,.viewer-bar,.viewer-collections,.viewer-info,dialog');
  }

  function sideButton(clientX, video = false) {
    const edge = video ? VIDEO_EDGE : SIDE_EDGE;
    if (clientX < innerWidth * edge) return prev;
    if (clientX > innerWidth * (1 - edge)) return next;
    return null;
  }

  function navigate(button) {
    if (!button || button.disabled || zoomed()) return false;
    clearTouchTap();
    button.click();
    return true;
  }

  function protectImages() {
    for (const item of media.querySelectorAll('img')) item.draggable = false;
  }

  protectImages();
  media.addEventListener('dragstart', event => {
    if (event.target.closest?.('img')) event.preventDefault();
  });
  media.addEventListener('selectstart', event => {
    if (event.target.closest?.('img')) event.preventDefault();
  });

  // Desktop: the browser's dblclick event is reliable as long as we do not
  // consume the two underlying clicks. Single image clicks wait briefly so a
  // double-click can win without flashing the chrome.
  stage.addEventListener('dblclick', event => {
    if (viewer.hidden || event.button > 0 || !event.target.closest?.('#viewer-media img')) return;
    clearMouseClick();
    window.getSelection()?.removeAllRanges();
    toggleZoom(event.clientX, event.clientY);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  stage.addEventListener('click', event => {
    if (viewer.hidden || event.button > 0 || activeUi(event.target)) return;
    if (event.target.closest?.('video')) return;
    if (event.target.closest?.('#viewer-media img')) {
      clearMouseClick();
      if (event.detail >= 2) return;
      mouseClickTimer = setTimeout(() => {
        mouseClickTimer = 0;
        if (!viewer.hidden) toggleChrome();
      }, DOUBLE_TAP_MS + 20);
      return;
    }
    toggleChrome();
  });

  stage.addEventListener('wheel', event => {
    if (viewer.hidden || !image() || activeUi(event.target)) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const delta = event.deltaY * multiplier;
    const sensitivity = event.ctrlKey ? .006 : .0015;
    setScaleAt(zoom.scale * Math.exp(-delta * sensitivity), event.clientX, event.clientY);
    clearMouseClick();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { passive: false, capture: true });

  stage.addEventListener('pointerdown', event => {
    if (viewer.hidden || event.pointerType !== 'mouse' || event.button !== 0 || !zoomed()) return;
    if (!event.target.closest?.('#viewer-media img')) return;
    mousePan = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: zoom.x,
      startY: zoom.y,
      active: false
    };
    window.getSelection()?.removeAllRanges();
  }, true);

  stage.addEventListener('pointermove', event => {
    if (!mousePan || event.pointerId !== mousePan.id) return;
    const dx = event.clientX - mousePan.x;
    const dy = event.clientY - mousePan.y;
    if (!mousePan.active && Math.hypot(dx, dy) < 5) return;
    if (!mousePan.active) {
      mousePan.active = true;
      clearMouseClick();
      try { stage.setPointerCapture(event.pointerId); } catch {}
      stage.classList.add('viewer-desktop-panning');
    }
    zoom.x = mousePan.startX + dx;
    zoom.y = mousePan.startY + dy;
    applyZoom();
    event.preventDefault();
  }, true);

  stage.addEventListener('pointerup', event => {
    if (!mousePan || event.pointerId !== mousePan.id) return;
    const active = mousePan.active;
    mousePan = null;
    stage.classList.remove('viewer-desktop-panning');
    if (!active) return;
    try { stage.releasePointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  stage.addEventListener('pointercancel', event => {
    if (mousePan?.id !== event.pointerId) return;
    mousePan = null;
    stage.classList.remove('viewer-desktop-panning');
  }, true);

  function touchPoint(touch) {
    return { x: touch.clientX, y: touch.clientY };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function beginPinch(event) {
    if (event.touches.length < 2 || !image()) return false;
    const a = touchPoint(event.touches[0]);
    const b = touchPoint(event.touches[1]);
    const centerX = (a.x + b.x) / 2;
    const centerY = (a.y + b.y) / 2;
    touchPinch = {
      distance: Math.max(1, distance(a, b)),
      scale: zoom.scale,
      anchorX: (centerX - innerWidth / 2 - zoom.x) / zoom.scale,
      anchorY: (centerY - innerHeight / 2 - zoom.y) / zoom.scale
    };
    touchGesture = null;
    clearTouchTap();
    return true;
  }

  stage.addEventListener('touchstart', event => {
    if (viewer.hidden || activeUi(event.target)) return;
    if (event.touches.length >= 2 && event.target.closest?.('#viewer-media img')) {
      beginPinch(event);
      event.preventDefault();
      return;
    }
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    const currentImage = Boolean(event.target.closest?.('#viewer-media img'));
    const video = event.target.closest?.('#viewer-media video');
    const rect = video?.getBoundingClientRect();
    const now = performance.now();
    const doubleCandidate = Boolean(currentImage && lastTouchTap?.image &&
      now - lastTouchTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(touch.clientX - lastTouchTap.x, touch.clientY - lastTouchTap.y) <= DOUBLE_TAP_DISTANCE);

    if (doubleCandidate) clearTimeout(touchTapTimer);
    touchGesture = {
      x: touch.clientX,
      y: touch.clientY,
      startX: touch.clientX,
      startY: touch.clientY,
      startedAt: now,
      image: currentImage,
      video: Boolean(video),
      videoControls: Boolean(rect && touch.clientY >= rect.bottom - Math.min(64, rect.height * .22)),
      startedZoomed: zoomed(),
      doubleCandidate,
      panActive: false,
      startZoomX: zoom.x,
      startZoomY: zoom.y
    };
  }, { passive: false });

  stage.addEventListener('touchmove', event => {
    if (viewer.hidden) return;
    if (event.touches.length >= 2 && image()) {
      if (!touchPinch && !beginPinch(event)) return;
      const a = touchPoint(event.touches[0]);
      const b = touchPoint(event.touches[1]);
      const centerX = (a.x + b.x) / 2;
      const centerY = (a.y + b.y) / 2;
      const scale = Math.max(1, Math.min(MAX_SCALE, touchPinch.scale * distance(a, b) / touchPinch.distance));
      zoom.scale = scale;
      zoom.x = centerX - innerWidth / 2 - touchPinch.anchorX * scale;
      zoom.y = centerY - innerHeight / 2 - touchPinch.anchorY * scale;
      applyZoom();
      event.preventDefault();
      return;
    }

    if (!touchGesture || event.touches.length !== 1) return;
    const touch = event.touches[0];
    touchGesture.x = touch.clientX;
    touchGesture.y = touch.clientY;
    const dx = touch.clientX - touchGesture.startX;
    const dy = touch.clientY - touchGesture.startY;
    const travel = Math.hypot(dx, dy);

    if (!touchGesture.startedZoomed) {
      if (touchGesture.doubleCandidate && travel >= TAP_TRAVEL) {
        touchGesture.doubleCandidate = false;
        clearTouchTap();
      }
      if (travel >= TAP_TRAVEL && !touchGesture.videoControls) event.preventDefault();
      return;
    }

    if (!touchGesture.image) return;
    const threshold = touchGesture.doubleCandidate ? DOUBLE_TAP_PAN_CANCEL : PAN_START;
    if (!touchGesture.panActive && travel < threshold) return;
    if (!touchGesture.panActive) {
      touchGesture.panActive = true;
      touchGesture.doubleCandidate = false;
      clearTouchTap();
    }
    zoom.x = touchGesture.startZoomX + dx;
    zoom.y = touchGesture.startZoomY + dy;
    applyZoom();
    event.preventDefault();
  }, { passive: false });

  stage.addEventListener('touchend', event => {
    if (viewer.hidden) return;
    if (touchPinch) {
      if (event.touches.length < 2) {
        touchPinch = null;
        touchGesture = null;
        clearTouchTap();
        if (zoom.scale <= 1.03) resetZoom(true);
      }
      event.preventDefault();
      return;
    }
    if (!touchGesture || event.changedTouches.length !== 1) return;

    const gesture = touchGesture;
    touchGesture = null;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;
    const travel = Math.hypot(dx, dy);
    const duration = Math.max(1, performance.now() - gesture.startedAt);

    if (gesture.panActive) {
      clearTouchTap();
      event.preventDefault();
      return;
    }

    if (gesture.doubleCandidate) {
      const limit = gesture.startedZoomed ? DOUBLE_TAP_PAN_CANCEL : TAP_TRAVEL;
      if (travel < limit) {
        clearTouchTap();
        toggleZoom(touch.clientX, touch.clientY);
        event.preventDefault();
        return;
      }
      clearTouchTap();
    }

    if (gesture.startedZoomed || zoomed()) {
      if (travel > TAP_TRAVEL) {
        clearTouchTap();
        return;
      }
      lastTouchTap = { time: performance.now(), x: touch.clientX, y: touch.clientY, image: gesture.image };
      clearTimeout(touchTapTimer);
      touchTapTimer = setTimeout(() => {
        touchTapTimer = 0;
        lastTouchTap = null;
        if (!viewer.hidden) toggleChrome();
      }, DOUBLE_TAP_MS + 20);
      event.preventDefault();
      return;
    }

    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const swipe = horizontal && (Math.abs(dx) >= 26 || (Math.abs(dx) >= 16 && velocity >= .18));
    if (swipe && !gesture.videoControls) {
      clearTouchTap();
      navigate(dx < 0 ? next : prev);
      event.preventDefault();
      return;
    }

    if (travel > TAP_TRAVEL) {
      clearTouchTap();
      return;
    }

    if (gesture.video) {
      clearTouchTap();
      const button = gesture.videoControls ? null : sideButton(touch.clientX, true);
      if (navigate(button)) event.preventDefault();
      return;
    }

    const button = sideButton(touch.clientX, false);
    if (navigate(button)) {
      event.preventDefault();
      return;
    }

    lastTouchTap = { time: performance.now(), x: touch.clientX, y: touch.clientY, image: gesture.image };
    clearTimeout(touchTapTimer);
    touchTapTimer = setTimeout(() => {
      touchTapTimer = 0;
      lastTouchTap = null;
      if (!viewer.hidden) toggleChrome();
    }, DOUBLE_TAP_MS + 20);
    event.preventDefault();
  }, { passive: false });

  stage.addEventListener('touchcancel', () => {
    touchGesture = null;
    touchPinch = null;
    clearTouchTap();
  });

  new MutationObserver(() => {
    protectImages();
    resetZoom();
    clearMouseClick();
  }).observe(media, { childList: true, subtree: true });

  new MutationObserver(() => {
    if (viewer.hidden) {
      resetZoom();
      clearMouseClick();
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
