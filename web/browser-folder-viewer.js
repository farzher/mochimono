if (document.documentElement.classList.contains('client-library')) {
  const viewer = document.querySelector('#viewer');
  const mediaHost = document.querySelector('#viewer-media');
  const openButton = document.querySelector('#viewer-open');
  let shownUrl = '';
  let shownHash = '';
  let generation = 0;

  const hashFromViewer = () => String(openButton?.getAttribute('href') || '')
    .match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';

  function releaseShownUrl() {
    if (shownUrl) URL.revokeObjectURL(shownUrl);
    shownUrl = '';
    shownHash = '';
  }

  async function browserFile(hash) {
    const api = window.mochimonoBrowserFolders;
    if (!api?.fileForHash || !hash) return null;
    try { return await api.fileForHash(hash); }
    catch { return null; }
  }

  async function repairViewer() {
    const mine = ++generation;
    if (!viewer || viewer.hidden) { releaseShownUrl(); return; }
    const hash = hashFromViewer();
    const media = mediaHost?.querySelector('img,video');
    if (!hash || !media) return;
    if (media.dataset.browserSourceHash === hash) return;

    const file = await browserFile(hash);
    if (!file || mine !== generation || viewer.hidden || hashFromViewer() !== hash || !media.isConnected) return;

    if (shownHash !== hash) releaseShownUrl();
    if (!shownUrl) {
      shownHash = hash;
      shownUrl = URL.createObjectURL(file);
    }

    media.dataset.browserSourceHash = hash;
    if (media instanceof HTMLImageElement) {
      media.removeAttribute('data-full-src');
      media.src = shownUrl;
    } else {
      media.src = shownUrl;
      media.load();
      media.play().catch(() => {});
    }
  }

  function scheduleRepair() { queueMicrotask(() => void repairViewer()); }

  if (viewer) new MutationObserver(scheduleRepair).observe(viewer, { attributes:true, attributeFilter:['hidden'] });
  if (mediaHost) new MutationObserver(scheduleRepair).observe(mediaHost, {
    childList:true,
    subtree:true,
    attributes:true,
    attributeFilter:['src','data-full-src']
  });
  if (openButton) new MutationObserver(scheduleRepair).observe(openButton, { attributes:true, attributeFilter:['href'] });

  openButton?.addEventListener('click', async event => {
    const hash = hashFromViewer();
    const file = await browserFile(hash);
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const url = URL.createObjectURL(file);
    open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, true);

  addEventListener('mochimono:browser-catalog-ready', scheduleRepair);
  addEventListener('beforeunload', releaseShownUrl, { once:true });
  scheduleRepair();
}
