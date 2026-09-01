const files = document.querySelector('#files');
const THUMB_VERSION = 3;

if (files) {
  const failedUntil = new Map();

  const hashFor = card => String(card?.dataset?.hash || '');

  function pending(box, hash) {
    if (!box || box.querySelector('.video-thumb-pending')) return;
    const item = document.createElement('span');
    item.className = 'video-thumb-pending';
    item.dataset.videoThumb = hash;
    box.prepend(item);
  }

  function paint(card) {
    if (!(card instanceof Element) || !card.matches('.file-card.media-card[data-hash]')) return;
    const hash = hashFor(card);
    if (!hash || Date.now() < (failedUntil.get(hash) || 0)) return;
    const box = card.querySelector('.media-thumb');
    if (!box || box.querySelector('img.cached-thumb')) return;

    const image = document.createElement('img');
    image.className = 'cached-thumb server-thumb direct-thumb';
    image.alt = card.dataset.filename || card.title || '';
    image.decoding = 'async';
    image.loading = 'lazy';

    image.addEventListener('load', () => {
      failedUntil.delete(hash);
      box.querySelector('.video-thumb-pending')?.remove();
      if (image.naturalWidth && image.naturalHeight) {
        const ratio = Math.max(.65, Math.min(2.1, image.naturalWidth / image.naturalHeight));
        const current = Number(card.style.getPropertyValue('--ratio')) || 0;
        if (Math.abs(current - ratio) >= .001) card.style.setProperty('--ratio', ratio);
        window.mochimonoCatalogCache?.rememberDimensions?.(hash, image.naturalWidth, image.naturalHeight);
      }
    }, { once: true });

    image.addEventListener('error', () => {
      // A missing preview is normal the first time a local file is seen. The
      // regular thumbnail controller will queue generation for nearby cards.
      // Back off this optimistic direct request so DOM mutations cannot create a
      // retry loop while that small preview is being generated.
      failedUntil.set(hash, Date.now() + 5000);
      image.remove();
      pending(box, hash);
    }, { once: true });

    const placeholder = box.querySelector('.video-thumb-pending');
    placeholder ? placeholder.replaceWith(image) : box.prepend(image);
    image.src = `/api/thumbs/${hash}?v=${THUMB_VERSION}`;
  }

  function paintTree(node) {
    if (!(node instanceof Element)) return;
    if (node.matches('.file-card.media-card[data-hash]')) paint(node);
    node.querySelectorAll('.file-card.media-card[data-hash]').forEach(paint);
  }

  function paintAll() {
    files.querySelectorAll('.file-card.media-card[data-hash]').forEach(paint);
  }

  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) paintTree(node);
  }).observe(files, { childList: true, subtree: true });

  // When the thumbnail controller finishes generating a preview it replaces the
  // placeholder itself. If a card is rebuilt later, this pass immediately tries
  // the immutable thumbnail URL again; browser/Agent caches make that path cheap.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) paintAll();
  });

  paintAll();
}
