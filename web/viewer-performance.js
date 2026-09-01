const viewer = document.querySelector('#viewer');
const viewerMedia = document.querySelector('#viewer-media');
const viewerOpen = document.querySelector('#viewer-open');

const objectHash = value => String(value || '').match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
const currentHash = () => objectHash(viewerOpen?.getAttribute('href'));
const hasLocalCopy = hash => Boolean(hash && window.mochimonoLocations?.forHash?.(hash)?.length);

// The normal viewer used to preload the full-resolution image on both sides of
// the current file. Rapid arrow-key navigation through large local photos could
// therefore keep several full image decodes running at once. Keep only the
// current remote-image upgrade; local images are loaded directly below.
const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
if (src?.get && src?.set) {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    enumerable: src.enumerable,
    get: src.get,
    set(value) {
      const hash = objectHash(value);
      if (hash && !this.isConnected && viewer && !viewer.hidden) {
        const current = currentHash();
        if (hash !== current || hasLocalCopy(hash)) return;
      }
      src.set.call(this, value);
    }
  });
}

function useLocalOriginal() {
  if (!viewer || viewer.hidden || !viewerMedia) return;
  const image = viewerMedia.querySelector('img[data-full-src]');
  if (!image) return;
  const full = image.dataset.fullSrc || '';
  const hash = objectHash(full);
  if (!hasLocalCopy(hash)) return;

  const fallback = image.getAttribute('src') || '';
  image.removeAttribute('data-full-src');
  image.decoding = 'async';
  image.onerror = () => {
    image.onerror = null;
    if (fallback && fallback !== full) image.src = fallback;
  };
  image.src = full;
}

if (viewerMedia) new MutationObserver(useLocalOriginal).observe(viewerMedia, { childList: true, subtree: true });
window.addEventListener('mochimono:locations-updated', useLocalOriginal);
