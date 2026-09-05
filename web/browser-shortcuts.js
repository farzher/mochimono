const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');

function showControls() {
  viewer?.classList.remove('viewer-controls-hidden');
}

function toggleControls() {
  if (viewer && !viewer.hidden) viewer.classList.toggle('viewer-controls-hidden');
}

window.mochimonoViewerControls = { show: showControls, toggle: toggleControls };

const zoom = { scale: 1, x: 0, y: 0 };
const WHEEL_NAV_STEP = 100;
const ZOOM_EXIT_GRACE_MS = 180;
const MAX_NATIVE_SCALE = 4;
const viewerPageKeys = new Set(['PageUp', 'PageDown', 'Home', 'End']);
let navState = null;
let pan = null;
let suppressClick = false;
let clickTimer = 0;
let wheelNavigationDelta = 0;
let wheelNavigationBlockedUntil = 0;

const image = () => viewerMedia?.querySelector('img') || null;
const zoomed = () => zoom.scale > 1.01;
const touchZoomed = () => stage?.classList.contains('viewer-touch-zoomed');
const currentViewerHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';

function pixelMetrics(current = image()) {
  if (!current || current.dataset.fullSrc || !current.naturalWidth || !current.naturalHeight) return null;
  const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
  const nativeWidth = current.naturalWidth / dpr;
  const nativeHeight = current.naturalHeight / dpr;
  const viewportWidth = stage?.clientWidth || innerWidth;
  const viewportHeight = stage?.clientHeight || innerHeight;
  if (!nativeWidth || !nativeHeight || !viewportWidth || !viewportHeight) return null;
  const fit = Math.min(1, viewportWidth / nativeWidth, viewportHeight / nativeHeight);
  return { dpr, nativeWidth, nativeHeight, viewportWidth, viewportHeight, fit };
}

function clearPixelLayout(current) {
  if (!current) return;
  for (const property of ['position','inset','left','top','width','height','maxWidth','maxHeight','marginLeft','marginTop','objectFit','transformOrigin','imageRendering']) {
    current.style[property] = '';
  }
}

function relativeMax(current = image()) {
  const metrics = pixelMetrics(current);
  return metrics?.fit ? Math.max(1, MAX_NATIVE_SCALE / metrics.fit) : MAX_NATIVE_SCALE;
}

function displayedScale(current = image(), relativeScale = zoom.scale) {
  const metrics = pixelMetrics(current);
  return metrics ? metrics.fit * relativeScale : relativeScale;
}

function displayedSize(metrics, relativeScale = zoom.scale) {
  const actualScale = metrics.fit * relativeScale;
  return {
    width: metrics.nativeWidth * actualScale,
    height: metrics.nativeHeight * actualScale,
    actualScale
  };
}

function viewerHashes() {
  const library = window.mochimonoLibrary;
  if (!library) return [];
  if (library.state?.().view === 'folders') {
    return (library.folderContents?.()?.files || []).map(file => String(file?.hash || '')).filter(Boolean);
  }
  return library.filteredHashes?.() || [];
}

function navigateViewerBy(step) {
  const hashes = viewerHashes();
  const index = hashes.indexOf(currentViewerHash());
  if (index < 0) return false;
  const hash = hashes[index + step];
  if (!hash) return false;
  wheelNavigationDelta = 0;
  return Boolean(window.mochimonoOpenViewer?.(hash));
}

function jumpViewerEdge(first) {
  const hashes = viewerHashes();
  const hash = first ? hashes[0] : hashes.at(-1);
  if (!hash) return false;
  wheelNavigationDelta = 0;
  return Boolean(window.mochimonoOpenViewer?.(hash));
}

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

function clampPan(metrics = null) {
  if (!metrics || !zoomed()) return { x: 0, y: 0 };
  const size = displayedSize(metrics);
  const maxX = Math.max(0, (size.width - metrics.viewportWidth) / 2);
  const maxY = Math.max(0, (size.height - metrics.viewportHeight) / 2);
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

  const metrics = pixelMetrics(current);
  current.style.transition = animate
    ? 'width 160ms ease-out,height 160ms ease-out,margin 160ms ease-out,transform 160ms ease-out'
    : 'none';

  if (metrics) {
    Object.assign(zoom, clampPan(metrics));
    const size = displayedSize(metrics);
    current.style.position = 'absolute';
    current.style.inset = 'auto';
    current.style.left = '50%';
    current.style.top = '50%';
    current.style.width = `${size.width}px`;
    current.style.height = `${size.height}px`;
    current.style.maxWidth = 'none';
    current.style.maxHeight = 'none';
    current.style.marginLeft = `${-size.width / 2}px`;
    current.style.marginTop = `${-size.height / 2}px`;
    current.style.objectFit = 'fill';
    current.style.transformOrigin = '50% 50%';
    current.style.imageRendering = 'auto';
    current.style.transform = `translate3d(${zoom.x}px,${zoom.y}px,0)`;
  } else {
    clearPixelLayout(current);
    current.style.transform = active ? `translate3d(${zoom.x}px,${zoom.y}px,0) scale(${zoom.scale})` : '';
  }

  if (animate) setTimeout(() => { if (current.isConnected) current.style.transition = ''; }, 180);
}

function resetZoom(animate = false) {
  zoom.scale = 1;
  zoom.x = 0;
  zoom.y = 0;
  pan = null;
  stage?.classList.remove('viewer-desktop-panning');
  applyZoom(animate);
}

function naturalZoom(current = image()) {
  const metrics = pixelMetrics(current);
  if (metrics) {
    const nativeRelative = 1 / metrics.fit;
    return nativeRelative > 1.01 ? nativeRelative : Math.min(relativeMax(current), 2.25);
  }
  if (!current) return 2.25;
  const scale = Math.max(
    Number(current.naturalWidth || 0) / Math.max(1, current.clientWidth),
    Number(current.naturalHeight || 0) / Math.max(1, current.clientHeight)
  );
  return Math.max(2.25, Math.min(MAX_NATIVE_SCALE, scale || 2.25));
}

function setScaleAt(nextScale, clientX, clientY, animate = false) {
  const current = image();
  if (!current) return;
  const oldScale = zoom.scale;
  const scale = Math.max(1, Math.min(relativeMax(current), Number(nextScale) || 1));
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

function setView(view = {}, animate = false) {
  const current = image();
  const metrics = pixelMetrics(current);
  const relative = Number.isFinite(Number(view.relativeScale))
    ? Number(view.relativeScale)
    : metrics && Number.isFinite(Number(view.scale))
      ? Number(view.scale) / Math.max(.0001, metrics.fit)
      : zoom.scale;
  zoom.scale = Math.max(1, Math.min(relativeMax(current), relative || 1));
  zoom.x = Number(view.x) || 0;
  zoom.y = Number(view.y) || 0;
  if (zoom.scale <= 1.01) {
    zoom.scale = 1;
    zoom.x = 0;
    zoom.y = 0;
  }
  applyZoom(animate);
}

function toggleZoom(clientX, clientY) {
  const current = image();
  if (!current) return;
  wheelNavigationDelta = 0;
  if (zoomed()) resetZoom(true);
  else setScaleAt(naturalZoom(current), clientX, clientY, true);
}

function bindCurrentImage() {
  const current = image();
  if (!current || current.dataset.pixelViewerBound === '1') return;
  current.dataset.pixelViewerBound = '1';
  current.addEventListener('load', () => {
    if (!current.isConnected || current.dataset.fullSrc) return;
    requestAnimationFrame(() => applyZoom());
  });
  if (current.complete && current.naturalWidth && !current.dataset.fullSrc) requestAnimationFrame(() => applyZoom());
}

window.mochimonoViewerPixelZoom = {
  state() {
    const current = image();
    const metrics = pixelMetrics(current);
    return {
      relativeScale: zoom.scale,
      scale: metrics ? metrics.fit * zoom.scale : displayedScale(current),
      fit: metrics?.fit || 1,
      x: zoom.x,
      y: zoom.y,
      ready: Boolean(metrics)
    };
  },
  zoomed,
  set: setView,
  setScaleAt,
  naturalScale: naturalZoom,
  reset: resetZoom,
  render: applyZoom
};

const activeUi = target => target?.closest?.('.viewer-nav,.viewer-bar,.viewer-collections,.viewer-info,dialog,video');
const wheelUi = target => target?.closest?.('.viewer-nav,.viewer-bar,.viewer-collections,.viewer-info,dialog');

document.addEventListener('keydown', event => {
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.stopImmediatePropagation();
    return;
  }
  if (!viewer?.hidden && viewerPageKeys.has(event.key)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: event.key === 'PageUp' ? 'ArrowUp' : 'ArrowDown',
        bubbles: true,
        cancelable: true
      }));
    } else jumpViewerEdge(event.key === 'Home');
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
    if (viewer.hidden || touchZoomed() || wheelUi(event.target)) return;
    if (!event.deltaY || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    clearTimeout(clickTimer);
    clickTimer = 0;

    if (zoomed()) {
      wheelNavigationDelta = 0;
      if (!image()) return;
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
      setScaleAt(zoom.scale * Math.exp(-event.deltaY * multiplier * (event.ctrlKey ? .006 : .0015)), event.clientX, event.clientY);
      if (!zoomed()) wheelNavigationBlockedUntil = performance.now() + ZOOM_EXIT_GRACE_MS;
    } else if (performance.now() < wheelNavigationBlockedUntil) {
      wheelNavigationDelta = 0;
    } else {
      const multiplier = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? innerHeight : 1;
      wheelNavigationDelta += event.deltaY * multiplier;
      while (Math.abs(wheelNavigationDelta) >= WHEEL_NAV_STEP) {
        const direction = wheelNavigationDelta > 0 ? 1 : -1;
        const button = direction > 0 ? viewerNext : viewerPrev;
        if (button && !button.disabled) button.click();
        wheelNavigationDelta += direction > 0 ? -WHEEL_NAV_STEP : WHEEL_NAV_STEP;
      }
    }

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

  new MutationObserver(() => {
    resetZoom();
    bindCurrentImage();
  }).observe(viewerMedia, { childList: true });
  new MutationObserver(() => {
    document.documentElement.classList.toggle('viewer-open', !viewer.hidden);
    wheelNavigationDelta = 0;
    wheelNavigationBlockedUntil = 0;
    if (viewer.hidden) resetZoom();
    else {
      showControls();
      bindCurrentImage();
      applyZoom();
    }
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });

  bindCurrentImage();
  document.documentElement.classList.toggle('viewer-open', !viewer.hidden);
  window.addEventListener('resize', () => { if (!viewer.hidden && !touchZoomed()) applyZoom(); }, { passive: true });
}
