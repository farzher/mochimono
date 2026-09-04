const viewer = document.querySelector('#viewer');
const files = document.querySelector('#files');

// Mochimono owns scroll anchoring for its virtual grid. Native browser anchoring
// otherwise competes with the explicit card anchor when rows are inserted above.
document.documentElement.style.overflowAnchor = 'none';

let active = false;
let until = 0;
let timer = 0;
let upwardEdgeFrame = 0;
let upwardEdgeOffset = -1;
let keyboardBoundaryPending = false;
let queuedBoundaryKey = '';

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
  if (!files) return null;
  const viewportTop = document.querySelector('.commandbar')?.getBoundingClientRect().bottom || 0;
  for (const card of files.querySelectorAll('[data-hash]')) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= viewportTop || rect.top >= innerHeight) continue;
    return { card, top: rect.top };
  }
  return null;
}

function restoreCardTop(card, top) {
  if (!card?.isConnected) return;
  const delta = card.getBoundingClientRect().top - top;
  if (Math.abs(delta) > .5) scrollBy({ top: delta, left: 0, behavior: 'auto' });
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
  if (anchor?.card.isConnected) restoreCardTop(anchor.card, anchor.top);
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

function cardWalker(current) {
  if (!files || !current?.isConnected) return null;
  const walker = document.createTreeWalker(files, NodeFilter.SHOW_ELEMENT, {
    acceptNode: node => node.hasAttribute?.('data-hash') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
  });
  walker.currentNode = current;
  return walker;
}

function hasRenderedRow(current, direction) {
  const walker = cardWalker(current);
  if (!walker) return true;
  const currentTop = current.getBoundingClientRect().top;
  const step = direction < 0 ? 'previousNode' : 'nextNode';
  for (let card = walker[step](); card; card = walker[step]()) {
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (direction < 0 ? rect.top < currentTop - 3 : rect.top > currentTop + 3) return true;
  }
  return false;
}

function canExtend(direction) {
  const state = window.mochimonoLibrary?.state?.();
  return direction < 0 ? Boolean(state?.hasPrevious) : Boolean(state?.hasMore);
}

function editingControl(target) {
  const control = target?.closest?.('input,select,textarea,[contenteditable="true"]');
  return Boolean(control && control.id !== 'search');
}

function runBoundaryArrow(key) {
  window.mochimonoGridKeyboard?.press?.(key);
  // The real keydown was intercepted before fast-arrow-nav saw it. Release the
  // synthetic press here so a very quick tap cannot leave its internal hold state
  // latched after the physical keyup has already happened.
  window.mochimonoGridKeyboard?.release?.();
}

function finishKeyboardBoundary(key, current, top) {
  // library-app keeps a delayed defensive anchor too. Let that settle while the
  // old cursor remains visually fixed, then make exactly one normal arrow move.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    restoreCardTop(current, top);
    keyboardBoundaryPending = false;
    const next = queuedBoundaryKey || key;
    queuedBoundaryKey = '';
    runBoundaryArrow(next);
  }));
}

function interceptKeyboardBoundary(event) {
  if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || (viewer && !viewer.hidden) || !files?.classList.contains('grid') || editingControl(event.target)) return;
  const current = document.activeElement?.closest?.('#files [data-hash]');
  if (!current) return;
  const direction = event.key === 'ArrowUp' ? -1 : 1;
  if (hasRenderedRow(current, direction) || !canExtend(direction)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  if (keyboardBoundaryPending) {
    queuedBoundaryKey = event.key;
    return;
  }

  keyboardBoundaryPending = true;
  pulse(180);
  const top = current.getBoundingClientRect().top;
  const changed = window.mochimonoLibrary?.extend?.(direction);
  if (!changed) {
    keyboardBoundaryPending = false;
    runBoundaryArrow(event.key);
    return;
  }
  window.mochimonoGallery?.layoutNow?.();
  restoreCardTop(current, top);
  finishKeyboardBoundary(event.key, current, top);
}

window.mochimonoGridInteraction = { active: () => active, pulse, release };

window.addEventListener('scroll', () => pulse(140), { passive: true });
window.addEventListener('wheel', event => {
  if (event.deltaY >= 0 || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || (viewer && !viewer.hidden)) return;
  scheduleUpwardWheelEdge();
}, { passive: true, capture: true });
document.addEventListener('keydown', interceptKeyboardBoundary, true);
window.addEventListener('blur', () => {
  keyboardBoundaryPending = false;
  queuedBoundaryKey = '';
  release();
});
