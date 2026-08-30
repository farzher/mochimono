const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');

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

document.addEventListener('keydown', event => {
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    // Browser Back/Forward must win over viewer navigation.
    event.stopImmediatePropagation();
  }
}, true);

if (stage && viewer) {
  const pointers = new Map();
  let pendingTap = 0;
  let lastTap = null;
  const DOUBLE_TAP_MS = 300;

  const activeUiAt = (x, y) => document.elementFromPoint(x, y)?.closest(
    '.viewer-nav,.viewer-bar,.viewer-collections,.viewer-info,dialog,video'
  );

  const zoomed = () => stage.classList.contains('viewer-zoomed');

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
      // browser-ui.js owns the actual double-tap zoom transition.
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
}
