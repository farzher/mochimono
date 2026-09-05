import './mobile-thumb-prewarm.js';

const viewer = document.querySelector('#viewer');
const viewerStage = document.querySelector('#viewer-stage');
const viewerMedia = document.querySelector('#viewer-media');
const viewerName = document.querySelector('#viewer-name');
const viewerMeta = document.querySelector('#viewer-meta');

const style = document.createElement('style');
style.textContent = `
.media-thumb{position:relative;isolation:isolate;background:#100f11}
.media-thumb>.cached-thumb{position:relative;z-index:2}
.media-thumb>.video-thumb-pending{position:absolute;z-index:1;inset:0;display:block;background:transparent;pointer-events:none}
.media-thumb>.play-badge{z-index:3}
#viewer-media>video{width:100vw!important;height:100dvh!important;max-width:100vw!important;max-height:100dvh!important;object-fit:contain!important;background:#000}
.viewer-nav{display:none!important;pointer-events:none!important}
#viewer-preview-status{position:absolute;z-index:102;right:14px;top:66px;padding:4px 7px;border:1px solid rgba(255,255,255,.11);border-radius:999px;background:rgba(18,18,18,.58);backdrop-filter:blur(7px);color:rgba(255,255,255,.78);font-size:10px;font-weight:650;line-height:1;letter-spacing:.01em;pointer-events:none}
`;
document.head.append(style);

const viewerPreviewStatus = document.createElement('span');
viewerPreviewStatus.id = 'viewer-preview-status';
viewerPreviewStatus.textContent = 'Preview';
viewerPreviewStatus.hidden = true;
viewerStage?.append(viewerPreviewStatus);

const RESOLUTION = /^\d[\d,]*×\d[\d,]*$/;

function rewriteViewerResolution(value = '', hide = false) {
  if (!viewerMeta) return;
  const before = String(viewerMeta.textContent || '');
  const parts = before.split(' · ').filter(Boolean);
  let resolutionIndex = parts.findIndex(part => RESOLUTION.test(part.trim()));

  if (hide && resolutionIndex >= 0) {
    parts.splice(resolutionIndex, 1);
    resolutionIndex = -1;
  } else if (resolutionIndex >= 0) {
    parts[resolutionIndex] = parts[resolutionIndex].replaceAll(',', '');
  }

  if (value) {
    if (resolutionIndex >= 0) parts[resolutionIndex] = value;
    else parts.splice(Math.min(1, parts.length), 0, value);
  }

  const after = parts.join(' · ');
  if (after !== before) viewerMeta.textContent = after;
}

function syncViewerResolution() {
  const image = viewerMedia?.querySelector(':scope>img');
  if (!(image instanceof HTMLImageElement)) return rewriteViewerResolution();
  if (image.dataset.previewOnly === '1') return rewriteViewerResolution();
  if (image.dataset.fullSrc) return rewriteViewerResolution('', true);
  if (image.dataset.viewerFullLoaded !== '1') return rewriteViewerResolution();
  if (image.naturalWidth && image.naturalHeight) rewriteViewerResolution(`${image.naturalWidth}×${image.naturalHeight}`);
}

function watchViewerResolution(image) {
  if (!(image instanceof HTMLImageElement) || image.dataset.viewerResolutionWatching === '1') return;
  image.dataset.viewerResolutionWatching = '1';
  image.addEventListener('load', () => {
    if (!image.isConnected) return;
    if (!image.dataset.fullSrc && image.dataset.previewOnly !== '1') image.dataset.viewerFullLoaded = '1';
    requestAnimationFrame(syncViewerResolution);
  });
  if (image.complete && image.naturalWidth) {
    if (!image.dataset.fullSrc && image.dataset.previewOnly !== '1') image.dataset.viewerFullLoaded = '1';
    requestAnimationFrame(syncViewerResolution);
  }
}

function syncViewerPreviewStatus() {
  if (!viewerPreviewStatus) return;
  const preview = viewerMedia?.querySelector(':scope>img[data-full-src],:scope>img[data-preview-only="1"]');
  viewerPreviewStatus.hidden = !preview || Boolean(viewer?.hidden);
}

function stabilizeViewerImage(node) {
  if (!(node instanceof Element)) return;
  const image = node.matches('#viewer-media>img') ? node : node.querySelector?.('#viewer-media>img');
  if (!(image instanceof HTMLImageElement)) return;
  const name = String(image.alt || viewerName?.textContent || '');
  if (/\.hei[cf]$/i.test(name)) {
    image.dataset.previewOnly = '1';
    image.removeAttribute('data-full-src');
  }
  watchViewerResolution(image);
}

if (viewerMedia) {
  stabilizeViewerImage(viewerMedia);
  syncViewerPreviewStatus();
  syncViewerResolution();
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) stabilizeViewerImage(node);
    syncViewerPreviewStatus();
    syncViewerResolution();
  }).observe(viewerMedia, { childList:true, subtree:true, attributes:true, attributeFilter:['data-full-src','data-preview-only','src'] });
  new MutationObserver(() => {
    syncViewerPreviewStatus();
    syncViewerResolution();
  }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
}

if (viewerMeta) new MutationObserver(syncViewerResolution).observe(viewerMeta, { childList:true, characterData:true, subtree:true });
