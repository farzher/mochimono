const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const media = document.querySelector('#viewer-media');
const prev = document.querySelector('#viewer-prev');
const next = document.querySelector('#viewer-next');

// Keep the legacy navigation buttons only as internal command targets for
// keyboard/swipe navigation. They should never be visible or tappable.
const navStyle = document.createElement('style');
navStyle.textContent = '#viewer-prev,#viewer-next{display:none!important;pointer-events:none!important}';
document.head.append(navStyle);

if (viewer && stage && media && prev && next) {
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_DISTANCE = 44;
  const TAP_TRAVEL = 14;
  const PAN_START = 22;

  const pointers = new Map();
  let pan = null;
  let pinch = null;
  let lastTap = null;
  let tapTimer = 0;
  let consumedPointer = null;

  const image = () => media.querySelector('img');
  const pixelZoom = () => window.mochimonoViewerPixelZoom || null;
  const pixelState = () => pixelZoom()?.state?.() || { relativeScale:1, scale:1, fit:1, x:0, y:0, ready:false };
  const zoomed = () => Boolean(pixelZoom()?.zoomed?.() || pixelState().relativeScale > 1.01);

  function clearTap() {
    clearTimeout(tapTimer);
    tapTimer = 0;
    lastTap = null;
  }

  function clearInteraction() {
    consumedPointer = null;
    pan = null;
    pinch = null;
    pointers.clear();
    clearTap();
    stage.classList.remove('viewer-touch-zoomed');
  }

  function resetZoom(animate = false) {
    clearInteraction();
    pixelZoom()?.reset?.(animate);
  }

  function toggleControls() {
    window.mochimonoViewerControls?.toggle();
  }

  function zoomIn(clientX, clientY) {
    const pixels = pixelZoom();
    const current = image();
    if (!pixels || !current || zoomed()) return;
    clearTap();
    const scale = pixels.naturalScale?.(current);
    if (Number.isFinite(scale)) pixels.setScaleAt?.(scale, clientX, clientY, true);
  }

  function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
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
    return target.closest?.('.viewer-bar,.viewer-collections,.viewer-info,dialog');
  }

  function beginPinch() {
    const values = [...pointers.values()].filter(point => point.image);
    const state = pixelState();
    if (values.length < 2 || !image() || !state.ready) return false;
    const [a, b] = values;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const relativeScale = Math.max(1, Number(state.relativeScale) || 1);
    pinch = {
      distance: Math.max(1, pointDistance(a, b)),
      scale: relativeScale,
      anchorX: (cx - innerWidth / 2 - state.x) / relativeScale,
      anchorY: (cy - innerHeight / 2 - state.y) / relativeScale
    };
    pan = null;
    clearTap();
    stage.classList.add('viewer-touch-zoomed');
    return true;
  }

  function updatePinch() {
    const values = [...pointers.values()].filter(point => point.image);
    if (!pinch || values.length < 2) return;
    const [a, b] = values;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const relativeScale = Math.max(1, pinch.scale * pointDistance(a, b) / pinch.distance);
    pixelZoom()?.set?.({
      relativeScale,
      x: cx - innerWidth / 2 - pinch.anchorX * relativeScale,
      y: cy - innerHeight / 2 - pinch.anchorY * relativeScale
    });
  }

  stage.addEventListener('pointerdown', event => {
    if (viewer.hidden || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    if (ignoredTarget(event.target)) return;

    const imageHit = Boolean(event.target.closest?.('#viewer-media img'));
    const video = event.target.closest?.('#viewer-media video');
    const startedZoomed = zoomed();

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
      moved: false
    };
    pointers.set(event.pointerId, point);

    if (pointers.size >= 2 && beginPinch()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (startedZoomed && imageHit) {
      const state = pixelState();
      pan = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        zoomX: state.x,
        zoomY: state.y,
        relativeScale: state.relativeScale,
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
        pan.startX = event.clientX;
        pan.startY = event.clientY;
        pan.zoomX = pixelState().x;
        pan.zoomY = pixelState().y;
        clearTap();
        stage.classList.add('viewer-touch-zoomed');
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      pixelZoom()?.set?.({
        relativeScale: pan.relativeScale,
        x: pan.zoomX + event.clientX - pan.startX,
        y: pan.zoomY + event.clientY - pan.startY
      });
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

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
      stage.classList.toggle('viewer-touch-zoomed', zoomed());
      if (!zoomed()) pixelZoom()?.reset?.(true);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (pointers.size < 2) pinch = null;

    if (wasPanning) {
      clearTap();
      stage.classList.toggle('viewer-touch-zoomed', zoomed());
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (point.startedZoomed) {
      if (travel >= PAN_START) clearTap();
      else rememberTap(event.clientX, event.clientY);
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
      return;
    }

    if (point.image && isDoubleTap(event.clientX, event.clientY)) {
      clearTap();
      zoomIn(event.clientX, event.clientY);
      stage.classList.toggle('viewer-touch-zoomed', zoomed());
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
    stage.classList.toggle('viewer-touch-zoomed', zoomed());
  }, true);

  new MutationObserver(clearInteraction).observe(media, { childList: true });
  new MutationObserver(() => {
    if (viewer.hidden) clearInteraction();
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  document.addEventListener('keydown', event => {
    if (viewer.hidden || !zoomed() || event.altKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}
