const files = document.querySelector('#files');
const THUMB_VERSION = 3;

if (files) {
  const ready = window.mochimonoReadyThumbs instanceof Set ? window.mochimonoReadyThumbs : new Set();
  window.mochimonoReadyThumbs = ready;
  const verifyQueue = new Set();
  const verifyAttempts = new Map();
  let verifyTimer = 0;

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

  function scheduleVerify(hash, delay = 600) {
    if (!/^[a-f0-9]{64}$/.test(hash) || ready.has(hash)) return;
    verifyQueue.add(hash);
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(verifyLoaded, delay);
  }

  async function verifyLoaded() {
    verifyTimer = 0;
    if (!verifyQueue.size || document.hidden) return;
    const hashes = [...verifyQueue];
    verifyQueue.clear();
    const discovered = [];
    const confirmed = new Set();

    for (let offset = 0; offset < hashes.length; offset += 500) {
      try {
        const response = await fetch('/api/thumbs/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hashes: hashes.slice(offset, offset + 500) })
        });
        if (!response.ok) continue;
        const data = await response.json();
        for (const item of data.thumbnails || []) {
          const hash = String(item.hash || '');
          if (!(Number(item.width) > 0 && Number(item.height) > 0)) continue;
          confirmed.add(hash);
          if (!ready.has(hash)) discovered.push(hash);
        }
      } catch {}
    }

    if (discovered.length) {
      if (window.mochimonoRememberReadyThumbs) window.mochimonoRememberReadyThumbs(discovered);
      else discovered.forEach(hash => ready.add(hash));
    }

    for (const hash of hashes) {
      if (confirmed.has(hash) || ready.has(hash)) {
        verifyAttempts.delete(hash);
        continue;
      }
      const attempts = (verifyAttempts.get(hash) || 0) + 1;
      verifyAttempts.set(hash, attempts);
      if (attempts < 3) setTimeout(() => scheduleVerify(hash, 0), attempts * 3500);
    }
  }

  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) paintTree(node);
  }).observe(files, { childList: true, subtree: true });

  files.addEventListener('load', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains('cached-thumb')) return;
    const hash = hashFor(image.closest('[data-hash]'));
    if (hash && !ready.has(hash)) scheduleVerify(hash);
  }, true);

  window.addEventListener('mochimono:ready-thumbs', event => {
    for (const hash of event.detail?.hashes || []) if (/^[a-f0-9]{64}$/.test(String(hash))) ready.add(String(hash));
    paintAll();
  });

  paintAll();
}
