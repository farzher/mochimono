const files = document.querySelector('#files');
const views = document.querySelector('#views');
const folderbar = document.querySelector('#folderbar');
const viewer = document.querySelector('#viewer');
const viewerStage = document.querySelector('#viewer-stage');
const viewerMedia = document.querySelector('#viewer-media');
const viewerPrev = document.querySelector('#viewer-prev');
const viewerNext = document.querySelector('#viewer-next');
const dateRail = document.querySelector('#dateRail');

function currentView() {
  return views.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function syncLayoutMode() {
  document.documentElement.classList.toggle('library-grid-view', currentView() === 'grid');
}

views.addEventListener('click', () => requestAnimationFrame(syncLayoutMode));
new MutationObserver(syncLayoutMode).observe(views, { subtree: true, attributes: true, attributeFilter: ['class'] });
syncLayoutMode();

folderbar.addEventListener('click', event => {
  if (!event.target.closest('[data-folder-home]') || currentView() === 'folders') return;
  const url = new URL(location.href);
  url.searchParams.delete('source');
  url.searchParams.delete('path');
  history.replaceState(history.state, '', url);
  requestAnimationFrame(() => {
    folderbar.hidden = true;
    folderbar.replaceChildren();
  });
});

const railTopHit = document.createElement('div');
railTopHit.hidden = true;
railTopHit.setAttribute('aria-hidden', 'true');
Object.assign(railTopHit.style, {
  position: 'fixed',
  top: '0',
  width: '0',
  height: '0',
  zIndex: '6',
  background: 'transparent',
  cursor: 'ns-resize',
  touchAction: 'none',
  userSelect: 'none'
});
document.body.append(railTopHit);

function syncRailTopHit() {
  if (dateRail.hidden) {
    railTopHit.hidden = true;
    return;
  }
  const rect = dateRail.getBoundingClientRect();
  if (rect.top <= 0 || rect.width <= 0) {
    railTopHit.hidden = true;
    return;
  }
  railTopHit.hidden = false;
  railTopHit.style.right = `${Math.max(0, innerWidth - rect.right)}px`;
  railTopHit.style.width = `${rect.width}px`;
  railTopHit.style.height = `${rect.top}px`;
}

function forwardRailPointer(type, event, forceTop = false) {
  if (dateRail.hidden) return;
  const rect = dateRail.getBoundingClientRect();
  const clientY = forceTop ? rect.top : Math.max(rect.top, Math.min(rect.bottom, event.clientY));
  const capture = dateRail.setPointerCapture;
  const release = dateRail.releasePointerCapture;
  dateRail.setPointerCapture = () => {};
  dateRail.releasePointerCapture = () => {};
  try {
    dateRail.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: event.pointerType || 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      clientX: Math.max(rect.left, rect.right - 1),
      clientY
    }));
  } finally {
    if (capture) dateRail.setPointerCapture = capture;
    else delete dateRail.setPointerCapture;
    if (release) dateRail.releasePointerCapture = release;
    else delete dateRail.releasePointerCapture;
  }
}

let railTopPointer = null;
railTopHit.addEventListener('pointerdown', event => {
  if (dateRail.hidden) return;
  railTopPointer = event.pointerId;
  try { railTopHit.setPointerCapture(event.pointerId); } catch {}
  forwardRailPointer('pointerdown', event, true);
  event.preventDefault();
});
railTopHit.addEventListener('pointermove', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointermove', event);
  event.preventDefault();
});
railTopHit.addEventListener('pointerup', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointerup', event);
  try { railTopHit.releasePointerCapture(event.pointerId); } catch {}
  railTopPointer = null;
  event.preventDefault();
});
railTopHit.addEventListener('pointercancel', event => {
  if (event.pointerId !== railTopPointer) return;
  forwardRailPointer('pointercancel', event);
  railTopPointer = null;
});

new MutationObserver(() => requestAnimationFrame(syncRailTopHit)).observe(dateRail, {
  childList: true,
  attributes: true,
  attributeFilter: ['hidden', 'style', 'class']
});
window.addEventListener('resize', syncRailTopHit, { passive: true });
views.addEventListener('click', () => requestAnimationFrame(syncRailTopHit));
requestAnimationFrame(syncRailTopHit);

let viewerUiTimer = 0;
let lastPointerType = 'mouse';

function hideViewerUiSoon() {
  clearTimeout(viewerUiTimer);
  viewerUiTimer = setTimeout(() => {
    if (!viewer.hidden && lastPointerType === 'mouse') viewer.classList.add('viewer-ui-hidden');
  }, 1000);
}

function showViewerUi() {
  if (viewer.hidden) return;
  viewer.classList.remove('viewer-ui-hidden');
  if (lastPointerType === 'mouse') hideViewerUiSoon();
  else clearTimeout(viewerUiTimer);
}

function syncViewerUi() {
  clearTimeout(viewerUiTimer);
  viewerUiTimer = 0;
  viewer.classList.remove('viewer-ui-hidden');
  if (!viewer.hidden && lastPointerType === 'mouse') hideViewerUiSoon();
}

window.addEventListener('pointerdown', event => {
  lastPointerType = event.pointerType || 'mouse';
  if (!viewer.hidden && lastPointerType !== 'mouse') showViewerUi();
}, { passive: true });

viewer.addEventListener('mousemove', () => {
  lastPointerType = 'mouse';
  showViewerUi();
}, { passive: true });
viewer.addEventListener('mouseenter', () => {
  lastPointerType = 'mouse';
  showViewerUi();
}, { passive: true });
new MutationObserver(syncViewerUi).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
syncViewerUi();

const viewerPointers = new Map();
let viewerSwipe = null;
let viewerPan = null;
let viewerPinch = null;
let lastViewerTap = null;
let viewerZoom = { scale: 1, x: 0, y: 0 };

function viewerImage() {
  return viewerMedia.querySelector('img');
}

function clampViewerPan(scale = viewerZoom.scale, x = viewerZoom.x, y = viewerZoom.y) {
  const image = viewerImage();
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

function applyViewerZoom(animate = false) {
  const image = viewerImage();
  const zoomed = viewerZoom.scale > 1.01;
  viewerStage.classList.toggle('viewer-zoomed', zoomed);
  if (!image) return;
  const clamped = clampViewerPan();
  viewerZoom.x = clamped.x;
  viewerZoom.y = clamped.y;
  image.style.transition = animate ? 'transform 160ms ease-out' : 'none';
  image.style.transform = zoomed
    ? `translate3d(${viewerZoom.x}px,${viewerZoom.y}px,0) scale(${viewerZoom.scale})`
    : '';
  if (animate) setTimeout(() => {
    if (image.isConnected) image.style.transition = '';
  }, 180);
}

function resetViewerZoom(animate = false) {
  viewerZoom = { scale: 1, x: 0, y: 0 };
  viewerSwipe = null;
  viewerPan = null;
  viewerPinch = null;
  viewerPointers.clear();
  applyViewerZoom(animate);
}

function zoomScaleForImage(image) {
  const renderedWidth = Math.max(1, image.clientWidth);
  const renderedHeight = Math.max(1, image.clientHeight);
  const naturalScale = Math.max(
    Number(image.naturalWidth || 0) / renderedWidth,
    Number(image.naturalHeight || 0) / renderedHeight
  );
  return Math.max(2.25, Math.min(4, naturalScale || 2.25));
}

function toggleViewerZoom(clientX, clientY) {
  const image = viewerImage();
  if (!image) return;
  if (viewerZoom.scale > 1.01) {
    resetViewerZoom(true);
    return;
  }
  const scale = zoomScaleForImage(image);
  viewerZoom.scale = scale;
  viewerZoom.x = (1 - scale) * (clientX - innerWidth / 2);
  viewerZoom.y = (1 - scale) * (clientY - innerHeight / 2);
  applyViewerZoom(true);
}

function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function beginPinch() {
  const points = [...viewerPointers.values()];
  if (points.length < 2 || !viewerImage()) return;
  const [a, b] = points;
  const centerX = (a.x + b.x) / 2;
  const centerY = (a.y + b.y) / 2;
  const scale = viewerZoom.scale;
  viewerPinch = {
    distance: Math.max(1, pointerDistance(a, b)),
    scale,
    anchorX: (centerX - innerWidth / 2 - viewerZoom.x) / scale,
    anchorY: (centerY - innerHeight / 2 - viewerZoom.y) / scale
  };
  viewerSwipe = null;
  viewerPan = null;
}

function updatePinch() {
  const points = [...viewerPointers.values()];
  if (!viewerPinch || points.length < 2) return;
  const [a, b] = points;
  const centerX = (a.x + b.x) / 2;
  const centerY = (a.y + b.y) / 2;
  const scale = Math.max(1, Math.min(4, viewerPinch.scale * pointerDistance(a, b) / viewerPinch.distance));
  viewerZoom.scale = scale;
  viewerZoom.x = centerX - innerWidth / 2 - viewerPinch.anchorX * scale;
  viewerZoom.y = centerY - innerHeight / 2 - viewerPinch.anchorY * scale;
  applyViewerZoom(false);
}

function clearViewerPointer(event) {
  viewerPointers.delete(event.pointerId);
  if (viewerSwipe?.pointerId === event.pointerId) viewerSwipe = null;
  if (viewerPan?.pointerId === event.pointerId) viewerPan = null;
  if (viewerPointers.size < 2) viewerPinch = null;
}

viewerStage.addEventListener('pointerdown', event => {
  if (viewer.hidden || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
  if (event.target.closest('.viewer-nav')) return;
  const point = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, startedAt: performance.now() };
  viewerPointers.set(event.pointerId, point);
  try { viewerStage.setPointerCapture(event.pointerId); } catch {}

  if (viewerPointers.size >= 2) {
    beginPinch();
    event.preventDefault();
    return;
  }

  if (viewerZoom.scale > 1.01) {
    viewerPan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: viewerZoom.x, startY: viewerZoom.y };
    event.preventDefault();
  } else {
    viewerSwipe = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startedAt: performance.now(), image: Boolean(event.target.closest('#viewer-media img')) };
  }
});

viewerStage.addEventListener('pointermove', event => {
  const point = viewerPointers.get(event.pointerId);
  if (!point) return;
  point.x = event.clientX;
  point.y = event.clientY;

  if (viewerPointers.size >= 2) {
    if (!viewerPinch) beginPinch();
    updatePinch();
    event.preventDefault();
    return;
  }

  if (viewerPan?.pointerId === event.pointerId && viewerZoom.scale > 1.01) {
    viewerZoom.x = viewerPan.startX + event.clientX - viewerPan.x;
    viewerZoom.y = viewerPan.startY + event.clientY - viewerPan.y;
    applyViewerZoom(false);
    event.preventDefault();
  }
});

viewerStage.addEventListener('pointerup', event => {
  const point = viewerPointers.get(event.pointerId);
  if (!point) return;
  const swipe = viewerSwipe?.pointerId === event.pointerId ? viewerSwipe : null;
  const wasPinching = Boolean(viewerPinch) || viewerPointers.size > 1;
  const wasPanning = viewerPan?.pointerId === event.pointerId;
  const dx = event.clientX - point.startX;
  const dy = event.clientY - point.startY;
  const travel = Math.hypot(dx, dy);
  const duration = Math.max(1, performance.now() - point.startedAt);
  clearViewerPointer(event);
  try { viewerStage.releasePointerCapture(event.pointerId); } catch {}

  if (wasPinching) {
    if (viewerZoom.scale <= 1.03) resetViewerZoom(true);
    return;
  }
  if (wasPanning || viewerZoom.scale > 1.01) return;

  if (swipe) {
    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.08;
    const velocity = Math.abs(dx) / duration;
    const deliberate = Math.abs(dx) >= 26;
    const quickFlick = Math.abs(dx) >= 16 && velocity >= .18;
    if (horizontal && (deliberate || quickFlick)) {
      lastViewerTap = null;
      if (dx < 0) {
        if (!viewerNext.disabled) viewerNext.click();
      } else if (!viewerPrev.disabled) {
        viewerPrev.click();
      }
      return;
    }
  }

  if (travel > 12 || !swipe?.image) {
    lastViewerTap = null;
    return;
  }

  const now = performance.now();
  if (lastViewerTap && now - lastViewerTap.time <= 320 && Math.hypot(event.clientX - lastViewerTap.x, event.clientY - lastViewerTap.y) <= 44) {
    toggleViewerZoom(event.clientX, event.clientY);
    lastViewerTap = null;
    event.preventDefault();
  } else {
    lastViewerTap = { time: now, x: event.clientX, y: event.clientY };
  }
});

viewerStage.addEventListener('pointercancel', event => {
  clearViewerPointer(event);
  if (!viewerPointers.size && viewerZoom.scale <= 1.03) resetViewerZoom(false);
});

new MutationObserver(() => resetViewerZoom(false)).observe(viewerMedia, { childList: true });
new MutationObserver(() => {
  if (viewer.hidden) resetViewerZoom(false);
}).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
window.addEventListener('resize', () => {
  if (viewerZoom.scale > 1.01) applyViewerZoom(false);
}, { passive: true });

let press = null;
let dispatchingLongPress = false;
let suppressHash = '';
let suppressUntil = 0;

function cancelPress() {
  if (press?.timer) clearTimeout(press.timer);
  press = null;
}

files.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  const item = event.target.closest('[data-hash]');
  if (!item) return;
  cancelPress();
  const hash = item.dataset.hash;
  press = {
    pointerId: event.pointerId,
    hash,
    x: event.clientX,
    y: event.clientY,
    timer: setTimeout(() => {
      if (!press || press.hash !== hash) return;
      suppressHash = hash;
      suppressUntil = performance.now() + 900;
      dispatchingLongPress = true;
      item.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: press.x,
        clientY: press.y
      }));
      dispatchingLongPress = false;
      navigator.vibrate?.(8);
      cancelPress();
    }, 500)
  };
}, { passive: true });

files.addEventListener('pointermove', event => {
  if (!press || event.pointerId !== press.pointerId) return;
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) cancelPress();
}, { passive: true });

files.addEventListener('pointerup', cancelPress, { passive: true });
files.addEventListener('pointercancel', cancelPress, { passive: true });

files.addEventListener('click', event => {
  if (dispatchingLongPress) return;
  const item = event.target.closest('[data-hash]');
  if (!item || item.dataset.hash !== suppressHash || performance.now() > suppressUntil) return;
  suppressHash = '';
  suppressUntil = 0;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

files.addEventListener('contextmenu', event => {
  const item = event.target.closest('[data-hash]');
  if (item && item.dataset.hash === suppressHash && performance.now() <= suppressUntil) event.preventDefault();
});