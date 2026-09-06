const viewer = document.querySelector('#viewer');
const viewerMeta = document.querySelector('#viewer-meta');
const viewerOpen = document.querySelector('#viewer-open');
const viewerMedia = document.querySelector('#viewer-media');

if (viewer && viewerMeta && viewerOpen && viewerMedia) {
  const resolutionPattern = /^\d[\d,]*×\d[\d,]*$/;

  function currentHash() {
    return viewerOpen.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  }

  function resolution(width, height) {
    return `${Number(width).toLocaleString()}×${Number(height).toLocaleString()}`;
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

  viewerMedia.addEventListener('load', event => updateViewerResolution(event.target), true);

  new MutationObserver(() => {
    const image = viewerMedia.querySelector('img:not([data-full-src])');
    if (image?.complete) updateViewerResolution(image);
  }).observe(viewerMedia, { childList:true, subtree:true, attributes:true, attributeFilter:['src','data-full-src'] });
}
