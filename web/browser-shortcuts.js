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
  if (viewer?.classList.contains('viewer-ui-hidden')) viewer.classList.remove('viewer-ui-hidden');
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
const finePointer = matchMedia('(hover:hover) and (pointer:fine)');

function desktopImage() {
  return viewerMedia?.querySelector('img') || null;
}

function desktopZoomed() {
  return desktopZoom.scale > 1.01;
}

function clampDesktopPan(scale = desktopZoom.scale, x = desktopZoom.x, y = desktopZoom.y) {
  const image = desktopImage();
  if (!image || scale <= 1) return { x: 0, y: 0 };
  const width = image.clientWidth * scale;
  const height = image.clientHeight * scale;
  const maxX = Math.max(0, (width - innerWidth) / 2);
  const maxY = Math.max(0, (height - innerHeight) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, x)),
    y: Math.max(-maxY, Math.min(maxY, y))
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

function desktopNaturalScale(image) {
  const renderedWidth = Math.max(1, image.clientWidth);
  const renderedHeight = Math.max(1, image.clientHeight);
  const naturalScale = Math.max(
    Number(image.naturalWidth || 0) / renderedWidth,
    Number(image.naturalHeight || 0) / renderedHeight
  );
  return Math.max(2.25, Math.min(4, naturalScale || 2.25));
}

function setDesktopScaleAt(nextScale, clientX, clientY, animate = false) {
  const image = desktopImage();
  if (!image) return;
  const oldScale = desktopZoom.scale;
  const scale = Math.max(1, Math.min(4, nextScale));
  if (scale <= 1.01) {
    resetDesktopZoom(animate);
    return;
  }
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
  else setDesktopScaleAt(desktopNaturalScale(image), clientX, clientY, true);
}

document.addEventListener('keydown', event => {
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    // Browser Back/Forward must win over viewer navigation.
    event.stopImmediatePropagation();
    return;
  }
  if (desktopZoomed() && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

if (stage && viewer) {
  // A tap directly on the video belongs to the native player. These handlers
  // run before browser-ui.js and stop its side-tap/swipe recognizer from
  // turning a play/pause tap into previous/next navigation.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    stage.addEventListener(type, event => {
      if (event.target.closest('#viewer-media video')) event.stopImmediatePropagation();
    });
  }

  stage.addEventListener('dblclick', event => {
    if (viewer.hidden || !finePointer.matches || event.button > 0) return;
    if (stage.classList.contains('viewer-zoomed') && !stage.classList.contains('viewer-desktop-zoomed')) return;
    if (!event.target.closest('#viewer-media img')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleDesktopZoom(event.clientX, event.clientY);
  });

  stage.addEventListener('wheel', event => {
    if (viewer.hidden || !finePointer.matches || !desktopImage()) return;
    if (event.target.closest('.viewer-bar,.viewer-collections,.viewer-info,dialog,video')) return;
    if (stage.classList.contains('viewer-zoomed') && !stage.classList.contains('viewer-desktop-zoomed')) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const delta = event.deltaY * multiplier;
    const sensitivity = event.ctrlKey ? .006 : .0015;
    const scale = desktopZoom.scale * Math.exp(-delta * sensitivity);
    setDesktopScaleAt(scale, event.clientX, event.clientY, false);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { passive: false });

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
    applyDesktopZoom(false);
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  stage.addEventListener('pointerup', event => {
    if (!desktopPan || event.pointerId !== desktopPan.pointerId) return;
    const moved = desktopPan.moved;
    desktopPan = null;
    stage.classList.remove('viewer-desktop-panning');
    try { stage.releasePointerCapture(event.pointerId); } catch {}
    if (!moved) toggleControls();
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  stage.addEventListener('pointercancel', event => {
    if (!desktopPan || event.pointerId !== desktopPan.pointerId) return;
    desktopPan = null;
    stage.classList.remove('viewer-desktop-panning');
    event.stopImmediatePropagation();
  });

  const pointers = new Map();
  let pendingTap = 0;
  let lastTap = null;
  const DOUBLE_TAP_MS = 300;

  const activeUiAt = (x, y) => document.elementFromPoint(x, y)?.closest(
    '.viewer-nav,.viewer-bar,.viewer-collections,.viewer-info,dialog,video'
  );

  const zoomed = () => stage.classList.contains('viewer-zoomed') || desktopZoomed();

  function clearPendingTap() {
    clearTimeout(pendingTap);
    pendingTap = 0;
  }

  stage.addEventListener('pointerdown', event => {
    if (viewer.hidden || event.button > 0 || activeUiAt(event.clientX, event.clientY)) return;
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType || 'mouse'
    });
  });

  stage.addEventListener('pointermove', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    if (Math.hypot(event.clientX - point.x, event.clientY - point.y) > 12) point.moved = true;
  });

  stage.addEventListener('pointerup', event => {
    const point = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (!point || point.moved || viewer.hidden) return;
    if (activeUiAt(event.clientX, event.clientY)) return;

    const touch = point.pointerType === 'touch' || point.pointerType === 'pen';
    const isZoomed = zoomed();

    // At fit size, the left/right thirds are active mobile navigation zones.
    // The center remains the conventional single-tap controls toggle.
    if (touch && !isZoomed && (event.clientX < innerWidth * .36 || event.clientX > innerWidth * .64)) return;

    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const imageHit = Boolean(hit?.closest('#viewer-media img'));
    const now = performance.now();
    const isDoubleTap = touch && lastTap &&
      now - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 44;

    if (isDoubleTap && (imageHit || isZoomed)) {
      clearPendingTap();
      lastTap = null;
      // browser-ui.js owns the actual touch double-tap zoom transition.
      return;
    }

    clearPendingTap();
    if (touch && (imageHit || isZoomed)) {
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

  stage.addEventListener('pointercancel', event => {
    pointers.delete(event.pointerId);
  });

  new MutationObserver(() => resetDesktopZoom(false)).observe(viewerMedia, { childList: true });
  new MutationObserver(() => {
    if (viewer.hidden) resetDesktopZoom(false);
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', () => {
    if (desktopZoomed()) applyDesktopZoom(false);
  }, { passive: true });
}
