const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const viewerMedia = document.querySelector('#viewer-media');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');

const style = document.createElement('style');
style.textContent = `
  .viewer.viewer-ui-hidden{cursor:auto!important}
  .viewer.viewer-ui-hidden .viewer-bar{opacity:1!important}
  .viewer.viewer-ui-hidden .viewer-bar>*{pointer-events:auto!important}
  .viewer:not(.viewer-controls-hidden) .viewer-bar,
  .viewer:not(.viewer-controls-hidden) .viewer-collections{opacity:1!important}
  .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:.68!important;pointer-events:auto!important}
  .viewer.viewer-controls-hidden .viewer-bar,
  .viewer.viewer-controls-hidden .viewer-collections,
  .viewer.viewer-controls-hidden .viewer-nav{opacity:0!important;pointer-events:none!important}
  .viewer.viewer-controls-hidden .viewer-bar *,
  .viewer.viewer-controls-hidden .viewer-collections *{pointer-events:none!important}
  .viewer-collections{transition:opacity .18s ease}
  .viewer-stage.viewer-desktop-zoomed .viewer-media>img{cursor:grab;will-change:transform}
  .viewer-stage.viewer-desktop-panning .viewer-media>img{cursor:grabbing}
  .viewer-stage.viewer-desktop-zoomed .viewer-nav{opacity:0!important;pointer-events:none!important}
  @media(max-width:840px){
    .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:0!important;pointer-events:none!important}
  }
  @media(min-width:841px){
    .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:.68!important;pointer-events:auto!important}
    .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled):hover{opacity:1!important}
  }
`;
document.head.append(style);

function clearAutoFade() {
  viewer?.classList.remove('viewer-ui-hidden');
}

function showControls() {
  viewer?.classList.remove('viewer-controls-hidden');
  clearAutoFade();
}

function toggleControls() {
  if (!viewer || viewer.hidden) return;
  viewer.classList.toggle('viewer-controls-hidden');
  clearAutoFade();
}

if (viewer) {
  new MutationObserver(() => {
    clearAutoFade();
    if (!viewer.hidden && viewer.dataset.viewerWasHidden === '1') showControls();
    viewer.dataset.viewerWasHidden = viewer.hidden ? '1' : '0';
  }).observe(viewer, { attributes: true, attributeFilter: ['class', 'hidden'] });
  viewer.dataset.viewerWasHidden = viewer.hidden ? '1' : '0';
  clearAutoFade();
}

const desktopZoom = { scale: 1, x: 0, y: 0 };
let desktopNavState = null;
let desktopPan = null;
let suppressDesktopClick = false;
let desktopClickTimer = 0;

function desktopImage() {
  return viewerMedia?.querySelector('img') || null;
}

function desktopZoomed() {
  return desktopZoom.scale > 1.01;
}

function touchZoomed() {
  return stage?.classList.contains('viewer-zoomed') && !desktopZoomed();
}

function clampDesktopPan(scale = desktopZoom.scale, x = desktopZoom.x, y = desktopZoom.y) {
  const image = desktopImage();
  if (!image || scale <= 1) return { x: 0, y: 0 };
  const width = image.clientWidth * scale;
  const height = image.clientHeight * scale;
  return {
    x: Math.max(-(Math.max(0, width - innerWidth) / 2), Math.min(Math.max(0, width - innerWidth) / 2, x)),
    y: Math.max(-(Math.max(0, height - innerHeight) / 2), Math.min(Math.max(0, height - innerHeight) / 2, y))
  };
}

function lockDesktopNavigation(locked) {
  if (!viewerPrev || !viewerNext) return;
  if (locked) {
    if (!desktopNavState) desktopNavState = { prev: viewerPrev.disabled, next: viewerNext.disabled };
    viewerPrev.disabled = true;
    viewerNext.disabled = true;
    return;
  }
  if (!desktopNavState) return;
  viewerPrev.disabled = desktopNavState.prev;
  viewerNext.disabled = desktopNavState.next;
  desktopNavState = null;
}

function applyDesktopZoom(animate = false) {
  const image = desktopImage();
  const zoomed = desktopZoomed();
  stage?.classList.toggle('viewer-desktop-zoomed', zoomed);
  lockDesktopNavigation(zoomed);
  if (!image) return;
  const clamped = clampDesktopPan();
  desktopZoom.x = clamped.x;
  desktopZoom.y = clamped.y;
  image.style.transition = animate ? 'transform 160ms ease-out' : 'none';
  image.style.transform = zoomed
    ? `translate3d(${desktopZoom.x}px,${desktopZoom.y}px,0) scale(${desktopZoom.scale})`
    : '';
  if (animate) setTimeout(() => {
    if (image.isConnected) image.style.transition = '';
  }, 180);
}

function resetDesktopZoom(animate = false) {
  desktopZoom.scale = 1;
  desktopZoom.x = 0;
  desktopZoom.y = 0;
  desktopPan = null;
  stage?.classList.remove('viewer-desktop-panning');
  applyDesktopZoom(animate);
}

function naturalZoom(image) {
  const naturalScale = Math.max(
    Number(image.naturalWidth || 0) / Math.max(1, image.clientWidth),
    Number(image.naturalHeight || 0) / Math.max(1, image.clientHeight)
  );
  return Math.max(2.25, Math.min(4, naturalScale || 2.25));
}

function setDesktopScaleAt(nextScale, clientX, clientY, animate = false) {
  const image = desktopImage();
  if (!image) return;
  const oldScale = desktopZoom.scale;
  const scale = Math.max(1, Math.min(4, nextScale));
  if (scale <= 1.01) return resetDesktopZoom(animate);

  const offsetX = clientX - innerWidth / 2;
  const offsetY = clientY - innerHeight / 2;
  const anchorX = (offsetX - desktopZoom.x) / oldScale;
  const anchorY = (offsetY - desktopZoom.y) / oldScale;
  desktopZoom.scale = scale;
  desktopZoom.x = offsetX - anchorX * scale;
  desktopZoom.y = offsetY - anchorY * scale;
  applyDesktopZoom(animate);
}

function toggleDesktopZoom(clientX, clientY) {
  const image = desktopImage();
  if (!image) return;
  if (desktopZoomed()) resetDesktopZoom(true);
  else setDesktopScaleAt(naturalZoom(image), clientX, clientY, true);
}

function activeUi(target) {
  return target?.closest?.('.viewer-nav,.viewer-bar,.viewer-collections,.viewer-info,dialog,video');
}

document.addEventListener('keydown', event => {
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.stopImmediatePropagation();
    return;
  }
  if (desktopZoomed() && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

if (stage && viewer) {
  // Video keeps the normal viewer gestures, but a stationary tap directly on
  // the player gets a much smaller navigation zone. The native control strip
  // at the bottom is never allowed to trigger previous/next.
  const videoPointers = new Map();
  let recentVideoGesture = null;
  const VIDEO_TAP_EDGE = .22;

  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const video = event.target.closest('#viewer-media video');
    if (!video) return;
    const rect = video.getBoundingClientRect();
    const controlBand = Math.min(64, rect.height * .22);
    videoPointers.set(event.pointerId, {
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      inControls: event.clientY >= rect.bottom - controlBand
    });
  });

  stage.addEventListener('pointermove', event => {
    const point = videoPointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
  });

  stage.addEventListener('pointerup', event => {
    const point = videoPointers.get(event.pointerId);
    if (!point) return;
    videoPointers.delete(event.pointerId);
    point.x = event.clientX;
    point.y = event.clientY;
    const dx = point.x - point.startX;
    const dy = point.y - point.startY;
    const travel = Math.hypot(dx, dy);
    const duration = Math.max(1, performance.now() - point.startedAt);
    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const swipe = horizontal && (Math.abs(dx) >= 26 || (Math.abs(dx) >= 16 && velocity >= .18));
    const edgeTap = travel <= 12 && (
      event.clientX < innerWidth * VIDEO_TAP_EDGE ||
      event.clientX > innerWidth * (1 - VIDEO_TAP_EDGE)
    );
    recentVideoGesture = {
      allowNavigation: !point.inControls && (swipe || edgeTap),
      until: performance.now() + 120
    };
  });

  stage.addEventListener('pointercancel', event => {
    videoPointers.delete(event.pointerId);
    recentVideoGesture = null;
  });

  for (const button of [viewerPrev, viewerNext]) {
    button?.addEventListener('click', event => {
      if (event.isTrusted || !recentVideoGesture || performance.now() > recentVideoGesture.until) return;
      const gesture = recentVideoGesture;
      recentVideoGesture = null;
      if (gesture.allowNavigation) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  // Desktop double-click uses the actual mouse gesture, not a media query about
  // the device's primary pointer. This matters on touch-capable Windows PCs.
  stage.addEventListener('dblclick', event => {
    if (viewer.hidden || event.button > 0 || touchZoomed()) return;
    if (!event.target.closest('#viewer-media img')) return;
    clearTimeout(desktopClickTimer);
    desktopClickTimer = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleDesktopZoom(event.clientX, event.clientY);
  }, true);

  // Delay a single mouse click on the image just enough to distinguish it from
  // a double-click. Blank viewer areas still toggle controls immediately.
  stage.addEventListener('click', event => {
    if (viewer.hidden || event.button > 0 || activeUi(event.target)) return;
    if (suppressDesktopClick) {
      suppressDesktopClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.target.closest('#viewer-media img')) return;
    clearTimeout(desktopClickTimer);
    if (event.detail >= 2) return;
    desktopClickTimer = setTimeout(() => {
      desktopClickTimer = 0;
      if (!viewer.hidden) toggleControls();
    }, 300);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  stage.addEventListener('wheel', event => {
    if (viewer.hidden || !desktopImage() || touchZoomed()) return;
    if (activeUi(event.target)) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const delta = event.deltaY * multiplier;
    const sensitivity = event.ctrlKey ? .006 : .0015;
    setDesktopScaleAt(desktopZoom.scale * Math.exp(-delta * sensitivity), event.clientX, event.clientY);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { passive: false, capture: true });

  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !desktopZoomed()) return;
    if (!event.target.closest('#viewer-media img')) return;
    desktopPan = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: desktopZoom.x,
      startY: desktopZoom.y,
      moved: false
    };
    try { stage.setPointerCapture(event.pointerId); } catch {}
    stage.classList.add('viewer-desktop-panning');
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  stage.addEventListener('pointermove', event => {
    if (!desktopPan || event.pointerId !== desktopPan.pointerId) return;
    const dx = event.clientX - desktopPan.x;
    const dy = event.clientY - desktopPan.y;
    if (Math.hypot(dx, dy) > 4) desktopPan.moved = true;
    desktopZoom.x = desktopPan.startX + dx;
    desktopZoom.y = desktopPan.startY + dy;
    applyDesktopZoom();
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  stage.addEventListener('pointerup', event => {
    if (!desktopPan || event.pointerId !== desktopPan.pointerId) return;
    suppressDesktopClick = desktopPan.moved;
    desktopPan = null;
    stage.classList.remove('viewer-desktop-panning');
    try { stage.releasePointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  stage.addEventListener('pointercancel', event => {
    if (!desktopPan || event.pointerId !== desktopPan.pointerId) return;
    desktopPan = null;
    stage.classList.remove('viewer-desktop-panning');
    event.stopImmediatePropagation();
  });

  // Touch controls toggle. browser-ui.js owns swipe navigation and touch zoom;
  // this only handles the conventional single-tap show/hide chrome behavior.
  const pointers = new Map();
  let pendingTap = 0;
  let lastTap = null;
  const DOUBLE_TAP_MS = 300;

  stage.addEventListener('pointerdown', event => {
    if (viewer.hidden || (event.pointerType !== 'touch' && event.pointerType !== 'pen') || activeUi(event.target)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });

  stage.addEventListener('pointermove', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (Math.hypot(event.clientX - point.x, event.clientY - point.y) > 12) point.moved = true;
  });

  stage.addEventListener('pointerup', event => {
    const point = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (!point || point.moved || viewer.hidden || activeUi(event.target)) return;

    const isZoomed = stage.classList.contains('viewer-zoomed') || desktopZoomed();
    if (!isZoomed && (event.clientX < innerWidth * .36 || event.clientX > innerWidth * .64)) return;

    const imageHit = Boolean(event.target.closest('#viewer-media img'));
    const now = performance.now();
    const doubleTap = lastTap && now - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 44;

    if (doubleTap && (imageHit || isZoomed)) {
      clearTimeout(pendingTap);
      pendingTap = 0;
      lastTap = null;
      return;
    }

    clearTimeout(pendingTap);
    if (imageHit || isZoomed) {
      lastTap = { time: now, x: event.clientX, y: event.clientY };
      pendingTap = setTimeout(() => {
        pendingTap = 0;
        lastTap = null;
        if (!viewer.hidden) toggleControls();
      }, DOUBLE_TAP_MS + 20);
      return;
    }

    lastTap = null;
    toggleControls();
  });

  stage.addEventListener('pointercancel', event => pointers.delete(event.pointerId));

  new MutationObserver(() => resetDesktopZoom()).observe(viewerMedia, { childList: true });
  new MutationObserver(() => {
    if (viewer.hidden) resetDesktopZoom();
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', () => {
    if (desktopZoomed()) applyDesktopZoom();
  }, { passive: true });
}
