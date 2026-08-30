const viewer = document.querySelector('#viewer');

const style = document.createElement('style');
style.textContent = `
  .viewer:not(.viewer-controls-hidden) .viewer-bar,
  .viewer:not(.viewer-controls-hidden) .viewer-collections{opacity:1!important}
  .viewer:not(.viewer-controls-hidden) .viewer-nav:not(:disabled){opacity:.68!important;pointer-events:auto!important}
  .viewer.viewer-controls-hidden .viewer-bar,
  .viewer.viewer-controls-hidden .viewer-collections,
  .viewer.viewer-controls-hidden .viewer-nav{opacity:0!important;pointer-events:none!important}
  .viewer.viewer-controls-hidden .viewer-bar *,
  .viewer.viewer-controls-hidden .viewer-collections *{pointer-events:none!important}
  .viewer-collections{transition:opacity .18s ease}
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

function clearLegacyFade() {
  viewer?.classList.remove('viewer-ui-hidden');
}

function showControls() {
  if (!viewer) return;
  viewer.classList.remove('viewer-controls-hidden');
  clearLegacyFade();
}

function toggleControls() {
  if (!viewer || viewer.hidden) return;
  viewer.classList.toggle('viewer-controls-hidden');
  clearLegacyFade();
}

window.mochimonoViewerControls = { show: showControls, toggle: toggleControls };

if (viewer) {
  let wasHidden = viewer.hidden;
  new MutationObserver(() => {
    const isHidden = viewer.hidden;
    clearLegacyFade();
    if (wasHidden && !isHidden) showControls();
    wasHidden = isHidden;
  }).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
  clearLegacyFade();
}

// Leave browser Back/Forward shortcuts to the browser. The app's ordinary
// ArrowLeft/ArrowRight handler must never consume Alt+Arrow.
document.addEventListener('keydown', event => {
  if (!viewer || viewer.hidden || !event.altKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopImmediatePropagation();
}, true);
