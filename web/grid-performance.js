const viewer = document.querySelector('#viewer');

let active = false;
let until = 0;
let timer = 0;
let upwardEdgeFrame = 0;
let upwardEdgeOffset = -1;

function finish() {
  timer = 0;
  const wait = until - performance.now();
  if (wait > 0) {
    timer = setTimeout(finish, wait + 4);
    return;
  }
  if (!active) return;
  active = false;
  document.documentElement.classList.remove('grid-interaction-active');
  window.dispatchEvent(new CustomEvent('mochimono:grid-interaction-end'));
}

function schedule() {
  if (timer) return;
  timer = setTimeout(finish, Math.max(0, until - performance.now()) + 4);
}

function pulse(duration = 130) {
  if (viewer && !viewer.hidden) return;
  until = Math.max(until, performance.now() + duration);
  if (!active) {
    active = true;
    document.documentElement.classList.add('grid-interaction-active');
    window.dispatchEvent(new CustomEvent('mochimono:grid-interaction-start'));
  }
  schedule();
}

function release() {
  if (!active) return;
  until = Math.min(until, performance.now() + 40);
  clearTimeout(timer);
  timer = 0;
  schedule();
}

function visibleTopAnchor() {
  const files = document.querySelector('#files');
  if (!files) return null;
  const viewportTop = document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0;
  for (const card of files.querySelectorAll('[data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= viewportTop || rect.top >= innerHeight) continue;
    return { card, top: rect.top };
  }
  return null;
}

function repairUpwardWheelEdge(expectedOffset) {
  const library = window.mochimonoLibrary;
  const state = library?.state?.();
  if (!state || state.view === 'folders' || !state.hasPrevious || state.offset !== expectedOffset || (viewer && !viewer.hidden)) return;

  const sentinel = document.querySelector('#top-scroll-sentinel');
  if (!sentinel || sentinel.hidden || sentinel.getBoundingClientRect().bottom < -360) return;

  // At the physical document top library-app normally has no anchor. If this is
  // only the top of the current virtual window, preserve the visible card here so
  // prepending creates real upward scroll headroom instead of leaving the sentinel
  // intersecting forever. Force justified-row geometry before measuring the
  // correction so the rough pre-layout rows never become a visible intermediate.
  const anchor = scrollY <= 4 ? visibleTopAnchor() : null;
  if (!library.extend(-1)) return;
  window.mochimonoGallery?.layoutNow?.();
  if (anchor?.card.isConnected) {
    const delta = anchor.card.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > .5) scrollBy({ top: delta, left: 0, behavior: 'auto' });
  }
}

function scheduleUpwardWheelEdge() {
  const state = window.mochimonoLibrary?.state?.();
  if (!state?.hasPrevious || state.view === 'folders') return;
  upwardEdgeOffset = state.offset;
  if (upwardEdgeFrame) return;
  upwardEdgeFrame = requestAnimationFrame(() => {
    upwardEdgeFrame = 0;
    repairUpwardWheelEdge(upwardEdgeOffset);
  });
}

window.mochimonoGridInteraction = { active: () => active, pulse, release };

window.addEventListener('scroll', () => pulse(140), { passive: true });
window.addEventListener('wheel', event => {
  if (event.deltaY >= 0 || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || (viewer && !viewer.hidden)) return;
  scheduleUpwardWheelEdge();
}, { passive: true, capture: true });
window.addEventListener('blur', release);
