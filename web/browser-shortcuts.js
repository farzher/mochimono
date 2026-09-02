const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const viewerMedia = document.querySelector('#viewer-media');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');

const style = document.createElement('style');
style.textContent = `
  html.viewer-open,html.viewer-open body{overflow:hidden!important;overscroll-behavior:none!important}
  .viewer{overscroll-behavior:none}
  .viewer:not([hidden]){inset:0!important;width:auto!important;height:auto!important}
  .viewer:not([hidden]) .viewer-stage{touch-action:none!important;overscroll-behavior:none!important}
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
  .viewer-stage.viewer-desktop-zoomed .viewer-nav,
  .viewer-stage.viewer-touch-zoomed .viewer-nav{opacity:0!important;pointer-events:none!important}
  @media(max-width:840px){
    .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:0!important;pointer-events:none!important}
  }
  @media(min-width:841px){
    .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:.68!important;pointer-events:auto!important}
    .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled):hover{opacity:1!important}
  }
`;
document.head.append(style);

function showControls() {
  if (!viewer) return;
  viewer.classList.remove('viewer-controls-hidden');
}

function toggleControls() {
  if (!viewer || viewer.hidden) return;
  viewer.classList.toggle('viewer-controls-hidden');
}

window.mochimonoViewerControls = { show: showControls, toggle: toggleControls };

let pageLocked = false;
let lockedScrollY = 0;
let savedBodyStyle = null;

function lockPage() {
  if (pageLocked) return;
  pageLocked = true;
  lockedScrollY = scrollY;
  savedBodyStyle = {
    position: document.body.style.position,
    top: document.body.style.top,
    left: document.body.style.left,
    right: document.body.style.right,
    width: document.body.style.width,
    overflow: document.body.style.overflow,
    overscrollBehavior: document.body.style.overscrollBehavior
  };
  document.documentElement.classList.add('viewer-open');
  document.body.style.position = 'fixed';
  document.body.style.top = `-${lockedScrollY}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
  document.body.style.overflow = 'hidden';
  document.body.style.overscrollBehavior = 'none';
}

function unlockPage() {
  if (!pageLocked) return;
  pageLocked = false;
  document.documentElement.classList.remove('viewer-open');
  if (savedBodyStyle) {
    document.body.style.position = savedBodyStyle.position;
    document.body.style.top = savedBodyStyle.top;
    document.body.style.left = savedBodyStyle.left;
    document.body.style.right = savedBodyStyle.right;
    document.body.style.width = savedBodyStyle.width;
    document.body.style.overflow = savedBodyStyle.overflow;
    document.body.style.overscrollBehavior = savedBodyStyle.overscrollBehavior;
  }
  savedBodyStyle = null;
  scrollTo(0, lockedScrollY);
}

function syncViewerOpen() {
  if (!viewer) return;
  if (viewer.hidden) unlockPage();
  else {
    lockPage();
    showControls();
  }
}

if (viewer) {
  new MutationObserver(syncViewerOpen).observe(viewer, {
    attributes: true,
    attributeFilter: ['hidden']
  });
  syncViewerOpen();
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
  return stage?.classList.contains('viewer-touch-zoomed');
}

function clampDesktopPan(scale = desktopZoom.scale, x = desktopZoom.x, y = desktopZoom.y) {
  const image = desktopImage();
  if (!image || scale <= 1) return { x: 0, y: 0 };
  const maxX = Math.max(0, (image.clientWidth * scale - innerWidth) / 2);
  const maxY = Math.max(0, (image.clientHeight * scale - innerHeight) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, x)),
    y: Math.max(-maxY, Math.min(maxY, y))
  };
}

function lockDesktopNavigation(locked) {
  if (!viewerPrev || !viewerNext) return;
  if (locked) {
    if (!desktopNavState) desktopNavState = {
      prev: viewerPrev.disabled,
      next: viewerNext.disabled
    };
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
  const active = desktopZoomed();
  stage?.classList.toggle('viewer-desktop-zoomed', active);
  lockDesktopNavigation(active);
  if (!image) return;
  const clamped = clampDesktopPan();
  desktopZoom.x = clamped.x;
  desktopZoom.y = clamped.y;
  image.style.transition = animate ? 'transform 160ms ease-out' : 'none';
  image.style.transform = active
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

function resetDesktopState() {
  if (!desktopZoomed() && !desktopZoom.x && !desktopZoom.y && !desktopPan && !desktopNavState && !stage?.classList.contains('viewer-desktop-panning')) return;
  resetDesktopZoom();
}

function naturalZoom(image) {
  const scale = Math.max(
    Number(image.naturalWidth || 0) / Math.max(1, image.clientWidth),
    Number(image.naturalHeight || 0) / Math.max(1, image.clientHeight)
  );
  return Math.max(2.25, Math.min(4, scale || 2.25));
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
  if (!event.altKey && desktopZoomed() && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

if (stage && viewer) {
  stage.addEventListener('dblclick', event => {
    if (viewer.hidden || event.button > 0 || touchZoomed()) return;
    if (!event.target.closest('#viewer-media img')) return;
    clearTimeout(desktopClickTimer);
    desktopClickTimer = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleDesktopZoom(event.clientX, event.clientY);
  }, true);

  stage.addEventListener('click', event => {
    if (viewer.hidden || event.button > 0 || activeUi(event.target)) return;
    if (suppressDesktopClick) {
      suppressDesktopClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.target.closest('#viewer-media img')) {
      toggleControls();
      return;
    }
    clearTimeout(desktopClickTimer);
    if (event.detail >= 2) return;
    desktopClickTimer = setTimeout(() => {
      desktopClickTimer = 0;
      if (!viewer.hidden) toggleControls();
    }, 300);
  }, true);

  stage.addEventListener('wheel', event => {
    if (viewer.hidden || !desktopImage() || touchZoomed() || activeUi(event.target)) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const delta = event.deltaY * multiplier;
    const sensitivity = event.ctrlKey ? .006 : .0015;
    setDesktopScaleAt(
      desktopZoom.scale * Math.exp(-delta * sensitivity),
      event.clientX,
      event.clientY
    );
    clearTimeout(desktopClickTimer);
    desktopClickTimer = 0;
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
  });

  stage.addEventListener('pointermove', event => {
    if (!desktopPan || event.pointerId !== desktopPan.pointerId) return;
    const dx = event.clientX - desktopPan.x;
    const dy = event.clientY - desktopPan.y;
    if (!desktopPan.moved) {
      if (Math.hypot(dx, dy) <= 4) return;
      desktopPan.moved = true;
      stage.classList.add('viewer-desktop-panning');
      clearTimeout(desktopClickTimer);
      desktopClickTimer = 0;
      try { stage.setPointerCapture(event.pointerId); } catch {}
    }
    desktopZoom.x = desktopPan.startX + dx;
    desktopZoom.y = desktopPan.startY + dy;
    applyDesktopZoom();
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  stage.addEventListener('pointerup', event => {
    if (!desktopPan || event.pointerId !== desktopPan.pointerId) return;
    const moved = desktopPan.moved;
    suppressDesktopClick = moved;
    desktopPan = null;
    stage.classList.remove('viewer-desktop-panning');
    try { stage.releasePointerCapture(event.pointerId); } catch {}
    if (moved) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  stage.addEventListener('pointercancel', event => {
    if (!desktopPan || event.pointerId !== desktopPan.pointerId) return;
    desktopPan = null;
    stage.classList.remove('viewer-desktop-panning');
    event.stopImmediatePropagation();
  });

  new MutationObserver(resetDesktopState).observe(viewerMedia, { childList: true });
  new MutationObserver(() => {
    if (viewer.hidden) resetDesktopState();
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  window.addEventListener('resize', () => {
    if (desktopZoomed()) applyDesktopZoom();
  }, { passive: true });
}