const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');

if (files) {
  const style = document.createElement('style');
  style.textContent = `
    /* Once a rendered month has an exact measured height, let Chromium skip
       layout/paint for the off-screen subtree while preserving that exact space. */
    .files.grid>.date-group.grid-contained{
      content-visibility:auto;
      contain-intrinsic-size:auto var(--grid-intrinsic-height)
    }
  `;
  document.head.append(style);

  let measureFrame = 0;
  let invalidateTimer = 0;
  const observedCards = new Set();

  function measureGroups() {
    measureFrame = 0;
    if (!files.classList.contains('grid')) return;
    for (const group of files.querySelectorAll(':scope > .date-group:not(.grid-contained)')) {
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
        group.classList.remove('grid-contained');
        group.style.removeProperty('--grid-intrinsic-height');
      }
      requestAnimationFrame(scheduleMeasure);
    }, 80);
  }

  // Keep decoded images only near the viewport. Cache Storage and thumbs.js keep
  // the compressed thumbnail available, and its existing 1400px observer paints
  // it again before the card becomes visible on a return scroll.
  const mediaObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const card = entry.target;
      const box = card.querySelector('.media-thumb');
      const image = box?.querySelector('img.cached-thumb');
      if (!image) continue;
      const pending = document.createElement('span');
      pending.className = 'video-thumb-pending';
      pending.dataset.videoThumb = card.dataset.hash || '';
      image.replaceWith(pending);
    }
  }, { rootMargin: '2200px 0px' });

  function cardsIn(node) {
    if (!(node instanceof Element)) return [];
    const cards = [];
    if (node.matches('.media-card[data-hash]')) cards.push(node);
    cards.push(...node.querySelectorAll('.media-card[data-hash]'));
    return cards;
  }

  function observe(node) {
    for (const card of cardsIn(node)) {
      if (observedCards.has(card)) continue;
      observedCards.add(card);
      mediaObserver.observe(card);
    }
  }

  function forget(node) {
    for (const card of cardsIn(node)) {
      if (!observedCards.delete(card)) continue;
      mediaObserver.unobserve(card);
    }
  }

  observe(files);
  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) forget(node);
      for (const node of record.addedNodes) observe(node);
    }
  }).observe(files, { childList:true, subtree:true });

  window.addEventListener('mochimono:grid-laid-out', scheduleMeasure);
  window.addEventListener('mochimono:media-size', invalidateGeometry);
  window.addEventListener('resize', invalidateGeometry, { passive:true });
  window.addEventListener('mochimono:catalog-cache-restored', scheduleMeasure);
  window.addEventListener('mochimono:catalog-updated', scheduleMeasure);

  // The hidden grid does not need to retain decoded images behind a full-screen
  // viewer. This is especially useful after browsing hundreds of videos/photos.
  if (viewer) new MutationObserver(() => {
    if (viewer.hidden) return;
    for (const card of observedCards) {
      const box = card.querySelector('.media-thumb');
      const image = box?.querySelector('img.cached-thumb');
      if (!image) continue;
      const pending = document.createElement('span');
      pending.className = 'video-thumb-pending';
      pending.dataset.videoThumb = card.dataset.hash || '';
      image.replaceWith(pending);
    }
  }).observe(viewer, { attributes:true, attributeFilter:['hidden'] });

  scheduleMeasure();
}
