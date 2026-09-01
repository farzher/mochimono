const files = document.querySelector('#files');
const bottomSentinel = document.querySelector('#scroll-sentinel');
const topSentinel = document.querySelector('#top-scroll-sentinel');
const viewer = document.querySelector('#viewer');

if (files && bottomSentinel) {
  let frame = 0;
  let passes = 0;

  function schedule(reset = false) {
    if (reset) passes = 0;
    if (frame) return;
    frame = requestAnimationFrame(fillHeadroom);
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
    // Prefer the user's current edge. This keeps several screens of real card DOM
    // ahead of a fast wheel/touchpad scroll without requesting any thumbnails by
    // itself. The existing bounded window still caps DOM size.
    if (state.hasMore && bottomDistance < headroom) extended = Boolean(library.extend(1));
    else if (state.hasPrevious && topDistance > -headroom) extended = Boolean(library.extend(-1));

    if (extended && ++passes < 4) requestAnimationFrame(() => schedule(false));
    else passes = 0;
  }

  addEventListener('scroll', () => schedule(true), { passive:true });
  addEventListener('resize', () => schedule(true), { passive:true });
  window.addEventListener('mochimono:fast-local', () => schedule(true));
  window.addEventListener('mochimono:local-catalog-ready', () => schedule(true));

  new MutationObserver(() => schedule(false)).observe(files, { childList:true, subtree:false });
  schedule(true);
}
