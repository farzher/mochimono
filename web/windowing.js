const files = document.querySelector('#files');
const viewer = document.querySelector('#viewer');
const bottom = document.querySelector('#scroll-sentinel');
const top = document.querySelector('#top-scroll-sentinel');

let frame = 0;
let filling = false;

function schedule() {
  if (!frame) frame = requestAnimationFrame(fill);
}

function fill() {
  frame = 0;
  if (filling || document.hidden || !files || !bottom || !top || (viewer && !viewer.hidden)) return;
  const library = window.mochimonoLibrary;
  const state = library?.state?.();
  if (!state || state.view === 'folders') return;

  const bottomHeadroom = Math.max(3000, innerHeight * 4);
  const topHeadroom = Math.max(2200, innerHeight * 3);
  const bottomDistance = bottom.getBoundingClientRect().top - innerHeight;
  const topDistance = top.getBoundingClientRect().bottom;

  let extended = false;
  filling = true;
  try {
    if (state.hasMore && bottomDistance < bottomHeadroom) extended = Boolean(library.extend(1));
    else if (state.hasPrevious && topDistance > -topHeadroom) extended = Boolean(library.extend(-1));
  } finally {
    filling = false;
  }

  if (extended) requestAnimationFrame(schedule);
}

addEventListener('scroll', schedule, { passive: true });
addEventListener('resize', schedule, { passive: true });
window.addEventListener('mochimono:grid-laid-out', schedule);
window.addEventListener('mochimono:catalog-cache-restored', schedule);
window.addEventListener('mochimono:catalog-updated', schedule);
window.addEventListener('mochimono-viewer-return', schedule);
new MutationObserver(schedule).observe(files, { childList: true, subtree: false });

schedule();
