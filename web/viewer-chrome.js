const viewer = document.querySelector('#viewer');
const stage = document.querySelector('#viewer-stage');
const actions = viewer?.querySelector('.viewer-actions');
const openLink = document.querySelector('#viewer-open');
const compress = viewer?.querySelector('.viewer-optimize-trigger');

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
.viewer:not(.viewer-zoomed-ui):not(.image-optimize-active):not(.video-optimize-active) .viewer-bar,
.viewer:not(.viewer-zoomed-ui):not(.image-optimize-active):not(.video-optimize-active) .viewer-collections,
.viewer.image-optimize-active .viewer-bar,
.viewer.image-optimize-active .viewer-collections,
.viewer.video-optimize-active .viewer-bar,
.viewer.video-optimize-active .viewer-collections{
  opacity:1!important;
  pointer-events:auto!important;
}
.viewer:not(.viewer-zoomed-ui):not(.image-optimize-active):not(.video-optimize-active) .viewer-bar *,
.viewer:not(.viewer-zoomed-ui):not(.image-optimize-active):not(.video-optimize-active) .viewer-collections *,
.viewer.image-optimize-active .viewer-bar *,
.viewer.image-optimize-active .viewer-collections *,
.viewer.video-optimize-active .viewer-bar *,
.viewer.video-optimize-active .viewer-collections *{
  pointer-events:auto!important;
}
.viewer.viewer-zoomed-ui:not(.image-optimize-active):not(.video-optimize-active) .viewer-bar,
.viewer.viewer-zoomed-ui:not(.image-optimize-active):not(.video-optimize-active) .viewer-collections{
  opacity:0!important;
  pointer-events:none!important;
}
.viewer.viewer-zoomed-ui:not(.image-optimize-active):not(.video-optimize-active) .viewer-bar *,
.viewer.viewer-zoomed-ui:not(.image-optimize-active):not(.video-optimize-active) .viewer-collections *{
  pointer-events:none!important;
}
`;
  document.head.append(style);

  if (compress && actions) {
    compress.classList.add('viewer-action');
    if (openLink?.parentElement === actions) openLink.before(compress);
    else actions.prepend(compress);
  }

  function zoomed() {
    return Boolean(
      window.mochimonoViewerPixelZoom?.zoomed?.() ||
      stage.classList.contains('viewer-desktop-zoomed') ||
      stage.classList.contains('viewer-touch-zoomed')
    );
  }

  function optimizing() {
    return viewer.classList.contains('image-optimize-active') || viewer.classList.contains('video-optimize-active');
  }

  function syncChrome() {
    const hide = !viewer.hidden && !optimizing() && zoomed();
    viewer.classList.toggle('viewer-zoomed-ui', hide);
    if (!hide) viewer.classList.remove('viewer-controls-hidden');
  }

  // These observers cannot recurse: syncChrome changes only viewer classes,
  // while we observe only stage classes and viewer.hidden.
  new MutationObserver(syncChrome).observe(stage, {
    attributes:true,
    attributeFilter:['class']
  });
  new MutationObserver(syncChrome).observe(viewer, {
    attributes:true,
    attributeFilter:['hidden']
  });

  window.addEventListener('mochimono:optimize-open', syncChrome);
  window.addEventListener('mochimono:optimize-close', syncChrome);
  syncChrome();
}

// Correct video dimensions from the actual loaded media rather than thumbnail
// metadata, then load one comparison controller. Playback sync, frame pairing,
// zoom and pan intentionally live together so separate controllers cannot fight.
import('./viewer-video-resolution.js').catch(error => console.error('Could not load video resolution correction', error));
import('./video-optimize.js')
  .then(() => import('./video-optimize-presets.js'))
  .then(() => import('./video-optimize-polish.js'))
  .then(() => import('./video-optimize-compare-loader.js'))
  .then(() => import('./video-optimize-transport.js'))
  .then(() => import('./video-optimize-live-settings.js'))
  .catch(error => console.error('Could not load video compression UI', error));
