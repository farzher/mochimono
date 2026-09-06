const viewer = document.querySelector('#viewer');
const viewerMeta = document.querySelector('#viewer-meta');
const viewerOpen = document.querySelector('#viewer-open');
const viewerMedia = document.querySelector('#viewer-media');

if (viewer && viewerMeta && viewerOpen && viewerMedia) {
  const resolutionPattern = /^\d[\d,]*×\d[\d,]*$/;
  const sourceState = document.createElement('span');
  sourceState.className = 'viewer-source-state';
  sourceState.hidden = true;
  viewerMeta.after(sourceState);

  const style = document.createElement('style');
  style.textContent = `
.viewer-source-state{display:inline-flex;align-items:center;margin-left:7px;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.07);color:#aaa29e;font-size:9px;font-weight:750;line-height:16px;white-space:nowrap}
.viewer-source-state[hidden]{display:none!important}
`;
  document.head.append(style);

  function currentHash() {
    return viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  }

  function resolution(width, height) {
    return `${Number(width).toLocaleString()}×${Number(height).toLocaleString()}`;
  }

  function mediaSourceState() {
    const image = viewerMedia.querySelector(':scope > img');
    if (image) {
      const src = image.currentSrc || image.src || '';
      if (image.hasAttribute('data-full-src') || src.includes('/api/thumbs/')) return 'Thumbnail';
      if (src.includes('/api/renditions/') || /\/api\/representations\/[^/]+\/compact(?:\?|$)/.test(src)) return 'Squished';
      if (src.includes('/api/objects/')) return 'Original';
      return '';
    }

    const video = viewerMedia.querySelector(':scope > video');
    if (video) {
      const src = video.currentSrc || video.src || '';
      if (src.includes('/api/renditions/') || /\/api\/representations\/[^/]+\/compact(?:\?|$)/.test(src)) return 'Squished';
      if (src.includes('/api/objects/')) return 'Original';
      if (!src && String(video.poster || '').includes('/api/thumbs/')) return 'Thumbnail';
    }
    return '';
  }

  function syncSourceState() {
    const label = mediaSourceState();
    sourceState.textContent = label;
    sourceState.hidden = !label;
  }

  function updateViewerResolution(image) {
    if (!(image instanceof HTMLImageElement) || image.hasAttribute('data-full-src')) return;
    const src = image.currentSrc || image.src || '';
    if (!src.includes('/api/objects/')) return;

    const width = Number(image.naturalWidth) || 0;
    const height = Number(image.naturalHeight) || 0;
    if (!width || !height) return;

    const nextResolution = resolution(width, height);
    const parts = String(viewerMeta.textContent || '').split('·').map(part => part.trim()).filter(Boolean);
    const index = parts.findIndex(part => resolutionPattern.test(part));
    const previousResolution = index >= 0 ? parts[index] : '';
    if (index >= 0) parts[index] = nextResolution;
    else parts.splice(Math.min(1, parts.length), 0, nextResolution);
    viewerMeta.textContent = parts.join(' · ');

    if (previousResolution === nextResolution) return;
    const hash = currentHash();
    if (hash) window.mochimonoLibrary?.upsert?.({ hash, width, height });
  }

  viewerMedia.addEventListener('load', event => {
    updateViewerResolution(event.target);
    syncSourceState();
  }, true);

  new MutationObserver(() => {
    const image = viewerMedia.querySelector('img:not([data-full-src])');
    if (image?.complete) updateViewerResolution(image);
    syncSourceState();
  }).observe(viewerMedia, { childList:true, subtree:true, attributes:true, attributeFilter:['src','poster','data-full-src'] });

  syncSourceState();
}
