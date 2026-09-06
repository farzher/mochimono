const files = document.querySelector('#files');
const commandbar = document.querySelector('.commandbar');

const VIEWER_RETURN_PREFILL = 120;

function onScreen(card) {
  if (!card?.isConnected) return false;
  const rect = card.getBoundingClientRect();
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return rect.bottom > top && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
}

function refreshThumbnails() {
  // A viewer jump can leave the stable grid with rows mounted around the old
  // viewer position while the document is already back at a different scroll
  // position. A normal scroll event would repair that row window, but returning
  // from the viewer does not always produce one.
  requestAnimationFrame(() => {
    const grid = window.mochimonoStableGrid;
    if (!grid?.active?.()) return;

    // Materialize a modest window around the grid's current visible index so
    // syncThumbnails has real cards to prioritize. ensureIndex is idempotent at
    // the row level, so this is cheap when the correct rows are already mounted.
    const center = Number(grid.visibleIndex?.());
    const count = Number(grid.count?.()) || 0;
    if (Number.isInteger(center) && center >= 0 && count > 0) {
      const start = Math.max(0, center - VIEWER_RETURN_PREFILL);
      const end = Math.min(count - 1, center + VIEWER_RETURN_PREFILL);
      for (let index = start; index <= end; index++) grid.ensureIndex?.(index);
    }

    // Force a fresh priority/check pass even when scrollY itself did not change.
    grid.syncThumbnails?.();
  });
}

window.addEventListener('mochimono-viewer-return', event => {
  if (!files?.classList.contains('grid')) return;
  const hash = String(event.detail?.hash || '');

  // library-app materializes the viewed row before this event. fast-arrow-nav
  // moves the selection/highlight to the viewed card. Only move the underlying
  // grid when that card is actually outside the current viewport.
  if (hash) {
    const card = files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
    if (card && !onScreen(card)) card.scrollIntoView({ behavior:'auto', block:'center', inline:'nearest' });
  }

  // Returning to an unchanged scroll position does not fire a scroll event, so
  // explicitly rebuild the current thumbnail work set instead of waiting for
  // the user to scroll.
  refreshThumbnails();
});
