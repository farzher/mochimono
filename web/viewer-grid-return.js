const files = document.querySelector('#files');
const commandbar = document.querySelector('.commandbar');

function onScreen(card) {
  if (!card?.isConnected) return false;
  const rect = card.getBoundingClientRect();
  const top = Math.max(0, commandbar?.getBoundingClientRect().bottom || 0);
  return rect.bottom > top && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
}

window.addEventListener('mochimono-viewer-return', event => {
  if (!files?.classList.contains('grid')) return;
  const hash = String(event.detail?.hash || '');
  if (!hash) return;

  // library-app materializes the viewed row before this event. fast-arrow-nav
  // moves the selection/highlight to the viewed card. Only move the underlying
  // grid when that card is actually outside the current viewport.
  const card = files.querySelector(`[data-hash="${CSS.escape(hash)}"]`);
  if (!card || onScreen(card)) return;
  card.scrollIntoView({ behavior:'auto', block:'center', inline:'nearest' });
  window.mochimonoStableGrid?.syncThumbnails?.();
});
