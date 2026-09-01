const files = document.querySelector('#files');
const THUMB_VERSION = 3;

if (files) {
  const ready = window.mochimonoReadyThumbs instanceof Set ? window.mochimonoReadyThumbs : new Set();
  window.mochimonoReadyThumbs = ready;

  const hashFor = card => String(card?.dataset?.hash || '');

  function pending(box, hash) {
    if (box.querySelector('.video-thumb-pending')) return;
    const item = document.createElement('span');
    item.className = 'video-thumb-pending';
    item.dataset.videoThumb = hash;
    box.prepend(item);
  }

  function paint(card) {
    if (!(card instanceof Element) || !card.matches('.file-card.media-card[data-hash]')) return;
    const hash = hashFor(card);
    if (!ready.has(hash)) return;
    const box = card.querySelector('.media-thumb');
    if (!box || box.querySelector('img.cached-thumb')) return;

    const image = document.createElement('img');
    image.className = 'cached-thumb server-thumb eager-ready-thumb';
    image.alt = card.dataset.filename || card.title || '';
    image.decoding = 'async';
    image.loading = 'eager';
    image.addEventListener('load', () => {
      box.querySelector('.video-thumb-pending')?.remove();
      if (image.naturalWidth && image.naturalHeight) {
        card.style.setProperty('--ratio', Math.max(.65, Math.min(2.1, image.naturalWidth / image.naturalHeight)));
      }
      image.classList.remove('eager-ready-thumb');
    }, { once: true });
    image.addEventListener('error', () => {
      ready.delete(hash);
      image.remove();
      pending(box, hash);
      window.dispatchEvent(new CustomEvent('mochimono:ready-thumb-missed', { detail: { hash } }));
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

  window.addEventListener('mochimono:ready-thumbs', event => {
    for (const hash of event.detail?.hashes || []) if (/^[a-f0-9]{64}$/.test(String(hash))) ready.add(String(hash));
    paintAll();
  });

  paintAll();
}
