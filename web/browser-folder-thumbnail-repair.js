if (document.documentElement.classList.contains('client-library')) {
  let fallbackPromise = null;
  const queued = new Set();

  const fallback = () => fallbackPromise ||= import('./browser-thumbnail-fallback.js');

  function recordFor(image) {
    const card = image?.closest?.('[data-hash]');
    const hash = String(card?.dataset?.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const filename = String(card.dataset.filename || card.title || '');
    const video = card.classList.contains('video-card');
    return { hash, filename, kind:video ? 'video' : 'image', urgent:true };
  }

  document.addEventListener('error', event => {
    const image = event.target instanceof HTMLImageElement ? event.target : null;
    if (!image?.classList.contains('cached-thumb')) return;
    const record = recordFor(image);
    if (!record || queued.has(record.hash)) return;
    queued.add(record.hash);
    fallback()
      .then(module => module.queueBrowserThumbnail(record))
      .catch(() => queued.delete(record.hash));
  }, true);

  addEventListener('mochimono:browser-thumbnail-ready', event => {
    const hash = String(event.detail?.hash || '');
    if (hash) queued.delete(hash);
  });

  addEventListener('mochimono:browser-folders-changed', () => queued.clear());
}
