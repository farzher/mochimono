const files = document.querySelector('#files');

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    /* Far-away months keep their measured space, but months approaching the
       viewport are made fully visible before their child thumbnails are needed. */
    .files.grid>.date-group.grid-contained{
      content-visibility:auto;
      contain-intrinsic-size:auto var(--grid-intrinsic-height)
    }
    .files.grid>.date-group.grid-contained.grid-near{content-visibility:visible}
  `;
  document.head.append(style);

  let measureFrame = 0;
  let invalidateTimer = 0;
  const observedGroups = new Set();

  const groupObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      entry.target.classList.toggle('grid-near', entry.isIntersecting);
    }
  }, { rootMargin:'2200px 0px' });

  function observeGroup(group) {
    if (observedGroups.has(group)) return;
    observedGroups.add(group);
    groupObserver.observe(group);
  }

  function forgetGroup(group) {
    if (!observedGroups.delete(group)) return;
    groupObserver.unobserve(group);
  }

  function measureGroups() {
    measureFrame = 0;
    if (!files.classList.contains('grid')) return;
    for (const group of files.querySelectorAll(':scope > .date-group')) {
      observeGroup(group);
      if (group.classList.contains('grid-contained')) continue;
      const height = group.getBoundingClientRect().height;
      if (!(height > 0)) continue;
      group.style.setProperty('--grid-intrinsic-height', `${Math.ceil(height)}px`);
      group.classList.add('grid-contained');
    }
  }

  function scheduleMeasure() {
    if (!measureFrame) measureFrame = requestAnimationFrame(measureGroups);
  }

  function invalidateGeometry() {
    clearTimeout(invalidateTimer);
    invalidateTimer = setTimeout(() => {
      for (const group of files.querySelectorAll(':scope > .date-group.grid-contained')) {
        group.classList.remove('grid-contained', 'grid-near');
        group.style.removeProperty('--grid-intrinsic-height');
      }
      requestAnimationFrame(scheduleMeasure);
    }, 80);
  }

  /* Do not replace off-screen thumbnail <img> elements with placeholders.
     Chromium can discard decoded bitmap memory itself while retaining the image
     resource, which makes reverse scrolling instant instead of visibly reloading
     thumbnails we already had. */

  function removeLoadingPlaceholder() {
    for (const node of files.querySelectorAll(':scope > .empty')) {
      if (node.textContent.trim() === 'Loading…') node.remove();
    }
  }

  removeLoadingPlaceholder();
  new MutationObserver(records => {
    let groupsChanged = false;
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node instanceof Element && node.matches('.date-group')) forgetGroup(node);
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('.empty') && node.textContent.trim() === 'Loading…') node.remove();
        if (node.matches('.date-group')) groupsChanged = true;
      }
    }
    if (groupsChanged) scheduleMeasure();
  }).observe(files, { childList:true });

  window.addEventListener('mochimono:grid-laid-out', scheduleMeasure);
  window.addEventListener('mochimono:media-size', invalidateGeometry);
  window.addEventListener('resize', invalidateGeometry, { passive:true });
  window.addEventListener('mochimono:catalog-cache-restored', scheduleMeasure);
  window.addEventListener('mochimono:catalog-updated', scheduleMeasure);

  scheduleMeasure();
}
