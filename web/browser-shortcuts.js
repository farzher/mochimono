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
  .viewer:not(.viewer-controls-hidden) .viewer-bar,.viewer:not(.viewer-controls-hidden) .viewer-collections{opacity:1!important}
  .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:.68!important;pointer-events:auto!important}
  .viewer.viewer-controls-hidden .viewer-bar,.viewer.viewer-controls-hidden .viewer-collections,.viewer.viewer-controls-hidden .viewer-nav{opacity:0!important;pointer-events:none!important}
  .viewer.viewer-controls-hidden .viewer-bar *,.viewer.viewer-controls-hidden .viewer-collections *{pointer-events:none!important}
  .viewer-collections{transition:opacity .18s ease}
  .viewer-stage.viewer-desktop-zoomed .viewer-media>img{cursor:grab;will-change:transform}
  .viewer-stage.viewer-desktop-panning .viewer-media>img{cursor:grabbing}
  .viewer-stage.viewer-desktop-zoomed .viewer-nav,.viewer-stage.viewer-touch-zoomed .viewer-nav{opacity:0!important;pointer-events:none!important}
  @media(max-width:840px){.viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:0!important;pointer-events:none!important}}
  @media(min-width:841px){.viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:.68!important;pointer-events:auto!important}.viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled):hover{opacity:1!important}}
`;
document.head.append(style);

function showControls() {
  viewer?.classList.remove('viewer-controls-hidden');
}

function toggleControls() {
  if (viewer && !viewer.hidden) viewer.classList.toggle('viewer-controls-hidden');
}

window.mochimonoViewerControls = { show: showControls, toggle: toggleControls };

const zoom = { scale: 1, x: 0, y: 0 };
let navState = null;
let pan = null;
let suppressClick = false;
let clickTimer = 0;

const image = () => viewerMedia?.querySelector('img') || null;
const zoomed = () => zoom.scale > 1.01;
const touchZoomed = () => stage?.classList.contains('viewer-touch-zoomed');

function lockNavigation(locked) {
  if (!viewerPrev || !viewerNext) return;
  if (locked) {
    navState ||= { prev: viewerPrev.disabled, next: viewerNext.disabled };
    viewerPrev.disabled = true;
    viewerNext.disabled = true;
  } else if (navState) {
    viewerPrev.disabled = navState.prev;
    viewerNext.disabled = navState.next;
    navState = null;
  }
}

function clampPan() {
  const current = image();
  if (!current || !zoomed()) return { x: 0, y: 0 };
  const maxX = Math.max(0, (current.clientWidth * zoom.scale - innerWidth) / 2);
  const maxY = Math.max(0, (current.clientHeight * zoom.scale - innerHeight) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, zoom.x)),
    y: Math.max(-maxY, Math.min(maxY, zoom.y))
  };
}

function applyZoom(animate = false) {
  const current = image();
  const active = zoomed();
  stage?.classList.toggle('viewer-desktop-zoomed', active);
  lockNavigation(active);
  if (!current) return;
  Object.assign(zoom, clampPan());
  current.style.transition = animate ? 'transform 160ms ease-out' : 'none';
  current.style.transform = active ? `translate3d(${zoom.x}px,${zoom.y}px,0) scale(${zoom.scale})` : '';
  if (animate) setTimeout(() => { if (current.isConnected) current.style.transition = ''; }, 180);
}

function resetZoom(animate = false) {
  if (!zoomed() && !zoom.x && !zoom.y && !pan && !navState && !stage?.classList.contains('viewer-desktop-panning')) return;
  zoom.scale = 1;
  zoom.x = 0;
  zoom.y = 0;
  pan = null;
  stage?.classList.remove('viewer-desktop-panning');
  applyZoom(animate);
}

function naturalZoom(current) {
  const scale = Math.max(
    Number(current.naturalWidth || 0) / Math.max(1, current.clientWidth),
    Number(current.naturalHeight || 0) / Math.max(1, current.clientHeight)
  );
  return Math.max(2.25, Math.min(4, scale || 2.25));
}

function setScaleAt(nextScale, clientX, clientY, animate = false) {
  const current = image();
  if (!current) return;
  const oldScale = zoom.scale;
  const scale = Math.max(1, Math.min(4, nextScale));
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
  else setScaleAt(naturalZoom(current), clientX, clientY, true);
}

const activeUi = target => target?.closest?.('.viewer-nav,.viewer-bar,.viewer-collections,.viewer-info,dialog,video');

document.addEventListener('keydown', event => {
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.stopImmediatePropagation();
    return;
  }
  if (!event.altKey && zoomed() && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

if (stage && viewer) {
  stage.addEventListener('dblclick', event => {
    if (viewer.hidden || event.button > 0 || touchZoomed() || !event.target.closest('#viewer-media img')) return;
    clearTimeout(clickTimer);
    clickTimer = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleZoom(event.clientX, event.clientY);
  }, true);

  stage.addEventListener('click', event => {
    if (viewer.hidden || event.button > 0 || activeUi(event.target)) return;
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.target.closest('#viewer-media img')) return toggleControls();
    clearTimeout(clickTimer);
    if (event.detail >= 2) return;
    clickTimer = setTimeout(() => {
      clickTimer = 0;
      if (!viewer.hidden) toggleControls();
    }, 300);
  }, true);

  stage.addEventListener('wheel', event => {
    if (viewer.hidden || !image() || touchZoomed() || activeUi(event.target)) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    setScaleAt(zoom.scale * Math.exp(-event.deltaY * multiplier * (event.ctrlKey ? .006 : .0015)), event.clientX, event.clientY);
    clearTimeout(clickTimer);
    clickTimer = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { passive: false, capture: true });

  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !zoomed() || !event.target.closest('#viewer-media img')) return;
    pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: zoom.x, startY: zoom.y, moved: false };
  });

  stage.addEventListener('pointermove', event => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.moved) {
      if (Math.hypot(dx, dy) <= 4) return;
      pan.moved = true;
      stage.classList.add('viewer-desktop-panning');
      clearTimeout(clickTimer);
      clickTimer = 0;
      try { stage.setPointerCapture(event.pointerId); } catch {}
    }
    zoom.x = pan.startX + dx;
    zoom.y = pan.startY + dy;
    applyZoom();
    event.preventDefault();
    event.stopImmediatePropagation();
  });

  stage.addEventListener('pointerup', event => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    suppressClick = pan.moved;
    const moved = pan.moved;
    pan = null;
    stage.classList.remove('viewer-desktop-panning');
    try { stage.releasePointerCapture(event.pointerId); } catch {}
    if (moved) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });

  stage.addEventListener('pointercancel', event => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    pan = null;
    stage.classList.remove('viewer-desktop-panning');
    event.stopImmediatePropagation();
  });

  new MutationObserver(resetZoom).observe(viewerMedia, { childList: true });
  new MutationObserver(() => {
    document.documentElement.classList.toggle('viewer-open', !viewer.hidden);
    if (viewer.hidden) resetZoom();
    else showControls();
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  document.documentElement.classList.toggle('viewer-open', !viewer.hidden);
  window.addEventListener('resize', () => { if (zoomed()) applyZoom(); }, { passive: true });
}
