const files = document.querySelector('#files');
const bottomSentinel = document.querySelector('#scroll-sentinel');
const topSentinel = document.querySelector('#top-scroll-sentinel');
const viewer = document.querySelector('#viewer');
const CLIENT = document.documentElement.classList.contains('client-library');

if (files && bottomSentinel) {
  const WINDOW_SIZE = 720;
  const EDGE_PREFLIGHT = 180;
  const preflightAt = new Map();
  let frame = 0;
  let lastScrollY = scrollY;
  let direction = 1;
  let preflightTimer = 0;

  function schedule() {
    if (!frame) frame = requestAnimationFrame(fillHeadroom);
  }

  function edgeHashes(edge = 1) {
    const cards = [...files.querySelectorAll('.media-card[data-hash]')];
    const slice = edge < 0 ? cards.slice(0, EDGE_PREFLIGHT) : cards.slice(-EDGE_PREFLIGHT);
    const now = performance.now();
    const hashes = [];
    for (const card of slice) {
      const hash = String(card.dataset.hash || '');
      if (!hash || now - (preflightAt.get(hash) || -Infinity) < 30_000) continue;
      preflightAt.set(hash, now);
      hashes.push(hash);
    }
    return hashes;
  }

  function preflightThumbs(edge = direction) {
    if (!CLIENT || document.hidden) return;
    const hashes = edgeHashes(edge);
    if (!hashes.length) return;
    fetch('/api/thumbs/check', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ background:true, hashes })
    }).catch(() => {});
  }

  function schedulePreflight(edge = direction) {
    if (!CLIENT) return;
    clearTimeout(preflightTimer);
    preflightTimer = setTimeout(() => preflightThumbs(edge), 120);
  }

  function fillHeadroom() {
    frame = 0;
    const library = window.mochimonoLibrary;
    if (!library?.state || !library?.extend || document.hidden || (viewer && !viewer.hidden)) return;
    const state = library.state();
    if (state.view === 'folders') return;

    // On first paint the app deliberately starts with 180 cards. Expand that to
    // the bounded 720-card window in ONE render instead of four successive page
    // rebuilds. ensureIndex() can do that while keeping the current top anchored.
    if (state.offset === 0 && state.hasMore && state.loaded < WINDOW_SIZE && library.ensureIndex) {
      if (library.ensureIndex(state.offset + state.loaded)) {
        schedulePreflight(1);
        return;
      }
    }

    const headroom = Math.max(4400, innerHeight * 5.5);
    const bottomDistance = bottomSentinel.getBoundingClientRect().top - innerHeight;
    const topDistance = topSentinel?.getBoundingClientRect().bottom ?? -Infinity;
    let extended = false;

    // Once the window is full, move it only one page per scroll frame. The large
    // headroom gives that render plenty of time without causing bursts of several
    // complete DOM rebuilds.
    if (direction >= 0 && state.hasMore && bottomDistance < headroom) extended = Boolean(library.extend(1));
    else if (direction < 0 && state.hasPrevious && topDistance > -headroom) extended = Boolean(library.extend(-1));

    if (extended) schedulePreflight(direction);
  }

  addEventListener('scroll', () => {
    const next = scrollY;
    if (Math.abs(next - lastScrollY) > 1) direction = next >= lastScrollY ? 1 : -1;
    lastScrollY = next;
    schedule();
  }, { passive:true });
  addEventListener('resize', schedule, { passive:true });
  window.addEventListener('mochimono:fast-local', schedule);
  window.addEventListener('mochimono:local-catalog-ready', schedule);

  // A new bounded window gets one cheap edge preflight. Do not measure hundreds
  // of card rectangles on every scroll event; thumbs.js already owns visibility.
  new MutationObserver(() => {
    schedule();
    schedulePreflight(direction);
  }).observe(files, { childList:true, subtree:false });

  addEventListener('beforeunload', () => clearTimeout(preflightTimer), { once:true });
  schedule();
}
