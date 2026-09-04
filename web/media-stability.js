import './mobile-thumb-prewarm.js';

const files = document.querySelector('#files');
const mediaSize = document.querySelector('#mediaSize');
const viewer = document.querySelector('#viewer');
const viewerStage = document.querySelector('#viewer-stage');
const viewerMedia = document.querySelector('#viewer-media');
const viewerName = document.querySelector('#viewer-name');

const style = document.createElement('style');
style.textContent = `
.media-thumb{position:relative;isolation:isolate}
.media-thumb>.cached-thumb{position:relative;z-index:1}
.media-thumb>.video-thumb-pending{position:absolute;z-index:2;inset:0;display:block;background:#080809;pointer-events:none}
.media-thumb.thumb-decoding::after{content:"";position:absolute;z-index:3;inset:0;background:#080809;pointer-events:none}
.media-thumb>.play-badge{z-index:4}
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

function finishDecode(image, box) {
  const reveal = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (box.isConnected) box.classList.remove('thumb-decoding');
  }));
  if (!image.decode) return reveal();
  image.decode().then(reveal).catch(reveal);
}

function stabilizeImage(image) {
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('cached-thumb')) return;
  const box = image.closest('.media-thumb');
  if (!box || image.dataset.stabilityWatching === '1') return;
  if (image.complete && image.naturalWidth) return;

  image.dataset.stabilityWatching = '1';
  box.classList.add('thumb-decoding');
  image.addEventListener('load', () => {
    delete image.dataset.stabilityWatching;
    finishDecode(image, box);
  }, { once:true });
  image.addEventListener('error', () => {
    delete image.dataset.stabilityWatching;
    box.classList.remove('thumb-decoding');
  }, { once:true });
}

function imagesIn(node) {
  if (!(node instanceof Element)) return [];
  const result = [];
  if (node.matches('img.cached-thumb')) result.push(node);
  result.push(...node.querySelectorAll('img.cached-thumb'));
  return result;
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
  if (!/\.hei[cf]$/i.test(name)) return;
  // Chromium/Windows does not reliably decode the original HEIC. Keep the
  // generated WebP preview instead of letting library-app swap it for a broken
  // original after the thumbnail has rendered successfully.
  image.dataset.previewOnly = '1';
  image.removeAttribute('data-full-src');
}

function cardRatio(card) {
  const width = Number(card.dataset.width) || 0;
  const height = Number(card.dataset.height) || 0;
  return width && height ? Math.max(.65, Math.min(2.1, width / height)) : 1;
}

function normalizeJustifiedRows() {
  if (!files?.isConnected) return;
  const target = Number(mediaSize?.value) || 170;
  const cap = target * 1.42;
  for (const row of files.querySelectorAll('.justified-media-row')) {
    const cards = [...row.querySelectorAll(':scope > .file-card.media-card')];
    if (!cards.length) continue;
    const last = row.classList.contains('last-layout-row');
    const current = Math.max(...cards.map(card => card.getBoundingClientRect().height));
    if (!last && current <= cap + 1) continue;
    const height = last || cards.length === 1 ? target : cap;
    for (const card of cards) {
      const width = cardRatio(card) * height;
      card.style.width = `${width}px`;
      card.style.height = `${height}px`;
      card.style.flexBasis = `${width}px`;
    }
  }
}

if (files) {
  for (const image of files.querySelectorAll('img.cached-thumb')) stabilizeImage(image);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) for (const image of imagesIn(node)) stabilizeImage(image);
      if (record.target instanceof Element) {
        const box = record.target.closest?.('.media-thumb.thumb-decoding');
        if (box && !box.querySelector('img.cached-thumb')) box.classList.remove('thumb-decoding');
      }
    }
  }).observe(files, { childList:true, subtree:true });
}

if (viewerMedia) {
  stabilizeViewerImage(viewerMedia);
  syncViewerPreviewStatus();
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) stabilizeViewerImage(node);
    syncViewerPreviewStatus();
  }).observe(viewerMedia, { childList:true, subtree:true, attributes:true, attributeFilter:['data-full-src','data-preview-only'] });
  new MutationObserver(syncViewerPreviewStatus).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
}

window.addEventListener('mochimono:grid-laid-out', normalizeJustifiedRows);
mediaSize?.addEventListener('input', () => requestAnimationFrame(normalizeJustifiedRows));
requestAnimationFrame(normalizeJustifiedRows);
