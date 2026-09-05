const files = document.querySelector('#files');
const THUMB_VERSION = 3;

// Stable-grid already mounts several screens of rows ahead of the viewport.
// Put the real <img> elements into those mounted rows immediately so Chromium
// can fetch and decode them before PageUp/PageDown exposes the rows. The normal
// thumbnail subsystem adopts these same nodes when its observer catches up.
function primeCard(card) {
  if (!card?.isConnected || !card.classList.contains('media-card')) return;
  const hash = String(card.dataset.hash || '');
  const box = card.querySelector('.media-thumb');
  if (!hash || !box || box.querySelector('img.cached-thumb')) return;

  const image = document.createElement('img');
  image.className = 'cached-thumb';
  image.alt = '';
  image.hidden = false;
  image.decoding = 'async';
  image.loading = 'eager';
  image.style.objectFit = 'cover';
  image.dataset.thumbHash = hash;
  try { image.fetchPriority = 'auto'; } catch {}

  image.addEventListener('load', () => {
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    box.querySelector('.video-thumb-pending')?.remove();
    try { window.mochimonoCatalogCache?.rememberDimensions?.(hash, image.naturalWidth, image.naturalHeight); } catch {}
  }, { once:true });

  image.addEventListener('error', () => {
    if (!image.isConnected || image.dataset.thumbHash !== hash) return;
    image.remove();
  }, { once:true });

  box.prepend(image);
  image.src = `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
  image.decode?.().catch(() => {});
}

function primeTree(node) {
  if (!(node instanceof Element)) return;
  if (node.matches('.stable-grid-row')) {
    for (const card of node.querySelectorAll('.media-card[data-hash]')) primeCard(card);
  }
  for (const row of node.querySelectorAll?.('.stable-grid-row') || []) {
    for (const card of row.querySelectorAll('.media-card[data-hash]')) primeCard(card);
  }
}

if (files) {
  primeTree(files);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) primeTree(node);
    }
  }).observe(files, { childList:true, subtree:true });
  window.addEventListener('mochimono:stable-grid-installed', () => primeTree(files));
}
