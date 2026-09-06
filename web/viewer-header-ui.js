const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const viewerActions = viewer?.querySelector('.viewer-actions');
const viewerOpen = document.querySelector('#viewer-open');

if (viewer && stage) {
  const style = document.createElement('style');
  style.textContent = `
.viewer-actions>.viewer-optimize-trigger{
  position:static!important;
  z-index:auto!important;
  inset:auto!important;
  min-height:40px!important;
  height:40px;
  padding:0 8px!important;
  border:0!important;
  border-radius:0!important;
  background:transparent!important;
  color:#f1f1f1!important;
  font-size:12px!important;
  font-weight:700;
  line-height:1;
  box-shadow:none!important;
  backdrop-filter:none!important;
  -webkit-backdrop-filter:none!important;
  text-shadow:0 1px 4px rgba(0,0,0,.9);
}
.viewer-actions>.viewer-optimize-trigger:hover{background:transparent!important;color:#fff!important}
`;
  document.head.append(style);

  function placeCompress() {
    if (!viewerActions) return;
    const compress = viewer.querySelector('.viewer-optimize-trigger');
    if (!compress || compress.parentElement === viewerActions) return;
    if (viewerOpen?.parentElement === viewerActions) viewerOpen.before(compress);
    else viewerActions.prepend(compress);
  }

  function zoomed() {
    const pixels = window.mochimonoViewerPixelZoom;
    return Boolean(
      pixels?.zoomed?.() ||
      stage.classList.contains('viewer-desktop-zoomed') ||
      stage.classList.contains('viewer-touch-zoomed')
    );
  }

  function sync() {
    placeCompress();
    if (viewer.hidden) {
      viewer.classList.remove('viewer-controls-hidden');
      return;
    }
    viewer.classList.toggle('viewer-controls-hidden', zoomed());
  }

  // Clicking/tapping the image no longer manually toggles the toolbar.
  // Existing callers still use this API, but visibility is derived only from
  // whether the viewer is away from its normal fitted zoom.
  if (window.mochimonoViewerControls) {
    window.mochimonoViewerControls.show = sync;
    window.mochimonoViewerControls.toggle = sync;
  }

  new MutationObserver(sync).observe(stage, { attributes:true, attributeFilter:['class'] });
  new MutationObserver(sync).observe(viewer, { childList:true, subtree:true, attributes:true, attributeFilter:['hidden','class'] });
  window.addEventListener('mochimono:optimize-open', sync);
  window.addEventListener('mochimono:optimize-close', sync);
  requestAnimationFrame(sync);
}
