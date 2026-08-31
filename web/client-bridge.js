if (location.pathname.startsWith('/files')) {
  const viewer = document.querySelector('#viewer');
  const report = () => window.parent.postMessage({
    type: 'mochimono-viewer-state',
    open: Boolean(viewer && !viewer.hidden)
  }, location.origin);
  if (viewer) {
    new MutationObserver(report).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
    report();
  }
}
