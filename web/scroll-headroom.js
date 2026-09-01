const files = document.querySelector('#files');
const bottomSentinel = document.querySelector('#scroll-sentinel');
const topSentinel = document.querySelector('#top-scroll-sentinel');
const viewer = document.querySelector('#viewer');
const CLIENT = document.documentElement.classList.contains('client-library');

if (files && bottomSentinel) {
  let frame = 0;
  let passes = 0;
  let thumbTimer = 0;
  const preflightAt = new Map();

  function schedule(reset = false) {
    if (reset) passes = 0;
    if (frame) return;
    frame = requestAnimationFrame(fillHeadroom);
  }

  function scheduleThumbs() {
    if (!CLIENT || thumbTimer) return;
    thumbTimer = setTimeout(() => {
      thumbTimer = 0;
      preflightThumbs();
    }, 90);
  }

  function preflightThumbs() {
    if (!CLIENT || document.hidden) return;
    const now = performance.now();
    const distance = Math.max(2400, innerHeight * 3);
    const hashes = [];
    for (const card of files.querySelectorAll('.media-card[data-hash]')) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom < -800 || rect.top > innerHeight + distance) continue;
      const hash = String(card.dataset.hash || '');
      if (!hash || now - (preflightAt.get(hash) || -Infinity) < 30_000) continue;
      preflightAt.set(hash, now);
      hashes.push(hash);
      if (hashes.length >= 240) break;
    }
    if (!hashes.length) return;
    fetch('/api/thumbs/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ background:true, hashes })
    }).catch(() => {});
  }

  function fillHeadroom() {
    frame = 0;
    const library = window.mochimonoLibrary;
    if (!library?.state || !library?.extend || document.hidden || (viewer && !viewer.hidden)) return;
    const state = library.state();
    if (state.view === 'folders') return;

    const headroom = Math.max(3600, innerHeight * 4.5);
    const bottomDistance = bottomSentinel.getBoundingClientRect().top - innerHeight;
    const topDistance = topSentinel?.getBoundingClientRect().bottom ?? -Infinity;

    let extended = false;
    // Keep several screens of actual card DOM ahead of the scroll position. The
    // bounded library window still limits memory; this only shifts it earlier.
    if (state.hasMore && bottomDistance < headroom) extended = Boolean(library.extend(1));
    else if (state.hasPrevious && topDistance > -headroom) extended = Boolean(library.extend(-1));

    scheduleThumbs();
    if (extended && ++passes < 4) requestAnimationFrame(() => schedule(false));
    else passes = 0;
  }

  addEventListener('scroll', () => schedule(true), { passive:true });
  addEventListener('resize', () => schedule(true), { passive:true });
  window.addEventListener('mochimono:fast-local', () => schedule(true));
  window.addEventListener('mochimono:local-catalog-ready', () => schedule(true));

  new MutationObserver(() => schedule(false)).observe(files, { childList:true, subtree:false });
  addEventListener('beforeunload', () => clearTimeout(thumbTimer), { once:true });
  schedule(true);
}
