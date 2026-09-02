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
  const reportScroll = () => window.parent.postMessage({
    type: 'mochimono-library-scroll',
    y: Math.max(0, window.scrollY || 0)
  }, location.origin);

  if (viewer) {
    new MutationObserver(reportViewer).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
    reportViewer();
  }
  if (viewerOpen) new MutationObserver(reportViewer).observe(viewerOpen, { attributes: true, attributeFilter: ['href'] });
  new MutationObserver(reportViewer).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  let scrollFrame = 0;
  addEventListener('scroll', () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      reportScroll();
    });
  }, { passive: true });
  reportScroll();
}
