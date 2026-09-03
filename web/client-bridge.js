if (location.pathname.startsWith('/files')) {
  const viewer = document.querySelector('#viewer');
  const viewerOpen = document.querySelector('#viewer-open');
  const viewerHash = () => viewerOpen?.getAttribute('href')?.match(/\/api\/objects\/([a-f0-9]{64})/)?.[1] || '';
  const reportViewer = () => window.parent.postMessage({
    type: 'mochimono-viewer-state',
    open: Boolean(viewer && !viewer.hidden),
    hash: viewer && !viewer.hidden ? viewerHash() : '',
    pending: document.documentElement.classList.contains('viewer-restore-pending')
  }, location.origin);
  const shellScrollY = () => Math.min(96, Math.max(0, Math.round(window.scrollY || 0)));
  let reportedScrollY = -1;
  const reportScroll = () => {
    const y = shellScrollY();
    if (y === reportedScrollY) return;
    reportedScrollY = y;
    window.parent.postMessage({ type: 'mochimono-library-scroll', y }, location.origin);
  };

  if (viewer || viewerOpen) {
    const viewerObserver = new MutationObserver(reportViewer);
    if (viewer) viewerObserver.observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
    if (viewerOpen) viewerObserver.observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
    reportViewer();
  }

  if (document.documentElement.classList.contains('viewer-restore-pending')) {
    const restoreObserver = new MutationObserver(() => {
      reportViewer();
      if (!document.documentElement.classList.contains('viewer-restore-pending')) restoreObserver.disconnect();
    });
    restoreObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }

  let scrollFrame = 0;
  addEventListener('scroll', () => {
    if (scrollFrame || shellScrollY() === reportedScrollY) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      reportScroll();
    });
  }, { passive: true });
  reportScroll();

  let localIndexTimer = 0;
  let localIndexGeneration = 0;
  const localIndexPaths = new Set();
  const localIndexSeen = new Set();
  const pathKey = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();

  async function followLocalIndex(paths) {
    for (const path of Array.isArray(paths) ? paths : [paths]) if (path) localIndexPaths.add(String(path));
    if (!localIndexPaths.size) return;
    const generation = ++localIndexGeneration;
    clearTimeout(localIndexTimer);
    let idleSince = 0;

    const tick = async () => {
      if (generation !== localIndexGeneration) return;
      for (const path of localIndexPaths) {
        try {
          const response = await fetch(`/api/client/local-catalog?limit=720&path=${encodeURIComponent(path)}`, { cache: 'no-store' });
          if (!response.ok) continue;
          const data = await response.json();
          const fresh = (data.files || []).filter(file => file?.hash && !localIndexSeen.has(file.hash));
          for (const file of fresh) localIndexSeen.add(file.hash);
          if (fresh.length) window.mochimonoLibrary?.upsertMany?.(fresh);
        } catch {}
      }

      let indexing = false;
      try {
        const response = await fetch('/api/state', { cache: 'no-store' });
        if (response.ok) {
          const state = await response.json();
          const progressPath = pathKey(state.job?.progress?.path);
          indexing = state.job?.status === 'running' && state.job?.progress?.phase === 'Indexing' &&
            [...localIndexPaths].some(path => pathKey(path) === progressPath);
        }
      } catch {}

      if (indexing) idleSince = 0;
      else idleSince ||= Date.now();
      if (!idleSince || Date.now() - idleSince < 2200) {
        localIndexTimer = setTimeout(tick, 700);
        return;
      }

      localIndexPaths.clear();
      localIndexSeen.clear();
      await window.mochimonoLibrary?.refresh?.().catch?.(() => {});
      await window.mochimonoLocations?.refresh?.().catch?.(() => {});
    };

    tick();
  }

  window.mochimonoClientBridge = { followLocalIndex };
  addEventListener('beforeunload', () => clearTimeout(localIndexTimer), { once: true });
}
