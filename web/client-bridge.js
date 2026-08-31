if (location.pathname.startsWith('/files')) {
  const viewer = document.querySelector('#viewer');
  const reportViewer = () => window.parent.postMessage({
    type: 'mochimono-viewer-state',
    open: Boolean(viewer && !viewer.hidden)
  }, location.origin);
  const reportScroll = () => window.parent.postMessage({
    type: 'mochimono-library-scroll',
    y: Math.max(0, window.scrollY || 0)
  }, location.origin);

  if (viewer) {
    new MutationObserver(reportViewer).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
    reportViewer();
  }

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
