const files = document.querySelector('#files');
const views = document.querySelector('#views');
const folderbar = document.querySelector('#folderbar');
const viewer = document.querySelector('#viewer');
const finePointer = matchMedia('(hover:hover) and (pointer:fine)');

function currentView() {
  return views.querySelector('[data-view].active')?.dataset.view || 'grid';
}

function syncLayoutMode() {
  document.documentElement.classList.toggle('library-grid-view', currentView() === 'grid');
}

views.addEventListener('click', () => requestAnimationFrame(syncLayoutMode));
new MutationObserver(syncLayoutMode).observe(views, { subtree: true, attributes: true, attributeFilter: ['class'] });
syncLayoutMode();

folderbar.addEventListener('click', event => {
  if (!event.target.closest('[data-folder-home]') || currentView() === 'folders') return;
  const url = new URL(location.href);
  url.searchParams.delete('source');
  url.searchParams.delete('path');
  history.replaceState(history.state, '', url);
  requestAnimationFrame(() => {
    folderbar.hidden = true;
    folderbar.replaceChildren();
  });
});

let viewerUiTimer = 0;

function showViewerUi() {
  if (viewer.hidden || !finePointer.matches) return;
  viewer.classList.remove('viewer-ui-hidden');
  clearTimeout(viewerUiTimer);
  viewerUiTimer = setTimeout(() => {
    if (!viewer.hidden && finePointer.matches) viewer.classList.add('viewer-ui-hidden');
  }, 500);
}

function syncViewerUi() {
  clearTimeout(viewerUiTimer);
  viewerUiTimer = 0;
  viewer.classList.remove('viewer-ui-hidden');
  if (!viewer.hidden && finePointer.matches) showViewerUi();
}

viewer.addEventListener('mousemove', showViewerUi, { passive: true });
viewer.addEventListener('mouseenter', showViewerUi, { passive: true });
new MutationObserver(syncViewerUi).observe(viewer, { attributes: true, attributeFilter: ['hidden'] });
finePointer.addEventListener?.('change', syncViewerUi);
syncViewerUi();

let press = null;
let dispatchingLongPress = false;
let suppressHash = '';
let suppressUntil = 0;

function cancelPress() {
  if (press?.timer) clearTimeout(press.timer);
  press = null;
}

files.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
  const item = event.target.closest('[data-hash]');
  if (!item) return;
  cancelPress();
  const hash = item.dataset.hash;
  press = {
    pointerId: event.pointerId,
    hash,
    x: event.clientX,
    y: event.clientY,
    timer: setTimeout(() => {
      if (!press || press.hash !== hash) return;
      suppressHash = hash;
      suppressUntil = performance.now() + 900;
      dispatchingLongPress = true;
      item.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: press.x,
        clientY: press.y
      }));
      dispatchingLongPress = false;
      navigator.vibrate?.(8);
      cancelPress();
    }, 500)
  };
}, { passive: true });

files.addEventListener('pointermove', event => {
  if (!press || event.pointerId !== press.pointerId) return;
  if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) cancelPress();
}, { passive: true });

files.addEventListener('pointerup', cancelPress, { passive: true });
files.addEventListener('pointercancel', cancelPress, { passive: true });

files.addEventListener('click', event => {
  if (dispatchingLongPress) return;
  const item = event.target.closest('[data-hash]');
  if (!item || item.dataset.hash !== suppressHash || performance.now() > suppressUntil) return;
  suppressHash = '';
  suppressUntil = 0;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

files.addEventListener('contextmenu', event => {
  const item = event.target.closest('[data-hash]');
  if (item && item.dataset.hash === suppressHash && performance.now() <= suppressUntil) event.preventDefault();
});
