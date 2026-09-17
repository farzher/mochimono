if (document.documentElement.classList.contains('client-library')) {
  let fallbackPromise = null;
  const queued = new Set();
  const attempts = new Map();
  const retryTimers = new Map();
  const MAX_ATTEMPTS = 3;

  const fallback = () => fallbackPromise ||= import('./browser-thumbnail-fallback.js');

  function recordFor(image) {
    const card = image?.closest?.('[data-hash]');
    const hash = String(card?.dataset?.hash || '');
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const filename = String(card.dataset.filename || card.title || '');
    const video = card.classList.contains('video-card');
    return { hash, filename, kind:video ? 'video' : 'image', urgent:true };
  }

  function releaseForRetry(hash, image) {
    clearTimeout(retryTimers.get(hash));
    retryTimers.set(hash, setTimeout(() => {
      retryTimers.delete(hash);
      queued.delete(hash);
      if (!image.isConnected || (attempts.get(hash) || 0) >= MAX_ATTEMPTS) return;
      const url = new URL(image.src, location.href);
      url.searchParams.set('repair', Date.now());
      image.src = url.href;
    }, 12_000));
  }

  document.addEventListener('error', event => {
    const image = event.target instanceof HTMLImageElement ? event.target : null;
    if (!image?.classList.contains('cached-thumb')) return;
    const record = recordFor(image);
    if (!record || queued.has(record.hash) || (attempts.get(record.hash) || 0) >= MAX_ATTEMPTS) return;
    attempts.set(record.hash, (attempts.get(record.hash) || 0) + 1);
    queued.add(record.hash);
    fallback()
      .then(module => {
        module.queueBrowserThumbnail(record);
        releaseForRetry(record.hash, image);
      })
      .catch(() => releaseForRetry(record.hash, image));
  }, true);

  addEventListener('mochimono:browser-thumbnail-ready', event => {
    const hash = String(event.detail?.hash || '');
    if (!hash) return;
    clearTimeout(retryTimers.get(hash));
    retryTimers.delete(hash);
    queued.delete(hash);
    attempts.delete(hash);
  });

  addEventListener('mochimono:browser-folders-changed', () => {
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    queued.clear();
    attempts.clear();
  });
}
