const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const media = document.querySelector('#viewer-media');

if (viewer && stage && media) {
  const MIN_SCALE = 1;
  const MAX_SCALE = 4;
  const PAN_START = 5;
  const CLICK_DELAY = 320;

  let zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let suppressClick = false;
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

  function clearClickTimer() {
    clearTimeout(clickTimer);
    clickTimer = 0;
  }

  function protectImages() {
    for (const item of media.querySelectorAll('img')) item.draggable = false;
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
    pan = null;
    suppressClick = false;
    clearClickTimer();
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

  stage.addEventListener('dblclick', event => {
    if (viewer.hidden || event.button > 0 || activeUi(event.target)) return;
    if (!event.target.closest?.('#viewer-media img')) return;
    clearClickTimer();
    window.getSelection()?.removeAllRanges();
    toggleZoom(event.clientX, event.clientY);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  stage.addEventListener('click', event => {
    if (viewer.hidden || event.button > 0 || activeUi(event.target)) return;
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (event.target.closest?.('#viewer-media img')) {
      clearClickTimer();
      if (event.detail >= 2) {
        event.preventDefault();
        return;
      }
      clickTimer = setTimeout(() => {
        clickTimer = 0;
        if (!viewer.hidden) toggleChrome();
      }, CLICK_DELAY);
      event.preventDefault();
      return;
    }

    toggleChrome();
  }, true);

  stage.addEventListener('pointerdown', event => {
    if (viewer.hidden || event.pointerType !== 'mouse' || event.button !== 0 || !zoomed()) return;
    if (!event.target.closest?.('#viewer-media img')) return;
    pan = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: zoom.x,
      startY: zoom.y,
      active: false
    };
    window.getSelection()?.removeAllRanges();
  }, true);

  stage.addEventListener('pointermove', event => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.active && Math.hypot(dx, dy) < PAN_START) return;
    if (!pan.active) {
      pan.active = true;
      clearClickTimer();
      try { stage.setPointerCapture(event.pointerId); } catch {}
      stage.classList.add('viewer-desktop-panning');
    }
    zoom.x = pan.startX + dx;
    zoom.y = pan.startY + dy;
    applyZoom();
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  stage.addEventListener('pointerup', event => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    const active = pan.active;
    pan = null;
    stage.classList.remove('viewer-desktop-panning');
    if (!active) return;
    suppressClick = true;
    try { stage.releasePointerCapture(event.pointerId); } catch {}
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  stage.addEventListener('pointercancel', event => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    pan = null;
    stage.classList.remove('viewer-desktop-panning');
  }, true);

  stage.addEventListener('wheel', event => {
    if (viewer.hidden || !image() || stage.classList.contains('viewer-touch-zoomed')) return;
    if (activeUi(event.target)) return;
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const delta = event.deltaY * multiplier;
    const sensitivity = event.ctrlKey ? .006 : .0015;
    setScaleAt(zoom.scale * Math.exp(-delta * sensitivity), event.clientX, event.clientY);
    clearClickTimer();
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
