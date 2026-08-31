const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const media = document.querySelector('#viewer-media');

if (viewer && stage && media) {
  const MIN_SCALE = 1;
  const MAX_SCALE = 4;
  const PAN_START = 5;
  const DOUBLE_CLICK_MS = 380;
  const DOUBLE_CLICK_DISTANCE = 44;

  let zoom = { scale: 1, x: 0, y: 0 };
  let press = null;
  let lastClick = null;
  let clickTimer = 0;

  const image = () => media.querySelector('img');
  const zoomed = () => zoom.scale > 1.01;
  const toggleChrome = () => window.mochimonoViewerControls?.toggle();

  const style = document.createElement('style');
  style.textContent = `
    #viewer-media img{
      user-select:none;
      -webkit-user-select:none;
      -webkit-user-drag:none;
    }
    .viewer-stage.viewer-desktop-zoomed .viewer-media>img{cursor:grab;will-change:transform}
    .viewer-stage.viewer-desktop-panning .viewer-media>img{cursor:grabbing}
  `;
  document.head.append(style);

  function protectImages() {
    for (const item of media.querySelectorAll('img')) item.draggable = false;
  }

  function clearClick() {
    clearTimeout(clickTimer);
    clickTimer = 0;
    lastClick = null;
  }

  function cancelPendingChrome() {
    clearTimeout(clickTimer);
    clickTimer = 0;
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
    stage.classList.toggle('viewer-desktop-zoomed', active);
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
    press = null;
    clearClick();
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
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    if (scale <= 1.01) return resetZoom(animate);

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
    if (zoomed()) resetZoom(true);
    else setScaleAt(naturalScale(current), clientX, clientY, true);
  }

  function activeUi(target) {
    return target.closest?.('.viewer-nav,.viewer-bar,.viewer-collections,.viewer-info,dialog,video');
  }

  function rememberSingleClick(clientX, clientY) {
    lastClick = { time: performance.now(), x: clientX, y: clientY };
    cancelPendingChrome();
    clickTimer = setTimeout(() => {
      clickTimer = 0;
      lastClick = null;
      if (!viewer.hidden) toggleChrome();
    }, DOUBLE_CLICK_MS + 20);
  }

  protectImages();
  new MutationObserver(() => {
    protectImages();
    resetZoom();
  }).observe(media, { childList: true, subtree: true });

  media.addEventListener('dragstart', event => {
    if (event.target.closest?.('img')) event.preventDefault();
  });
  media.addEventListener('selectstart', event => {
    if (event.target.closest?.('img')) event.preventDefault();
  });

  stage.addEventListener('pointerdown', event => {
    if (viewer.hidden || event.pointerType !== 'mouse' || event.button !== 0) return;
    if (activeUi(event.target)) return;
    const imageHit = Boolean(event.target.closest?.('#viewer-media img'));
    if (!imageHit) return;

    const doubleCandidate = Boolean(lastClick &&
      performance.now() - lastClick.time <= DOUBLE_CLICK_MS &&
      Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) <= DOUBLE_CLICK_DISTANCE);
    if (doubleCandidate) cancelPendingChrome();

    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startZoomX: zoom.x,
      startZoomY: zoom.y,
      startedZoomed: zoomed(),
      doubleCandidate,
      panning: false
    };
    window.getSelection()?.removeAllRanges();
    event.preventDefault();
  }, true);

  stage.addEventListener('pointermove', event => {
    if (!press || event.pointerId !== press.pointerId) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!press.startedZoomed || press.doubleCandidate || (!press.panning && Math.hypot(dx, dy) < PAN_START)) return;

    if (!press.panning) {
      press.panning = true;
      clearClick();
      try { stage.setPointerCapture(event.pointerId); } catch {}
      stage.classList.add('viewer-desktop-panning');
    }
    zoom.x = press.startZoomX + dx;
    zoom.y = press.startZoomY + dy;
    applyZoom();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  stage.addEventListener('pointerup', event => {
    if (!press || event.pointerId !== press.pointerId) return;
    const current = press;
    press = null;
    const travel = Math.hypot(event.clientX - current.x, event.clientY - current.y);
    stage.classList.remove('viewer-desktop-panning');
    try { stage.releasePointerCapture(event.pointerId); } catch {}

    if (current.panning) {
      clearClick();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (travel > PAN_START) {
      clearClick();
      event.preventDefault();
      return;
    }

    if (current.doubleCandidate) {
      clearClick();
      toggleZoom(event.clientX, event.clientY);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    rememberSingleClick(event.clientX, event.clientY);
    event.preventDefault();
  }, true);

  stage.addEventListener('pointercancel', event => {
    if (!press || event.pointerId !== press.pointerId) return;
    press = null;
    stage.classList.remove('viewer-desktop-panning');
    clearClick();
  }, true);

  // We recognize the two clicks ourselves. Suppress the browser's native
  // dblclick behavior so it cannot select/drag the image or fire a second zoom.
  stage.addEventListener('dblclick', event => {
    if (!event.target.closest?.('#viewer-media img')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  // Blank viewer area toggles chrome immediately. Image clicks are handled by
  // the pointer state machine above so a double-click never flashes the UI.
  stage.addEventListener('click', event => {
    if (viewer.hidden || event.button > 0 || activeUi(event.target)) return;
    if (event.target.closest?.('#viewer-media img')) {
      event.preventDefault();
      return;
    }
    toggleChrome();
  }, true);

  stage.addEventListener('wheel', event => {
    if (viewer.hidden || !image() || stage.classList.contains('viewer-touch-zoomed')) return;
    if (activeUi(event.target)) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const delta = event.deltaY * multiplier;
    const sensitivity = event.ctrlKey ? .006 : .0015;
    setScaleAt(zoom.scale * Math.exp(-delta * sensitivity), event.clientX, event.clientY);
    clearClick();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { passive: false, capture: true });

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
